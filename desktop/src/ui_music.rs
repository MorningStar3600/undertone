//! Native form orchestration and bounded detail panels. No playback IPC or raw REST data.
use super::{
    Control, Player, ui,
    ui_input::{InputEvent, NativeInput},
};
use gpui::{Context, Div, Entity, Focusable, Stateful, Window, div, prelude::*, px, rgb};
use std::collections::BTreeMap;
use undertone_desktop::{
    music::{
        ActiveTag, ConfirmationOffer, Content, ICON_KEYS, Intent, Mood, MoodChip, MusicCommand,
        MusicStatus, Page, Reference,
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

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
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
    /// Toggle a panel (header buttons).
    Panel(Panel),
    /// Open a panel without toggling it closed (links, tabs, widget).
    Show(Panel),
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
    Preview(u64),
    Identity,
}
struct PendingHttp {
    work: HttpWork,
    saw_busy: bool,
    before: String,
}
impl PendingHttp {
    fn completed(&mut self, state: &NativeState) -> bool {
        if let HttpWork::Preview(request_id) = self.work {
            return state.preview_completed_id == Some(request_id);
        }
        self.saw_busy |= state.http_busy;
        !state.http_busy && (self.saw_busy || marker(self.work, state) != self.before)
    }
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
        HttpWork::Preview(_) => format!(
            "{}:{:?}",
            s.preview_generation,
            s.preview.as_ref().map(|p| p.items.len())
        ),
        HttpWork::Identity => format!("{:?}:{}", pair(s), s.account.known),
    };
    format!("{value}:{:?}", s.error)
}

