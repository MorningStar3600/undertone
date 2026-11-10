use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use tokio_tungstenite::{accept_async, tungstenite::Message};
use undertone_desktop::{
    bridge::RoomAddress,
    connection::{EventKind, Network},
};

async fn read_request(socket: &mut tokio::net::TcpStream) -> String {
    let mut request = Vec::new();
    while !request.ends_with(b"\r\n\r\n") {
        let mut chunk = [0; 1024];
        let count = socket.read(&mut chunk).await.unwrap();
        assert!(count > 0 && request.len() + count <= 8192);
        request.extend_from_slice(&chunk[..count]);
    }
    String::from_utf8(request).unwrap()
}

#[tokio::test(flavor = "current_thread")]
async fn temporary_guest_auth_and_playback_only_transport_with_local_fixture() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let fixture = tokio::spawn(async move {
        let (mut http, _) = listener.accept().await.unwrap();
        assert!(
            read_request(&mut http)
                .await
                .starts_with("GET /api/auth/grant ")
        );
        let body = r#"{"token":"desktop-fixture-guest"}"#;
        http.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        drop(http);
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        let auth: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(
            auth,
            json!({"action":"auth","token":"desktop-fixture-guest"})
        );
        for message in [
            json!({"action":"sync","currentSource":{"service":"youtube"}}),
            json!({"action":"chat","message":"private fixture chat"}),
            json!({"action":"playback-capabilities","version":1,"recovery":"snapshot"}),
        ] {
            socket
                .send(Message::Text(message.to_string().into()))
                .await
                .unwrap();
        }
        let subscription: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(subscription["action"], "playback-subscribe");
        assert_eq!(subscription["nonce"], "fixture");
        socket.send(Message::Text(json!({"action":"playback-snapshot","nonce":"fixture","timeline":{},"attachment":null}).to_string().into())).await.unwrap();
        // Abort closes the owned socket; no hidden reconnect is spawned.
        let _ = socket.next().await;
    });
    let network = Network::new().unwrap();
    let (sender, receiver) = async_channel::bounded(8);
    let connection = network.connect(
        42,
        RoomAddress::parse(&format!("http://127.0.0.1:{port}/room/fixture")).unwrap(),
        sender,
    );
    let event = tokio::time::timeout(Duration::from_secs(10), receiver.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event.generation, 42);
    assert!(
        matches!(event.kind, EventKind::Message(ref value) if value["action"] == "playback-capabilities")
    );
    assert!(!connection.send(json!({"action":"auth","token":"attempt"})));
    assert!(connection.send(json!({"action":"playback-subscribe","version":1,"nonce":"fixture"})));
    let event = receiver.recv().await.unwrap();
    assert!(
        matches!(event.kind, EventKind::Message(ref value) if value["action"] == "playback-snapshot")
    );
    assert!(receiver.try_recv().is_err());
    drop(connection);
    tokio::time::timeout(Duration::from_secs(5), fixture)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn legacy_only_server_times_out_without_forwarding_sync_or_starting_a_player() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let fixture = tokio::spawn(async move {
        let (mut http, _) = listener.accept().await.unwrap();
        assert!(
            read_request(&mut http)
                .await
                .starts_with("GET /api/auth/grant ")
        );
        let body = r#"{"token":"legacy-fixture"}"#;
        http.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        drop(http);
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        let _auth = socket.next().await.unwrap().unwrap();
        socket.send(Message::Text(json!({"action":"sync", "isPlaying":true, "currentSource":{"service":"youtube","id":"abcdefghijk"}}).to_string().into())).await.unwrap();
        let _ = socket.next().await;
    });
    let network = Network::new().unwrap();
    let (sender, receiver) = async_channel::bounded(8);
    let connection = network.connect(
        1,
        RoomAddress::parse(&format!("http://127.0.0.1:{port}/room/legacy")).unwrap(),
        sender,
    );
    let event = tokio::time::timeout(Duration::from_secs(12), receiver.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(event.kind, EventKind::Failed("protocolRequired")));
    assert!(receiver.try_recv().is_err());
    drop(connection);
    fixture.await.unwrap();
}
