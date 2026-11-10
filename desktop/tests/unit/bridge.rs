use serde_json::{Value, json};
use undertone_desktop::bridge::*;

fn capability() -> Value {
    json!({"action":"playback-capabilities", "version":1, "recovery":"snapshot"})
}
fn snapshot(service: &str) -> Value {
    json!({"action":"playback-snapshot", "nonce":"desktop-1", "timeline":{
        "version":1, "epoch":"epoch", "baseline":{
            "sequence":1, "serverTimeMs":1000, "lastEffectiveAtMs":1000,
            "lastOccurrenceId":1, "state":{
                "occurrenceId":1, "media":{"service":"adapter","id":"mapping"},
                "positionSeconds":0, "isPlaying":false, "rate":1
            }
        }, "events":[]
    }, "attachment":{
        "epoch":"epoch", "sequence":1, "occurrenceId":1,
        "media":{"service":"adapter","id":"mapping"},
        "item":{"service":service,"id":"abcdefghijk","title":"Fixture"}
    }})
}

#[test]
fn room_urls_preserve_subpaths_and_do_not_accept_credentials_or_other_schemes() {
    let address = RoomAddress::parse("http://localhost:3000/ott/room/a%20b").unwrap();
    assert_eq!(
        address.grant.as_str(),
        "http://localhost:3000/ott/api/auth/grant"
    );
    assert_eq!(
        address.socket.as_str(),
        "ws://localhost:3000/ott/api/room/a%20b"
    );
    assert_eq!(
        RoomAddress::parse("https://example.com/room/a")
            .unwrap()
            .socket
            .scheme(),
        "wss"
    );
    for url in [
        "file:///room/a",
        "https://user:password@example.com/room/a",
        "https://example.com/room/a?token=x",
        "http://localhost:3000",
        "https://example.com/room/a/b",
    ] {
        assert!(RoomAddress::parse(url).is_none());
    }
}

#[test]
fn only_allowlisted_typed_playback_messages_can_leave_the_browser() {
    assert!(allowed_outbound(
        &json!({"action":"clock-probe", "generation":1,"nonce":"abc"})
    ));
    assert!(allowed_outbound(
        &json!({"action":"playback-subscribe", "version":1,"nonce":"abc"})
    ));
    for command in [
        json!({"command":"play","requestId":"a","epoch":"e","occurrenceId":1}),
        json!({"command":"seek","requestId":"a","epoch":"e","occurrenceId":1,"positionSeconds":0}),
        json!({"command":"previous","requestId":"a","epoch":"e","occurrenceId":0,"sequence":3}),
    ] {
        assert!(allowed_outbound(
            &json!({"action":"playback-command", "command":command})
        ));
    }
    for message in [
        json!({"action":"auth","token":"fake"}),
        json!({"action":"chat", "message":"x"}),
        json!({"action":"clock-probe", "generation":-1,"nonce":"abc"}),
        json!({"action":"clock-probe", "generation":1,"nonce":"https://evil"}),
        json!({"action":"playback-subscribe", "version":1,"nonce":"abc","url":"https://evil"}),
        json!({"action":"playback-command", "command":{"command":"seek","requestId":"a","epoch":"e","occurrenceId":1,"positionSeconds":-1}}),
        json!({"action":"playback-command", "command":{"command":"next","requestId":"a","epoch":"e","occurrenceId":0}}),
        json!({"action":"playback-command", "command":{"command":"play","requestId":"a","epoch":"e","occurrenceId":1,"actor":"other"}}),
    ] {
        assert!(!allowed_outbound(&message));
    }
}