pub struct MusicUi {
    pub scrolling: super::ui_scroll::PanelScroll,
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
                    if p.native.preview.is_some()
                        || p.music_ui
                            .pending_http
                            .as_ref()
                            .is_some_and(|pending| matches!(pending.work, HttpWork::Preview(_)))
                    {
                        p.native_submit(
                            p.music_ui.rendered_authority,
                            NativeCommand::InvalidatePreview,
                            None,
                        );
                    }
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
            scrolling: super::ui_scroll::PanelScroll::default(),
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
    pub(super) fn busy(&self, s: &NativeState) -> bool {
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
        self.music_ui
            .scrolling
            .handle
            .set_offset(gpui::point(px(0.), px(0.)));
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
        self.clear_artwork();
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
        if let Some(pending) = &mut self.music_ui.pending_http
            && pending.completed(&state)
        {
            if let HttpWork::Preview(request_id) = pending.work {
                self.music_ui.preview_valid = state.preview.is_some()
                    && state.preview_request_id == Some(request_id)
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
    pub(super) fn drive_pages(&mut self) {
        let authority = self.native.authority();
        if !self.native.can().account_write || self.music_ui.busy(&self.native) {
            return;
        }
        let next = self.music_ui.reload.iter().position(|r| *r).or_else(|| {
            next_page(
                &self.native,
                visible_mood_surface(self.music_ui.panel, self.widget.is_some()),
                &self.music_ui.attempted,
            )
        });
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
                self.music_ui
                    .scrolling
                    .handle
                    .set_offset(gpui::point(px(0.), px(0.)));
                self.music_ui.panel = if self.music_ui.panel == Some(panel) {
                    None
                } else {
                    Some(panel)
                };
                self.drive_pages();
            }
            Action::Show(panel) => {
                if self.music_ui.panel != Some(panel) {
                    self.music_ui
                        .scrolling
                        .handle
                        .set_offset(gpui::point(px(0.), px(0.)));
                    self.music_ui.panel = Some(panel);
                }
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
                let input = self.music_ui.url.read(cx).value().trim().to_owned();
                let request_id = self.music_ui.command_sequence.wrapping_add(1);
                self.music_ui.preview_valid = false;
                self.music_ui.preview_version = self.music_ui.url_version;
                self.native_submit(
                    authority,
                    NativeCommand::SearchMusic { input, request_id },
                    Some(HttpWork::Preview(request_id)),
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
                        .is_some_and(|p| p.items.iter().any(|p| p.reference == reference))
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
                    NativeCommand::Music(MusicCommand::RequestPreview {
                        request_id,
                        intent,
                        reference,
                    }),
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
/// Which mood surface is on screen. With no panel open, the main player shows the one-click
/// mood strip; other panels hide it, unless the widget (which always shows chips) is open.
fn visible_mood_surface(panel: Option<Panel>, widget: bool) -> Option<Panel> {
    match panel {
        None => Some(Panel::Moods),
        Some(panel @ (Panel::Moods | Panel::Preferences)) => Some(panel),
        Some(_) => widget.then_some(Panel::Moods),
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
/// Wrapping row for chips and button groups.
fn wrap() -> Div {
    div().flex().items_center().flex_wrap().gap(px(8.))
}
/// Single, non-wrapping row.
fn line() -> Div {
    div().flex().items_center().gap(px(8.))
}
fn label(key: &str) -> Div {
    div()
        .text_size(px(12.))
        .text_color(rgb(ui::MUTED))
        .child(text(key))
}
fn heading(key: &str) -> Div {
    ui::section_label(text(key))
}
fn provider_name(service: &str) -> String {
    match service {
        "youtube" => "YouTube".into(),
        "vimeo" => "Vimeo".into(),
        "googledrive" => "Google Drive".into(),
        "reddit" => "Reddit".into(),
        "tubi" => "Tubi".into(),
        "pluto" => "Pluto TV".into(),
        "direct" | "hls" | "dash" => text("directSource"),
        other => other.to_owned(),
    }
}
pub(super) fn result_meta(service: &str, length: Option<f64>) -> String {
    let mut parts = vec![provider_name(service)];
    if let Some(length) = length {
        parts.push(ui::time(length));
    }
    parts.join(" · ")
}

impl Player {
    fn panel_input(&self, input: &Entity<NativeInput>, cx: &Context<Self>) -> Div {
        self.music_ui
            .scrolling
            .watch(div().w_full().child(input.clone()), input.focus_handle(cx))
    }

    /// Shared behaviour of every native action control: focus, keyboard and captured authority.
    fn action_base(
        &self,
        id: impl Into<gpui::ElementId>,
        action: Action,
        enabled: bool,
        cx: &Context<Self>,
    ) -> Stateful<Div> {
        let authority = self.native.authority();
        let id = id.into();
        let focus = self.music_ui.scrolling.focus(id.clone(), cx);
        let element = if self.music_ui.scrolling.rendering.get() {
            self.music_ui.scrolling.watch(div(), focus.clone())
        } else {
            div()
        };
        element
            .id(id)
            .flex()
            .items_center()
            .justify_center()
            .flex_shrink_0()
            .when(enabled, |s| {
                s.cursor_pointer()
                    .track_focus(&focus)
                    .tab_stop(true)
                    .focus(|s| s.bg(rgb(ui::SECONDARY)))
            })
            .on_click(cx.listener(move |p, _, w, cx| {
                if enabled {
                    p.music_action(action.clone(), authority, w, cx);
                }
            }))
    }

    /// Bordered secondary button with a text label.
    pub fn action_button(
        &self,
        id: impl Into<gpui::ElementId>,
        title: String,
        action: Action,
        enabled: bool,
        selected: bool,
        cx: &Context<Self>,
    ) -> Stateful<Div> {
        self.action_base(id, action, enabled, cx)
            .h(px(32.))
            .px(px(12.))
            .gap(px(6.))
            .rounded(px(9.))
            .border_1()
            .border_color(rgb(if selected { ui::AMBER } else { ui::BORDER }))
            .bg(rgb(if selected {
                ui::AMBER_SURFACE
            } else {
                ui::POPOVER
            }))
            .text_size(px(12.))
            .text_color(rgb(if !enabled {
                ui::FAINT
            } else if selected {
                ui::AMBER
            } else {
                ui::TEXT
            }))
            .when(enabled, |s| {
                s.hover(|s| s.bg(rgb(ui::SECONDARY)))
                    .focus(|s| s.border_color(rgb(ui::AMBER)))
            })
            .child(title)
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

    /// The one amber action of a form or panel.
    fn primary_button(
        &self,
        id: impl Into<gpui::ElementId>,
        glyph: Option<&'static str>,
        title: String,
        action: Action,
        enabled: bool,
        cx: &Context<Self>,
    ) -> Stateful<Div> {
        let foreground = if enabled { ui::AMBER_TEXT } else { ui::FAINT };
        self.action_base(id, action, enabled, cx)
            .h(px(36.))
            .px(px(16.))
            .gap(px(8.))
            .rounded(px(10.))
            .border_1()
            .border_color(rgb(if enabled { ui::AMBER } else { ui::BORDER }))
            .bg(rgb(if enabled { ui::AMBER } else { ui::SECONDARY }))
            .text_size(px(13.))
            .font_weight(gpui::FontWeight::SEMIBOLD)
            .text_color(rgb(foreground))
            .when(enabled, |s| {
                s.hover(|s| s.bg(rgb(ui::AMBER_HOVER)))
                    .focus(|s| s.border_color(rgb(ui::TEXT)))
            })
            .when_some(glyph, |s, glyph| {
                s.child(ui::icon(glyph, 16.).text_color(rgb(foreground)))
            })
            .child(title)
    }

    /// Square icon-only action with a tooltip.
    #[expect(
        clippy::too_many_arguments,
        reason = "glyph, tooltip, action, enabled and selected state stay explicit"
    )]
    pub fn icon_action(
        &self,
        id: impl Into<gpui::ElementId>,
        glyph: &'static str,
        tip: String,
        action: Action,
        enabled: bool,
        selected: bool,
        cx: &Context<Self>,
    ) -> Stateful<Div> {
        let foreground = if !enabled {
            ui::FAINT
        } else if selected {
            ui::AMBER
        } else {
            ui::TEXT
        };
        self.action_base(id, action, enabled, cx)
            .size(px(32.))
            .rounded(px(9.))
            .when(selected, |s| s.bg(rgb(ui::AMBER_SURFACE)))
            .when(enabled, |s| s.hover(|s| s.bg(rgb(ui::SECONDARY))))
            .tooltip(move |_, cx| cx.new(|_| ui::Tip(tip.clone())).into())
            .child(ui::icon(glyph, 16.).text_color(rgb(foreground)))
    }

    /// Header pill: icon plus a short label.
    #[expect(
        clippy::too_many_arguments,
        reason = "glyph, label, action, selected and accent state stay explicit"
    )]
    pub fn pill_action(
        &self,
        id: &'static str,
        glyph: &'static str,
        label: String,
        action: Action,
        selected: bool,
        accent: bool,
        cx: &Context<Self>,
    ) -> Stateful<Div> {
        let foreground = if selected || accent {
            ui::AMBER
        } else {
            ui::TEXT
        };
        self.action_base(id, action, true, cx)
            .h(px(32.))
            .max_w(px(170.))
            .px(px(12.))
            .gap(px(7.))
            .rounded(px(9.))
            .border_1()
            .border_color(rgb(if selected {
                ui::AMBER
            } else if accent {
                0x5a4520
            } else {
                ui::BORDER
            }))
            .bg(rgb(if selected {
                ui::AMBER_SURFACE
            } else {
                ui::CARD
            }))
            .text_size(px(12.))
            .text_color(rgb(foreground))
            .hover(|s| s.bg(rgb(ui::SECONDARY)))
            .focus(|s| s.border_color(rgb(ui::AMBER)))
            .child(ui::icon(glyph, 15.).text_color(rgb(foreground)))
            .child(div().min_w_0().truncate().child(label))
    }

    /// Quiet "See queue ›" style navigation.
    pub fn link_action(
        &self,
        id: &'static str,
        label: String,
        action: Action,
        enabled: bool,
        cx: &Context<Self>,
    ) -> Stateful<Div> {
        self.action_base(id, action, enabled, cx)
            .h(px(24.))
            .px(px(6.))
            .gap(px(2.))
            .rounded(px(6.))
            .text_size(px(12.))
            .text_color(rgb(ui::MUTED))
            .when(enabled, |s| s.hover(|s| s.text_color(rgb(ui::TEXT))))
            .child(label)
            .child(ui::icon("chevron", 14.).text_color(rgb(ui::MUTED)))
    }

    /// Full-width secondary action ("Add a track").
    pub fn wide_action(
        &self,
        id: &'static str,
        glyph: &'static str,
        label: String,
        action: Action,
        enabled: bool,
        cx: &Context<Self>,
    ) -> Stateful<Div> {
        let foreground = if enabled { ui::TEXT } else { ui::FAINT };
        self.action_base(id, action, enabled, cx)
            .w_full()
            .h(px(40.))
            .gap(px(8.))
            .rounded(px(12.))
            .border_1()
            .border_color(rgb(ui::BORDER))
            .bg(rgb(ui::POPOVER))
            .text_size(px(13.))
            .font_weight(gpui::FontWeight::SEMIBOLD)
            .text_color(rgb(foreground))
            .when(enabled, |s| {
                s.hover(|s| s.bg(rgb(ui::SECONDARY)))
                    .focus(|s| s.border_color(rgb(ui::AMBER)))
            })
            .child(ui::icon(glyph, 16.).text_color(rgb(foreground)))
            .child(label)
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

    /// One mood. The body toggles your tag on the current track; the optional heart toggles the
    /// favorite shortcut. Only confirmed own Active tags are blue; Unknown cannot be toggled.
    fn mood_chip(&self, mood: &Mood, scope: &str, with_favorite: bool, cx: &Context<Self>) -> Div {
        let can_write = self.native.can().account_write;
        let own = can_write && !self.music_ui.busy(&self.native);
        let state = self.tag_state(&mood.id);
        let confirmed = state == ActiveTag::Active;
        let blue = confirmed && self.native.account.logged_in && !self.native.account.expired;
        let favorite = self.native.favorites.items.iter().any(|m| m.id == mood.id)
            && !self.native.favorites.stale
            && !self.native.favorites.failed;
        let favorite_known = favorite || self.native.favorites.complete();
        let track = self.native.room.track_id();
        let tag_enabled = own && track.is_some() && state != ActiveTag::Unknown;
        let favorite_enabled = own && favorite_known;
        let foreground = if blue {
            ui::PERSONAL
        } else if tag_enabled {
            ui::TEXT
        } else {
            ui::MUTED
        };
        let tag_tip = text(if !can_write {
            "signInToTag"
        } else if track.is_none() {
            "catalogueNeededShort"
        } else {
            match state {
                ActiveTag::Active => "tagRemoveTip",
                ActiveTag::Inactive => "tagAddTip",
                ActiveTag::Unknown => "tagUnknownTip",
            }
        });
        let favorite_tip = text(if !can_write {
            "signInToTag"
        } else if favorite {
            "unfavoriteTip"
        } else if favorite_known {
            "favoriteTip"
        } else {
            "tagUnknownTip"
        });
        let id = &mood.id;
        div()
            .flex()
            .items_center()
            .flex_shrink_0()
            .h(px(32.))
            .rounded(px(10.))
            .border_1()
            .border_color(rgb(if blue {
                ui::PERSONAL_BORDER
            } else {
                ui::BORDER
            }))
            .bg(rgb(if blue {
                ui::PERSONAL_SURFACE
            } else {
                ui::POPOVER
            }))
            .overflow_hidden()
            .child(
                self.action_base(
                    gpui::SharedString::from(format!("{scope}-tag-{id}")),
                    Action::Tag {
                        track: track.unwrap_or_default().into(),
                        epoch: self.native.track_generation,
                        mood: id.clone(),
                        active: !confirmed,
                    },
                    tag_enabled,
                    cx,
                )
                .h_full()
                .pl(px(10.))
                .pr(px(if with_favorite { 8. } else { 12. }))
                .gap(px(6.))
                .text_size(px(12.))
                .text_color(rgb(foreground))
                .when(tag_enabled, |s| {
                    s.hover(move |s| s.bg(rgb(if blue { 0x29425e } else { ui::SECONDARY })))
                })
                .tooltip(move |_, cx| cx.new(|_| ui::Tip(tag_tip.clone())).into())
                .child(ui::icon(ui::mood_glyph(&mood.icon_key), 14.).text_color(rgb(foreground)))
                .child(div().max_w(px(150.)).truncate().child(mood.name.clone()))
                .when(blue, |s| {
                    s.child(ui::icon("check", 12.).text_color(rgb(ui::PERSONAL)))
                }),
            )
            .when(with_favorite, |s| {
                s.child(div().w(px(1.)).h(px(16.)).bg(rgb(ui::BORDER)))
                    .child(
                        self.action_base(
                            gpui::SharedString::from(format!("{scope}-favorite-{id}")),
                            Action::Favorite {
                                mood: id.clone(),
                                active: !favorite,
                            },
                            favorite_enabled,
                            cx,
                        )
                        .h_full()
                        .w(px(30.))
                        .when(favorite_enabled, |s| s.hover(|s| s.bg(rgb(ui::SECONDARY))))
                        .tooltip(move |_, cx| cx.new(|_| ui::Tip(favorite_tip.clone())).into())
                        .child(
                            ui::icon(if favorite { "heart-fill" } else { "heart" }, 13.)
                                .text_color(rgb(if favorite {
                                    ui::AMBER
                                } else if favorite_enabled {
                                    ui::MUTED
                                } else {
                                    ui::FAINT
                                })),
                        ),
                    )
            })
    }

    /// "My moods on this track" card of the main player: one-click tags, then All moods.
    pub fn mood_strip(&self, cx: &Context<Self>) -> Div {
        let groups = self.native.mood_groups();
        let music = self.native.room.active();
        let signed_in = self.native.can().account_write;
        // Same order as the widget: your moods first, then the contributor's suggestions.
        let chips: Vec<_> = groups
            .complement
            .iter()
            .chain(&groups.priority)
            .take(6)
            .collect();
        let suggestions = self.details.tags.join(" · ");
        let hint = if !music {
            text("musicModeShort")
        } else if !signed_in {
            text("signInToTag")
        } else if !suggestions.is_empty() {
            match self.contributor_name() {
                Some(name) => format!("{} {name} : {suggestions}", text("suggestedBy")),
                None => format!("{} {suggestions}", text("widgetSuggestions")),
            }
        } else if chips.is_empty() {
            text("widgetMoodsHint")
        } else {
            text("widgetTagHint")
        };
        ui::card()
            .flex_shrink_0()
            .p(px(16.))
            .flex()
            .flex_col()
            .gap(px(10.))
            .child(
                line()
                    .justify_between()
                    .child(
                        div()
                            .text_size(px(13.))
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .child(text("widgetMoods")),
                    )
                    .child(self.link_action(
                        "all-moods",
                        text("allMoods"),
                        Action::Show(Panel::Moods),
                        true,
                        cx,
                    )),
            )
            .child(
                wrap()
                    .children(
                        chips
                            .iter()
                            .map(|chip| self.mood_chip(&chip.mood, "strip", false, cx)),
                    )
                    .child(
                        self.icon_action(
                            "strip-more",
                            "plus",
                            text("allMoods"),
                            Action::Show(Panel::Moods),
                            true,
                            false,
                            cx,
                        )
                        .border_1()
                        .border_color(rgb(ui::BORDER)),
                    ),
            )
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(rgb(ui::MUTED))
                    .truncate()
                    .child(hint),
            )
    }

    /// Only shown when something needs attention: loading, a failure, unloaded or more pages.
    fn page_status(&self, kind: usize, cx: &Context<Self>) -> Option<Div> {
        if !self.native.can().account_write || (kind == 0 && self.native.room.track_id().is_none())
        {
            return None;
        }
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
        if page.loading {
            return Some(label("nativePending"));
        }
        let (state, button, offset) = if page.failed {
            ("pageFailed", "retry", 0)
        } else if !page.loaded || page.stale {
            ("pageNotLoaded", "load", 0)
        } else if page.has_more() {
            ("pagePartial", "loadMore", page.next_offset())
        } else {
            return None;
        };
        Some(
            line()
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .text_size(px(12.))
                        .text_color(rgb(if page.failed { ui::DANGER } else { ui::MUTED }))
                        .child(format!("{} · {}", text(title), text(state))),
                )
                .child(self.action_button(
                    ("page", kind),
                    text(button),
                    action(offset),
                    !self.music_ui.busy(&self.native),
                    false,
                    cx,
                )),
        )
    }

    fn mood_section(
        &self,
        title: String,
        moods: &[MoodChip],
        empty: &str,
        scope: &str,
        cx: &Context<Self>,
    ) -> Div {
        column()
            .gap(px(10.))
            .child(ui::section_label(title))
            .child(if moods.is_empty() {
                label(empty)
            } else {
                wrap().children(
                    moods
                        .iter()
                        .map(|chip| self.mood_chip(&chip.mood, scope, true, cx)),
                )
            })
    }

    fn account_panel(&self, cx: &Context<Self>) -> Div {
        let account = &self.native.account;
        let free = !self.music_ui.busy(&self.native) && self.connection.is_some();
        let signed_in = account.logged_in && !account.expired;
        let check = self.button(
            "refreshAccount",
            Action::RefreshAccount,
            self.connection.is_some() && !self.native.http_busy,
            cx,
        );
        column()
            .gap(px(16.))
            .child(
                line()
                    .gap(px(12.))
                    .child(
                        div()
                            .size(px(44.))
                            .flex_shrink_0()
                            .rounded_full()
                            .bg(rgb(if signed_in {
                                ui::AMBER_SURFACE
                            } else {
                                ui::SECONDARY
                            }))
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(ui::icon("user", 20.).text_color(rgb(if signed_in {
                                ui::AMBER
                            } else {
                                ui::MUTED
                            }))),
                    )
                    .child(
                        column()
                            .gap(px(2.))
                            .min_w_0()
                            .child(
                                div()
                                    .text_size(px(15.))
                                    .font_weight(gpui::FontWeight::SEMIBOLD)
                                    .truncate()
                                    .child(if signed_in {
                                        account.username.clone().unwrap_or_else(|| text("account"))
                                    } else {
                                        text("guest")
                                    }),
                            )
                            .child(label(if account.expired {
                                "accountExpired"
                            } else if !account.known {
                                "accountUnknown"
                            } else if account.logged_in {
                                "accountSignedIn"
                            } else {
                                "accountGuest"
                            })),
                    ),
            )
            .map(|panel| {
                if signed_in {
                    panel.child(
                        wrap()
                            .child(self.button("signOut", Action::Logout, free, cx))
                            .child(check),
                    )
                } else {
                    panel
                        .child(label("accountGuestBody"))
                        .child(self.panel_input(&self.music_ui.user, cx))
                        .child(self.panel_input(&self.music_ui.password, cx))
                        .child(
                            wrap()
                                .child(self.primary_button(
                                    "signIn",
                                    Some("user"),
                                    text("signIn"),
                                    Action::Login,
                                    free && !self.music_ui.user.read(cx).value().trim().is_empty()
                                        && !self.music_ui.password.read(cx).value().is_empty(),
                                    cx,
                                ))
                                .child(check),
                        )
                        .child(label("passwordAccountsOnly"))
                }
            })
    }

    fn moods_panel(&self, cx: &Context<Self>) -> Div {
        let groups = self.native.mood_groups();
        let can = self.native.can();
        let query = self.music_ui.search.read(cx).value().trim().to_lowercase();
        let shown: Vec<&str> = groups
            .priority
            .iter()
            .chain(&groups.complement)
            .map(|chip| chip.mood.id.as_str())
            .collect();
        // Without a query, list what is not already shown above.
        let found: Vec<Mood> = self
            .vocabulary()
            .into_iter()
            .filter(|m| {
                if query.is_empty() {
                    !shown.contains(&m.id.as_str())
                } else {
                    m.name.to_lowercase().contains(&query)
                }
            })
            .collect();
        let contributor = match self.contributor_name() {
            Some(name) => format!("{} {name}", text("suggestedBy")),
            None => text("contributorMoods"),
        };
        let free = can.account_write && !self.music_ui.busy(&self.native);
        column()
            .gap(px(20.))
            .when(!can.account_write, |s| {
                s.child(
                    ui::banner(ui::Tone::Info, text("signInToTag")).child(self.action_button(
                        "moods-sign-in",
                        text("signIn"),
                        Action::Show(Panel::Account),
                        self.connection.is_some(),
                        false,
                        cx,
                    )),
                )
            })
            .when(self.native.room.track_id().is_none(), |s| {
                s.child(ui::banner(ui::Tone::Info, text("catalogueNeeded")))
            })
            .child(self.mood_section(
                contributor,
                &groups.priority,
                "noContributorMoods",
                "priority",
                cx,
            ))
            .child(self.mood_section(
                text("ownComplement"),
                &groups.complement,
                "noOwnMoods",
                "complement",
                cx,
            ))
            .when_some(self.page_status(0, cx), |s, status| s.child(status))
            .when_some(self.page_status(1, cx), |s, status| s.child(status))
            .child(
                column()
                    .gap(px(10.))
                    .child(heading("findMood"))
                    .child(self.panel_input(&self.music_ui.search, cx))
                    .child(if found.is_empty() {
                        label("noMoodMatch")
                    } else {
                        wrap().children(
                            found
                                .iter()
                                .map(|m| self.mood_chip(m, "vocabulary", true, cx)),
                        )
                    })
                    .when_some(self.page_status(2, cx), |s, status| s.child(status)),
            )
            .when(can.account_write, |s| {
                s.child(
                    column()
                        .gap(px(10.))
                        .pt(px(16.))
                        .border_t_1()
                        .border_color(rgb(ui::BORDER))
                        .child(heading("createMoodTitle"))
                        .child(label("createMoodHelp"))
                        .child(
                            wrap()
                                .gap(px(4.))
                                .children(ICON_KEYS.iter().enumerate().map(|(i, key)| {
                                    let selected = self.music_ui.icon == i;
                                    self.icon_action(
                                        ("mood-icon", i),
                                        ui::mood_glyph(key),
                                        text(&format!("icon-{key}")),
                                        Action::Icon(i),
                                        true,
                                        selected,
                                        cx,
                                    )
                                    .border_1()
                                    .border_color(rgb(
                                        if selected { ui::AMBER } else { ui::BORDER },
                                    ))
                                })),
                        )
                        .child(
                            line()
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .child(self.panel_input(&self.music_ui.name, cx)),
                                )
                                .child(self.primary_button(
                                    "createMood",
                                    Some("plus"),
                                    text("createMood"),
                                    Action::Create,
                                    free && !self.music_ui.name.read(cx).value().trim().is_empty(),
                                    cx,
                                )),
                        )
                        .when_some(self.native.created_mood.as_ref(), |s, m| {
                            s.child(label("createdMoodChoice"))
                                .child(wrap().child(self.mood_chip(m, "created", true, cx)))
                        }),
                )
            })
    }

    fn preference_choice(&self, id: &str, choice: i8, enabled: bool, cx: &Context<Self>) -> Div {
        div()
            .flex()
            .flex_shrink_0()
            .h(px(28.))
            .rounded(px(8.))
            .border_1()
            .border_color(rgb(ui::BORDER))
            .overflow_hidden()
            .bg(rgb(ui::CARD))
            .children(
                [
                    ("include", 1i8, "includeTip"),
                    ("neutral", 0, "neutralTip"),
                    ("exclude", -1, "excludeTip"),
                ]
                .into_iter()
                .map(|(key, value, tip)| {
                    let selected = choice == value;
                    let (surface, foreground) = match (selected, value) {
                        (true, 1) => (ui::AMBER_SURFACE, ui::AMBER),
                        (true, -1) => (ui::DANGER_SURFACE, ui::DANGER),
                        (true, _) => (ui::SECONDARY, ui::TEXT),
                        _ => (ui::CARD, if enabled { ui::MUTED } else { ui::FAINT }),
                    };
                    let tip = text(tip);
                    self.action_base(
                        gpui::SharedString::from(format!("{key}-{id}")),
                        Action::Preference(id.to_owned(), value),
                        enabled,
                        cx,
                    )
                    .h_full()
                    .px(px(10.))
                    .bg(rgb(surface))
                    .text_size(px(11.))
                    .text_color(rgb(foreground))
                    .when(enabled && !selected, |s| {
                        s.hover(|s| s.bg(rgb(ui::SECONDARY)))
                    })
                    .tooltip(move |_, cx| cx.new(|_| ui::Tip(tip.clone())).into())
                    .child(text(key))
                }),
            )
    }

    fn preferences_enabled(&self) -> bool {
        self.native.can().preferences
            && !self.room_busy()
            && !self.native.http_busy
            && !self.music_ui.draft.awaiting_sync
    }

    fn preferences_panel(&self, cx: &Context<Self>) -> Div {
        let draft = &self.music_ui.draft;
        let enabled = self.preferences_enabled();
        let mut vocabulary: BTreeMap<String, (String, &'static str)> = self
            .vocabulary()
            .into_iter()
            .map(|m| (m.id, (m.name, ui::mood_glyph(&m.icon_key))))
            .collect();
        // Unknown saved IDs remain visible and preserved. Only an explicit choice removes them.
        for id in draft.include.iter().chain(&draft.exclude) {
            vocabulary
                .entry(id.clone())
                .or_insert_with(|| (text("unknownMood"), "brand"));
        }
        column()
            .gap(px(12.))
            .child(label("preferencesHelp"))
            .when(draft.awaiting_sync, |s| {
                s.child(ui::banner(ui::Tone::Info, text("preferencesAwaitingSync")))
            })
            .when(!self.native.room.active(), |s| {
                s.child(ui::banner(ui::Tone::Warn, text("musicModeNeeded")))
            })
            .child(
                column()
                    .gap(px(6.))
                    .children(vocabulary.iter().map(|(id, (name, glyph))| {
                        let choice = if draft.include.contains(id) {
                            1
                        } else if draft.exclude.contains(id) {
                            -1
                        } else {
                            0
                        };
                        line()
                            .h(px(40.))
                            .px(px(10.))
                            .gap(px(10.))
                            .rounded(px(10.))
                            .bg(rgb(ui::POPOVER))
                            .child(ui::icon(glyph, 15.).text_color(rgb(match choice {
                                1 => ui::AMBER,
                                -1 => ui::DANGER,
                                _ => ui::MUTED,
                            })))
                            .child(div().flex_1().min_w_0().truncate().child(name.clone()))
                            .child(self.preference_choice(id, choice, enabled, cx))
                    })),
            )
            .when_some(self.page_status(2, cx), |s, status| s.child(status))
    }

    /// Save bar of the room preferences tab, outside the scrolling list.
    fn preference_footer(&self, cx: &Context<Self>) -> Div {
        let dirty = self.music_ui.draft.dirty;
        let enabled = self.preferences_enabled() && dirty;
        let keep = text("keepHelp");
        let renew = text("renewHelp");
        line()
            .flex_shrink_0()
            .pt(px(12.))
            .border_t_1()
            .border_color(rgb(ui::BORDER))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .text_size(px(12.))
                    .text_color(rgb(if dirty { ui::AMBER } else { ui::MUTED }))
                    .child(text(if dirty {
                        "unsavedChanges"
                    } else {
                        "noUnsavedChanges"
                    })),
            )
            .child(self.button("resetDraft", Action::ResetDraft, !self.room_busy(), cx))
            .child(
                self.action_button(
                    "saveRenew",
                    text("saveRenew"),
                    Action::Save(Content::Renew),
                    enabled,
                    false,
                    cx,
                )
                .tooltip(move |_, cx| cx.new(|_| ui::Tip(renew.clone())).into()),
            )
            .child(
                self.primary_button(
                    "saveKeep",
                    Some("check"),
                    text("saveKeep"),
                    Action::Save(Content::Keep),
                    enabled,
                    cx,
                )
                .tooltip(move |_, cx| cx.new(|_| ui::Tip(keep.clone())).into()),
            )
    }

    fn confirmation_card(
        &self,
        offer: &undertone_desktop::music::Request,
        ready: bool,
        cx: &Context<Self>,
    ) -> Div {
        column()
            .gap(px(8.))
            .p(px(14.))
            .rounded(px(12.))
            .bg(rgb(ui::AMBER_SURFACE))
            .border_1()
            .border_color(rgb(ui::AMBER))
            .child(
                div()
                    .text_size(px(14.))
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .text_color(rgb(ui::AMBER))
                    .child(text("confirmTitle")),
            )
            .child(
                div()
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .truncate()
                    .child(offer.title.clone().unwrap_or_else(|| text("untitledTrack"))),
            )
            .child(label("confirmationHelp"))
            .children(offer.conflicts.iter().map(|c| {
                let detail = offer
                    .conflict_metadata
                    .iter()
                    .find(|d| d.participant_id == c.participant_id && d.mood_id == c.mood_id);
                match detail.and_then(|d| d.participant_name.as_ref().zip(d.mood.as_ref())) {
                    Some((name, mood)) => line()
                        .text_size(px(12.))
                        .child(
                            ui::icon(ui::mood_glyph(&mood.icon_key), 14.)
                                .text_color(rgb(ui::DANGER)),
                        )
                        .child(format!("{name} · {}", mood.name)),
                    None => label("confirmationIncomplete"),
                }
            }))
            .child(
                wrap()
                    .child(self.primary_button(
                        "confirm",
                        None,
                        text("confirm"),
                        Action::Confirm(self.native.room.confirmation_offer()),
                        ready && self.native.can().confirm,
                        cx,
                    ))
                    .child(self.button(
                        "cancel",
                        Action::Cancel(offer.request_id.clone()),
                        ready,
                        cx,
                    )),
            )
    }

    fn pending_requests(&self, ready: bool, cx: &Context<Self>) -> Option<Div> {
        let page = &self.native.room.requests_page;
        let count = self.native.room.pending_count;
        if count == Some(0) && page.items.is_empty() && !page.stale {
            return None;
        }
        Some(
            column()
                .gap(px(8.))
                .pt(px(14.))
                .border_t_1()
                .border_color(rgb(ui::BORDER))
                .child(
                    line()
                        .justify_between()
                        .child(ui::section_label(match count {
                            Some(count) => format!("{} · {count}", text("pendingRequests")),
                            None => text("pendingRequests"),
                        }))
                        .child(self.icon_action(
                            "refreshRequests",
                            "refresh",
                            text("refreshRequests"),
                            Action::Requests(0),
                            ready && self.native.room.active(),
                            false,
                            cx,
                        )),
                )
                .children(page.items.iter().map(|r| {
                    line()
                        .h(px(36.))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
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
                .when(!page.loaded, |s| s.child(label("pendingNotLoaded")))
                .when(page.offset > 0 || page.has_more(), |s| {
                    s.child(
                        wrap()
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
                })
                .when(page.stale, |s| s.child(label("refreshPendingHelp"))),
        )
    }

    fn add_panel(&self, cx: &Context<Self>) -> Div {
        let can = self.native.can();
        let ready = self.native.connected && !self.room_busy() && !self.music_ui.busy(&self.native);
        let searching = self
            .music_ui
            .pending_http
            .as_ref()
            .is_some_and(|pending| matches!(pending.work, HttpWork::Preview(_)));
        let query_empty = self.music_ui.url.read(cx).value().trim().is_empty();
        let mut panel = column()
            .gap(px(14.))
            .when(!self.native.room.active(), |s| {
                s.child(ui::banner(ui::Tone::Warn, text("musicModeNeeded")))
            })
            .when(self.native.room.active() && !can.add_mix, |s| {
                s.child(ui::banner(ui::Tone::Warn, text("addPermissionNeeded")))
            });
        if let Some(offer) = &self.native.room.confirmation {
            panel = panel.child(self.confirmation_card(offer, ready, cx));
        }
        panel = panel.child(
            column()
                .gap(px(6.))
                .child(
                    line()
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .child(self.panel_input(&self.music_ui.url, cx)),
                        )
                        .child(self.primary_button(
                            "previewUrl",
                            Some("search"),
                            text("previewUrl"),
                            Action::Preview,
                            ready && can.add_mix && !query_empty,
                            cx,
                        )),
                )
                .child(label("addHelp")),
        );
        if searching {
            panel = panel.child(ui::banner(ui::Tone::Info, text("searching")));
        } else if self.music_ui.preview_valid
            && let Some(value) = &self.native.preview
        {
            let mix_tip = text("addMixTip");
            let next_tip = text("addNextTip");
            let mut results = column()
                .gap(px(6.))
                .child(heading(if value.items.is_empty() {
                    "musicSearchEmpty"
                } else {
                    "musicSearchChoose"
                }));
            for (index, item) in value.items.iter().enumerate() {
                let (mix_tip, next_tip) = (mix_tip.clone(), next_tip.clone());
                results = results.child(
                    line()
                        .gap(px(10.))
                        .p(px(8.))
                        .rounded(px(12.))
                        .bg(rgb(ui::POPOVER))
                        .border_1()
                        .border_color(rgb(ui::BORDER))
                        .child(ui::artwork(40., None))
                        .child(
                            column()
                                .gap(px(2.))
                                .min_w_0()
                                .flex_1()
                                .child(
                                    div()
                                        .text_size(px(13.))
                                        .font_weight(gpui::FontWeight::SEMIBOLD)
                                        .truncate()
                                        .child(
                                            item.title
                                                .clone()
                                                .unwrap_or_else(|| text("untitledTrack")),
                                        ),
                                )
                                .child(ui::quiet(
                                    result_meta(&item.reference.service, item.length),
                                    11.,
                                )),
                        )
                        .child(
                            self.action_button(
                                ("music-mix", index),
                                text("addMix"),
                                Action::Request(
                                    Intent::Mix,
                                    item.reference.clone(),
                                    self.music_ui.preview_version,
                                ),
                                ready && can.add_mix,
                                false,
                                cx,
                            )
                            .tooltip(move |_, cx| cx.new(|_| ui::Tip(mix_tip.clone())).into()),
                        )
                        .child(
                            self.action_button(
                                ("music-next", index),
                                text("addNext"),
                                Action::Request(
                                    Intent::Next,
                                    item.reference.clone(),
                                    self.music_ui.preview_version,
                                ),
                                ready && can.add_next,
                                false,
                                cx,
                            )
                            .tooltip(move |_, cx| cx.new(|_| ui::Tip(next_tip.clone())).into()),
                        ),
                );
            }
            if value.truncated {
                results = results.child(label("musicSearchLimited"));
            }
            panel = panel.child(results);
        }
        panel.when_some(self.pending_requests(ready, cx), |s, pending| {
            s.child(pending)
        })
    }

    fn queue_panel(&self, cx: &Context<Self>) -> Div {
        let page = &self.native.room.queue_page;
        let ready = self.native.connected
            && self.native.room.active()
            && !self.room_busy()
            && !self.native.http_busy;
        let paged = page.loaded && !page.stale;
        let entries = if paged {
            page.items.as_slice()
        } else {
            self.native
                .room
                .music
                .as_ref()
                .map(|m| m.queue.as_slice())
                .unwrap_or_default()
        };
        let total = self.native.room.music.as_ref().map(|m| m.queue_total);
        let first = if paged { page.offset } else { 0 };
        column()
            .gap(px(10.))
            .child(
                line()
                    .justify_between()
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(rgb(ui::MUTED))
                            .when_some(total, |s, total| {
                                s.child(format!("{total} {}", text("queueCount")))
                            }),
                    )
                    .child(self.icon_action(
                        "refreshQueue",
                        "refresh",
                        text("refreshQueue"),
                        Action::Queue(0),
                        ready,
                        false,
                        cx,
                    )),
            )
            .when(!self.native.room.active(), |s| {
                s.child(ui::banner(ui::Tone::Warn, text("musicModeNeeded")))
            })
            .when(!self.show_up_next, |s| s.child(label("upcomingHidden")))
            .when(self.show_up_next, |s| {
                s.children(entries.iter().enumerate().map(|(i, e)| {
                    line()
                        .h(px(48.))
                        .gap(px(10.))
                        .child(
                            div()
                                .w(px(22.))
                                .text_size(px(11.))
                                .text_color(rgb(ui::FAINT))
                                .child((first + i + 1).to_string()),
                        )
                        .child(ui::artwork(36., None))
                        .child(
                            column()
                                .gap(px(2.))
                                .min_w_0()
                                .flex_1()
                                .child(
                                    div()
                                        .text_size(px(13.))
                                        .font_weight(gpui::FontWeight::SEMIBOLD)
                                        .truncate()
                                        .child(
                                            e.title
                                                .clone()
                                                .unwrap_or_else(|| text("untitledTrack")),
                                        ),
                                )
                                .when(!e.artists.is_empty(), |s| {
                                    s.child(ui::quiet(e.artists.join(", "), 11.))
                                }),
                        )
                }))
            })
            .when(entries.is_empty() && self.native.room.active(), |s| {
                s.child(label("queueEmptyHint"))
            })
            .when(page.offset > 0 || page.has_more(), |s| {
                s.child(
                    wrap()
                        .child(self.button(
                            "previousPage",
                            Action::Queue(page.offset.saturating_sub(page.limit)),
                            ready && paged && page.offset > 0,
                            cx,
                        ))
                        .child(self.button(
                            "nextPage",
                            Action::Queue(page.next_offset()),
                            ready && page.has_more(),
                            cx,
                        )),
                )
            })
            .when(page.stale || page.failed, |s| {
                s.child(ui::banner(ui::Tone::Info, text("queueRefreshNeeded")))
            })
    }

    fn settings_panel(&self, cx: &Context<Self>) -> Div {
        let setting = |title: &str, help: &str| {
            column()
                .gap(px(2.))
                .flex_1()
                .min_w_0()
                .child(div().text_size(px(13.)).child(text(title)))
                .child(label(help))
        };
        column()
            .gap(px(18.))
            .child(label("volumeHelp"))
            .child(
                line()
                    .gap(px(12.))
                    .child(setting("upcomingSetting", "upcomingSettingHelp"))
                    .child(self.action_button(
                        "toggle-upcoming",
                        text(if self.show_up_next { "on" } else { "off" }),
                        Action::ToggleUpcoming,
                        true,
                        self.show_up_next,
                        cx,
                    )),
            )
            .child(
                line()
                    .gap(px(12.))
                    .child(setting("widgetSetting", "localSettingsHelp"))
                    .child(self.labeled_control(
                        if self.widget.is_some() {
                            "closeWidget"
                        } else {
                            "openWidget"
                        },
                        "compact",
                        Control::ToggleWidget,
                        cx,
                    )),
            )
            .child(
                line()
                    .gap(px(12.))
                    .child(setting("leaveSetting", "leaveHelp"))
                    .child(self.labeled_control(
                        "disconnect",
                        "disconnect",
                        Control::Disconnect,
                        cx,
                    )),
            )
    }

    pub fn detail_panel(&self, cx: &Context<Self>) -> Div {
        let Some(panel) = self.music_ui.panel else {
            return column();
        };
        let tabs = matches!(panel, Panel::Moods | Panel::Preferences);
        let header = line()
            .justify_between()
            .flex_shrink_0()
            .child(
                div()
                    .text_size(px(16.))
                    .font_weight(gpui::FontWeight::BOLD)
                    .child(text(if tabs { "moodsTitle" } else { panel.key() })),
            )
            .child(self.icon_action(
                "closePanel",
                "close",
                text("closePanel"),
                Action::Close,
                true,
                false,
                cx,
            ));
        let tab_bar = tabs.then(|| {
            div()
                .flex()
                .flex_shrink_0()
                .p(px(3.))
                .gap(px(2.))
                .rounded(px(10.))
                .bg(rgb(ui::POPOVER))
                .children([Panel::Moods, Panel::Preferences].into_iter().map(|tab| {
                    let selected = tab == panel;
                    self.action_base(
                        if tab == Panel::Moods {
                            "tab-track"
                        } else {
                            "tab-room"
                        },
                        Action::Show(tab),
                        !selected,
                        cx,
                    )
                    .flex_1()
                    .h(px(30.))
                    .rounded(px(8.))
                    .text_size(px(12.))
                    .when(selected, |s| {
                        s.bg(rgb(ui::SECONDARY))
                            .text_color(rgb(ui::TEXT))
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                    })
                    .when(!selected, |s| {
                        s.text_color(rgb(ui::MUTED))
                            .hover(|s| s.text_color(rgb(ui::TEXT)))
                    })
                    .child(text(tab.key()))
                }))
        });
        let banners = self.status_banners(cx);
        self.music_ui.scrolling.rendering.set(true);
        let content = match panel {
            Panel::Account => self.account_panel(cx),
            Panel::Moods => self.moods_panel(cx),
            Panel::Preferences => self.preferences_panel(cx),
            Panel::Add => self.add_panel(cx),
            Panel::Queue => self.queue_panel(cx),
            Panel::Settings => self.settings_panel(cx),
        };
        self.music_ui.scrolling.rendering.set(false);
        let footer = (panel == Panel::Preferences).then(|| self.preference_footer(cx));
        ui::card()
            .min_h_0()
            .flex_1()
            .p(px(16.))
            .flex()
            .flex_col()
            .gap(px(12.))
            .on_key_down(cx.listener(|p, event: &gpui::KeyDownEvent, _, cx| {
                if !event.keystroke.modifiers.control
                    && !event.keystroke.modifiers.alt
                    && !event.keystroke.modifiers.platform
                    && matches!(event.keystroke.key.as_str(), "pageup" | "pagedown")
                {
                    p.music_ui.scrolling.page(event.keystroke.key == "pagedown");
                    cx.stop_propagation();
                    cx.notify();
                }
            }))
            .child(header)
            .when_some(tab_bar, |s, tabs| s.child(tabs))
            .when_some(banners, |s, banners| s.child(banners))
            .child(
                div()
                    .id("native-detail-scroll")
                    .min_h_0()
                    .flex_1()
                    .overflow_y_scroll()
                    .track_scroll(&self.music_ui.scrolling.handle)
                    .child(content.pb(px(4.))),
            )
            .when_some(footer, |s, footer| s.child(footer))
    }

    /// Server/room outcomes that need the user's attention, with their explicit recovery.
    /// Nothing is rendered when everything is fine; Refresh room also lives in the header.
    pub fn status_banners(&self, cx: &Context<Self>) -> Option<Div> {
        let mut items: Vec<Div> = Vec::new();
        let mut refresh = false;
        if self.native.http_busy || self.native.room.busy || self.music_ui.pending_http.is_some() {
            items.push(ui::banner(ui::Tone::Info, text("nativePending")));
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
            refresh |= matches!(
                error.code,
                ErrorCode::Stale | ErrorCode::Auth | ErrorCode::Unavailable
            );
            let message = match error.retry_after_seconds {
                Some(seconds) => format!(
                    "{} {} {seconds} {}",
                    text(key),
                    text("retryAfter"),
                    text("seconds")
                ),
                None => text(key),
            };
            items.push(ui::banner(ui::Tone::Error, message));
        }
        let mut review = false;
        if let Some(result) = self.native.room.status {
            let key = match result {
                MusicStatus::Applied | MusicStatus::Duplicate => None,
                MusicStatus::ConfirmationRequired => {
                    review = self.music_ui.panel != Some(Panel::Add);
                    Some("musicConfirmation")
                }
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
                refresh |= !review;
                items.push(ui::banner(ui::Tone::Warn, text(key)));
            }
        }
        let retry = self.native.room.retry_available;
        if retry || refresh || review {
            items.push(
                wrap()
                    .when(review, |s| {
                        s.child(self.action_button(
                            "reviewConfirmation",
                            text("reviewConfirmation"),
                            Action::Show(Panel::Add),
                            true,
                            false,
                            cx,
                        ))
                    })
                    .when(retry, |s| {
                        s.child(self.button(
                            "retryIntent",
                            Action::Retry,
                            self.native.connected && !self.room_busy() && !self.native.http_busy,
                            cx,
                        ))
                    })
                    .when(refresh && self.connection.is_some(), |s| {
                        s.child(self.button(
                            "refreshRoom",
                            Action::RefreshRoom,
                            !self.native.http_busy,
                            cx,
                        ))
                    }),
            );
        }
        (!items.is_empty()).then(|| column().gap(px(8.)).flex_shrink_0().children(items))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mood_pages_load_only_while_a_mood_surface_is_visible() {
        // Main player with no panel shows the mood strip.
        assert_eq!(visible_mood_surface(None, false), Some(Panel::Moods));
        assert_eq!(
            visible_mood_surface(Some(Panel::Preferences), false),
            Some(Panel::Preferences)
        );
        // Add/Queue/Account/Settings hide the strip; only the widget keeps chips visible.
        for panel in [Panel::Add, Panel::Queue, Panel::Account, Panel::Settings] {
            assert_eq!(visible_mood_surface(Some(panel), false), None);
            assert_eq!(visible_mood_surface(Some(panel), true), Some(Panel::Moods));
        }
    }

    #[test]
    fn search_results_show_only_supplied_provider_and_duration() {
        assert_eq!(result_meta("youtube", Some(225.)), "YouTube · 3:45");
        assert_eq!(result_meta("vimeo", None), "Vimeo");
        assert_eq!(result_meta("hls", None), text("directSource"));
    }

    #[test]
    fn edit_snapshot_cannot_complete_a_newer_search() {
        let mut state = NativeState {
            preview_request_id: Some(10),
            preview_completed_id: Some(10),
            ..NativeState::default()
        };
        let mut pending = PendingHttp {
            work: HttpWork::Preview(11),
            saw_busy: false,
            before: marker(HttpWork::Preview(11), &state),
        };
        // The queued input edit arrives after submission but before search 11 starts.
        state.preview_generation += 1;
        state.preview_request_id = None;
        assert!(!pending.completed(&state));
        // Neither another operation's error nor the search's busy snapshot completes it.
        state.error = Some(undertone_desktop::session::NativeError {
            code: undertone_desktop::session::ErrorCode::Busy,
            retry_after_seconds: None,
        });
        assert!(!pending.completed(&state));
        state.preview_request_id = Some(11);
        state.http_busy = true;
        assert!(!pending.completed(&state));
        state.http_busy = false;
        state.error = None;
        state.preview_completed_id = Some(11);
        assert!(pending.completed(&state));
        // Coalesced success, empty result, or failure also completes without observing busy.
        let mut coalesced = PendingHttp {
            work: HttpWork::Preview(11),
            saw_busy: false,
            before: String::new(),
        };
        assert!(coalesced.completed(&state));
    }
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
