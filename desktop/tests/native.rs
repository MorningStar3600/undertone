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
    music::{Content, Intent, MusicCommand, MusicStatus, Reference},
    session::{ErrorCode, HttpActivity, NativeCommand, NativeState},
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

async fn search_socket(listener: &TcpListener, input: &str) -> TcpStream {
    let (mut tcp, _) = listener.accept().await.unwrap();
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        let mut buf = [0; 2048];
        let n = tcp.read(&mut buf).await.unwrap();
        assert!(n > 0 && bytes.len() + n <= 8192);
        bytes.extend_from_slice(&buf[..n]);
    }
    let head = String::from_utf8(bytes).unwrap();
    let path = head.split_whitespace().nth(1).unwrap();
    let url = url::Url::parse(&format!("http://fixture{path}")).unwrap();
    assert!(head.starts_with("GET "));
    assert_eq!(url.path(), "/prefix/api/data/previewAdd");
    assert_eq!(
        url.query_pairs().collect::<Vec<_>>(),
        vec![("input".into(), input.into())]
    );
    assert!(
        head.to_lowercase()
            .contains("authorization: bearer dummy-retained-token")
    );
    tcp
}

async fn search_reply(tcp: &mut TcpStream, result: Value) {
    let body = json!({"success":true,"result":result}).to_string();
    // Superseded HTTP requests are cancelled, so a closed peer is expected for delayed replies.
    let _ = tcp.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await;
}

