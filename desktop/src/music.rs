//! Native-only music DTOs and room command authority. Never serialize these to the player host.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

pub const ICON_KEYS: &[&str] = &[
    "heart",
    "headphones",
    "bolt",
    "sun",
    "cloud-rain",
    "moon",
    "sparkles",
    "coffee",
    "flame",
];

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Mood {
    pub id: String,
    pub name: String,
    pub normalized_name: String,
    pub icon_key: String,
}

pub fn default_moods() -> Vec<Mood> {
    [
        ("like", "heart"),
        ("focus", "headphones"),
        ("energetic", "bolt"),
        ("happy", "sun"),
        ("sad", "cloud-rain"),
    ]
    .iter()
    .enumerate()
    .map(|(i, (name, icon))| Mood {
        id: format!("00000000-0000-4000-8000-{:012}", i + 1),
        name: (*name).into(),
        normalized_name: (*name).into(),
        icon_key: (*icon).into(),
    })
    .collect()
}

pub fn uuid(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub entry_id: String,
    pub track_id: String,
    pub source_id: String,
    pub contributor_id: String,
    pub artists: Vec<String>,
    pub origin: String,
    pub request_id: Option<String>,
    pub title: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Current {
    #[serde(flatten)]
    pub entry: Entry,
    pub playback_id: String,
    pub started: bool,
    pub contributor_mood_ids: Vec<String>,
    pub contributor_moods: Vec<Mood>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Participant {
    pub participant_id: String,
    pub include_mood_ids: Vec<String>,
    pub exclude_mood_ids: Vec<String>,
    pub name: Option<String>,
    #[serde(default)]
    pub client_ids: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fair_share: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_admit_on_join: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remove_departed_entries: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomMusic {
    pub revision: u64,
    pub plan_revision: u64,
    pub queue: Vec<Entry>,
    pub queue_total: usize,
    pub current: Option<Current>,
    pub participants: Vec<Participant>,
    #[serde(default)]
    pub rule_moods: Vec<Mood>,
    pub settings: Settings,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub participant_id: String,
    pub mood_id: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictDetail {
    pub participant_id: String,
    pub mood_id: String,
    pub mood: Option<Mood>,
    pub participant_name: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub request_id: String,
    pub entry_id: String,
    pub track_id: String,
    pub intent: Intent,
    pub status: String,
    pub conflicts: Vec<Conflict>,
    pub title: Option<String>,
    #[serde(default)]
    pub conflict_metadata: Vec<ConflictDetail>,
}
impl Request {
    pub fn can_confirm(&self) -> bool {
        self.status == "pending"
            && uuid(&self.track_id)
            && !self.conflicts.is_empty()
            && self.conflicts.len() <= 1000
            && self.conflicts.iter().all(|c| {
                self.conflict_metadata.iter().any(|d| {
                    d.participant_id == c.participant_id
                        && d.mood_id == c.mood_id
                        && d.participant_name
                            .as_ref()
                            .is_some_and(|n| !n.trim().is_empty())
                        && d.mood
                            .as_ref()
                            .is_some_and(|m| m.id == c.mood_id && !m.name.trim().is_empty())
                })
            })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Intent {
    Mix,
    Next,
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Content {
    Keep,
    Renew,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Reference {
    pub service: String,
    pub id: String,
}
impl Reference {
    pub fn valid(&self) -> bool {
        // Only the server's supported provider discriminators, never an arbitrary request URL.
        matches!(
            self.service.as_str(),
            "youtube"
                | "vimeo"
                | "direct"
                | "hls"
                | "dash"
                | "tubi"
                | "reddit"
                | "googledrive"
                | "pluto"
                | "invidious"
                | "odysee"
                | "peertube"
        ) && !self.id.is_empty()
            && self.id.len() <= 2048
    }
}

#[derive(Clone, Debug)]
pub enum MusicCommand {
    Preferences {
        include: Vec<String>,
        exclude: Vec<String>,
        content: Content,
    },
    Settings(Settings),
    RequestPreview {
        request_id: String,
        intent: Intent,
    },
    Confirm,
    Cancel {
        request_id: String,
    },
    Queue {
        offset: usize,
    },
    Requests {
        offset: usize,
    },
    Retry,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MusicStatus {
    Applied,
    Duplicate,
    ConfirmationRequired,
    RevisionConflict,
    SlotConflict,
    RequestConflict,
    SourceUnavailable,
    InvalidConfirmation,
    NotFound,
    Rejected,
    Uncertain,
    Stale,
    Busy,
    Unavailable,
}
impl MusicStatus {
    fn parse(value: &str) -> Self {
        match value {
            "applied" => Self::Applied,
            "duplicate" => Self::Duplicate,
            "confirmation-required" => Self::ConfirmationRequired,
            "revision-conflict" => Self::RevisionConflict,
            "slot-conflict" => Self::SlotConflict,
            "request-conflict" => Self::RequestConflict,
            "source-unavailable" => Self::SourceUnavailable,
            "invalid-confirmation" => Self::InvalidConfirmation,
            "not-found" => Self::NotFound,
            _ => Self::Rejected,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
    pub loaded: bool,
    pub stale: bool,
    pub loading: bool,
    pub failed: bool,
}
impl<T> Default for Page<T> {
    fn default() -> Self {
        Self {
            items: vec![],
            total: 0,
            offset: 0,
            limit: 100,
            loaded: false,
            stale: false,
            loading: false,
            failed: false,
        }
    }
}
impl<T> Page<T> {
    fn begin(&mut self, offset: usize, limit: usize) {
        *self = Self {
            offset,
            limit,
            loading: true,
            ..Self::default()
        };
    }
    pub fn complete(&self) -> bool {
        self.loaded
            && !self.stale
            && !self.loading
            && !self.failed
            && self.offset == 0
            && self.items.len() >= self.total
    }
    pub fn has_more(&self) -> bool {
        self.loaded
            && !self.stale
            && !self.loading
            && !self.failed
            && self.next_offset() < self.total
            && self.next_offset() <= 10000
    }
    pub fn next_offset(&self) -> usize {
        self.offset + self.items.len()
    }
}

#[derive(Clone, Debug, Default)]
pub struct Can {
    pub preferences: bool,
    pub add_mix: bool,
    pub add_next: bool,
    pub settings: bool,
    pub confirm: bool,
    pub account_write: bool,
}

#[derive(Clone, Debug, Default)]
pub struct RoomState {
    pub name: Option<String>,
    pub title: Option<String>,
    pub queue_mode: Option<String>,
    pub own_client_id: Option<String>,
    pub own_name: Option<String>,
    pub own_role: Option<i64>,
    pub own_logged_in: Option<bool>,
    /// Only a catalogue UUID is retained from legacy currentSource; no source URL/provider payload.
    pub catalogue_track_id: Option<String>,
    pub music: Option<RoomMusic>,
    pub revision: u64,
    pub busy: bool,
    pub status: Option<MusicStatus>,
    pub confirmation: Option<Request>,
    pub queue_page: Page<Entry>,
    pub requests_page: Page<Request>,
    pub pending_count: Option<usize>,
    pub retry_available: bool,
    grants: Vec<(i64, u64)>,
    users: BTreeMap<String, User>,
    pending: Option<Pending>,
    retry: Option<Value>,
    counter: u64,
}
#[derive(Clone, Debug, Default)]
struct User {
    name: Option<String>,
    role: Option<i64>,
    logged_in: Option<bool>,
}
#[derive(Clone, Debug)]
struct Pending {
    correlation: String,
    command: Value,
    at: Instant,
    account: u64,
}

impl RoomState {
    /// Explicit same-account refresh cancels outstanding correlations, preserving only retry intent.
    pub(crate) fn refreshed(&self) -> Self {
        let retry = self
            .pending
            .as_ref()
            .filter(|p| !is_read(&p.command) && p.command["action"] != "confirm")
            .map(|p| p.command.clone())
            .or_else(|| self.retry.clone());
        Self {
            retry_available: retry.is_some(),
            status: retry.as_ref().map(|_| MusicStatus::Uncertain),
            retry,
            ..Self::default()
        }
    }
    pub fn own(&self) -> Option<&Participant> {
        let id = self.own_client_id.as_ref()?;
        self.music
            .as_ref()?
            .participants
            .iter()
            .find(|p| p.client_ids.contains(id))
    }
    pub fn active(&self) -> bool {
        self.queue_mode.as_deref() == Some("music") && self.own().is_some()
    }
    pub fn can(&self) -> Can {
        // Sync carries already inherited masks. Owner (-1) must never leak into other roles.
        let mask = self
            .own_role
            .and_then(|role| {
                self.grants
                    .iter()
                    .find(|(r, _)| *r == role)
                    .map(|(_, m)| *m)
            })
            .unwrap_or(0);
        let active = self.active();
        Can {
            preferences: active,
            add_mix: active && mask & (1 << 3) != 0,
            add_next: active && mask & ((1 << 3) | (1 << 5)) == ((1 << 3) | (1 << 5)),
            settings: active && mask & (1 << 22) != 0,
            confirm: active
                && self.confirmation.as_ref().is_some_and(|r| {
                    r.can_confirm()
                        && mask & (1 << 3) != 0
                        && (r.intent != Intent::Next || mask & (1 << 5) != 0)
                }),
            account_write: false,
        }
    }
    pub fn track_id(&self) -> Option<&str> {
        if self.queue_mode.as_deref() == Some("music") {
            self.music
                .as_ref()?
                .current
                .as_ref()
                .map(|c| c.entry.track_id.as_str())
                .filter(|id| uuid(id))
        } else {
            self.catalogue_track_id.as_deref()
        }
    }
    pub fn public_moods(&self) -> Vec<Mood> {
        let mut map: BTreeMap<_, _> = default_moods()
            .into_iter()
            .map(|m| (m.id.clone(), m))
            .collect();
        if let Some(music) = &self.music {
            for m in music.rule_moods.iter().chain(
                music
                    .current
                    .iter()
                    .flat_map(|c| c.contributor_moods.iter()),
            ) {
                map.insert(m.id.clone(), m.clone());
            }
        }
        map.into_values().collect()
    }
    pub(crate) fn project(&mut self, message: &Value, account: u64) {
        match message["action"].as_str() {
            Some("sync") => {
                let old_revision = self.revision;
                if let Some(v) = message.get("currentSource") {
                    self.catalogue_track_id = v["trackId"]
                        .as_str()
                        .filter(|id| uuid(id))
                        .map(str::to_owned);
                }
                if let Some(v) = message.get("name") {
                    self.name = v.as_str().map(str::to_owned);
                }
                if let Some(v) = message.get("title") {
                    self.title = v.as_str().map(str::to_owned);
                }
                if let Some(v) = message.get("queueMode") {
                    self.queue_mode = v.as_str().map(str::to_owned);
                }
                if let Some(v) = message.get("grants") {
                    self.grants = serde_json::from_value(v.clone()).unwrap_or_default();
                }
                if let Some(v) = message.get("music") {
                    if v.is_null() {
                        self.music = None;
                        self.revision = 0;
                        self.queue_page = Page::default();
                        self.requests_page = Page::default();
                        self.pending_count = None;
                        self.cancel_pending();
                    } else if let Ok(mut music) = serde_json::from_value::<RoomMusic>(v.clone())
                        && music.revision >= self.revision
                    {
                        music.queue.truncate(10);
                        self.revision = music.revision;
                        self.music = Some(music);
                    }
                }
                if !self.active() {
                    self.cancel_pending();
                }
                if self.revision > old_revision {
                    self.invalidate_pages();
                    self.confirmation = None;
                }
            }
            Some("you") => {
                self.own_client_id = message["info"]["id"].as_str().map(str::to_owned);
                self.update_own();
            }
            Some("user") => {
                let update = &message["update"];
                match update["kind"].as_str() {
                    Some("init") => {
                        self.users.clear();
                        if let Some(users) = update["value"].as_array() {
                            for user in users.iter().take(1024) {
                                self.update_user(user);
                            }
                        }
                    }
                    Some("update") => self.update_user(&update["value"]),
                    Some("remove") => {
                        if let Some(id) = update["value"].as_str() {
                            self.users.remove(id);
                        }
                    }
                    _ => (),
                }
                self.update_own();
            }
            Some("music-result") => self.result(&message["result"], account),
            _ => (),
        }
    }
    fn update_user(&mut self, v: &Value) {
        let Some(id) = v["id"].as_str().filter(|id| id.len() <= 256) else {
            return;
        };
        if !self.users.contains_key(id) && self.users.len() >= 1024 {
            return;
        }
        let user = self.users.entry(id.into()).or_default();
        if let Some(v) = v.get("name") {
            user.name = v.as_str().filter(|s| s.len() <= 256).map(str::to_owned);
        }
        if let Some(v) = v.get("role") {
            user.role = v.as_i64().filter(|r| (-1..=4).contains(r));
        }
        if let Some(v) = v.get("isLoggedIn") {
            user.logged_in = v.as_bool();
        }
    }
    fn update_own(&mut self) {
        let user = self
            .own_client_id
            .as_ref()
            .and_then(|id| self.users.get(id));
        self.own_name = user.and_then(|u| u.name.clone());
        self.own_role = user.and_then(|u| u.role);
        self.own_logged_in = user.and_then(|u| u.logged_in);
    }
    fn invalidate_pages(&mut self) {
        self.queue_page.stale = true;
        self.requests_page.stale = true;
    }
    fn cancel_pending(&mut self) {
        self.pending = None;
        self.busy = false;
        self.retry = None;
        self.retry_available = false;
        self.confirmation = None;
    }
    pub(crate) fn expire(&mut self, now: Instant) {
        if self
            .pending
            .as_ref()
            .is_some_and(|p| now.duration_since(p.at) >= Duration::from_secs(20))
        {
            let pending = self.pending.take().unwrap();
            if is_read(&pending.command) {
                self.finish_read(&pending.command, true);
            }
            self.busy = false;
            self.status = Some(MusicStatus::Uncertain);
            if !is_read(&pending.command) && pending.command["action"] != "confirm" {
                self.retry = Some(pending.command);
                self.retry_available = true;
            }
        }
    }
    pub(crate) fn prepare(
        &mut self,
        command: MusicCommand,
        preview: Option<&Reference>,
        account: u64,
        generation: u64,
        socket: u64,
    ) -> Option<Value> {
        if !self.active() {
            self.status = Some(MusicStatus::Unavailable);
            return None;
        }
        if self.pending.is_some() {
            self.status = Some(MusicStatus::Busy);
            return None;
        }
        let can = self.can();
        let value = match command {
            MusicCommand::Preferences {
                include,
                exclude,
                content,
            } if include.len() <= 100
                && exclude.len() <= 100
                && include.iter().chain(&exclude).all(|id| uuid(id))
                && !include.iter().any(|id| exclude.contains(id)) =>
            {
                json!({"action":"preferences","includeMoodIds":include,"excludeMoodIds":exclude,"content":content})
            }
            MusicCommand::Settings(settings) if can.settings => {
                json!({"action":"settings","settings":settings})
            }
            MusicCommand::RequestPreview { request_id, intent }
                if valid_id(&request_id, 128)
                    && (if intent == Intent::Next {
                        can.add_next
                    } else {
                        can.add_mix
                    }) =>
            {
                let Some(reference) = preview.filter(|r| r.valid()) else {
                    self.status = Some(MusicStatus::Unavailable);
                    return None;
                };
                json!({"action":"request","requestId":request_id,"reference":reference,"intent":intent})
            }
            MusicCommand::Confirm => {
                let Some(offer) = self.confirmation.as_ref().filter(|r| r.can_confirm()) else {
                    self.status = Some(MusicStatus::InvalidConfirmation);
                    return None;
                };
                if !(if offer.intent == Intent::Next {
                    can.add_next
                } else {
                    can.add_mix
                }) {
                    self.status = Some(MusicStatus::Rejected);
                    return None;
                }
                json!({"action":"confirm","requestId":offer.request_id,"trackId":offer.track_id,"conflicts":offer.conflicts})
            }
            MusicCommand::Cancel { request_id } if valid_id(&request_id, 256) => {
                json!({"action":"cancel","requestId":request_id})
            }
            MusicCommand::Queue { offset } if offset <= 10000 => {
                json!({"action":"queue","offset":offset,"limit":25})
            }
            MusicCommand::Requests { offset } if offset <= 10000 => {
                json!({"action":"requests","filter":"pending","offset":offset,"limit":25})
            }
            MusicCommand::Retry => {
                let value = self.retry.take()?;
                if !self.allowed_value(&value) {
                    self.status = Some(MusicStatus::Rejected);
                    return None;
                }
                value
            }
            _ => {
                self.status = Some(MusicStatus::Rejected);
                return None;
            }
        };
        self.counter += 1;
        let correlation = format!("native-{generation}-{socket}-{account}-{}", self.counter);
        let mut wire = value.clone();
        if is_read(&value) {
            let offset = value["offset"].as_u64().unwrap() as usize;
            if value["action"] == "queue" {
                self.queue_page.begin(offset, 25);
            } else {
                self.requests_page.begin(offset, 25);
            }
        }
        wire["expectedRevision"] = json!(self.revision);
        wire["correlationId"] = json!(correlation);
        self.pending = Some(Pending {
            correlation,
            command: value,
            at: Instant::now(),
            account,
        });
        self.busy = true;
        self.status = None;
        self.retry = None;
        self.retry_available = false;
        Some(json!({"action":"req","request":{"type":20,"command":wire}}))
    }
    fn allowed_value(&self, v: &Value) -> bool {
        let c = self.can();
        match v["action"].as_str() {
            Some("request") => {
                if v["intent"] == "next" {
                    c.add_next
                } else {
                    c.add_mix
                }
            }
            // Confirmation must always use the latest server offer, through Confirm.
            Some("confirm") => false,
            Some("settings") => c.settings,
            Some("preferences" | "cancel") => c.preferences,
            _ => false,
        }
    }
    fn result(&mut self, result: &Value, account: u64) {
        let Some(p) = &self.pending else {
            return;
        };
        if p.account != account || result["correlationId"] != p.correlation {
            return;
        }
        let Some(revision) = result["revision"].as_u64() else {
            return;
        };
        let p = self.pending.take().unwrap();
        self.busy = false;
        let stale = revision < self.revision;
        self.revision = self.revision.max(revision);
        let status = MusicStatus::parse(result["status"].as_str().unwrap_or("rejected"));
        if is_read(&p.command) {
            self.finish_read(&p.command, stale || status != MusicStatus::Applied);
        }
        self.status = Some(if stale && is_read(&p.command) {
            MusicStatus::Stale
        } else {
            status
        });
        if !stale {
            self.pending_count = result["pendingCount"]
                .as_u64()
                .map(|n| n as usize)
                .or(self.pending_count);
            if let Ok(offer) = serde_json::from_value::<Request>(result["request"].clone()) {
                self.confirmation =
                    (offer.status == "pending" && !offer.conflicts.is_empty()).then_some(offer);
            } else if !is_read(&p.command) {
                self.confirmation = None;
            }
            if status == MusicStatus::Applied && is_read(&p.command) {
                if p.command["action"] == "queue" {
                    if let Some(page) = parse_page::<Entry>(&result["page"], 25)
                        .filter(|p| p.offset == self.queue_page.offset && p.limit == 25)
                    {
                        self.queue_page = page;
                    } else {
                        self.queue_page.failed = true;
                        self.status = Some(MusicStatus::Rejected);
                    }
                } else if let Some(page) = parse_page::<Request>(&result["page"], 25)
                    .filter(|p| p.offset == self.requests_page.offset && p.limit == 25)
                {
                    self.confirmation = page
                        .items
                        .iter()
                        .find(|r| r.status == "pending" && !r.conflicts.is_empty())
                        .cloned();
                    self.requests_page = page;
                } else {
                    self.requests_page.failed = true;
                    self.status = Some(MusicStatus::Rejected);
                }
            }
        }
        if !is_read(&p.command) {
            self.invalidate_pages();
            if !matches!(
                status,
                MusicStatus::Applied | MusicStatus::Duplicate | MusicStatus::ConfirmationRequired
            ) {
                self.retry_available = p.command["action"] != "confirm";
                self.retry = self.retry_available.then_some(p.command);
            }
        }
    }
    fn finish_read(&mut self, command: &Value, failed: bool) {
        if command["action"] == "queue" {
            self.queue_page.loading = false;
            self.queue_page.failed = failed;
        } else {
            self.requests_page.loading = false;
            self.requests_page.failed = failed;
        }
    }
}
fn is_read(v: &Value) -> bool {
    matches!(v["action"].as_str(), Some("queue" | "requests"))
}
fn valid_id(v: &str, max: usize) -> bool {
    !v.is_empty() && v.len() <= max && !v.chars().any(char::is_control)
}

pub(crate) fn parse_page<T: serde::de::DeserializeOwned>(v: &Value, max: usize) -> Option<Page<T>> {
    let items: Vec<T> = serde_json::from_value(v["items"].clone()).ok()?;
    let limit = usize::try_from(v["limit"].as_u64()?).ok()?;
    let offset = usize::try_from(v["offset"].as_u64()?).ok()?;
    let total = usize::try_from(v["total"].as_u64()?).ok()?;
    if limit == 0
        || limit > max
        || items.len() > limit
        || offset > 10000
        || items.len() > total.saturating_sub(offset)
    {
        return None;
    }
    Some(Page {
        items,
        limit,
        offset,
        total,
        loaded: true,
        stale: false,
        loading: false,
        failed: false,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActiveTag {
    Active,
    Inactive,
    Unknown,
}
#[derive(Clone, Debug)]
pub struct MoodChip {
    pub mood: Mood,
    pub active: ActiveTag,
}
#[derive(Clone, Debug, Default)]
pub struct MoodGroups {
    pub priority: Vec<MoodChip>,
    pub complement: Vec<MoodChip>,
}
pub fn mood_groups(room: &RoomState, tags: &Page<Mood>, favorites: &Page<Mood>) -> MoodGroups {
    let priority = room
        .music
        .as_ref()
        .and_then(|m| m.current.as_ref())
        .map(|c| c.contributor_moods.clone())
        .unwrap_or_default();
    let active = |m: &Mood| {
        if tags.loaded
            && !tags.stale
            && !tags.loading
            && !tags.failed
            && tags.items.iter().any(|t| t.id == m.id)
        {
            ActiveTag::Active
        } else if tags.complete() {
            ActiveTag::Inactive
        } else {
            ActiveTag::Unknown
        }
    };
    let mut complement: BTreeMap<String, Mood> = BTreeMap::new();
    for m in tags.items.iter().chain(&favorites.items) {
        if !priority.iter().any(|p| p.id == m.id) {
            complement.insert(m.id.clone(), m.clone());
        }
    }
    MoodGroups {
        priority: priority
            .into_iter()
            .map(|m| MoodChip {
                active: active(&m),
                mood: m,
            })
            .collect(),
        complement: complement
            .into_values()
            .map(|m| MoodChip {
                active: active(&m),
                mood: m,
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    pub fn room() -> RoomState {
        let mut room = RoomState::default();
        room.project(&json!({"action":"sync","queueMode":"music","grants":[[-1,67108863],[0,8]],"music":{
            "revision":3,"planRevision":3,"queue":[],"queueTotal":0,"current":null,"settings":{},
            "participants":[{"participantId":"guest:one","includeMoodIds":[],"excludeMoodIds":[],"clientIds":["client"],"name":"Guest"}]
        }}),0);
        room.project(&json!({"action":"user","update":{"kind":"update","value":{"id":"client","name":"Guest","role":0,"isLoggedIn":false,"token":"secret-user-field"}}}),0);
        room.project(
            &json!({"action":"you","info":{"id":"client","token":"secret-you-field"}}),
            0,
        );
        room
    }
    #[test]
    fn projection_merges_presence_and_orders_identity_without_private_fields() {
        let mut r = room();
        assert_eq!(r.own_name.as_deref(), Some("Guest"));
        assert!(r.own().is_some());
        assert!(r.can().add_mix);
        assert!(!r.can().add_next, "owner grant must not leak to guests");
        let debug = format!("{r:?}");
        assert!(!debug.contains("secret-"));
        r.project(
            &json!({"action":"sync","playbackPosition":7,"token":"ignored"}),
            0,
        );
        assert_eq!(r.music.as_ref().unwrap().revision, 3);
        r.project(&json!({"action":"sync","music":null}), 0);
        assert!(r.music.is_none());
        assert!(!r.active());
    }
    #[test]
    fn guest_preferences_are_scoped_and_requests_require_grants_and_preview() {
        let mut r = room();
        let id = default_moods()[0].id.clone();
        assert!(
            r.prepare(
                MusicCommand::Preferences {
                    include: vec![id.clone()],
                    exclude: vec![id.clone()],
                    content: Content::Keep
                },
                None,
                0,
                1,
                0
            )
            .is_none()
        );
        let wire = r
            .prepare(
                MusicCommand::Preferences {
                    include: vec![id],
                    exclude: vec![],
                    content: Content::Keep,
                },
                None,
                0,
                1,
                0,
            )
            .unwrap();
        assert_eq!(wire["request"]["type"], 20);
        assert!(wire["request"]["command"].get("participantId").is_none());
        assert!(
            r.prepare(MusicCommand::Queue { offset: 0 }, None, 0, 1, 0)
                .is_none()
        );
        let p = r.pending.as_ref().unwrap().clone();
        r.result(
            &json!({"correlationId":p.correlation,"revision":4,"status":"applied"}),
            1,
        );
        assert!(r.busy, "stale account reply must be ignored");
        r.result(
            &json!({"correlationId":"wrong","revision":100,"status":"applied"}),
            0,
        );
        assert_eq!(r.revision, 3);
        r.result(
            &json!({"correlationId":p.correlation,"revision":4,"status":"applied"}),
            0,
        );
        assert!(!r.busy);
        assert_eq!(r.revision, 4);
        let reference = Reference {
            service: "youtube".into(),
            id: "stable".into(),
        };
        assert!(
            r.prepare(
                MusicCommand::RequestPreview {
                    request_id: "next".into(),
                    intent: Intent::Next
                },
                Some(&reference),
                0,
                1,
                0
            )
            .is_none()
        );
        assert!(
            r.prepare(
                MusicCommand::RequestPreview {
                    request_id: "mix".into(),
                    intent: Intent::Mix
                },
                None,
                0,
                1,
                0
            )
            .is_none()
        );
    }
    #[test]
    fn timeout_is_uncertain_and_explicit_retry_keeps_request_identity() {
        let mut r = room();
        let reference = Reference {
            service: "invidious".into(),
            id: "original".into(),
        };
        let first = r
            .prepare(
                MusicCommand::RequestPreview {
                    request_id: "stable-request".into(),
                    intent: Intent::Mix,
                },
                Some(&reference),
                0,
                1,
                0,
            )
            .unwrap();
        r.expire(Instant::now() + Duration::from_secs(21));
        assert_eq!(r.status, Some(MusicStatus::Uncertain));
        let retry = r.prepare(MusicCommand::Retry, None, 0, 1, 0).unwrap();
        assert_eq!(retry["request"]["command"]["requestId"], "stable-request");
        assert_eq!(
            retry["request"]["command"]["reference"],
            first["request"]["command"]["reference"]
        );
        assert_ne!(
            retry["request"]["command"]["correlationId"],
            first["request"]["command"]["correlationId"]
        );
        r.result(&json!({"correlationId":first["request"]["command"]["correlationId"],"revision":9,"status":"applied"}),0);
        assert!(r.busy);
        r.result(&json!({"correlationId":retry["request"]["command"]["correlationId"],"revision":5,"status":"revision-conflict"}),0);
        assert!(!r.busy);
        assert_eq!(r.revision, 5);
        assert!(r.pending.is_none());
    }
    #[test]
    fn confirmation_uses_only_latest_authoritative_pairs() {
        let mut r = room();
        let mood = default_moods()[0].clone();
        let offer = json!({"requestId":"mine","entryId":"entry","trackId":mood.id,"intent":"mix","status":"pending",
            "conflicts":[{"participantId":"other","moodId":mood.id}],"conflictMetadata":[]});
        r.confirmation = Some(serde_json::from_value(offer.clone()).unwrap());
        assert!(r.prepare(MusicCommand::Confirm, None, 0, 1, 0).is_none());
        let mut full = offer;
        full["conflictMetadata"] = json!([{"participantId":"other","moodId":mood.id,"participantName":"Actual person","mood":{"id":mood.id,"name":"like","normalizedName":"like","iconKey":"heart"}}]);
        r.confirmation = Some(serde_json::from_value(full).unwrap());
        let wire = r.prepare(MusicCommand::Confirm, None, 0, 1, 0).unwrap();
        assert_eq!(
            wire["request"]["command"]["conflicts"],
            json!([{"participantId":"other","moodId":mood.id}])
        );
        let id = wire["request"]["command"]["correlationId"].clone();
        r.result(&json!({"correlationId":id,"revision":4,"status":"confirmation-required","request":{"requestId":"mine","entryId":"entry","trackId":mood.id,"intent":"mix","status":"pending","conflicts":[{"participantId":"new","moodId":mood.id}]}}),0);
        assert_eq!(
            r.confirmation.as_ref().unwrap().conflicts[0].participant_id,
            "new"
        );
        assert!(!r.can().confirm);
    }
    #[test]
    fn late_pages_cannot_replace_newer_sync_and_modes_gate_writes() {
        let mut r = room();
        let wire = r
            .prepare(MusicCommand::Queue { offset: 0 }, None, 0, 1, 0)
            .unwrap();
        r.revision = 5;
        r.result(&json!({"correlationId":wire["request"]["command"]["correlationId"],"revision":4,"status":"applied","page":{"items":[],"total":0,"offset":0,"limit":25}}),0);
        assert_eq!(r.status, Some(MusicStatus::Stale));
        assert!(!r.queue_page.loaded);
        r.project(&json!({"action":"sync","queueMode":"manual"}), 0);
        assert!(
            r.prepare(MusicCommand::Queue { offset: 0 }, None, 0, 1, 0)
                .is_none()
        );
    }
    #[test]
    fn partial_tag_pages_mean_unknown_and_only_own_tags_mean_active() {
        let mut tags = Page::default();
        let favorites = Page {
            items: default_moods(),
            total: 5,
            loaded: true,
            ..Page::default()
        };
        let groups = mood_groups(&room(), &tags, &favorites);
        assert!(
            groups
                .complement
                .iter()
                .all(|c| c.active == ActiveTag::Unknown)
        );
        tags.loaded = true;
        tags.total = 0;
        let groups = mood_groups(&room(), &tags, &favorites);
        assert!(
            groups
                .complement
                .iter()
                .all(|c| c.active == ActiveTag::Inactive)
        );
        tags.items = vec![default_moods()[0].clone()];
        tags.total = 200;
        assert_eq!(
            mood_groups(&room(), &tags, &favorites)
                .complement
                .iter()
                .filter(|c| c.active == ActiveTag::Active)
                .count(),
            1
        );
    }
}
