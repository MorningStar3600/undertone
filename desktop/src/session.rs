//! Memory-only bearer sessions and bounded native REST. No cookie jar or arbitrary API paths.
use crate::bridge::{MAX_MESSAGE, RoomAddress};
use crate::music::{
    Can, ICON_KEYS, Mood, MoodGroups, MusicCommand, Page, Reference, RoomState, mood_groups,
    parse_page, uuid,
};
use reqwest::{Client, Method, RequestBuilder, StatusCode};
use serde_json::{Value, json};
use std::time::Duration;
use url::{Host, Url};

/// Deliberately not Debug/Serialize: credentials must not enter diagnostics or UI events.
pub enum NativeCommand {
    Login {
        user: String,
        password: String,
    },
    Logout,
    RefreshAccount,
    RefreshRoom,
    Music(MusicCommand),
    PreviewUrl {
        url: String,
    },
    LoadMoods {
        offset: usize,
    },
    LoadFavorites {
        offset: usize,
    },
    LoadTrackMoods {
        track_id: String,
        offset: usize,
    },
    SetTag {
        track_id: String,
        mood_id: String,
        active: bool,
    },
    SetFavorite {
        mood_id: String,
        active: bool,
    },
    CreateMood {
        name: String,
        icon_key: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorCode {
    Network,
    Auth,
    RateLimit,
    Rejected,
    InvalidResponse,
    InvalidInput,
    InsecureCredentials,
    Busy,
    Stale,
    Unavailable,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeError {
    pub code: ErrorCode,
    pub retry_after_seconds: Option<u64>,
}
impl NativeError {
    pub(crate) fn new(code: ErrorCode) -> Self {
        Self {
            code,
            retry_after_seconds: None,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct AccountState {
    pub logged_in: bool,
    pub username: Option<String>,
    pub discord_linked: bool,
    pub known: bool,
    pub expired: bool,
}
#[derive(Clone, Debug)]
pub struct Preview {
    pub title: Option<String>,
    pub reference: Reference,
}
#[derive(Clone, Debug, Default)]
pub struct NativeState {
    pub generation: u64,
    pub account_generation: u64,
    /// Changes on an explicit same-token socket refresh, login or logout.
    pub socket_generation: u64,
    pub connected: bool,
    pub account: AccountState,
    pub room: RoomState,
    pub moods: Page<Mood>,
    pub favorites: Page<Mood>,
    pub tags: Page<Mood>,
    pub tags_track_id: Option<String>,
    pub track_generation: u64,
    pub preview: Option<Preview>,
    pub created_mood: Option<Mood>,
    pub http_busy: bool,
    pub error: Option<NativeError>,
}

/// Capture from the state that produced a control or host, never at send time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CommandAuthority {
    generation: u64,
    account: u64,
    socket: u64,
    track: u64,
}
impl CommandAuthority {
    pub fn matches_session(self, state: &NativeState) -> bool {
        self.generation == state.generation
            && self.account == state.account_generation
            && self.socket == state.socket_generation
    }
    pub(crate) fn matches_native(self, state: &NativeState, command: &NativeCommand) -> bool {
        self.matches_session(state)
            && (!matches!(
                command,
                NativeCommand::SetTag { .. } | NativeCommand::LoadTrackMoods { .. }
            ) || self.track == state.track_generation)
    }
}
impl NativeState {
    pub fn authority(&self) -> CommandAuthority {
        CommandAuthority {
            generation: self.generation,
            account: self.account_generation,
            socket: self.socket_generation,
            track: self.track_generation,
        }
    }
    pub fn can(&self) -> Can {
        let mut can = self.room.can();
        can.account_write =
            self.connected && self.account.logged_in && !self.account.expired && !self.http_busy;
        if !self.connected || self.account.expired {
            return Can {
                account_write: can.account_write,
                ..Can::default()
            };
        }
        can
    }
    pub fn mood_groups(&self) -> MoodGroups {
        mood_groups(&self.room, &self.tags, &self.favorites)
    }
    pub(crate) fn clear_private(&mut self) {
        self.account = AccountState::default();
        self.moods = Page::default();
        self.favorites = Page::default();
        self.tags = Page::default();
        self.tags_track_id = None;
        self.created_mood = None;
        self.preview = None;
    }
    pub(crate) fn track_changed(&mut self) {
        if self.tags_track_id.as_deref() != self.room.track_id() {
            self.track_generation = self.track_generation.wrapping_add(1);
            self.tags = Page::default();
            self.tags_track_id = self.room.track_id().map(str::to_owned);
        }
    }
}

// At most one server origin/base path is retained by Network. Never Debug or Serialize.
#[derive(Default)]
pub(crate) struct SessionCache {
    pub epoch: u64,
    pub key: String,
    pub token: Option<String>,
    pub account: AccountState,
}

pub(crate) fn client() -> Result<Client, NativeError> {
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| NativeError::new(ErrorCode::Network))
}
pub(crate) fn base(address: &RoomAddress) -> Url {
    let mut base = address.grant.clone();
    let path = base
        .path()
        .strip_suffix("auth/grant")
        .expect("RoomAddress contract")
        .to_owned();
    base.set_path(&path);
    base
}
pub(crate) fn credentials_allowed(base: &Url) -> bool {
    base.scheme() == "https"
        || (base.scheme() == "http"
            && match base.host() {
                Some(Host::Domain("localhost")) => true,
                Some(Host::Ipv4(ip)) => ip.is_loopback(),
                Some(Host::Ipv6(ip)) => ip.is_loopback(),
                _ => false,
            })
}

pub(crate) async fn response(builder: RequestBuilder) -> Result<Value, NativeError> {
    bounded_response(builder, MAX_MESSAGE).await
}
async fn bounded_response(builder: RequestBuilder, max: usize) -> Result<Value, NativeError> {
    let mut response = builder
        .send()
        .await
        .map_err(|_| NativeError::new(ErrorCode::Network))?;
    if !response.status().is_success() {
        let code = match response.status() {
            StatusCode::UNAUTHORIZED => ErrorCode::Auth,
            StatusCode::TOO_MANY_REQUESTS => ErrorCode::RateLimit,
            _ => ErrorCode::Rejected,
        };
        return Err(NativeError {
            code,
            retry_after_seconds: response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse().ok()),
        });
    }
    if response
        .content_length()
        .is_some_and(|size| size > max as u64)
    {
        return Err(NativeError::new(ErrorCode::InvalidResponse));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| NativeError::new(ErrorCode::Network))?
    {
        if body.len() + chunk.len() > max {
            return Err(NativeError::new(ErrorCode::InvalidResponse));
        }
        body.extend_from_slice(&chunk);
    }
    let value: Value =
        serde_json::from_slice(&body).map_err(|_| NativeError::new(ErrorCode::InvalidResponse))?;
    if value["success"] == false {
        return Err(NativeError::new(ErrorCode::Rejected));
    }
    Ok(value)
}

pub(crate) async fn grant(client: &Client, address: &RoomAddress) -> Result<String, NativeError> {
    let value = bounded_response(client.get(address.grant.clone()), 16 * 1024).await?;
    value["token"]
        .as_str()
        .filter(|t| !t.is_empty() && t.len() <= 8192 && !t.chars().any(char::is_control))
        .map(str::to_owned)
        .ok_or_else(|| NativeError::new(ErrorCode::InvalidResponse))
}

#[derive(Clone, Debug)]
pub(crate) enum RestKind {
    Login,
    Logout,
    Account,
    Preview,
    Moods(usize),
    Favorites(usize),
    Tags(String, usize),
    Tag(String),
    Favorite,
    Create,
}
impl RestKind {
    pub fn identity(&self) -> bool {
        matches!(self, Self::Login | Self::Logout)
    }
}

/// Returns a prepared, fixed-route request. Login strings are dropped before network I/O starts.
pub(crate) fn prepare(
    client: &Client,
    base: &Url,
    token: &str,
    state: &NativeState,
    command: NativeCommand,
) -> Result<(RestKind, RequestBuilder), NativeError> {
    let invalid = || NativeError::new(ErrorCode::InvalidInput);
    let route = |path: &str| base.join(path).map_err(|_| invalid());
    let auth = |method, path: &str| -> Result<RequestBuilder, NativeError> {
        Ok(client.request(method, route(path)?).bearer_auth(token))
    };
    match command {
        NativeCommand::Login { user, password } => {
            if !credentials_allowed(base) {
                return Err(NativeError::new(ErrorCode::InsecureCredentials));
            }
            if user.trim().is_empty()
                || user.len() > 320
                || password.is_empty()
                || password.len() > 4096
            {
                return Err(invalid());
            }
            let builder =
                auth(Method::POST, "user/login")?.json(&json!({"user":user,"password":password}));
            Ok((RestKind::Login, builder))
        }
        NativeCommand::Logout => Ok((RestKind::Logout, auth(Method::POST, "user/logout")?)),
        NativeCommand::RefreshAccount => Ok((RestKind::Account, auth(Method::GET, "user/")?)),
        NativeCommand::PreviewUrl { url } => {
            if !state.can().add_mix {
                return Err(NativeError::new(ErrorCode::Unavailable));
            }
            if !valid_url(&url) {
                return Err(invalid());
            }
            Ok((
                RestKind::Preview,
                auth(Method::GET, "data/previewAdd")?.query(&[("input", url)]),
            ))
        }
        command => {
            if !state.account.logged_in || state.account.expired {
                return Err(NativeError::new(ErrorCode::Auth));
            }
            let page = |path: &str, offset: usize| -> Result<RequestBuilder, NativeError> {
                if offset > 10000 {
                    return Err(invalid());
                }
                Ok(auth(Method::GET, path)?.query(&[("limit", 100), ("offset", offset)]))
            };
            match command {
                NativeCommand::LoadMoods { offset } => {
                    Ok((RestKind::Moods(offset), page("music/moods", offset)?))
                }
                NativeCommand::LoadFavorites { offset } => Ok((
                    RestKind::Favorites(offset),
                    page("music/favorites", offset)?,
                )),
                NativeCommand::LoadTrackMoods { track_id, offset }
                    if uuid(&track_id) && state.room.track_id() == Some(track_id.as_str()) =>
                {
                    let request = page(&format!("music/tracks/{track_id}/moods"), offset)?;
                    Ok((RestKind::Tags(track_id, offset), request))
                }
                NativeCommand::SetTag {
                    track_id,
                    mood_id,
                    active,
                } if uuid(&track_id)
                    && uuid(&mood_id)
                    && state.room.track_id() == Some(track_id.as_str()) =>
                {
                    let request = auth(
                        if active { Method::PUT } else { Method::DELETE },
                        &format!("music/tracks/{track_id}/moods/{mood_id}"),
                    )?;
                    Ok((RestKind::Tag(track_id), request))
                }
                NativeCommand::SetFavorite { mood_id, active } if uuid(&mood_id) => Ok((
                    RestKind::Favorite,
                    auth(
                        if active { Method::PUT } else { Method::DELETE },
                        &format!("music/favorites/{mood_id}"),
                    )?,
                )),
                NativeCommand::CreateMood { name, icon_key }
                    if !name.trim().is_empty()
                        && name.chars().count() <= 64
                        && !name.chars().any(char::is_control)
                        && ICON_KEYS.contains(&icon_key.as_str()) =>
                {
                    Ok((
                        RestKind::Create,
                        auth(Method::POST, "music/moods")?
                            .json(&json!({"name":name,"iconKey":icon_key})),
                    ))
                }
                _ => Err(invalid()),
            }
        }
    }
}
fn valid_url(input: &str) -> bool {
    input.len() <= 2048
        && Url::parse(input).is_ok_and(|u| {
            matches!(u.scheme(), "https" | "http")
                && u.username().is_empty()
                && u.password().is_none()
                && u.host().is_some()
        })
}

pub(crate) fn apply(
    state: &mut NativeState,
    kind: &RestKind,
    value: Value,
) -> Result<(), NativeError> {
    let invalid = || NativeError::new(ErrorCode::InvalidResponse);
    match kind {
        RestKind::Account | RestKind::Login | RestKind::Logout => {
            let logged_in = value["loggedIn"].as_bool().ok_or_else(invalid)?;
            state.account = AccountState {
                logged_in,
                known: true,
                username: value["username"].as_str().map(str::to_owned),
                discord_linked: value["discordLinked"].as_bool().unwrap_or(false),
                expired: false,
            };
        }
        RestKind::Preview => {
            let items = value["result"].as_array().ok_or_else(invalid)?;
            // Collection/search results need selection UI, deliberately outside this scoped flow.
            if items.len() != 1 {
                return Err(NativeError::new(ErrorCode::Rejected));
            }
            let item = &items[0];
            let reference: Reference =
                serde_json::from_value(item.get("originalReference").unwrap_or(item).clone())
                    .map_err(|_| invalid())?;
            if !reference.valid() {
                return Err(invalid());
            }
            state.preview = Some(Preview {
                title: item["title"].as_str().map(str::to_owned),
                reference,
            });
        }
        RestKind::Moods(offset) => merge_page(&mut state.moods, value, *offset)?,
        RestKind::Favorites(offset) => merge_page(&mut state.favorites, value, *offset)?,
        RestKind::Tags(track, offset) => {
            if state.room.track_id() != Some(track.as_str()) {
                return Err(NativeError::new(ErrorCode::Stale));
            }
            state.tags_track_id = Some(track.clone());
            merge_page(&mut state.tags, value, *offset)?;
        }
        RestKind::Tag(track) => {
            if state.room.track_id() != Some(track.as_str()) {
                return Err(NativeError::new(ErrorCode::Stale));
            }
            state.tags.stale = true;
        }
        RestKind::Favorite => state.favorites.stale = true,
        RestKind::Create => {
            let mood: Mood =
                serde_json::from_value(value["mood"].clone()).map_err(|_| invalid())?;
            if !uuid(&mood.id) || !ICON_KEYS.contains(&mood.icon_key.as_str()) {
                return Err(invalid());
            }
            state.created_mood = Some(mood);
            state.moods.stale = true;
        }
    }
    Ok(())
}
pub(crate) fn start(state: &mut NativeState, kind: &RestKind) {
    let page = match kind {
        RestKind::Moods(offset) => Some((&mut state.moods, *offset)),
        RestKind::Favorites(offset) => Some((&mut state.favorites, *offset)),
        RestKind::Tags(_, offset) => Some((&mut state.tags, *offset)),
        _ => None,
    };
    if let Some((page, offset)) = page {
        if offset == 0 {
            *page = Page::default();
        }
        page.loading = true;
        page.failed = false;
    }
}
pub(crate) fn finish(state: &mut NativeState, kind: &RestKind, failed: bool) {
    let page = match kind {
        RestKind::Moods(_) => Some(&mut state.moods),
        RestKind::Favorites(_) => Some(&mut state.favorites),
        RestKind::Tags(..) => Some(&mut state.tags),
        _ => None,
    };
    if let Some(page) = page {
        page.loading = false;
        page.failed = failed;
    }
}
fn merge_page(target: &mut Page<Mood>, value: Value, offset: usize) -> Result<(), NativeError> {
    let page = parse_page::<Mood>(&value, 100)
        .filter(|p| p.offset == offset)
        .ok_or_else(|| NativeError::new(ErrorCode::InvalidResponse))?;
    if page
        .items
        .iter()
        .any(|m| !uuid(&m.id) || !ICON_KEYS.contains(&m.icon_key.as_str()))
    {
        return Err(NativeError::new(ErrorCode::InvalidResponse));
    }
    if offset == 0 {
        *target = page;
    } else {
        if !target.loaded
            || target.stale
            || offset != target.items.len()
            || target.total != page.total
        {
            return Err(NativeError::new(ErrorCode::Stale));
        }
        for mood in page.items {
            if !target.items.iter().any(|m| m.id == mood.id) {
                target.items.push(mood);
            }
        }
        target.limit = page.limit;
        target.failed = false;
        target.loading = false;
        // Accumulated pages keep offset zero; has_more uses the loaded count below.
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credentials_require_tls_except_literal_loopback() {
        for url in [
            "http://localhost/api/",
            "http://127.0.0.1/api/",
            "http://[::1]/api/",
            "https://remote.example/api/",
        ] {
            assert!(credentials_allowed(&Url::parse(url).unwrap()));
        }
        for url in [
            "http://remote.example/api/",
            "http://localhost.example/api/",
            "http://192.168.1.2/api/",
        ] {
            assert!(!credentials_allowed(&Url::parse(url).unwrap()));
        }
    }
    #[test]
    fn account_routes_cannot_be_selected_by_input_or_used_by_guests() {
        let c = client().unwrap();
        let base = Url::parse("https://example.test/prefix/api/").unwrap();
        let mut state = NativeState::default();
        let id = "00000000-0000-4000-8000-000000000001";
        assert!(
            prepare(
                &c,
                &base,
                "dummy",
                &state,
                NativeCommand::SetFavorite {
                    mood_id: id.into(),
                    active: true
                }
            )
            .is_err()
        );
        state.account.logged_in = true;
        let (_, request) = prepare(
            &c,
            &base,
            "dummy",
            &state,
            NativeCommand::LoadMoods { offset: 100 },
        )
        .unwrap();
        let request = request.build().unwrap();
        assert_eq!(
            request.url().as_str(),
            "https://example.test/prefix/api/music/moods?limit=100&offset=100"
        );
        assert!(
            prepare(
                &c,
                &base,
                "dummy",
                &state,
                NativeCommand::SetFavorite {
                    mood_id: "../user/logout".into(),
                    active: true
                }
            )
            .is_err()
        );
        assert!(
            prepare(
                &c,
                &base,
                "dummy",
                &state,
                NativeCommand::LoadMoods { offset: 10001 }
            )
            .is_err()
        );
        assert!(
            prepare(
                &c,
                &Url::parse("http://example.test/api/").unwrap(),
                "dummy",
                &state,
                NativeCommand::Login {
                    user: "user".into(),
                    password: "dummy-password".into()
                }
            )
            .is_err()
        );
    }
    #[test]
    fn preview_uses_original_reference_and_rejects_collections() {
        let mut state = NativeState::default();
        apply(&mut state,&RestKind::Preview,json!({"success":true,"result":[{"service":"direct","id":"https://temporary.test/stream","title":"Tune","originalReference":{"service":"odysee","id":"original-id"}}]})).unwrap();
        assert_eq!(
            state.preview.unwrap().reference,
            Reference {
                service: "odysee".into(),
                id: "original-id".into()
            }
        );
        assert!(
            apply(
                &mut NativeState::default(),
                &RestKind::Preview,
                json!({"result":[{},{}],"highlighted":{"service":"youtube","id":"not-selected"}})
            )
            .is_err()
        );
    }
    #[test]
    fn pages_append_only_contiguously_and_stale_pages_cannot_imply_inactive() {
        let moods = crate::music::default_moods();
        let value =
            |items: Value, offset| json!({"items":items,"total":5,"offset":offset,"limit":2});
        let mood = |m: &Mood| json!({"id":m.id,"name":m.name,"normalizedName":m.normalized_name,"iconKey":m.icon_key});
        let mut page = Page::default();
        merge_page(
            &mut page,
            value(json!([mood(&moods[0]), mood(&moods[1])]), 0),
            0,
        )
        .unwrap();
        assert!(!page.complete());
        assert_eq!(page.next_offset(), 2);
        assert!(merge_page(&mut page, value(json!([mood(&moods[4])]), 4), 4).is_err());
        merge_page(
            &mut page,
            value(json!([mood(&moods[2]), mood(&moods[3])]), 2),
            2,
        )
        .unwrap();
        assert_eq!(page.next_offset(), 4);
        assert!(page.has_more());
        merge_page(&mut page, value(json!([mood(&moods[4])]), 4), 4).unwrap();
        assert!(page.complete());
        assert!(!page.has_more());
    }
    #[test]
    fn replacement_track_rejects_annotation_completions() {
        let mut s = NativeState::default();
        s.room.project(&json!({"action":"sync","currentSource":{"trackId":"00000000-0000-4000-8000-000000000001"}}),0);
        s.track_changed();
        let first = s.track_generation;
        s.room
            .project(&json!({"action":"sync","currentSource":null}), 0);
        s.track_changed();
        assert!(s.track_generation > first);
        assert!(
            apply(
                &mut s,
                &RestKind::Tag("00000000-0000-4000-8000-000000000001".into()),
                json!({"success":true})
            )
            .is_err()
        );
        assert!(!s.tags.loaded);
    }
}
