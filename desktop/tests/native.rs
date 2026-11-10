use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::watch,
};
use tokio_tungstenite::{WebSocketStream, accept_async, tungstenite::Message};
use undertone_desktop::{
    bridge::RoomAddress,
    connection::{EventKind, Network},
    music::{Content, MusicCommand},
    session::{ErrorCode, NativeCommand, NativeState},
};

async fn request(
    listener: &TcpListener,
    method: &str,
    path: &str,
    status: &str,
    body: &str,
    extra: &str,
) -> String {
    let (mut tcp, _) = listener.accept().await.unwrap();
    let mut bytes = Vec::new();
    let mut buf = [0; 2048];
    let end = loop {
        let n = tcp.read(&mut buf).await.unwrap();
        assert!(n > 0);
        bytes.extend_from_slice(&buf[..n]);
        assert!(bytes.len() < 16384);
        if let Some(end) = bytes.windows(4).position(|s| s == b"\r\n\r\n") {
            break end + 4;
        }
    };
    let head = String::from_utf8(bytes[..end].to_vec()).unwrap();
    let len = head
        .lines()
        .find_map(|line| {
            line.to_lowercase()
                .strip_prefix("content-length:")
                .map(|s| s.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    while bytes.len() < end + len {
        let n = tcp.read(&mut buf).await.unwrap();
        assert!(n > 0);
        bytes.extend_from_slice(&buf[..n]);
    }
    let input = String::from_utf8(bytes).unwrap();
    assert!(
        input.starts_with(&format!("{method} {path} HTTP/1.1")),
        "{head}"
    );
    if path != "/prefix/api/auth/grant" {
        assert!(
            head.to_lowercase()
                .contains("authorization: bearer dummy-retained-token")
        );
    }
    tcp.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body}",body.len()).as_bytes()).await.unwrap();
    input[end..].into()
}
async fn socket(listener: &TcpListener, logged: bool) -> WebSocketStream<TcpStream> {
    let (tcp, _) = listener.accept().await.unwrap();
    let mut ws = accept_async(tcp).await.unwrap();
    let auth: Value =
        serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(
        auth,
        json!({"action":"auth","token":"dummy-retained-token"})
    );
    for v in [
        json!({"action":"playback-capabilities","version":1,"recovery":"snapshot"}),
        json!({"action":"user","update":{"kind":"update","value":{"id":"self","name":"Fixture","role":0,"isLoggedIn":logged,"private":"must-not-project"}}}),
        json!({"action":"you","info":{"id":"self"}}),
        json!({"action":"sync","queueMode":"music","grants":[[0,8]],"music":{"revision":1,"planRevision":1,"queue":[],"queueTotal":0,"current":null,"settings":{},"participants":[{"participantId":"me","clientIds":["self"],"includeMoodIds":[],"excludeMoodIds":[]}]}}),
    ] {
        ws.send(Message::Text(v.to_string().into())).await.unwrap();
    }
    ws
}
async fn until(
    rx: &mut watch::Receiver<NativeState>,
    test: impl Fn(&NativeState) -> bool,
) -> NativeState {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let state = rx.borrow_and_update().clone();
            if test(&state) {
                return state;
            }
            rx.changed().await.unwrap();
        }
    })
    .await
    .unwrap()
}

