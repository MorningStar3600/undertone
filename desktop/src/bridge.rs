//! This is a source/lifecycle observer, not a second timeline/clock implementation.
use serde::Deserialize;
use serde_json::Value;
use url::Url;

pub const HOST_URL: &str = "http://undertone.localhost/index.html";
pub const MAX_MESSAGE: usize = 256 * 1024;
const MAX_COUNTER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomAddress {
    pub grant: Url,
    pub socket: Url,
}

impl RoomAddress {
    pub fn parse(input: &str) -> Option<Self> {
        if input.len() > 8192 {
            return None;
        }
        let mut url = Url::parse(input.trim()).ok()?;
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return None;
        }
        let path = url.path().trim_end_matches('/');
        let (base, room) = path.rsplit_once("/room/")?;
        if room.is_empty() || room.contains('/') || base.contains("/room/") {
            return None;
        }
        // Keep room percent-encoding intact; never concatenate user input into script/HTML.
        let grant_path = format!("{base}/api/auth/grant");
        let socket_path = format!("{base}/api/room/{room}");
        url.set_path(&grant_path);
        let grant = url.clone();
        let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
        url.set_scheme(scheme).ok()?;
        url.set_path(&socket_path);
        Some(Self { grant, socket: url })
    }
}

pub fn trusted_host(uri: &str) -> bool {
    uri == HOST_URL
}

fn nonce(value: &Value) -> bool {
    identifier(value, 128)
}
fn identifier(value: &Value, max: usize) -> bool {
    value.as_str().is_some_and(|s| {
        !s.is_empty()
            && s.len() <= max
            && s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._~-".contains(&c))
    })
}
fn counter(value: &Value) -> bool {
    value.as_u64().is_some_and(|n| n <= MAX_COUNTER)
}
fn keys(value: &Value, allowed: &[&str]) -> bool {
    value.as_object().is_some_and(|v| {
        v.len() == allowed.len() && v.keys().all(|k| allowed.contains(&k.as_str()))
    })
}

/// The browser cannot send auth, URLs, arbitrary socket messages, or invoke Rust methods.
pub fn allowed_outbound(value: &Value) -> bool {
    match value["action"].as_str() {
        Some("clock-probe") => {
            keys(value, &["action", "generation", "nonce"])
                && counter(&value["generation"])
                && nonce(&value["nonce"])
        }
        Some("playback-subscribe") => {
            keys(value, &["action", "version", "nonce"])
                && value["version"] == 1
                && nonce(&value["nonce"])
        }
        Some("playback-command") => {
            let c = &value["command"];
            let extra = match c["command"].as_str() {
                Some("play" | "pause" | "next") => None,
                Some("previous") if counter(&c["sequence"]) => Some("sequence"),
                Some("seek")
                    if c["positionSeconds"]
                        .as_f64()
                        .is_some_and(|n| n.is_finite() && (0.0..=1e9).contains(&n)) =>
                {
                    Some("positionSeconds")
                }
                Some("rate")
                    if c["rate"]
                        .as_f64()
                        .is_some_and(|n| n.is_finite() && (0.1..=16.0).contains(&n)) =>
                {
                    Some("rate")
                }
                _ => return false,
            };
            let mut fields = vec!["command", "requestId", "epoch", "occurrenceId"];
            if let Some(extra) = extra {
                fields.push(extra);
            }
            keys(value, &["action", "command"])
                && keys(c, &fields)
                && nonce(&c["requestId"])
                && nonce(&c["epoch"])
                && counter(&c["occurrenceId"])
                && (c["command"] == "previous" || c["occurrenceId"].as_u64().unwrap_or(0) > 0)
        }
        _ => false,
    }
}

