//! Native form orchestration and bounded detail panels. No playback IPC or raw REST data.
use super::{
    Player, ui,
    ui_input::{InputEvent, NativeInput},
};
use gpui::{Context, Div, Entity, Stateful, Window, div, prelude::*, px, rgb};
use std::collections::BTreeMap;
use undertone_desktop::{
    music::{
        ActiveTag, ConfirmationOffer, Content, ICON_KEYS, Intent, Mood, MusicCommand, MusicStatus,
        Page, Reference,
    },
    session::{CommandAuthority, ErrorCode, NativeCommand, NativeState},
    text,
};

pub fn pair(state: &NativeState) -> (u64, u64) {
    (state.account_generation, state.socket_generation)
}

#[derive(Default)]
pub struct Authority {
    applied: Option<(u64, u64)>,
    connected: bool,
    fenced: Option<(u64, u64)>,
}
impl Authority {
    /// Event and watch paths share this operation. A delayed watch cannot reset fresh capabilities.
    pub fn reconcile(&mut self, state: &NativeState) -> bool {
        let next = pair(state);
        let changed = self.applied != Some(next);
        let reset = changed || (self.connected && (!state.connected || state.account.expired));
        if changed {
            self.fenced = None;
        }
        self.applied = Some(next);
        self.connected = state.connected && !state.account.expired;
        reset
    }
    pub fn fence(&mut self, state: &NativeState) {
        self.fenced = Some(pair(state));
    }
    pub fn accepts(&self, state: &NativeState) -> bool {
        self.connected
            && state.connected
            && !state.account.expired
            && self.applied == Some(pair(state))
            && self.fenced != Some(pair(state))
    }
    pub fn accepts_event(&self, state: &NativeState, event: (u64, u64)) -> bool {
        self.accepts(state) && event == pair(state)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Panel {
    Account,
    Moods,
    Preferences,
    Add,
    Queue,
    Settings,
}
impl Panel {
    pub fn key(self) -> &'static str {
        match self {
            Self::Account => "account",
            Self::Moods => "trackMoods",
            Self::Preferences => "roomMoods",
            Self::Add => "addMusic",
            Self::Queue => "upNext",
            Self::Settings => "settings",
        }
    }
}

#[derive(Clone)]
pub enum Action {
    Panel(Panel),
    Close,
    Login,
    Logout,
    RefreshAccount,
    RefreshRoom,
    Tags(usize),
    Favorites(usize),
    Moods(usize),
    Tag {
        track: String,
        epoch: u64,
        mood: String,
        active: bool,
    },
    Favorite {
        mood: String,
        active: bool,
    },
    Create,
    Icon(usize),
    Preference(String, i8),
    Save(Content),
    ResetDraft,
    Preview,
    Request(Intent, Reference, u64),
    Confirm(Option<ConfirmationOffer>),
    Cancel(String),
    Retry,
    Queue(usize),
    Requests(usize),
    ToggleUpcoming,
}

#[derive(Default)]
pub struct PreferenceDraft {
    owner: Option<String>,
    pub include: Vec<String>,
    pub exclude: Vec<String>,
    pub dirty: bool,
    awaiting_sync: bool,
}
impl PreferenceDraft {
    fn read(&mut self, state: &NativeState, force: bool) {
        let own = state.room.own();
        let owner = own.map(|p| p.participant_id.clone());
        let same_ids =
            |a: &[String], b: &[String]| a.len() == b.len() && a.iter().all(|id| b.contains(id));
        if self.awaiting_sync
            && own.is_some_and(|p| {
                same_ids(&self.include, &p.include_mood_ids)
                    && same_ids(&self.exclude, &p.exclude_mood_ids)
            })
        {
            self.dirty = false;
            self.awaiting_sync = false;
        }
        if force || self.owner != owner || !self.dirty {
            self.owner = owner;
            self.include = own.map(|p| p.include_mood_ids.clone()).unwrap_or_default();
            self.exclude = own.map(|p| p.exclude_mood_ids.clone()).unwrap_or_default();
            self.dirty = false;
            self.awaiting_sync = false;
        }
    }
    fn set(&mut self, id: String, choice: i8) {
        self.include.retain(|v| v != &id);
        self.exclude.retain(|v| v != &id);
        if choice > 0 {
            self.include.push(id);
        } else if choice < 0 {
            self.exclude.push(id);
        }
        self.dirty = true;
    }
}

#[derive(Clone, Copy)]
enum HttpWork {
    Tags,
    Favorites,
    Moods,
    Tag,
    Favorite,
    Create,
    Preview,
    Identity,
}
struct PendingHttp {
    work: HttpWork,
    saw_busy: bool,
    before: String,
}
fn room_marker(s: &NativeState) -> String {
    format!(
        "{}:{:?}:{}:{}:{}:{}",
        s.room.revision,
        s.room.status,
        page_mark(&s.room.queue_page),
        page_mark(&s.room.requests_page),
        s.room
            .confirmation
            .as_ref()
            .map(|r| r.request_id.as_str())
            .unwrap_or_default(),
        s.room.retry_available
    )
}
fn page_mark<T>(page: &Page<T>) -> String {
    format!(
        "{}:{}:{}:{}:{}",
        page.loaded,
        page.stale,
        page.failed,
        page.items.len(),
        page.total
    )
}
fn marker(work: HttpWork, s: &NativeState) -> String {
    let value = match work {
        HttpWork::Tags | HttpWork::Tag => page_mark(&s.tags),
        HttpWork::Favorites | HttpWork::Favorite => page_mark(&s.favorites),
        HttpWork::Moods => page_mark(&s.moods),
        HttpWork::Create => s
            .created_mood
            .as_ref()
            .map(|m| m.id.clone())
            .unwrap_or_default(),
        HttpWork::Preview => s
            .preview
            .as_ref()
            .map(|p| format!("{}:{}", p.reference.service, p.reference.id))
            .unwrap_or_default(),
        HttpWork::Identity => format!("{:?}:{}", pair(s), s.account.known),
    };
    format!("{value}:{:?}", s.error)
}

pub struct MusicUi {
    pub panel: Option<Panel>,
    pub rendered_authority: CommandAuthority,
    pub user: Entity<NativeInput>,
    pub password: Entity<NativeInput>,
    pub url: Entity<NativeInput>,
    pub search: Entity<NativeInput>,
    pub name: Entity<NativeInput>,
    pub icon: usize,
    pub draft: PreferenceDraft,
    pending_http: Option<PendingHttp>,
    attempted: [bool; 3],
    reload: [bool; 3],
    context: Option<(u64, u64, Option<String>, u64)>,
    pub preview_valid: bool,
    url_version: u64,
    preview_version: u64,
    pub draft_submitted: bool,
    pending_room: Option<(String, bool)>,
    request_counter: u64,
    command_sequence: u64,
    timeout_sequence: u64,
}
impl MusicUi {
    pub fn new(window: &mut Window, cx: &mut Context<Player>) -> Self {
        let user = cx.new(|cx| NativeInput::new(text("username"), false, cx));
        let password = cx.new(|cx| NativeInput::new(text("password"), true, cx));
        let url = cx.new(|cx| NativeInput::new(text("musicUrl"), false, cx));
        let search = cx.new(|cx| NativeInput::new(text("searchMoods"), false, cx));
        let name = cx.new(|cx| NativeInput::new(text("moodName"), false, cx));
        for input in [&user, &password] {
            cx.subscribe_in(input, window, |p, _, event, w, cx| {
                if matches!(event, InputEvent::Submit) {
                    p.music_action(Action::Login, p.music_ui.rendered_authority, w, cx);
                }
                cx.notify();
            })
            .detach();
        }
        cx.subscribe_in(&url, window, |p, _, event, w, cx| {
            match event {
                InputEvent::Changed => {
                    p.music_ui.preview_valid = false;
                    p.music_ui.url_version += 1;
                }
                InputEvent::Submit => {
                    p.music_action(Action::Preview, p.music_ui.rendered_authority, w, cx)
                }
            }
            cx.notify();
        })
        .detach();
        cx.subscribe_in(&search, window, |_, _, _, _, cx| cx.notify())
            .detach();
        cx.subscribe_in(&name, window, |p, _, event, w, cx| {
            if matches!(event, InputEvent::Submit) {
                p.music_action(Action::Create, p.music_ui.rendered_authority, w, cx);
            }
            cx.notify();
        })
        .detach();
        Self {
            panel: None,
            rendered_authority: NativeState::default().authority(),
            user,
            password,
            url,
            search,
            name,
            icon: 0,
            draft: PreferenceDraft::default(),
            pending_http: None,
            attempted: [false; 3],
            reload: [false; 3],
            context: None,
            preview_valid: false,
            url_version: 0,
            preview_version: 0,
            draft_submitted: false,
            pending_room: None,
            request_counter: 0,
            command_sequence: 0,
            timeout_sequence: 0,
        }
    }
    fn busy(&self, s: &NativeState) -> bool {
        s.http_busy || self.pending_http.is_some()
    }
}

impl Player {
    fn arm_native_timeout(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.music_ui.command_sequence == self.music_ui.timeout_sequence
            || (self.music_ui.pending_http.is_none() && self.music_ui.pending_room.is_none())
        {
            return;
        }
        let sequence = self.music_ui.command_sequence;
        self.music_ui.timeout_sequence = sequence;
        let generation = self.generation;
        let authority = self.native.authority();
        cx.spawn_in(window, async move |this, cx| {
            gpui::Timer::after(std::time::Duration::from_secs(25)).await;
            let _ = this.update_in(cx, |p, _, cx| {
                if p.generation == generation
                    && authority.matches_session(&p.native)
                    && p.music_ui.command_sequence == sequence
                    && (p.music_ui.pending_http.is_some() || p.music_ui.pending_room.is_some())
                {
                    // A coalesced identical response may omit the intermediate busy snapshot.
                    // Release only our admission latch; never replay or assert server success.
                    p.music_ui.pending_http = None;
                    p.music_ui.pending_room = None;
                    p.music_ui.draft_submitted = false;
                    p.notice = text("nativeOutcomeUnknown");
                    cx.notify();
                }
            });
        })
        .detach();
    }
    fn room_busy(&self) -> bool {
        self.native.room.busy || self.music_ui.pending_room.is_some()
    }
    pub fn clear_native_forms(&mut self, cx: &mut Context<Self>) {
        for input in [
            &self.music_ui.user,
            &self.music_ui.password,
            &self.music_ui.url,
            &self.music_ui.search,
            &self.music_ui.name,
        ] {
            input.update(cx, |i, cx| i.clear(cx));
        }
        self.music_ui.pending_http = None;
        self.music_ui.pending_room = None;
        self.music_ui.attempted = [false; 3];
        self.music_ui.reload = [false; 3];
        self.music_ui.draft = PreferenceDraft::default();
        self.music_ui.draft_submitted = false;
        self.music_ui.preview_valid = false;
        self.music_ui.context = None;
    }
    fn reset_playback_authority(&mut self) {
        self.dispose_host();
        self.observer_sequence = self.observer_sequence.wrapping_add(1);
        self.observer = undertone_desktop::bridge::Observer::new(self.observer_sequence);
        self.connection_ready = false;
        self.title.clear();
        self.details = ui::TrackDetails::default();
        self.status = text("waiting-snapshot");
    }
    pub fn native_changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(connection) = &self.connection else {
            return;
        };
        let state = connection.native_state();
        if state.generation != self.generation {
            return;
        }
        if self.authority.reconcile(&state) {
            self.reset_playback_authority();
        }
        let context = (
            state.account_generation,
            state.socket_generation,
            state.room.track_id().map(str::to_owned),
            state.track_generation,
        );
        if self.music_ui.context.as_ref() != Some(&context) {
            let private_changed = self
                .music_ui
                .context
                .as_ref()
                .is_none_or(|c| c.0 != context.0 || c.1 != context.1);
            if private_changed {
                self.clear_native_forms(cx);
            } else {
                self.music_ui.attempted[0] = false;
                self.music_ui.reload[0] = false;
            }
            self.music_ui.context = Some(context);
        }
        if let Some(pending) = &mut self.music_ui.pending_http {
            pending.saw_busy |= state.http_busy;
            if !state.http_busy
                && (pending.saw_busy || marker(pending.work, &state) != pending.before)
            {
                if matches!(pending.work, HttpWork::Preview) {
                    self.music_ui.preview_valid = state.preview.is_some()
                        && state.error.is_none()
                        && self.music_ui.preview_version == self.music_ui.url_version;
                }
                if matches!(pending.work, HttpWork::Tag) && state.tags.stale {
                    self.music_ui.reload[0] = true;
                }
                if matches!(pending.work, HttpWork::Favorite) && state.favorites.stale {
                    self.music_ui.reload[1] = true;
                }
                if matches!(pending.work, HttpWork::Create) && state.created_mood.is_some() {
                    self.music_ui.reload[2] = true;
                }
                self.music_ui.pending_http = None;
            }
        }
        if let Some((before, saw_busy)) = &mut self.music_ui.pending_room {
            *saw_busy |= state.room.busy;
            if !state.room.busy && (*saw_busy || *before != room_marker(&state)) {
                if self.music_ui.draft_submitted
                    && matches!(
                        state.room.status,
                        Some(MusicStatus::Applied | MusicStatus::Duplicate)
                    )
                {
                    // The result may precede the authoritative participant sync. Keep the
                    // submitted choices visible until that sync, rather than restoring old IDs.
                    self.music_ui.draft.awaiting_sync = true;
                }
                self.music_ui.draft_submitted = false;
                self.music_ui.pending_room = None;
            }
        }
        self.details = ui::TrackDetails::default();
        self.music_ui.draft.read(&state, false);
        self.room_name = state
            .room
            .name
            .clone()
            .unwrap_or_else(|| self.room_name.clone());
        if let Some(current) = state.room.music.as_ref().and_then(|m| m.current.as_ref()) {
            self.details.artist =
                (!current.entry.artists.is_empty()).then(|| current.entry.artists.join(", "));
            self.details.tags = current
                .contributor_moods
                .iter()
                .map(|m| m.name.clone())
                .collect();
        }
        self.details.personal_tags = (state.account.logged_in
            && !state.account.expired
            && state.tags.loaded
            && !state.tags.stale
            && !state.tags.failed)
            .then(|| state.tags.items.iter().map(|m| m.name.clone()).collect());
        self.up_next = state
            .room
            .music
            .as_ref()
            .map(|m| {
                m.queue
                    .iter()
                    .map(|e| ui::UpcomingTrack {
                        title: e.title.clone().unwrap_or_else(|| text("untitledTrack")),
                        artist: (!e.artists.is_empty()).then(|| e.artists.join(", ")),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let authority = state.authority();
        self.native = state;
        // Exactly once per explicit outer Join, including a cached native account.
        if !self.account_refresh_requested && self.native.connected && !self.native.http_busy {
            self.account_refresh_requested = true;
            self.native_submit(
                authority,
                NativeCommand::RefreshAccount,
                Some(HttpWork::Identity),
            );
        } else {
            self.drive_pages();
        }
        self.arm_native_timeout(window, cx);
        self.sync_layout(window);
        cx.notify();
    }
    fn native_submit(
        &mut self,
        authority: CommandAuthority,
        command: NativeCommand,
        work: Option<HttpWork>,
    ) -> bool {
        if !authority.matches_session(&self.native)
            || !self
                .connection
                .as_ref()
                .is_some_and(|c| authority.matches_session(&c.native_state()))
        {
            self.notice = text("nativeStale");
            return false;
        }
        let room_command = matches!(command, NativeCommand::Music(_));
        let identity = matches!(
            command,
            NativeCommand::Login { .. }
                | NativeCommand::Logout
                | NativeCommand::RefreshAccount
                | NativeCommand::RefreshRoom
        );
        if identity {
            self.authority.fence(&self.native);
            self.reset_playback_authority();
        }
        if self
            .connection
            .as_ref()
            .is_some_and(|c| c.send_native(authority, command))
        {
            self.notice.clear();
            self.music_ui.command_sequence = self.music_ui.command_sequence.wrapping_add(1);
            if room_command {
                self.music_ui.pending_room = Some((room_marker(&self.native), false));
            }
            if let Some(work) = work {
                self.music_ui.pending_http = Some(PendingHttp {
                    work,
                    saw_busy: false,
                    before: marker(work, &self.native),
                });
            }
            true
        } else {
            self.notice = text("nativeQueueBusy");
            false
        }
    }
    fn drive_pages(&mut self) {
        let authority = self.native.authority();
        if !self.native.can().account_write || self.music_ui.busy(&self.native) {
            return;
        }
        let next = self
            .music_ui
            .reload
            .iter()
            .position(|r| *r)
            .or_else(|| next_page(&self.native, self.music_ui.panel, &self.music_ui.attempted));
        if let Some(index) = next {
            let (command, work) = match index {
                0 => (
                    NativeCommand::LoadTrackMoods {
                        track_id: self.native.room.track_id().unwrap().to_owned(),
                        offset: 0,
                    },
                    HttpWork::Tags,
                ),
                1 => (
                    NativeCommand::LoadFavorites { offset: 0 },
                    HttpWork::Favorites,
                ),
                _ => (NativeCommand::LoadMoods { offset: 0 }, HttpWork::Moods),
            };
            // Attempt once, even if admission fails. Recovery always requires an explicit action.
            self.music_ui.attempted[index] = true;
            self.music_ui.reload[index] = false;
            self.native_submit(authority, command, Some(work));
        }
    }
    pub fn music_action(
        &mut self,
        action: Action,
        authority: CommandAuthority,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !authority.matches_session(&self.native) {
            self.notice = text("nativeStale");
            cx.notify();
            return;
        }
        let free = !self.music_ui.busy(&self.native);
        let room_free = self.native.connected && !self.room_busy() && !self.native.http_busy;
        let can = self.native.can();
        match action {
            Action::Panel(panel) => {
                self.music_ui.panel = if self.music_ui.panel == Some(panel) {
                    None
                } else {
                    Some(panel)
                };
                self.drive_pages();
            }
            Action::Close => self.music_ui.panel = None,
            Action::Login if free && self.connection.is_some() => {
                let user = self.music_ui.user.read(cx).value().trim().to_owned();
                let password = self.music_ui.password.read(cx).value().to_owned();
                self.music_ui.password.update(cx, |i, cx| i.clear(cx));
                if !user.is_empty() && !password.is_empty() {
                    self.native_submit(
                        authority,
                        NativeCommand::Login { user, password },
                        Some(HttpWork::Identity),
                    );
                }
            }
            Action::Logout if free => {
                self.native_submit(authority, NativeCommand::Logout, Some(HttpWork::Identity));
            }
            Action::RefreshAccount if !self.native.http_busy => {
                self.music_ui.pending_http = None;
                self.native_submit(
                    authority,
                    NativeCommand::RefreshAccount,
                    Some(HttpWork::Identity),
                );
            }
            Action::RefreshRoom if !self.native.http_busy => {
                self.music_ui.pending_http = None;
                self.native_submit(authority, NativeCommand::RefreshRoom, None);
            }
            Action::Tags(offset) if free && can.account_write => {
                if let Some(id) = self.native.room.track_id() {
                    self.music_ui.attempted[0] = true;
                    self.native_submit(
                        authority,
                        NativeCommand::LoadTrackMoods {
                            track_id: id.into(),
                            offset,
                        },
                        Some(HttpWork::Tags),
                    );
                }
            }
            Action::Favorites(offset) if free && can.account_write => {
                self.music_ui.attempted[1] = true;
                self.native_submit(
                    authority,
                    NativeCommand::LoadFavorites { offset },
                    Some(HttpWork::Favorites),
                );
            }
            Action::Moods(offset) if free && can.account_write => {
                self.music_ui.attempted[2] = true;
                self.native_submit(
                    authority,
                    NativeCommand::LoadMoods { offset },
                    Some(HttpWork::Moods),
                );
            }
            Action::Tag {
                track,
                epoch,
                mood,
                active,
            } if free
                && can.account_write
                && self.native.room.track_id() == Some(track.as_str())
                && epoch == self.native.track_generation =>
            {
                self.native_submit(
                    authority,
                    NativeCommand::SetTag {
                        track_id: track,
                        mood_id: mood,
                        active,
                    },
                    Some(HttpWork::Tag),
                );
            }
            Action::Favorite { mood, active } if free && can.account_write => {
                self.native_submit(
                    authority,
                    NativeCommand::SetFavorite {
                        mood_id: mood,
                        active,
                    },
                    Some(HttpWork::Favorite),
                );
            }
            Action::Create if free && can.account_write => {
                let name = self.music_ui.name.read(cx).value().trim().to_owned();
                if !name.is_empty() {
                    self.native_submit(
                        authority,
                        NativeCommand::CreateMood {
                            name,
                            icon_key: ICON_KEYS[self.music_ui.icon].into(),
                        },
                        Some(HttpWork::Create),
                    );
                }
            }
            Action::Icon(index) if index < ICON_KEYS.len() => self.music_ui.icon = index,
            Action::Preference(id, choice) if can.preferences => {
                self.music_ui.draft.set(id, choice)
            }
            Action::Save(content) if room_free && can.preferences => {
                self.music_ui.draft_submitted = self.native_submit(
                    authority,
                    NativeCommand::Music(MusicCommand::Preferences {
                        include: self.music_ui.draft.include.clone(),
                        exclude: self.music_ui.draft.exclude.clone(),
                        content,
                    }),
                    None,
                );
            }
            Action::ResetDraft => self.music_ui.draft.read(&self.native, true),
            Action::Preview if free && can.add_mix => {
                let url = self.music_ui.url.read(cx).value().trim().to_owned();
                self.music_ui.preview_valid = false;
                self.music_ui.preview_version = self.music_ui.url_version;
                self.native_submit(
                    authority,
                    NativeCommand::PreviewUrl { url },
                    Some(HttpWork::Preview),
                );
            }
            Action::Request(intent, reference, version)
                if room_free
                    && free
                    && self.music_ui.preview_valid
                    && version == self.music_ui.url_version
                    && self
                        .native
                        .preview
                        .as_ref()
                        .is_some_and(|p| p.reference == reference)
                    && (if intent == Intent::Next {
                        can.add_next
                    } else {
                        can.add_mix
                    }) =>
            {
                self.music_ui.request_counter += 1;
                let request_id = format!(
                    "desktop-{}-{}-{}-{}",
                    self.generation,
                    self.native.account_generation,
                    self.native.socket_generation,
                    self.music_ui.request_counter
                );
                self.native_submit(
                    authority,
                    NativeCommand::Music(MusicCommand::RequestPreview { request_id, intent }),
                    None,
                );
            }
            Action::Confirm(Some(offer)) if room_free && can.confirm => {
                self.native_submit(
                    authority,
                    NativeCommand::Music(MusicCommand::Confirm(offer)),
                    None,
                );
            }
            Action::Cancel(request_id) if room_free && self.native.room.active() => {
                self.native_submit(
                    authority,
                    NativeCommand::Music(MusicCommand::Cancel { request_id }),
                    None,
                );
            }
            Action::Retry if room_free && self.native.room.retry_available => {
                self.native_submit(authority, NativeCommand::Music(MusicCommand::Retry), None);
            }
            Action::Queue(offset) if room_free && self.native.room.active() => {
                self.native_submit(
                    authority,
                    NativeCommand::Music(MusicCommand::Queue { offset }),
                    None,
                );
            }
            Action::Requests(offset) if room_free && self.native.room.active() => {
                self.native_submit(
                    authority,
                    NativeCommand::Music(MusicCommand::Requests { offset }),
                    None,
                );
            }
            Action::ToggleUpcoming => self.show_up_next = !self.show_up_next,
            _ => (),
        }
        self.arm_native_timeout(window, cx);
        self.sync_layout(window);
        cx.notify();
    }
}

fn own_tag(page: &Page<Mood>, id: &str) -> ActiveTag {
    if page.loaded
        && !page.stale
        && !page.failed
        && !page.loading
        && page.items.iter().any(|m| m.id == id)
    {
        ActiveTag::Active
    } else if page.complete() {
        ActiveTag::Inactive
    } else {
        ActiveTag::Unknown
    }
}
fn next_page(s: &NativeState, panel: Option<Panel>, attempted: &[bool; 3]) -> Option<usize> {
    if !matches!(panel, Some(Panel::Moods | Panel::Preferences)) {
        return None;
    }
    let needs = |p: &Page<Mood>| (!p.loaded || p.stale) && !p.failed && !p.loading;
    if panel == Some(Panel::Moods) && !attempted[0] && s.room.track_id().is_some() && needs(&s.tags)
    {
        Some(0)
    } else if panel == Some(Panel::Moods) && !attempted[1] && needs(&s.favorites) {
        Some(1)
    } else if !attempted[2] && needs(&s.moods) {
        Some(2)
    } else {
        None
    }
}

pub fn column() -> Div {
    div().flex().flex_col().gap(px(8.))
}
fn row() -> Div {
    div().flex().items_center().flex_wrap().gap(px(6.))
}
fn label(key: &str) -> Div {
    div()
        .text_size(px(12.))
        .text_color(rgb(ui::MUTED))
        .child(text(key))
}

impl Player {
    pub fn action_button(
        &self,
        id: impl Into<gpui::ElementId>,
        title: String,
        action: Action,
        enabled: bool,
        selected: bool,
        cx: &Context<Self>,
    ) -> Stateful<Div> {
        let authority = self.native.authority();
        div()
            .id(id)
            .px(px(10.))
            .py(px(6.))
            .rounded(px(8.))
            .border_1()
            .border_color(rgb(if selected { ui::AMBER } else { ui::BORDER }))
            .bg(rgb(if selected { ui::SECONDARY } else { ui::CARD }))
            .text_size(px(12.))
            .text_color(rgb(if enabled { ui::TEXT } else { ui::MUTED }))
            .when(enabled, |s| {
                s.cursor_pointer()
                    .focusable()
                    .tab_stop(true)
                    .focus(|s| s.border_color(rgb(ui::AMBER)))
                    .hover(|s| s.bg(rgb(ui::SECONDARY)))
            })
            .child(title)
            .on_click(cx.listener(move |p, _, w, cx| {
                if enabled {
                    p.music_action(action.clone(), authority, w, cx);
                }
            }))
    }
    fn button(
        &self,
        id: &'static str,
        action: Action,
        enabled: bool,
        cx: &Context<Self>,
    ) -> Stateful<Div> {
        self.action_button(id, text(id), action, enabled, false, cx)
    }
    pub fn panel_navigation(&self, cx: &Context<Self>) -> Div {
        row().flex_shrink_0().children(
            [
                Panel::Moods,
                Panel::Preferences,
                Panel::Add,
                Panel::Account,
                Panel::Queue,
                Panel::Settings,
            ]
            .into_iter()
            .map(|panel| {
                self.action_button(
                    panel.key(),
                    text(panel.key()),
                    Action::Panel(panel),
                    true,
                    self.music_ui.panel == Some(panel),
                    cx,
                )
            }),
        )
    }
    fn vocabulary(&self) -> Vec<Mood> {
        let mut map = BTreeMap::new();
        for mood in self
            .native
            .room
            .public_moods()
            .into_iter()
            .chain(self.native.moods.items.clone())
            .chain(self.native.tags.items.clone())
            .chain(self.native.favorites.items.clone())
            .chain(self.native.created_mood.clone())
        {
            map.insert(mood.id.clone(), mood);
        }
        map.into_values().collect()
    }
    fn tag_state(&self, id: &str) -> ActiveTag {
        own_tag(&self.native.tags, id)
    }
    fn mood_row(&self, mood: &Mood, scope: &str, cx: &Context<Self>) -> Div {
        let own = self.native.can().account_write && !self.music_ui.busy(&self.native);
        let state = self.tag_state(&mood.id);
        let active = state == ActiveTag::Active;
        let favorite = self.native.favorites.items.iter().any(|m| m.id == mood.id)
            && !self.native.favorites.stale
            && !self.native.favorites.failed;
        let favorite_known = favorite || self.native.favorites.complete();
        let track = self.native.room.track_id();
        row()
            .child(div().flex_1().min_w_0().child(mood.name.clone()))
            .child(
                self.action_button(
                    gpui::SharedString::from(format!("{scope}-tag-{}", mood.id)),
                    text(match state {
                        ActiveTag::Active => "tagActive",
                        ActiveTag::Inactive => "tagAdd",
                        ActiveTag::Unknown => "tagUnknown",
                    }),
                    Action::Tag {
                        track: track.unwrap_or_default().into(),
                        epoch: self.native.track_generation,
                        mood: mood.id.clone(),
                        active: !active,
                    },
                    own && track.is_some() && state != ActiveTag::Unknown,
                    false,
                    cx,
                )
                .when(active, |s| {
                    s.bg(rgb(ui::PERSONAL_SURFACE))
                        .text_color(rgb(ui::PERSONAL))
                }),
            )
            .child(self.action_button(
                gpui::SharedString::from(format!("{scope}-favorite-{}", mood.id)),
                text(if favorite { "unfavorite" } else { "favorite" }),
                Action::Favorite {
                    mood: mood.id.clone(),
                    active: !favorite,
                },
                own && favorite_known,
                false,
                cx,
            ))
    }
    fn page_controls(&self, kind: usize, cx: &Context<Self>) -> Div {
        let (page, title) = match kind {
            0 => (&self.native.tags, "personalMoods"),
            1 => (&self.native.favorites, "favorites"),
            _ => (&self.native.moods, "vocabulary"),
        };
        let action = |offset| match kind {
            0 => Action::Tags(offset),
            1 => Action::Favorites(offset),
            _ => Action::Moods(offset),
        };
        let enabled = self.native.can().account_write
            && !self.music_ui.busy(&self.native)
            && (kind != 0 || self.native.room.track_id().is_some());
        column().child(label(title)).child(
            row()
                .child(self.action_button(
                    ("refresh-page", kind),
                    text("refresh"),
                    action(0),
                    enabled,
                    false,
                    cx,
                ))
                .child(self.action_button(
                    ("more-page", kind),
                    text("loadMore"),
                    action(page.next_offset()),
                    enabled && page.has_more(),
                    false,
                    cx,
                ))
                .child(label(if page.failed {
                    "pageFailed"
                } else if page.loading {
                    "nativePending"
                } else if page.complete() {
                    "pageComplete"
                } else {
                    "pagePartial"
                })),
        )
    }
    fn account_panel(&self, cx: &Context<Self>) -> Div {
        let account = &self.native.account;
        let free = !self.music_ui.busy(&self.native) && self.connection.is_some();
        column()
            .child(label(if account.expired {
                "accountExpired"
            } else if !account.known {
                "accountUnknown"
            } else if account.logged_in {
                "accountSignedIn"
            } else {
                "accountGuest"
            }))
            .when_some(account.username.clone(), |s, name| s.child(name))
            .child(label("passwordAccountsOnly"))
            .child(self.music_ui.user.clone())
            .child(self.music_ui.password.clone())
            .child(
                row()
                    .child(self.button(
                        "signIn",
                        Action::Login,
                        free && !account.logged_in
                            && !self.music_ui.user.read(cx).value().trim().is_empty()
                            && !self.music_ui.password.read(cx).value().is_empty(),
                        cx,
                    ))
                    .child(self.button("signOut", Action::Logout, free && account.logged_in, cx))
                    .child(self.button(
                        "refreshAccount",
                        Action::RefreshAccount,
                        self.connection.is_some() && !self.native.http_busy,
                        cx,
                    )),
            )
    }
    fn moods_panel(&self, cx: &Context<Self>) -> Div {
        let groups = self.native.mood_groups();
        let query = self.music_ui.search.read(cx).value().to_lowercase();
        column()
            .when(
                !self.native.account.logged_in || self.native.account.expired,
                |s| s.child(label("accountNeeded")),
            )
            .when(self.native.room.track_id().is_none(), |s| {
                s.child(label("catalogueNeeded"))
            })
            .child(label("contributorMoods"))
            .children(
                groups
                    .priority
                    .iter()
                    .map(|m| self.mood_row(&m.mood, "priority", cx)),
            )
            .when(groups.priority.is_empty(), |s| {
                s.child(label("noContributorMoods"))
            })
            .child(label("ownComplement"))
            .children(
                groups
                    .complement
                    .iter()
                    .map(|m| self.mood_row(&m.mood, "complement", cx)),
            )
            .child(self.page_controls(0, cx))
            .child(self.page_controls(1, cx))
            .child(label("vocabulary"))
            .child(self.music_ui.search.clone())
            .children(
                self.vocabulary()
                    .iter()
                    .filter(|m| m.name.to_lowercase().contains(&query))
                    .map(|m| self.mood_row(m, "vocabulary", cx)),
            )
            .child(self.page_controls(2, cx))
            .child(label("createMoodHelp"))
            .child(self.music_ui.name.clone())
            .child(row().children(ICON_KEYS.iter().enumerate().map(|(i, key)| {
                self.action_button(
                    ("mood-icon", i),
                    text(&format!("icon-{key}")),
                    Action::Icon(i),
                    true,
                    self.music_ui.icon == i,
                    cx,
                )
            })))
            .child(self.button(
                "createMood",
                Action::Create,
                self.native.can().account_write
                    && !self.music_ui.busy(&self.native)
                    && !self.music_ui.name.read(cx).value().trim().is_empty(),
                cx,
            ))
            .when_some(self.native.created_mood.as_ref(), |s, m| {
                s.child(label("createdMoodChoice"))
                    .child(self.mood_row(m, "created", cx))
            })
    }
    fn preferences_panel(&self, cx: &Context<Self>) -> Div {
        let draft = &self.music_ui.draft;
        let enabled = self.native.can().preferences
            && !self.room_busy()
            && !self.native.http_busy
            && !draft.awaiting_sync;
        let mut vocabulary: BTreeMap<String, String> = self
            .vocabulary()
            .into_iter()
            .map(|m| (m.id, m.name))
            .collect();
        // Unknown saved IDs remain visible and preserved. Only an explicit choice removes them.
        for id in draft.include.iter().chain(&draft.exclude) {
            vocabulary
                .entry(id.clone())
                .or_insert_with(|| format!("{} {id}", text("unknownMood")));
        }
        column()
            .child(label("preferencesHelp"))
            .when(draft.awaiting_sync, |s| {
                s.child(label("preferencesAwaitingSync"))
            })
            .when(!self.native.room.active(), |s| {
                s.child(label("musicModeNeeded"))
            })
            .children(vocabulary.iter().map(|(id, name)| {
                let choice = if draft.include.contains(id) {
                    1
                } else if draft.exclude.contains(id) {
                    -1
                } else {
                    0
                };
                column().child(name.clone()).child(
                    row().children(
                        [("include", 1), ("neutral", 0), ("exclude", -1)]
                            .into_iter()
                            .map(|(key, value)| {
                                self.action_button(
                                    gpui::SharedString::from(format!("{key}-{id}")),
                                    text(key),
                                    Action::Preference(id.clone(), value),
                                    enabled,
                                    choice == value,
                                    cx,
                                )
                            }),
                    ),
                )
            }))
            .child(self.page_controls(2, cx))
            .child(
                row()
                    .child(self.button(
                        "saveKeep",
                        Action::Save(Content::Keep),
                        enabled && draft.dirty,
                        cx,
                    ))
                    .child(self.button(
                        "saveRenew",
                        Action::Save(Content::Renew),
                        enabled && draft.dirty,
                        cx,
                    ))
                    .child(self.button("resetDraft", Action::ResetDraft, !self.room_busy(), cx)),
            )
            .child(label("renewHelp"))
    }
    fn add_panel(&self, cx: &Context<Self>) -> Div {
        let can = self.native.can();
        let ready = self.native.connected && !self.room_busy() && !self.music_ui.busy(&self.native);
        let preview = self.music_ui.preview_valid && self.native.preview.is_some();
        let mut panel = column()
            .child(label("addHelp"))
            .when(!self.native.room.active(), |s| {
                s.child(label("musicModeNeeded"))
            })
            .when(self.native.room.active() && !can.add_mix, |s| {
                s.child(label("addPermissionNeeded"))
            })
            .child(self.music_ui.url.clone())
            .child(self.button(
                "previewUrl",
                Action::Preview,
                ready && can.add_mix && !self.music_ui.url.read(cx).value().trim().is_empty(),
                cx,
            ));
        if preview && let Some(value) = &self.native.preview {
            panel = panel
                .child(value.title.clone().unwrap_or_else(|| text("untitledTrack")))
                .child(
                    row()
                        .child(self.button(
                            "addMix",
                            Action::Request(
                                Intent::Mix,
                                value.reference.clone(),
                                self.music_ui.preview_version,
                            ),
                            ready && can.add_mix,
                            cx,
                        ))
                        .child(self.button(
                            "addNext",
                            Action::Request(
                                Intent::Next,
                                value.reference.clone(),
                                self.music_ui.preview_version,
                            ),
                            ready && can.add_next,
                            cx,
                        )),
                );
        }
        if let Some(offer) = &self.native.room.confirmation {
            panel = panel
                .child(label("confirmationHelp"))
                .child(offer.title.clone().unwrap_or_else(|| text("untitledTrack")))
                .children(offer.conflicts.iter().map(|c| {
                    let detail = offer
                        .conflict_metadata
                        .iter()
                        .find(|d| d.participant_id == c.participant_id && d.mood_id == c.mood_id);
                    div().child(
                        detail
                            .and_then(|d| d.participant_name.as_ref().zip(d.mood.as_ref()))
                            .map(|(n, m)| format!("{n} · {}", m.name))
                            .unwrap_or_else(|| text("confirmationIncomplete")),
                    )
                }))
                .child(
                    row()
                        .child(self.button(
                            "confirm",
                            Action::Confirm(self.native.room.confirmation_offer()),
                            ready && can.confirm,
                            cx,
                        ))
                        .child(self.button(
                            "cancel",
                            Action::Cancel(offer.request_id.clone()),
                            ready,
                            cx,
                        )),
                );
        }
        let page = &self.native.room.requests_page;
        panel
            .child(label("pendingRequests"))
            .when_some(self.native.room.pending_count, |s, count| {
                s.child(format!("{}: {count}", text("pendingCount")))
            })
            .child(self.button(
                "refreshRequests",
                Action::Requests(0),
                ready && self.native.room.active(),
                cx,
            ))
            .children(page.items.iter().map(|r| {
                row()
                    .child(
                        div()
                            .flex_1()
                            .child(r.title.clone().unwrap_or_else(|| text("untitledTrack"))),
                    )
                    .child(self.action_button(
                        gpui::SharedString::from(format!("cancel-{}", r.request_id)),
                        text("cancel"),
                        Action::Cancel(r.request_id.clone()),
                        ready && !page.stale,
                        false,
                        cx,
                    ))
            }))
            .child(
                row()
                    .child(self.button(
                        "previousPage",
                        Action::Requests(page.offset.saturating_sub(page.limit)),
                        ready && page.loaded && page.offset > 0,
                        cx,
                    ))
                    .child(self.button(
                        "nextPage",
                        Action::Requests(page.next_offset()),
                        ready && page.has_more(),
                        cx,
                    )),
            )
            .when(page.stale, |s| s.child(label("refreshPendingHelp")))
    }
    fn queue_panel(&self, cx: &Context<Self>) -> Div {
        let page = &self.native.room.queue_page;
        let ready = self.native.connected
            && self.native.room.active()
            && !self.room_busy()
            && !self.native.http_busy;
        let entries = if page.loaded && !page.stale {
            page.items.as_slice()
        } else {
            self.native
                .room
                .music
                .as_ref()
                .map(|m| m.queue.as_slice())
                .unwrap_or_default()
        };
        column()
            .child(self.button(
                if self.show_up_next {
                    "hideUpcoming"
                } else {
                    "showUpcoming"
                },
                Action::ToggleUpcoming,
                true,
                cx,
            ))
            .when(!self.native.room.active(), |s| {
                s.child(label("musicModeNeeded"))
            })
            .child(
                row()
                    .child(self.button("refreshQueue", Action::Queue(0), ready, cx))
                    .child(self.button(
                        "previousPage",
                        Action::Queue(page.offset.saturating_sub(page.limit)),
                        ready && page.loaded && !page.stale && page.offset > 0,
                        cx,
                    ))
                    .child(self.button(
                        "nextPage",
                        Action::Queue(page.next_offset()),
                        ready && page.has_more(),
                        cx,
                    )),
            )
            .when(self.show_up_next, |s| {
                s.children(entries.iter().map(|e| {
                    column()
                        .child(e.title.clone().unwrap_or_else(|| text("untitledTrack")))
                        .when(!e.artists.is_empty(), |s| s.child(e.artists.join(", ")))
                }))
            })
            .when(entries.is_empty(), |s| s.child(label("queueEmpty")))
            .when(page.stale || page.failed, |s| {
                s.child(label("queueRefreshNeeded"))
            })
    }
    pub fn detail_panel(&self, cx: &Context<Self>) -> Div {
        let Some(panel) = self.music_ui.panel else {
            return column();
        };
        let content = match panel {
            Panel::Account => self.account_panel(cx),
            Panel::Moods => self.moods_panel(cx),
            Panel::Preferences => self.preferences_panel(cx),
            Panel::Add => self.add_panel(cx),
            Panel::Queue => self.queue_panel(cx),
            Panel::Settings => column()
                .child(label("localSettingsHelp"))
                .child(self.button(
                    if self.show_up_next {
                        "hideUpcoming"
                    } else {
                        "showUpcoming"
                    },
                    Action::ToggleUpcoming,
                    true,
                    cx,
                )),
        };
        column()
            .min_h_0()
            .flex_1()
            .p(px(12.))
            .rounded(px(12.))
            .bg(rgb(ui::CARD))
            .border_1()
            .border_color(rgb(ui::BORDER))
            .child(
                row()
                    .justify_between()
                    .child(text(panel.key()))
                    .child(self.button("closePanel", Action::Close, true, cx)),
            )
            .child(
                div()
                    .id("native-detail-scroll")
                    .min_h_0()
                    .flex_1()
                    .overflow_y_scroll()
                    .child(
                        column()
                            .child(self.native_status())
                            .child(self.recovery_controls(cx))
                            .child(content),
                    ),
            )
    }
    pub fn native_status(&self) -> Div {
        let mut status = column().gap(px(2.));
        if self.native.http_busy || self.native.room.busy || self.music_ui.pending_http.is_some() {
            status = status.child(label("nativePending"));
        }
        if let Some(error) = &self.native.error {
            let key = match error.code {
                ErrorCode::Network => "nativeNetwork",
                ErrorCode::Auth => "nativeAuth",
                ErrorCode::RateLimit => "nativeRateLimit",
                ErrorCode::Rejected => "nativeRejected",
                ErrorCode::InvalidResponse => "nativeInvalidResponse",
                ErrorCode::InvalidInput => "nativeInvalidInput",
                ErrorCode::InsecureCredentials => "nativeTls",
                ErrorCode::Busy => "nativeBusy",
                ErrorCode::Stale => "nativeStale",
                ErrorCode::Unavailable => "nativeUnavailable",
            };
            status = status.child(label(key));
            if let Some(seconds) = error.retry_after_seconds {
                status = status.child(format!(
                    "{} {seconds} {}",
                    text("retryAfter"),
                    text("seconds")
                ));
            }
        }
        if let Some(result) = self.native.room.status {
            let key = match result {
                MusicStatus::Applied | MusicStatus::Duplicate => None,
                MusicStatus::ConfirmationRequired => Some("musicConfirmation"),
                MusicStatus::RevisionConflict => Some("musicRevision"),
                MusicStatus::SlotConflict => Some("musicSlot"),
                MusicStatus::RequestConflict => Some("musicRequest"),
                MusicStatus::SourceUnavailable => Some("musicSource"),
                MusicStatus::InvalidConfirmation => Some("musicInvalidConfirmation"),
                MusicStatus::NotFound => Some("musicNotFound"),
                MusicStatus::Rejected => Some("nativeRejected"),
                MusicStatus::Uncertain => Some("musicUncertain"),
                MusicStatus::Stale => Some("nativeStale"),
                MusicStatus::Busy => Some("nativeBusy"),
                MusicStatus::Unavailable => Some("nativeUnavailable"),
            };
            if let Some(key) = key {
                status = status.child(label(key));
            }
        }
        status
    }
    pub fn recovery_controls(&self, cx: &Context<Self>) -> Div {
        row()
            .when(self.native.room.retry_available, |s| {
                s.child(self.button(
                    "retryIntent",
                    Action::Retry,
                    self.native.connected && !self.room_busy() && !self.native.http_busy,
                    cx,
                ))
            })
            .when(self.connection.is_some(), |s| {
                s.child(self.button(
                    "refreshRoom",
                    Action::RefreshRoom,
                    !self.native.http_busy,
                    cx,
                ))
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn partial_tags_are_unknown_and_stale_active_tags_are_not_blue() {
        let moods = undertone_desktop::music::default_moods();
        let mut page = Page {
            items: vec![moods[0].clone()],
            loaded: true,
            total: 3,
            ..Default::default()
        };
        assert_eq!(own_tag(&page, &moods[0].id), ActiveTag::Active);
        assert_eq!(own_tag(&page, &moods[1].id), ActiveTag::Unknown);
        page.stale = true;
        assert_eq!(own_tag(&page, &moods[0].id), ActiveTag::Unknown);
        page.stale = false;
        page.total = 1;
        assert_eq!(own_tag(&page, &moods[1].id), ActiveTag::Inactive);
    }
    #[test]
    fn first_pages_are_sequential_without_failed_retries_or_pagination_drain() {
        let mut s = NativeState::default();
        s.room.catalogue_track_id = Some(undertone_desktop::music::default_moods()[0].id.clone());
        assert_eq!(next_page(&s, Some(Panel::Moods), &[false; 3]), Some(0));
        s.tags.failed = true;
        assert_eq!(
            next_page(&s, Some(Panel::Moods), &[true, false, false]),
            Some(1)
        );
        s.favorites.loaded = true;
        s.favorites.total = 200;
        assert_eq!(
            next_page(&s, Some(Panel::Moods), &[true, true, false]),
            Some(2)
        );
        s.moods.failed = true;
        assert_eq!(next_page(&s, Some(Panel::Moods), &[true; 3]), None);
        assert_eq!(next_page(&s, Some(Panel::Moods), &[false; 3]), None);
        s.tags.failed = false;
        assert_eq!(next_page(&s, Some(Panel::Preferences), &[false; 3]), None);
        assert_eq!(next_page(&s, None, &[false; 3]), None);
    }
    #[test]
    fn queued_authority_and_watch_order_reset_once() {
        for watch_first in [true, false] {
            let mut gate = Authority::default();
            let mut state = NativeState {
                connected: true,
                ..Default::default()
            };
            assert!(gate.reconcile(&state));
            let old = pair(&state);
            state.socket_generation += 1;
            // Both callbacks read current connection state, regardless of delivery order.
            assert!(gate.reconcile(&state), "first delivery: {watch_first}");
            assert!(!gate.reconcile(&state));
            assert_ne!(old, pair(&state));
            assert!(!gate.accepts_event(&state, old));
            assert!(gate.accepts_event(&state, pair(&state)));
            assert!(gate.accepts(&state));
            gate.fence(&state);
            assert!(!gate.accepts(&state));
            assert!(!gate.reconcile(&state));
            state.account_generation += 1;
            assert!(gate.reconcile(&state));
            assert!(!gate.accepts_event(&state, (0, state.socket_generation)));
            assert!(gate.accepts(&state));
            state.connected = false;
            assert!(gate.reconcile(&state));
            assert!(!gate.accepts(&state));
            assert!(!gate.reconcile(&state));
        }
    }

    #[test]
    fn delayed_watch_preserves_already_applied_capabilities_and_nonce() {
        use undertone_desktop::bridge::{Observation, Observer};
        let mut gate = Authority::default();
        let mut state = NativeState {
            connected: true,
            ..Default::default()
        };
        assert!(gate.reconcile(&state));
        state.socket_generation += 1;
        assert!(gate.reconcile(&state));
        let mut observer = Observer::new(42);
        let capability =
            serde_json::json!({"action":"playback-capabilities","version":1,"recovery":"snapshot"});
        assert!(matches!(
            observer.observe(&capability),
            Ok(Observation::Capability)
        ));
        let subscription = observer.subscribe();
        // The queued native delivery reads the same current authority, so no second reset.
        assert!(!gate.reconcile(&state));
        assert_eq!(subscription, observer.subscribe());
        assert!(matches!(
            observer.observe(&capability),
            Ok(Observation::Ignore)
        ));
    }
    #[test]
    fn drafts_preserve_unknown_ids_and_require_explicit_choice() {
        let mut draft = PreferenceDraft {
            include: vec!["unknown".into()],
            exclude: vec!["other".into()],
            dirty: true,
            ..Default::default()
        };
        draft.set("known".into(), -1);
        assert_eq!(draft.include, ["unknown"]);
        assert_eq!(draft.exclude, ["other", "known"]);
        draft.set("unknown".into(), 0);
        assert!(draft.include.is_empty());
        assert_eq!(draft.exclude, ["other", "known"]);
        draft.set("known".into(), 1);
        assert_eq!(draft.include, ["known"]);
        assert_eq!(draft.exclude, ["other"]);
    }

    #[test]
    fn successful_preferences_wait_for_authoritative_participant_sync() {
        let mut s = NativeState::default();
        s.room.own_client_id = Some("client".into());
        s.room.music = Some(serde_json::from_value(serde_json::json!({
            "revision":1,"planRevision":1,"queue":[],"queueTotal":0,"current":null,"settings":{},
            "participants":[{"participantId":"person","clientIds":["client"],"includeMoodIds":["old"],"excludeMoodIds":[]}]
        })).unwrap());
        let mut draft = PreferenceDraft::default();
        draft.read(&s, false);
        draft.set("new".into(), 1);
        draft.awaiting_sync = true;
        draft.read(&s, false);
        assert_eq!(draft.include, ["old", "new"]);
        assert!(draft.awaiting_sync && draft.dirty);
        s.room.music.as_mut().unwrap().participants[0].include_mood_ids =
            vec!["new".into(), "old".into()];
        draft.read(&s, false);
        assert!(!draft.awaiting_sync && !draft.dirty);
        assert_eq!(draft.include, ["new", "old"]);
    }
}