#[tokio::test(flavor = "current_thread")]
async fn native_search_selects_exact_results_and_fences_queries_edits_and_teardown() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let network = Network::new().unwrap();
        let (events, _playback) = async_channel::bounded(8);
        let c = network.connect(71, RoomAddress::parse(&format!("http://127.0.0.1:{port}/prefix/room/test")).unwrap(), events);
        let mut native = c.subscribe_native();
        request(&listener, "GET", "/prefix/api/auth/grant", "200 OK", r#"{"token":"dummy-retained-token"}"#, "").await;
        let mut ws = socket(&listener, false).await;
        ws.send(Message::Text(json!({"action":"sync","grants":[[0,40]]}).to_string().into())).await.unwrap();
        until(&mut native, |s| s.can().add_next).await;

        let search_sequence = std::cell::Cell::new(0u64);
        let search = |input: &str| {
            search_sequence.set(search_sequence.get() + 1);
            NativeCommand::SearchMusic { input: input.into(), request_id: search_sequence.get() }
        };
        let reference = |id: &str| Reference { service: "youtube".into(), id: id.into() };
        let choose = |id: &str, intent| NativeCommand::Music(MusicCommand::RequestPreview {
            request_id: format!("pick-{id}-{intent:?}"), intent, reference: reference(id),
        });
        assert!(c.send_native(c.native_state().authority(), search("Artist & title")));
        let mut http = search_socket(&listener, "Artist & title").await;
        let busy = until(&mut native, |s| s.http_busy).await;
        assert!(c.send_native(busy.authority(), NativeCommand::RefreshRoom));
        until(&mut native, |s| s.error.as_ref().is_some_and(|e| e.code == ErrorCode::Busy)).await;
        search_reply(&mut http, json!([
            {"title":"First", "service":"direct", "id":"https://temporary/first", "originalReference":{"service":"youtube","id":"first"}},
            {"title":"Second", "service":"hls", "id":"https://temporary/second", "originalReference":{"service":"youtube","id":"second"}}
        ])).await;
        let results = until(&mut native, |s| s.preview.is_some() && !s.http_busy).await;
        assert!(results.error.is_none(), "a rejected concurrent operation must not poison a successful search");
        assert_eq!(results.preview_completed_id, Some(1));
        assert_eq!(results.preview.as_ref().unwrap().items.len(), 2);
        // An arbitrary reference must never borrow the authority of a displayed result.
        assert!(c.send_native(results.authority(), choose("not-in-results", Intent::Mix)));
        until(&mut native, |s| s.room.status == Some(MusicStatus::Unavailable)).await;
        for (id, intent) in [("second", Intent::Mix), ("first", Intent::Next)] {
            assert!(c.send_native(results.authority(), choose(id, intent)));
            let message: Value = serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
            let command = &message["request"]["command"];
            assert_eq!(command["action"], "request");
            assert_eq!(command["reference"], json!(reference(id)));
            assert_eq!(command["intent"], json!(intent));
            ws.send(Message::Text(json!({"action":"music-result","result":{"correlationId":command["correlationId"],"revision":1,"status":"applied"}}).to_string().into())).await.unwrap();
            until(&mut native, |s| !s.room.busy && s.room.status == Some(MusicStatus::Applied)).await;
        }

        // Order-only loss must revoke displayed selection authority even though Mix remains.
        ws.send(Message::Text(json!({"action":"sync","grants":[[0,8]]}).to_string().into())).await.unwrap();
        let revoked = until(&mut native, |s| s.can().add_mix && !s.can().add_next).await;
        assert!(revoked.preview_generation > results.preview_generation);
        assert!(revoked.preview.is_none());
        ws.send(Message::Text(json!({"action":"sync","grants":[[0,40]]}).to_string().into())).await.unwrap();
        until(&mut native, |s| s.can().add_next).await;
        assert!(!c.send_native(results.authority(), choose("first", Intent::Next)));

        // New searches revoke old admission immediately and supersede an outstanding query.
        assert!(c.send_native(results.authority(), search("older query")));
        let mut older = search_socket(&listener, "older query").await;
        let loading = until(&mut native, |s| s.http_busy && s.preview.is_none()).await;
        assert!(!c.send_native(results.authority(), choose("second", Intent::Mix)));
        assert!(c.send_native(loading.authority(), search("newer query")));
        let mut newer = search_socket(&listener, "newer query").await;
        search_reply(&mut newer, json!([])).await;
        let empty = until(&mut native, |s| s.preview.as_ref().is_some_and(|p| p.items.is_empty()) && !s.http_busy).await;
        assert_eq!(empty.preview_completed_id, Some(3));
        search_reply(&mut older, json!([{"service":"youtube","id":"obsolete"}])).await;
        assert!(c.send_native(empty.authority(), choose("obsolete", Intent::Mix)));
        until(&mut native, |s| s.room.status == Some(MusicStatus::Unavailable)).await;

        // Editing without submitting also cancels a pending query and revokes its results.
        assert!(c.send_native(c.native_state().authority(), search("https://youtu.be/abcdefghijk")));
        let mut edited = search_socket(&listener, "https://youtu.be/abcdefghijk").await;
        let loading = until(&mut native, |s| s.http_busy).await;
        assert!(c.send_native(loading.authority(), NativeCommand::InvalidatePreview));
        until(&mut native, |s| !s.http_busy && s.preview.is_none() && s.preview_generation > loading.preview_generation).await;
        search_reply(&mut edited, json!([{"service":"youtube","id":"edited"}])).await;

        // Live room/grant loss cancels search and leaves the legacy room intact.
        assert!(c.send_native(c.native_state().authority(), search("room teardown")));
        let mut removed = search_socket(&listener, "room teardown").await;
        until(&mut native, |s| s.http_busy).await;
        ws.send(Message::Text(json!({"action":"sync","queueMode":"manual","music":null}).to_string().into())).await.unwrap();
        let legacy = until(&mut native, |s| s.room.queue_mode.as_deref() == Some("manual") && !s.http_busy).await;
        assert!(legacy.preview.is_none());
        search_reply(&mut removed, json!([{"service":"youtube","id":"removed"}])).await;
        assert!(c.send_native(legacy.authority(), search("legacy room query")));
        let unavailable = until(&mut native, |s| s.error.as_ref().is_some_and(|e| e.code == ErrorCode::Unavailable)).await;
        assert_eq!(unavailable.room.queue_mode.as_deref(), Some("manual"));
        assert!(unavailable.preview.is_none());
        assert!(tokio::time::timeout(Duration::from_millis(100), ws.next()).await.is_err(), "no rejected/stale selection or room conversion may escape");
    }).await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn native_search_failure_and_logout_clear_previous_results() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let network = Network::new().unwrap();
        let (events, _playback) = async_channel::bounded(8);
        let c = network.connect(
            72,
            RoomAddress::parse(&format!("http://127.0.0.1:{port}/prefix/room/test")).unwrap(),
            events,
        );
        let mut native = c.subscribe_native();
        request(
            &listener,
            "GET",
            "/prefix/api/auth/grant",
            "200 OK",
            r#"{"token":"dummy-retained-token"}"#,
            "",
        )
        .await;
        let _ws = socket(&listener, false).await;
        let original = until(&mut native, |s| s.can().add_mix).await;
        assert!(c.send_native(
            original.authority(),
            NativeCommand::SearchMusic {
                input: "song".into(),
                request_id: 1,
            }
        ));
        let mut http = search_socket(&listener, "song").await;
        search_reply(&mut http, json!([{"service":"youtube","id":"stable"}])).await;
        let displayed = until(&mut native, |s| s.preview.is_some() && !s.http_busy).await;
        assert!(c.send_native(
            displayed.authority(),
            NativeCommand::SearchMusic {
                input: "failure".into(),
                request_id: 2,
            }
        ));
        request(
            &listener,
            "GET",
            "/prefix/api/data/previewAdd?input=failure",
            "429 Too Many Requests",
            r#"{"error":"private-provider-url"}"#,
            "Retry-After: 7\r\n",
        )
        .await;
        let failed = until(&mut native, |s| {
            s.error
                .as_ref()
                .is_some_and(|e| e.code == ErrorCode::RateLimit)
        })
        .await;
        assert!(failed.preview.is_none());
        assert!(!failed.http_busy);
        assert_eq!(failed.preview_completed_id, Some(2));
        assert_eq!(failed.error.unwrap().retry_after_seconds, Some(7));
        assert!(!format!("{:?}", c.native_state()).contains("private-provider-url"));
        assert!(c.send_native(
            c.native_state().authority(),
            NativeCommand::SearchMusic {
                input: "pending".into(),
                request_id: 3,
            }
        ));
        let mut pending = search_socket(&listener, "pending").await;
        let loading = until(&mut native, |s| s.http_busy).await;
        assert!(c.send_native(loading.authority(), NativeCommand::Logout));
        let cleared = until(&mut native, |s| {
            s.account_generation > loading.account_generation
        })
        .await;
        assert!(cleared.preview.is_none());
        search_reply(
            &mut pending,
            json!([{"service":"youtube","id":"old-account"}]),
        )
        .await;
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
            r#"{"loggedIn":false}"#,
            "",
        )
        .await;
        let _fresh = socket(&listener, false).await;
        let refreshed = until(&mut native, |s| s.socket_generation == 1 && s.room.active()).await;
        assert!(refreshed.preview.is_none());
        assert!(!c.send_native(
            displayed.authority(),
            NativeCommand::Music(MusicCommand::RequestPreview {
                request_id: "old-account".into(),
                intent: Intent::Mix,
                reference: Reference {
                    service: "youtube".into(),
                    id: "stable".into()
                },
            })
        ));
    })
    .await
    .unwrap();
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
        match event.kind {
            EventKind::Message(v) => assert_eq!(v["action"], "playback-capabilities"),
            // The fixture has closed its socket; delivery of this terminal event races
            // this drain. It is not an account payload crossing the playback boundary.
            EventKind::Failed(code) => assert_eq!(code, "connectionFailed"),
            other => panic!("unexpected playback event: {other:?}"),
        }
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