#[test]
fn iframe_and_stale_host_ipc_are_not_trusted() {
    assert!(matches!(
        parse_ipc(HOST_URL, r#"{"kind":"ready"}"#),
        Some(Ipc::Ready)
    ));
    for origin in [
        "https://www.youtube.com/embed/abcdefghijk",
        "http://undertone.localhost.evil/index.html",
        "http://undertone.localhost/other.html",
        "about:blank",
    ] {
        assert!(parse_ipc(origin, r#"{"kind":"ready"}"#).is_none());
    }
    assert!(
        parse_ipc(
            HOST_URL,
            r#"{"kind":"send","message":{"action":"auth","token":"fake"}}"#
        )
        .is_none()
    );
    assert!(
        parse_ipc(
            HOST_URL,
            r#"{"kind":"state","position":-1,"duration":1,"playing":true,"available":true}"#
        )
        .is_none()
    );
    assert!(
        parse_ipc(
            HOST_URL,
            r#"{"kind":"status","code":"arbitrary untrusted text"}"#
        )
        .is_none()
    );
    assert!(parse_ipc(HOST_URL, &"x".repeat(16385)).is_none());
    assert!(current_generation(2, 5, 2, 5));
    assert!(!current_generation(2, 5, 1, 5));
    assert!(!current_generation(2, 5, 2, 4));
}

#[test]
fn discovery_requires_capability_own_nonce_and_atomic_attachment() {
    let mut observer = Observer::new(1);
    assert_eq!(
        observer.observe(&snapshot("youtube")),
        Ok(Observation::Ignore)
    );
    assert_eq!(observer.observe(&capability()), Ok(Observation::Capability));
    let mut stale = snapshot("youtube");
    stale["nonce"] = json!("desktop-0");
    assert_eq!(observer.observe(&stale), Ok(Observation::Ignore));
    let mut invalid = snapshot("youtube");
    invalid["attachment"]["occurrenceId"] = json!(2);
    assert_eq!(observer.observe(&invalid), Err("invalidTimeline"));
    let mut observer = Observer::new(1);
    observer.observe(&capability()).unwrap();
    assert_eq!(
        observer.observe(&snapshot("youtube")),
        Ok(Observation::Source(Some(Source {
            youtube: true,
            title: "Fixture".into()
        })))
    );
}

#[test]
fn idle_non_youtube_clear_and_reconnect_never_require_a_browser() {
    let mut observer = Observer::new(1);
    assert_eq!(
        observer.observe(&json!({"action":"sync","currentSource":{"service":"youtube"}})),
        Ok(Observation::Ignore)
    );
    observer.observe(&capability()).unwrap();
    assert!(matches!(
        observer.observe(&snapshot("vimeo")),
        Ok(Observation::Source(Some(Source { youtube: false, .. })))
    ));
    let clear = json!({"action":"playback-event", "event":{"type":"clear","epoch":"epoch","sequence":2,"occurrenceId":1,"effectiveAtMs":2000}});
    assert_eq!(observer.observe(&clear), Ok(Observation::Source(None)));
    assert_eq!(observer.observe(&clear), Ok(Observation::Ignore));
    let mut reconnected = Observer::new(2);
    reconnected.observe(&capability()).unwrap();
    assert_eq!(
        reconnected.observe(&snapshot("youtube")),
        Ok(Observation::Ignore)
    );
}

#[test]
fn source_events_use_current_atomic_metadata_and_snapshot_nonces_are_single_use() {
    let mut observer = Observer::new(1);
    observer.observe(&capability()).unwrap();
    observer.observe(&snapshot("youtube")).unwrap();
    let mut source = snapshot("vimeo")["attachment"].clone();
    source["sequence"] = json!(2);
    let event = json!({"action":"playback-event", "event":{
        "type":"source", "epoch":"epoch", "sequence":2, "occurrenceId":1,
        "media":{"service":"adapter", "id":"mapping"}, "effectiveAtMs":2000
    }, "attachment":source});
    assert!(matches!(
        observer.observe(&event),
        Ok(Observation::Source(Some(Source { youtube: false, .. })))
    ));
    assert_eq!(
        observer.observe(&snapshot("youtube")),
        Ok(Observation::Ignore)
    );
    let mut conflict = event.clone();
    conflict["attachment"]["item"]["service"] = json!("youtube");
    assert_eq!(observer.observe(&conflict), Err("invalidTimeline"));
}

#[test]
fn gaps_conflicts_and_future_source_schedules_fail_closed() {
    let mut observer = Observer::new(1);
    observer.observe(&capability()).unwrap();
    observer.observe(&snapshot("youtube")).unwrap();
    assert_eq!(observer.observe(&json!({"action":"playback-event", "event":{"type":"pause","epoch":"epoch","sequence":3,"occurrenceId":1}})), Err("invalidTimeline"));
    let mut observer = Observer::new(1);
    observer.observe(&capability()).unwrap();
    let mut future = snapshot("youtube");
    future["timeline"]["events"] = json!([{"type":"load"}]);
    assert_eq!(observer.observe(&future), Err("unsupportedTimeline"));
    for action in ["auth", "user", "chat", "sync", "playback-capabilities"] {
        assert!(!forwarded(&json!({"action":action})));
    }
}