#[tokio::test(flavor = "current_thread")]
async fn same_token_login_logout_refresh_401_and_playback_privacy() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let fixture = tokio::spawn(async move {
        request(
            &listener,
            "GET",
            "/prefix/api/auth/grant",
            "200 OK",
            r#"{"token":"dummy-retained-token"}"#,
            "",
        )
        .await;
        let first = socket(&listener, false).await;
        let login = request(
            &listener,
            "POST",
            "/prefix/api/user/login",
            "200 OK",
            r#"{"success":true,"user":{"email":"private-email"}}"#,
            "",
        )
        .await;
        assert_eq!(
            serde_json::from_str::<Value>(&login).unwrap(),
            json!({"user":"fixture","password":"dummy-password"})
        );
        request(&listener,"GET","/prefix/api/user/","200 OK",r#"{"loggedIn":true,"username":"Fixture","discordLinked":false,"token":"must-not-project"}"#,"").await;
        let mut second = socket(&listener, true).await;
        drop(first);
        let received: Value = serde_json::from_str(
            tokio::time::timeout(Duration::from_secs(3), second.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .to_text()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(received["nonce"], "fresh-account");
        request(
            &listener,
            "POST",
            "/prefix/api/user/logout",
            "200 OK",
            r#"{"success":true}"#,
            "",
        )
        .await;
        request(
            &listener,
            "GET",
            "/prefix/api/user/",
            "200 OK",
            r#"{"loggedIn":false,"username":"Guest"}"#,
            "",
        )
        .await;
        let third = socket(&listener, false).await;
        drop(second);
        // A full same-token state refresh must not mint another token.
        let fourth = socket(&listener, false).await;
        drop(third);
        request(
            &listener,
            "GET",
            "/prefix/api/user/",
            "401 Unauthorized",
            r#"{"error":{"message":"private upstream detail"}}"#,
            "",
        )
        .await;
        let mut fourth = fourth;
        // No fenced native preference write can escape after 401.
        assert!(
            tokio::time::timeout(Duration::from_millis(150), fourth.next())
                .await
                .is_err()
        );
    });
    let network = Network::new().unwrap();
    let (events, playback) = async_channel::bounded(16);
    let connection = network.connect(
        22,
        RoomAddress::parse(&format!("http://127.0.0.1:{port}/prefix/room/test")).unwrap(),
        events.clone(),
    );
    let mut native = connection.subscribe_native();
    let original = until(&mut native, |s| s.room.active()).await.authority();
    assert!(connection.send_native(
        original,
        NativeCommand::Login {
            user: "fixture".into(),
            password: "dummy-password".into()
        }
    ));
    let logged = until(&mut native, |s| {
        s.account.logged_in && s.socket_generation == 1 && s.room.active()
    })
    .await;
    assert!(logged.can().account_write);
    assert!(!connection.send(
        original,
        json!({"action":"playback-subscribe","version":1,"nonce":"old-host"})
    ));
    assert!(!connection.send_native(original, NativeCommand::Logout));
    assert!(connection.send(
        logged.authority(),
        json!({"action":"playback-subscribe","version":1,"nonce":"fresh-account"})
    ));
    let projected = format!("{logged:?}");
    for secret in [
        "dummy-retained-token",
        "dummy-password",
        "private-email",
        "must-not-project",
    ] {
        assert!(!projected.contains(secret));
    }
    assert!(connection.send_native(connection.native_state().authority(), NativeCommand::Logout));
    until(&mut native, |s| {
        s.account.known && !s.account.logged_in && s.socket_generation == 2 && s.room.active()
    })
    .await;
    drop(connection);
    let connection = network.connect(
        23,
        RoomAddress::parse(&format!("http://127.0.0.1:{port}/prefix/room/other")).unwrap(),
        events,
    );
    let mut native = connection.subscribe_native();
    until(&mut native, |s| s.room.active()).await;
    assert!(connection.send_native(
        connection.native_state().authority(),
        NativeCommand::RefreshAccount
    ));
    let expired = until(&mut native, |s| {
        s.error.as_ref().is_some_and(|e| e.code == ErrorCode::Auth)
    })
    .await;
    assert!(expired.account.expired);
    assert!(!expired.can().account_write);
    assert!(!expired.can().preferences);
    assert!(connection.send_native(
        connection.native_state().authority(),
        NativeCommand::Music(MusicCommand::Preferences {
            include: vec![],
            exclude: vec![],
            content: Content::Keep
        })
    ));
    tokio::time::timeout(Duration::from_secs(8), fixture)
        .await
        .unwrap()
        .unwrap();
    while let Ok(event) = playback.try_recv() {
        assert!([22, 23].contains(&event.generation));
        assert!(
            matches!(event.kind,EventKind::Message(ref v) if v["action"]=="playback-capabilities")
        );
    }
}

#[tokio::test(flavor = "current_thread")]
async fn sanitized_rate_limit_keeps_retry_after_and_never_raw_body() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let fixture = tokio::spawn(async move {
        request(
            &listener,
            "GET",
            "/prefix/api/auth/grant",
            "200 OK",
            r#"{"token":"dummy-retained-token"}"#,
            "",
        )
        .await;
        let mut ws = socket(&listener, false).await;
        request(
            &listener,
            "POST",
            "/prefix/api/user/login",
            "429 Too Many Requests",
            r#"{"error":{"message":"private-url-password-token"}}"#,
            "Retry-After: 42\r\n",
        )
        .await;
        let _ = ws.next().await;
    });
    let network = Network::new().unwrap();
    // Retain the playback receiver, otherwise a capability delivery correctly terminates the socket.
    let (events, rx) = async_channel::bounded(8);
    let connection = network.connect(
        1,
        RoomAddress::parse(&format!("http://127.0.0.1:{port}/prefix/room/test")).unwrap(),
        events,
    );
    let mut native = connection.subscribe_native();
    until(&mut native, |s| s.room.active()).await;
    assert!(connection.send_native(
        connection.native_state().authority(),
        NativeCommand::Login {
            user: "fixture".into(),
            password: "dummy-password".into()
        }
    ));
    let state = until(&mut native, |s| {
        s.error
            .as_ref()
            .is_some_and(|e| e.code == ErrorCode::RateLimit)
    })
    .await;
    assert_eq!(state.error.unwrap().retry_after_seconds, Some(42));
    assert!(!format!("{:?}", connection.native_state()).contains("private-url-password-token"));
    drop(connection);
    drop(rx);
    tokio::time::timeout(Duration::from_secs(5), fixture)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn a_delayed_tag_reply_cannot_update_a_replacement_track() {
    replaced_tag_reply("200 OK", ErrorCode::Stale).await;
}
#[tokio::test(flavor = "current_thread")]
async fn a_401_from_a_replaced_track_still_fences_the_current_account() {
    replaced_tag_reply("401 Unauthorized", ErrorCode::Auth).await;
}
async fn replaced_tag_reply(status: &'static str, expected: ErrorCode) {
    const A: &str = "00000000-0000-4000-8000-000000000001";
    const B: &str = "00000000-0000-4000-8000-000000000002";
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (changed, change_seen) = tokio::sync::oneshot::channel();
    let fixture = tokio::spawn(async move {
        request(
            &listener,
            "GET",
            "/prefix/api/auth/grant",
            "200 OK",
            r#"{"token":"dummy-retained-token"}"#,
            "",
        )
        .await;
        let first = socket(&listener, false).await;
        request(
            &listener,
            "POST",
            "/prefix/api/user/login",
            "200 OK",
            r#"{"success":true}"#,
            "",
        )
        .await;
        request(
            &listener,
            "GET",
            "/prefix/api/user/",
            "200 OK",
            r#"{"loggedIn":true,"username":"Fixture"}"#,
            "",
        )
        .await;
        let mut ws = socket(&listener, true).await;
        drop(first);
        ws.send(Message::Text(json!({"action":"sync","queueMode":"manual","music":null,"currentSource":{"trackId":A,"src_url":"never-project"}}).to_string().into())).await.unwrap();
        let (mut tag, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        let mut buf = [0; 1024];
        while !bytes.windows(4).any(|b| b == b"\r\n\r\n") {
            let n = tag.read(&mut buf).await.unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&buf[..n]);
            assert!(bytes.len() < 8192);
        }
        let head = String::from_utf8(bytes).unwrap();
        assert!(head.starts_with(&format!("PUT /prefix/api/music/tracks/{A}/moods/{B} ")));
        assert!(
            head.to_lowercase()
                .contains("authorization: bearer dummy-retained-token")
        );
        assert!(!head.contains("userId"));
        ws.send(Message::Text(
            json!({"action":"sync","currentSource":{"trackId":B}})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
        change_seen.await.unwrap();
        tag.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: 16\r\nConnection: close\r\n\r\n{{\"success\":true}}").as_bytes()).await.unwrap();
        let _ = ws.next().await;
    });
    let network = Network::new().unwrap();
    let (events, _rx) = async_channel::bounded(8);
    let c = network.connect(
        1,
        RoomAddress::parse(&format!("http://127.0.0.1:{port}/prefix/room/test")).unwrap(),
        events,
    );
    let mut native = c.subscribe_native();
    until(&mut native, |s| s.room.active()).await;
    assert!(c.send_native(
        c.native_state().authority(),
        NativeCommand::Login {
            user: "fixture".into(),
            password: "dummy-password".into()
        }
    ));
    until(&mut native, |s| {
        s.account.logged_in && s.room.track_id() == Some(A)
    })
    .await;
    assert!(c.send_native(
        c.native_state().authority(),
        NativeCommand::SetTag {
            track_id: A.into(),
            mood_id: B.into(),
            active: true
        }
    ));
    until(&mut native, |s| s.room.track_id() == Some(B)).await;
    changed.send(()).unwrap();
    let state = until(&mut native, |s| {
        s.error.as_ref().is_some_and(|e| e.code == expected)
    })
    .await;
    assert!(!state.tags.loaded);
    if expected == ErrorCode::Auth {
        assert!(state.account.expired);
        assert!(!state.can().account_write);
        assert!(state.tags_track_id.is_none());
    } else {
        assert_eq!(state.tags_track_id.as_deref(), Some(B));
    }
    assert!(!format!("{state:?}").contains("never-project"));
    drop(c);
    tokio::time::timeout(Duration::from_secs(5), fixture)
        .await
        .unwrap()
        .unwrap();
}