async fn grant(listener: &TcpListener) {
    request(
        listener,
        "GET",
        "/prefix/api/auth/grant",
        "200 OK",
        r#"{"token":"dummy-retained-token"}"#,
        "",
    )
    .await;
}

#[tokio::test(flavor = "current_thread")]
async fn search_failures_stay_next_to_the_search_with_their_status() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let network = Network::new().unwrap();
        let (events, _playback) = async_channel::bounded(8);
        let c = network.connect(
            91,
            RoomAddress::parse(&format!("http://127.0.0.1:{port}/prefix/room/test")).unwrap(),
            events,
        );
        let mut native = c.subscribe_native();
        grant(&listener).await;
        let _ws = socket(&listener, false).await;
        let joined = until(&mut native, |s| s.can().add_mix).await;

        // 429: the rate limit and its delay are kept for the search area, not only globally.
        let limited = c
            .send_native_ticket(
                joined.authority(),
                NativeCommand::SearchMusic {
                    input: "toomany".into(),
                    request_id: 1,
                },
            )
            .unwrap();
        request(
            &listener,
            "GET",
            "/prefix/api/data/previewAdd?input=toomany",
            "429 Too Many Requests",
            r#"{"error":{"message":"private-limiter-detail"}}"#,
            "Retry-After: 7\r\n",
        )
        .await;
        let state = until(&mut native, |s| s.settled(limited)).await;
        let error = state.preview_error.clone().expect("429 surfaced");
        assert_eq!(
            (error.code, error.status, error.retry_after_seconds),
            (ErrorCode::RateLimit, Some(429), Some(7))
        );
        assert!(state.preview.is_none() && !state.http_busy);
        assert!(!format!("{state:?}").contains("private-limiter-detail"));

        // 400 (quota, query too short...) keeps its status so the UI can say which.
        let refused = c
            .send_native_ticket(
                state.authority(),
                NativeCommand::SearchMusic {
                    input: "ab".into(),
                    request_id: 2,
                },
            )
            .unwrap();
        request(
            &listener,
            "GET",
            "/prefix/api/data/previewAdd?input=ab",
            "400 Bad Request",
            r#"{"success":false,"error":{"name":"InvalidAddPreviewInputException"}}"#,
            "",
        )
        .await;
        let state = until(&mut native, |s| s.settled(refused)).await;
        let error = state.preview_error.clone().expect("400 surfaced");
        assert_eq!((error.code, error.status), (ErrorCode::Rejected, Some(400)));
        assert_eq!(state.preview_completed_id, Some(2));

        // Editing the query clears the stale explanation.
        let edit = c
            .send_native_ticket(state.authority(), NativeCommand::InvalidatePreview)
            .unwrap();
        let state = until(&mut native, |s| s.settled(edit)).await;
        assert!(state.preview_error.is_none() && state.error.is_none());
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn failed_account_requests_keep_the_room_and_refresh_room_recovers() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let network = Network::new().unwrap();
        let (events, _playback) = async_channel::bounded(16);
        let c = network.connect(
            92,
            RoomAddress::parse(&format!("http://127.0.0.1:{port}/prefix/room/test")).unwrap(),
            events,
        );
        let mut native = c.subscribe_native();
        grant(&listener).await;
        let _first = socket(&listener, false).await;
        let joined = until(&mut native, |s| s.can().add_mix).await;

        // The automatic account check fails (server error): the room resynchronizes instead of
        // staying fenced with every music feature disabled.
        assert!(c.send_native(joined.authority(), NativeCommand::RefreshAccount));
        request(
            &listener,
            "GET",
            "/prefix/api/user/",
            "500 Internal Server Error",
            r#"{"success":false}"#,
            "",
        )
        .await;
        let _second = socket(&listener, false).await;
        let recovered = until(&mut native, |s| {
            s.socket_generation > joined.socket_generation && s.can().add_mix
        })
        .await;
        assert!(!recovered.account.expired);
        let error = recovered.error.clone().unwrap();
        assert_eq!((error.code, error.status), (ErrorCode::Rejected, Some(500)));

        // A refused sign-in (401 from /login) is a credentials error, not an expired session.
        assert!(c.send_native(
            recovered.authority(),
            NativeCommand::Login {
                user: "fixture".into(),
                password: "dummy-wrong-password".into(),
            }
        ));
        request(
            &listener,
            "POST",
            "/prefix/api/user/login",
            "401 Unauthorized",
            r#"{"success":false,"error":{"message":"private"}}"#,
            "",
        )
        .await;
        let _third = socket(&listener, false).await;
        let refused = until(&mut native, |s| {
            s.error
                .as_ref()
                .is_some_and(|e| e.code == ErrorCode::Credentials)
                && s.can().add_mix
        })
        .await;
        assert!(!refused.account.expired && !refused.account.logged_in);

        // A 401 on the account check means the bearer itself was rejected...
        assert!(c.send_native(refused.authority(), NativeCommand::RefreshAccount));
        request(
            &listener,
            "GET",
            "/prefix/api/user/",
            "401 Unauthorized",
            r#"{"success":false}"#,
            "",
        )
        .await;
        let expired = until(&mut native, |s| {
            s.error.as_ref().is_some_and(|e| e.code == ErrorCode::Auth)
        })
        .await;
        assert!(expired.account.expired && !expired.can().add_mix);
        // ...and Refresh room recovers with a fresh guest grant and a new socket.
        assert!(c.send_native(expired.authority(), NativeCommand::RefreshRoom));
        grant(&listener).await;
        let _fourth = socket(&listener, false).await;
        let fresh = until(&mut native, |s| {
            s.socket_generation > expired.socket_generation && s.can().add_mix
        })
        .await;
        assert!(!fresh.account.expired && fresh.error.is_none());

        // Search works again.
        assert!(c.send_native(
            fresh.authority(),
            NativeCommand::SearchMusic {
                input: "after recovery".into(),
                request_id: 1,
            }
        ));
        let mut http = search_socket(&listener, "after recovery").await;
        search_reply(&mut http, json!([{"service":"youtube","id":"recovered"}])).await;
        until(&mut native, |s| {
            s.preview.as_ref().is_some_and(|p| p.items.len() == 1)
        })
        .await;
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn a_search_preempts_a_mood_page_load_and_keeps_partially_valid_results() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let network = Network::new().unwrap();
        let (events, _playback) = async_channel::bounded(16);
        let c = network.connect(
            93,
            RoomAddress::parse(&format!("http://127.0.0.1:{port}/prefix/room/test")).unwrap(),
            events,
        );
        let mut native = c.subscribe_native();
        grant(&listener).await;
        let _first = socket(&listener, false).await;
        let guest = until(&mut native, |s| s.room.active()).await;
        assert!(c.send_native(
            guest.authority(),
            NativeCommand::Login {
                user: "fixture".into(),
                password: "dummy-password".into(),
            }
        ));
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
        let _second = socket(&listener, true).await;
        let logged = until(&mut native, |s| {
            s.account.logged_in && s.can().add_mix && s.can().account_write
        })
        .await;

        // A background mood page holds the HTTP slot, the server stays silent...
        let page = c
            .send_native_ticket(logged.authority(), NativeCommand::LoadMoods { offset: 0 })
            .unwrap();
        let (mut held, _) = listener.accept().await.unwrap();
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            let mut buf = [0; 1024];
            let n = held.read(&mut buf).await.unwrap();
            assert!(n > 0);
            head.extend_from_slice(&buf[..n]);
        }
        assert!(head.starts_with(b"GET /prefix/api/music/moods?limit=100&offset=0 "));
        let loading = until(&mut native, |s| {
            s.http_activity == Some(HttpActivity::Page)
        })
        .await;
        assert!(!loading.search_blocked());

        // ...yet the search starts at once and the page is dropped, not failed.
        let search = c
            .send_native_ticket(
                loading.authority(),
                NativeCommand::SearchMusic {
                    input: "while loading".into(),
                    request_id: 1,
                },
            )
            .unwrap();
        let mut http = search_socket(&listener, "while loading").await;
        let searching = until(&mut native, |s| {
            s.http_activity == Some(HttpActivity::Search)
        })
        .await;
        assert!(searching.settled(page) && !searching.settled(search));
        assert!(!searching.moods.loading && !searching.moods.failed && !searching.moods.loaded);
        assert!(searching.error.is_none());

        // One unreadable item does not throw away the others.
        search_reply(
            &mut http,
            json!([
                {"title":"Kept","service":"youtube","id":"kept-first"},
                {"title":"Broken","service":"youtube","id":"x","originalReference":{"service":"unknown","id":"x"}},
                {"title":"No id"},
                {"title":"Also kept","service":"youtube","id":"kept-second"}
            ]),
        )
        .await;
        let done = until(&mut native, |s| s.settled(search) && s.preview.is_some()).await;
        let ids: Vec<_> = done
            .preview
            .as_ref()
            .unwrap()
            .items
            .iter()
            .map(|p| p.reference.id.clone())
            .collect();
        assert_eq!(ids, ["kept-first", "kept-second"]);
        assert!(done.preview_error.is_none());

        // The dropped page loads again afterwards.
        assert!(c.send_native(done.authority(), NativeCommand::LoadMoods { offset: 0 }));
        request(
            &listener,
            "GET",
            "/prefix/api/music/moods?limit=100&offset=0",
            "200 OK",
            r#"{"items":[],"total":0,"offset":0,"limit":100}"#,
            "",
        )
        .await;
        until(&mut native, |s| s.moods.loaded && !s.http_busy).await;
        drop(held);
    })
    .await
    .unwrap();
}

