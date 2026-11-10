use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use tokio_tungstenite::{accept_async, tungstenite::Message};
use undertone_desktop::{
    bridge::{Ipc, RoomAddress},
    connection::{EventKind, Network, enqueue_ipc},
};

#[test]
fn ipc_saturation_is_bounded_and_reports_failure_instead_of_losing_paused_authority() {
    let (sender, receiver) = async_channel::bounded(2);
    let overflow = AtomicBool::new(false);
    enqueue_ipc(&sender, 3, 8, Ipc::Ready, &overflow);
    enqueue_ipc(&sender, 3, 8, Ipc::Ready, &overflow);
    enqueue_ipc(
        &sender,
        3,
        8,
        Ipc::State {
            position: 0.,
            duration: 120.,
            playing: false,
            available: true,
        },
        &overflow,
    );
    assert_eq!(receiver.len(), 2);
    assert!(overflow.load(Ordering::Acquire));
    // No unrelated/new-generation event was evicted to make space for a failure.
    for _ in 0..2 {
        assert!(matches!(
            receiver.try_recv().unwrap().kind,
            EventKind::Ipc {
                host: 8,
                data: Ipc::Ready
            }
        ));
    }
    assert!(receiver.is_empty());
}

#[test]
fn ipc_delivery_and_closed_receiver_do_not_block() {
    let (sender, receiver) = async_channel::bounded(1);
    let overflow = AtomicBool::new(false);
    enqueue_ipc(&sender, 1, 2, Ipc::Ready, &overflow);
    assert!(matches!(
        receiver.try_recv().unwrap().kind,
        EventKind::Ipc {
            host: 2,
            data: Ipc::Ready
        }
    ));
    drop(receiver);
    enqueue_ipc(&sender, 1, 2, Ipc::Ready, &overflow);
    assert!(!overflow.load(Ordering::Acquire));
}

#[test]
fn stale_host_overflow_does_not_poison_its_replacement() {
    let (sender, receiver) = async_channel::bounded(1);
    let old_host = AtomicBool::new(false);
    let new_host = AtomicBool::new(false);
    enqueue_ipc(&sender, 1, 3, Ipc::Ready, &new_host);
    enqueue_ipc(&sender, 1, 2, Ipc::Ready, &old_host);
    assert!(old_host.load(Ordering::Acquire));
    assert!(!new_host.load(Ordering::Acquire));
    assert!(matches!(
        receiver.try_recv().unwrap().kind,
        EventKind::Ipc {
            host: 3,
            data: Ipc::Ready
        }
    ));
}

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
    assert!(!connection.send(
        connection.native_state().authority(),
        json!({"action":"auth","token":"attempt"})
    ));
    assert!(connection.send(
        connection.native_state().authority(),
        json!({"action":"playback-subscribe","version":1,"nonce":"fixture"})
    ));
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