pub fn forwarded(value: &Value) -> bool {
    matches!(
        value["action"].as_str(),
        Some("playback-snapshot" | "playback-event" | "playback-result" | "clock-reply")
    )
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Ipc {
    Ready,
    Send {
        message: Value,
    },
    State {
        position: f64,
        duration: f64,
        playing: bool,
        available: bool,
    },
    Status {
        code: String,
    },
}

pub fn parse_ipc(uri: &str, body: &str) -> Option<Ipc> {
    if !trusted_host(uri) || body.len() > 16 * 1024 {
        return None;
    }
    let ipc = serde_json::from_str::<Ipc>(body).ok()?;
    match &ipc {
        Ipc::Send { message } if !allowed_outbound(message) => None,
        Ipc::State {
            position, duration, ..
        } if !position.is_finite()
            || !duration.is_finite()
            || !(0.0..=1e9).contains(position)
            || !(0.0..=1e9).contains(duration) =>
        {
            None
        }
        Ipc::Status { code }
            if !matches!(
                code.as_str(),
                "waiting-snapshot"
                    | "waiting-clock"
                    | "recovering"
                    | "idle"
                    | "loading"
                    | "playing"
                    | "paused"
                    | "buffering"
                    | "autoplay-blocked"
                    | "unsupported-rate"
                    | "error"
                    | "disposed"
                    | "commandUnavailable"
            ) =>
        {
            None
        }
        _ => Some(ipc),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Source {
    pub youtube: bool,
    pub title: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Observation {
    Ignore,
    Capability,
    Source(Option<Source>),
}

#[derive(Default)]
pub struct Observer {
    capable: bool,
    nonce: String,
    epoch: String,
    sequence: u64,
    occurrence: u64,
    media: Value,
    last_event: Option<Value>,
}

impl Observer {
    pub fn new(generation: u64) -> Self {
        Self {
            nonce: format!("desktop-{generation}"),
            ..Self::default()
        }
    }

    pub fn subscribe(&self) -> Value {
        serde_json::json!({"action":"playback-subscribe", "version":1, "nonce":self.nonce})
    }

    pub fn observe(&mut self, message: &Value) -> Result<Observation, &'static str> {
        match message["action"].as_str() {
            Some("playback-capabilities") if !self.capable => {
                if !keys(message, &["action", "version", "recovery"])
                    || message["version"] != 1
                    || message["recovery"] != "snapshot"
                {
                    return Err("protocolRequired");
                }
                self.capable = true;
                Ok(Observation::Capability)
            }
            Some("playback-snapshot")
                if self.capable && !self.nonce.is_empty() && message["nonce"] == self.nonce =>
            {
                let t = &message["timeline"];
                let b = &t["baseline"];
                if t["version"] != 1
                    || !nonce(&t["epoch"])
                    || !counter(&b["sequence"])
                    || !counter(&b["serverTimeMs"])
                    || !counter(&b["lastEffectiveAtMs"])
                    || b["lastEffectiveAtMs"].as_u64() > b["serverTimeMs"].as_u64()
                    || !counter(&b["lastOccurrenceId"])
                {
                    return Err("invalidTimeline");
                }
                // Current server folds all immediate events. Do not invent a Rust scheduler.
                if t["events"]
                    .as_array()
                    .is_none_or(|events| !events.is_empty())
                {
                    return Err("unsupportedTimeline");
                }
                self.epoch = t["epoch"].as_str().unwrap().into();
                self.sequence = b["sequence"].as_u64().unwrap();
                self.last_event = None;
                // Consume the one discovery request; late repeats cannot roll back source identity.
                self.nonce.clear();
                let state = &b["state"];
                if state.is_null() && b.as_object().is_some_and(|b| b.contains_key("state")) {
                    if !message["attachment"].is_null() {
                        return Err("invalidTimeline");
                    }
                    self.occurrence = 0;
                    self.media = Value::Null;
                    return Ok(Observation::Source(None));
                }
                self.occurrence = state["occurrenceId"]
                    .as_u64()
                    .filter(|n| *n > 0 && *n <= MAX_COUNTER)
                    .ok_or("invalidTimeline")?;
                if state["occurrenceId"] != b["lastOccurrenceId"]
                    || self.occurrence > self.sequence
                    || state["isPlaying"].as_bool().is_none()
                    || state["positionSeconds"]
                        .as_f64()
                        .is_none_or(|n| !n.is_finite() || !(0.0..=1e9).contains(&n))
                    || state["rate"]
                        .as_f64()
                        .is_none_or(|n| !n.is_finite() || !(0.1..=16.0).contains(&n))
                {
                    return Err("invalidTimeline");
                }
                self.media = state["media"].clone();
                self.source(&message["attachment"], false)
                    .map(|s| Observation::Source(Some(s)))
            }
            Some("playback-event") if self.capable && !self.epoch.is_empty() => {
                let e = &message["event"];
                if e["epoch"] != self.epoch || !counter(&e["sequence"]) {
                    return Err("invalidTimeline");
                }
                let sequence = e["sequence"].as_u64().unwrap();
                if sequence == self.sequence && self.last_event.as_ref() == Some(message) {
                    return Ok(Observation::Ignore);
                }
                if sequence != self.sequence + 1 {
                    return Err("invalidTimeline");
                }
                self.sequence = sequence;
                self.last_event = Some(message.clone());
                match e["type"].as_str() {
                    Some("clear") => {
                        self.occurrence = 0;
                        self.media = Value::Null;
                        Ok(Observation::Source(None))
                    }
                    Some("source" | "load") => {
                        self.occurrence = e["occurrenceId"]
                            .as_u64()
                            .filter(|n| *n > 0 && *n <= MAX_COUNTER)
                            .ok_or("invalidTimeline")?;
                        self.media = e["media"].clone();
                        self.source(&message["attachment"], true)
                            .map(|s| Observation::Source(Some(s)))
                    }
                    Some("play" | "pause" | "seek" | "rate")
                        if e["occurrenceId"] == self.occurrence =>
                    {
                        Ok(Observation::Ignore)
                    }
                    _ => Err("invalidTimeline"),
                }
            }
            _ => Ok(Observation::Ignore),
        }
    }

    fn source(&self, attachment: &Value, exact: bool) -> Result<Source, &'static str> {
        if attachment["epoch"] != self.epoch
            || attachment["occurrenceId"] != self.occurrence
            || self.media["service"] != "adapter"
            || !identifier(&self.media["id"], 256)
            || attachment["media"] != self.media
            || !counter(&attachment["sequence"])
            || attachment["sequence"]
                .as_u64()
                .is_none_or(|n| n == 0 || n > self.sequence || (exact && n != self.sequence))
        {
            return Err("invalidTimeline");
        }
        let item = &attachment["item"];
        let service = item["service"].as_str().ok_or("invalidTimeline")?;
        let id = item["id"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 8192)
            .ok_or("invalidTimeline")?;
        let youtube = service == "youtube"
            && id.len() == 11
            && id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c));
        Ok(Source {
            youtube,
            title: item["title"]
                .as_str()
                .unwrap_or("")
                .chars()
                .take(300)
                .collect(),
        })
    }
}

/// Both connection and host generations must match, including WebViews replaced in one room.
pub fn current_generation(
    connection: u64,
    host: u64,
    incoming_connection: u64,
    incoming_host: u64,
) -> bool {
    connection == incoming_connection && host == incoming_host
}