async fn next_json(ws: &mut WebSocketStream<TcpStream>) -> Value {
    let message = tokio::time::timeout(Duration::from_secs(3), ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    serde_json::from_str(message.to_text().unwrap()).unwrap()
}

/// The guarded `previous` the host page builds for any Previous (as `player.js` does).
fn host_previous(request: &str) -> String {
    json!({"kind":"send","message":{"action":"playback-command","command":{
        "command":"previous","requestId":request,"epoch":"epoch-a","occurrenceId":4,"sequence":12}}})
    .to_string()
}

#[tokio::test(flavor = "current_thread")]
async fn played_tracks_reach_the_state_and_a_played_row_sends_a_stepped_guarded_previous() {
    use std::time::Instant;
    use undertone_desktop::{
        bridge::{HOST_URL, Ipc, PreviousSteps, parse_ipc},
        music::steps_back,
    };
    tokio::time::timeout(Duration::from_secs(15), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let network = Network::new().unwrap();
        let (events, _playback) = async_channel::bounded(8);
        let c = network.connect(
            91,
            RoomAddress::parse(&format!("http://127.0.0.1:{port}/prefix/room/test")).unwrap(),
            events,
        );
        let mut native = c.subscribe_native();
        grant(&listener).await;
        let mut ws = socket(&listener, false).await;
        // The host page's command, then what Rust adds before it reaches the socket.
        let mut steps = PreviousSteps::default();
        let outbound = |steps: &mut PreviousSteps, body: String| {
            let Some(Ipc::Send { message }) = parse_ipc(HOST_URL, &body) else {
                panic!("the host's guarded previous is a valid outbound message");
            };
            steps.apply(1, message, Instant::now())
        };

        // An older server sends no history: nothing to go back to, Previous stays plain.
        let old = until(&mut native, |s| s.room.active()).await;
        assert!(old.room.music.as_ref().unwrap().played.is_empty());
        assert!(old.room.played_tracks.is_empty());
        assert!(c.send(
            old.authority(),
            outbound(&mut steps, host_previous("plain-0"))
        ));
        let sent = next_json(&mut ws).await;
        assert_eq!(sent["command"]["requestId"], "plain-0");
        assert!(sent["command"].get("steps").is_none());

        let entry = |n: u8| {
            json!({"entryId":format!("entry-{n}"),"trackId":format!("track-{n}"),
            "sourceId":"source","contributorId":"me","artists":["Artist"],"origin":"manual",
            "title":format!("Track {n}"),
            "artworkUrl":format!("https://i.ytimg.com/vi/abcdefghi{n:02}/mqdefault.jpg")})
        };
        ws.send(Message::Text(
            json!({"action":"sync","grants":[[0,10]],"previousAvailable":true,
            "playedTracks":[],"music":{"revision":2,"planRevision":2,"queue":[entry(4)],
                "queueTotal":1,"played":[entry(1),entry(2),entry(3)],"current":null,
                "settings":{},"participants":[{"participantId":"me","clientIds":["self"],
                    "includeMoodIds":[],"excludeMoodIds":[]}]}})
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
        let state = until(&mut native, |s| {
            s.room.music.as_ref().is_some_and(|m| m.played.len() == 3)
        })
        .await;
        let played = &state.room.music.as_ref().unwrap().played;
        assert_eq!(played[0].title.as_deref(), Some("Track 1"));
        assert_eq!(
            played[2].artwork_url.as_deref(),
            Some("https://i.ytimg.com/vi/abcdefghi03/mqdefault.jpg")
        );
        assert!(state.room.can_go_back() && state.room.can_previous(0.));

        // Clicking played[1] (oldest first) goes back two tracks, with the host's guards.
        let back = steps_back(played.len(), 1).unwrap();
        assert_eq!(back, 2);
        assert!(steps.arm(1, back, Instant::now()));
        assert!(c.send(
            state.authority(),
            outbound(&mut steps, host_previous("stepped-1"))
        ));
        assert_eq!(
            next_json(&mut ws).await,
            json!({"action":"playback-command","command":{"command":"previous","steps":2,
                "requestId":"stepped-1","epoch":"epoch-a","occurrenceId":4,"sequence":12}})
        );
        // The Previous button right after is plain again: the server may restart the track.
        assert!(c.send(
            state.authority(),
            outbound(&mut steps, host_previous("plain-1"))
        ));
        let sent = next_json(&mut ws).await;
        assert_eq!(sent["command"]["requestId"], "plain-1");
        assert!(sent["command"].get("steps").is_none());
        // The host page itself can never choose how far back to go.
        let mut forged: Value = serde_json::from_str(&host_previous("forged")).unwrap();
        forged["message"]["command"]["steps"] = json!(1);
        assert!(parse_ipc(HOST_URL, &forged.to_string()).is_none());

        // A regular queue publishes its own history; the most recent is one step back.
        ws.send(Message::Text(
            json!({"action":"sync","queueMode":"manual","music":null,
            "playedTracks":[{"service":"youtube","id":"abcdefghijk","title":"Old one"},
                {"service":"vimeo","id":"42","title":"Last one"}],
            "currentSource":{"service":"youtube","id":"zyxwvutsrqp","title":"Now","startAt":0},
            "queue":[{"service":"youtube","id":"kJQP7kiw5Fk","title":"Next"}]})
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
        let regular = until(&mut native, |s| {
            s.room.queue_mode.as_deref() == Some("manual") && s.room.played_tracks.len() == 2
        })
        .await;
        assert_eq!(
            regular.room.played_tracks[1].title.as_deref(),
            Some("Last one")
        );
        assert_eq!(regular.room.upcoming_total, 1);
        assert!(regular.room.can_go_back(), "no Music membership needed");
        let back = steps_back(regular.room.played_tracks.len(), 1).unwrap();
        assert!(steps.arm(1, back, Instant::now()));
        assert!(c.send(
            regular.authority(),
            outbound(&mut steps, host_previous("stepped-2"))
        ));
        let sent = next_json(&mut ws).await;
        assert_eq!(
            (&sent["command"]["requestId"], &sent["command"]["steps"]),
            (&json!("stepped-2"), &json!(1))
        );
        // Vote-skip closes going back, like the Previous button.
        ws.send(Message::Text(
            json!({"action":"sync","enableVoteSkip":true,"previousAvailable":false})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
        let voting = until(&mut native, |s| s.room.vote_skip).await;
        assert!(!voting.room.can_go_back() && !voting.room.can_previous(60.));
        assert!(
            tokio::time::timeout(Duration::from_millis(100), ws.next())
                .await
                .is_err(),
            "nothing else leaves"
        );
    })
    .await
    .unwrap();
}
