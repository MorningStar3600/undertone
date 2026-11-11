#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use async_channel::Sender;
use gpui::{
    App, AppContext, Application, Bounds, Context, Entity, FocusHandle, TitlebarOptions, Window,
    WindowBounds, WindowOptions, px, size,
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use undertone_desktop::{
    bridge::{self, HOST_URL, Ipc, Observation, Observer, RoomAddress},
    connection::{Connection, Event, EventKind, Network, enqueue_ipc},
    session::{CommandAuthority, NativeState},
    text,
};
use wry::{WebView, WebViewBuilder, WebViewBuilderExtWindows};

mod native_window;
mod ui;
mod ui_input;
mod ui_music;
mod ui_scroll;
mod ui_widget;

#[derive(Clone, Copy)]
enum Control {
    Join,
    Disconnect,
    PlayPause,
    Previous,
    Next,
    Seek(f64),
    Mute,
    Volume(u8),
    ToggleWidget,
}

struct Player {
    focus: FocusHandle,
    network: Network,
    events: Sender<Event>,
    connection: Option<Connection>,
    connection_ready: bool,
    generation: u64,
    host_generation: u64,
    observer: Observer,
    webview: Option<WebView>,
    host_ready: bool,
    host_authority: Option<CommandAuthority>,
    ipc_overflow: Arc<AtomicBool>,
    status: String,
    title: String,
    notice: String,
    position: f64,
    duration: f64,
    playing: bool,
    available: bool,
    volume: u8,
    muted: bool,
    widget: Option<gpui::WindowHandle<ui_widget::Widget>>,
    widget_open_pending: bool,
    artwork_loader: undertone_desktop::artwork::Loader,
    artwork_selection: undertone_desktop::artwork::Selection,
    artwork_task: Option<gpui::Task<()>>,
    artwork: Option<Arc<gpui::RenderImage>>,
    room_name: String,
    details: ui::TrackDetails,
    up_next: Vec<ui::UpcomingTrack>,
    show_up_next: bool,
    join_input: Entity<ui_input::NativeInput>,
    native: NativeState,
    music_ui: ui_music::MusicUi,
    authority: ui_music::Authority,
    observer_sequence: u64,
    account_refresh_requested: bool,
}

impl Player {
    fn new(window: &mut Window, cx: &mut Context<Self>, muted: bool) -> Self {
        let (events, receiver) = async_channel::bounded(64);
        cx.spawn_in(window, async move |this, cx| {
            while let Ok(event) = receiver.recv().await {
                if this
                    .update_in(cx, |player: &mut Self, window, cx| {
                        player.event(event, window, cx);
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        cx.observe_window_bounds(window, |player, window, _| {
            if let Some(view) = &player.webview {
                let _ = view.set_bounds(player.video_bounds(window));
            }
        })
        .detach();
        let join_input =
            cx.new(|cx| ui_input::NativeInput::new(text("roomLinkPlaceholder"), false, cx));
        cx.subscribe_in(&join_input, window, |player, _, event, window, cx| {
            if matches!(event, ui_input::InputEvent::Submit) {
                player.control(
                    Control::Join,
                    player.music_ui.rendered_authority,
                    window,
                    cx,
                );
            }
        })
        .detach();
        let music_ui = ui_music::MusicUi::new(window, cx);
        let focus = cx.focus_handle();
        window.focus(&focus);
        let owner = cx.weak_entity();
        window.on_window_should_close(cx, move |window, cx| {
            let widget_open = owner
                .upgrade()
                .is_some_and(|owner| owner.read(cx).widget_open(cx));
            if ui_widget::keep_owner_on_close(widget_open) {
                window.minimize_window();
                false
            } else {
                true
            }
        });
        let network = Network::new().expect("desktop network runtime");
        let artwork_loader = undertone_desktop::artwork::Loader::new(network.runtime_handle())
            .expect("public thumbnail client");
        Self {
            focus,
            network,
            events,
            connection: None,
            connection_ready: false,
            generation: 0,
            host_generation: 0,
            observer: Observer::default(),
            webview: None,
            host_ready: false,
            host_authority: None,
            ipc_overflow: Arc::new(AtomicBool::new(false)),
            status: text("idle"),
            title: String::new(),
            notice: String::new(),
            position: 0.0,
            duration: 0.0,
            playing: false,
            available: false,
            volume: 50,
            muted,
            widget: None,
            widget_open_pending: false,
            artwork_loader,
            artwork_selection: Default::default(),
            artwork_task: None,
            artwork: None,
            room_name: String::new(),
            details: ui::TrackDetails::default(),
            up_next: Vec::new(),
            show_up_next: true,
            join_input,
            native: NativeState::default(),
            music_ui,
            authority: ui_music::Authority::default(),
            observer_sequence: 0,
            account_refresh_requested: false,
        }
    }

    fn video_bounds(&self, window: &Window) -> wry::Rect {
        let viewport = window.viewport_size();
        let rect = ui::provider_rect(f32::from(viewport.width));
        wry::Rect {
            position: wry::dpi::LogicalPosition::new(rect.x, rect.y).into(),
            size: wry::dpi::LogicalSize::new(rect.width, rect.height).into(),
        }
    }

    fn sync_layout(&self, window: &mut Window) {
        let (width, height) = ui::PLAYER_SIZE;
        let viewport = window.viewport_size();
        if (f32::from(viewport.width) - width).abs() > 0.5
            || (f32::from(viewport.height) - height).abs() > 0.5
        {
            window.resize(size(px(width), px(height)));
        }
        if let Some(view) = &self.webview {
            // Move the same controller; changing presentation never remounts the browser.
            let _ = view.set_bounds(self.video_bounds(window));
        }
    }

    fn dispose_host(&mut self) {
        // Evaluate disposal best-effort; dropping WebView synchronously closes its controller.
        if let Some(view) = self.webview.take() {
            let _ = view.evaluate_script("window.undertone?.dispose()");
            drop(view);
        }
        self.host_generation += 1;
        self.host_ready = false;
        self.host_authority = None;
        self.ipc_overflow = Arc::new(AtomicBool::new(false));
        self.available = false;
        self.position = 0.;
        self.duration = 0.;
        self.playing = false;
    }

    fn disconnect(&mut self, cx: &mut Context<Self>) {
        self.generation += 1;
        self.connection = None;
        self.connection_ready = false;
        self.dispose_host();
        self.clear_artwork();
        self.observer = Observer::default();
        self.status = text("idle");
        self.title.clear();
        self.room_name.clear();
        self.details = ui::TrackDetails::default();
        self.up_next.clear();
        self.notice.clear();
        self.native = NativeState::default();
        self.authority = ui_music::Authority::default();
        self.account_refresh_requested = false;
        self.music_ui.panel = None;
        self.clear_native_forms(cx);
    }

    fn join(&mut self, input: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(address) = RoomAddress::parse(input) else {
            self.notice = text("invalidRoom");
            return;
        };
        self.disconnect(cx);
        self.room_name = address
            .socket
            .path_segments()
            .and_then(|mut p| p.next_back())
            .unwrap_or_default()
            .chars()
            .take(80)
            .collect();
        self.observer = Observer::new(self.generation);
        self.status = text("connecting");
        self.connection = Some(
            self.network
                .connect(self.generation, address, self.events.clone()),
        );
        let mut native = self.connection.as_ref().unwrap().subscribe_native();
        let generation = self.generation;
        cx.spawn_in(window, async move |this, cx| {
            // Clone the watch value before any GUI await; never retain a watch borrow.
            let initial = native.borrow_and_update().clone();
            let _ = this.update_in(cx, |player, window, cx| {
                if player.generation == generation && initial.generation == generation {
                    player.native_changed(window, cx);
                }
            });
            while native.changed().await.is_ok() {
                let state = native.borrow_and_update().clone();
                if this
                    .update_in(cx, |player, window, cx| {
                        if player.generation == generation && state.generation == generation {
                            // Re-read the current connection: an earlier queued GUI snapshot may lag.
                            player.native_changed(window, cx);
                        }
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
    }

    fn fail(&mut self, code: &str, cx: &mut Context<Self>) {
        self.disconnect(cx);
        self.status = text(code);
    }

    fn start_host(
        &mut self,
        window: &Window,
        authority: CommandAuthority,
    ) -> Result<(), wry::Error> {
        // The sole WebView allocation site. Only a validated YouTube attachment reaches here.
        self.host_generation += 1;
        let host = self.host_generation;
        let generation = self.generation;
        let events = self.events.clone();
        self.ipc_overflow = Arc::new(AtomicBool::new(false));
        let overflow = self.ipc_overflow.clone();
        let view = WebViewBuilder::new()
            .with_incognito(true)
            .with_devtools(false)
            .with_clipboard(false)
            .with_permission_handler(|kind| match kind {
                wry::PermissionKind::Autoplay => wry::PermissionResponse::Allow,
                _ => wry::PermissionResponse::Deny,
            })
            .with_default_context_menus(false)
            .with_focused(false)
            .with_bounds(self.video_bounds(window))
            .with_custom_protocol("undertone".into(), |_, request| {
                let (content_type, body, status) = match request.uri().path() {
                    "/index.html" => (
                        "text/html; charset=utf-8",
                        include_bytes!("../generated/index.html").as_slice(),
                        200,
                    ),
                    "/player.js" => (
                        "text/javascript; charset=utf-8",
                        include_bytes!("../generated/player.js").as_slice(),
                        200,
                    ),
                    _ => ("text/plain", b"".as_slice(), 404),
                };
                wry::http::Response::builder()
                    .status(status)
                    .header("Content-Type", content_type)
                    .header("X-Content-Type-Options", "nosniff")
                    .header("Referrer-Policy", "strict-origin-when-cross-origin")
                    .body(std::borrow::Cow::Borrowed(body))
                    .expect("static host response")
            })
            .with_navigation_handler(|url| bridge::trusted_host(&url))
            .with_new_window_req_handler(|_, _| wry::NewWindowResponse::Deny)
            .with_download_started_handler(|_, _| false)
            .with_ipc_handler(move |request| {
                if let Some(data) = bridge::parse_ipc(&request.uri().to_string(), request.body()) {
                    enqueue_ipc(&events, generation, host, data, &overflow);
                }
            })
            .with_url(HOST_URL)
            .build_as_child(window)?;
        self.webview = Some(view);
        self.host_authority = Some(authority);
        self.status = text("loading");
        Ok(())
    }

    fn script(&mut self, method: &str, argument: Value) {
        if let Some(view) = &self.webview {
            // `method` is a code constant, all data crosses as serialized JSON.
            if view
                .evaluate_script(&format!("window.undertone.{method}({argument})"))
                .is_err()
            {
                self.notice = text("bridgeFailed");
            }
        }
    }

    fn send(&mut self, authority: CommandAuthority, message: Value) {
        if !self.connection.as_ref().is_some_and(|c| {
            self.authority.accepts(&c.native_state()) && c.send(authority, message)
        }) {
            // Identity transitions deliberately close playback admission. Never turn a login
            // into a permanent connection failure or send an old host's probe to a new socket.
            self.notice = text("commandUnavailable");
        }
    }

    fn event(&mut self, event: Event, window: &mut Window, cx: &mut Context<Self>) {
        if event.generation != self.generation {
            return;
        }
        self.native_changed(window, cx);
        if let Some(pair) = event.authority
            && !self
                .connection
                .as_ref()
                .is_some_and(|c| self.authority.accepts_event(&c.native_state(), pair))
        {
            return;
        }
        // A full channel already has a wakeup pending. Check before consuming any authority.
        if self.ipc_overflow.swap(false, Ordering::AcqRel) {
            self.fail("bridgeFailed", cx);
            self.sync_layout(window);
            cx.notify();
            return;
        }
        let event_authority = self.native.authority();
        match event.kind {
            EventKind::Failed(code) => self.fail(code, cx),
            EventKind::Message(message) => {
                match self.observer.observe(&message) {
                    Ok(Observation::Capability) => {
                        self.connection_ready = true;
                        self.status = text("connected");
                        self.send(event_authority, self.observer.subscribe());
                    }
                    Ok(Observation::Source(source)) => {
                        self.title = source.as_ref().map(|s| s.title.clone()).unwrap_or_default();
                        self.select_artwork(
                            source.as_ref().and_then(|s| s.youtube_id.clone()),
                            window,
                            cx,
                        );
                        if source.as_ref().is_some_and(|s| s.youtube) {
                            if self.title.is_empty() {
                                self.title = text("untitled");
                            }
                            // Keep exactly one host across consecutive YouTube tracks.
                            if self.webview.is_none() {
                                if self.start_host(window, event_authority).is_err() {
                                    self.fail("browserFailed", cx);
                                } else {
                                    let generation = self.generation;
                                    let host = self.host_generation;
                                    cx.spawn_in(window, async move |this, cx| {
                                        gpui::Timer::after(Duration::from_secs(15)).await;
                                        let _ = this.update_in(cx, |player, window, cx| {
                                            if bridge::current_generation(
                                                player.generation,
                                                player.host_generation,
                                                generation,
                                                host,
                                            ) && !player.host_ready
                                            {
                                                player.fail("bridgeFailed", cx);
                                                player.sync_layout(window);
                                                cx.notify();
                                            }
                                        });
                                    })
                                    .detach();
                                }
                            }
                        } else {
                            self.dispose_host();
                            self.status = text(if source.is_none() {
                                "empty"
                            } else {
                                "unsupportedSource"
                            });
                        }
                        self.sync_layout(window);
                    }
                    Ok(Observation::Ignore) => {}
                    Err(code) => {
                        self.fail(code, cx);
                        self.sync_layout(window);
                        cx.notify();
                        return;
                    }
                }
                if self.host_ready && bridge::forwarded(&message) {
                    self.script("receive", message.clone());
                }
                if message["action"] == "playback-result" {
                    match message["result"]["status"].as_str() {
                        Some("rejected") => self.notice = text("commandRejected"),
                        Some("applied") => self.notice = text("commandApplied"),
                        _ => {}
                    }
                }
            }
            EventKind::Ipc { host, data } => {
                if !self.authority.accepts(&self.native)
                    || !bridge::current_generation(
                        self.generation,
                        self.host_generation,
                        event.generation,
                        host,
                    )
                    || self.webview.is_none()
                {
                    return;
                }
                match data {
                    Ipc::Ready if !self.host_ready => {
                        self.host_ready = true;
                        self.script("setVolume", json!(if self.muted { 0 } else { self.volume }));
                        self.script("start", Value::Null);
                    }
                    Ipc::Send { message } if self.host_ready => {
                        if let Some(authority) = self.host_authority {
                            self.send(authority, message);
                        }
                    }
                    Ipc::State {
                        position,
                        duration,
                        playing,
                        available,
                    } => {
                        self.position = position;
                        self.duration = duration;
                        self.playing = playing;
                        self.available = available;
                    }
                    Ipc::Status { code } => {
                        if matches!(
                            code.as_str(),
                            "waiting-snapshot" | "waiting-clock" | "recovering" | "disposed"
                        ) {
                            self.available = false;
                        }
                        if code == "commandUnavailable" {
                            self.notice = text(&code);
                        } else {
                            self.status = text(&code);
                        }
                    }
                    _ => {}
                }
            }
        }
        // Keep error recovery/join forms visible as well as resizing the provider slot.
        self.sync_layout(window);
        cx.notify();
    }

    fn control(
        &mut self,
        control: Control,
        authority: CommandAuthority,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !authority.matches_session(&self.native) {
            self.notice = text("nativeStale");
            cx.notify();
            return;
        }
        let command = match control {
            Control::Join => {
                let typed = self.join_input.read(cx).value().trim().to_owned();
                if !typed.is_empty() {
                    self.join(&typed, window, cx);
                } else if let Some(input) = cx.read_from_clipboard().and_then(|item| item.text()) {
                    self.join(&input, window, cx);
                } else {
                    self.notice = text("invalidRoom");
                }
                None
            }
            Control::Disconnect => {
                self.disconnect(cx);
                None
            }
            Control::PlayPause => {
                Some(json!({"command":if self.playing { "pause" } else { "play" }}))
            }
            Control::Previous => Some(json!({"command":"previous"})),
            Control::Next => Some(json!({"command":"next"})),
            Control::Seek(position) => {
                ui::safe_seek(position, self.duration, self.available && self.host_ready)
                    .map(|position| json!({"command":"seek", "positionSeconds":position}))
            }
            Control::Mute => {
                self.muted = !self.muted;
                if !self.muted && self.volume == 0 {
                    self.volume = 50;
                }
                self.update_volume();
                None
            }
            Control::Volume(volume) => {
                self.volume = volume.min(100);
                self.muted = self.volume == 0;
                self.update_volume();
                None
            }
            Control::ToggleWidget => {
                self.toggle_widget(window, cx);
                None
            }
        };
        if let Some(command) = command {
            if self.available
                && self.host_ready
                && self
                    .connection
                    .as_ref()
                    .is_some_and(|c| authority.matches_session(&c.native_state()))
            {
                self.script("command", command);
            } else {
                self.notice = text("commandUnavailable");
            }
        }
        if matches!(control, Control::Join | Control::Disconnect) {
            if matches!(control, Control::Join) && self.connection.is_some() {
                self.join_input.update(cx, |input, cx| input.clear(cx));
            }
            self.sync_layout(window);
        }
        cx.notify();
    }

    fn update_volume(&mut self) {
        self.script("setVolume", json!(if self.muted { 0 } else { self.volume }));
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        self.connection = None;
        self.dispose_host();
    }
}

fn main() -> anyhow::Result<()> {
    let mut server = None;
    let mut room = None;
    let mut muted = false;
    let mut smoke = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--server" => server = args.next(),
            "--room" => room = args.next(),
            "--muted" => muted = true,
            "--smoke-test" => {
                smoke = true;
                muted = true;
            }
            "--help" | "-h" => {
                println!("{}", text("help"));
                return Ok(());
            }
            _ => anyhow::bail!("{}", text("help")),
        }
    }
    let initial = match (server, room) {
        (Some(server), Some(room)) => {
            let mut url = url::Url::parse(&server)?;
            url.path_segments_mut()
                .map_err(|_| anyhow::anyhow!(text("invalidRoom")))?
                .pop_if_empty()
                .push("room")
                .push(&room);
            if RoomAddress::parse(url.as_str()).is_none() {
                anyhow::bail!("{}", text("invalidRoom"));
            }
            Some(url.to_string())
        }
        (None, None) => None,
        _ => anyhow::bail!("{}", text("help")),
    };
    // Smoke mode is always offline, even when other CLI parameters were supplied.
    Application::new().with_assets(ui::Assets).run(move |cx: &mut App| {
        cx.on_window_closed(|cx| { if cx.windows().is_empty() { cx.quit(); } }).detach();
        let (width, height) = ui::PLAYER_SIZE;
        let bounds = Bounds::centered(None, size(px(width), px(height)), cx);
        cx.open_window(WindowOptions {
            titlebar: Some(TitlebarOptions { title: Some(text("app").into()), ..Default::default() }),
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            window_min_size: Some(size(px(440.), px(480.))),
            is_resizable: false,
            ..Default::default()
        }, move |window, cx| cx.new(|cx| {
            let mut player = Player::new(window, cx, muted);
            if !smoke && let Some(initial) = initial { player.join(&initial, window, cx); }
            player.sync_layout(window);
            if smoke {
                assert!(player.webview.is_none() && player.connection.is_none() && player.muted);
                cx.spawn(async |this, cx| {
                    gpui::Timer::after(Duration::from_secs(2)).await;
                    let _ = this.update(cx, |player, cx| {
                        assert!(player.webview.is_none() && player.connection.is_none());
                        println!("{{\"smoke\":\"passed\",\"webviews\":0,\"connections\":0,\"muted\":true}}");
                        cx.quit();
                    });
                }).detach();
            }
            player
        })).expect("desktop window");
        cx.activate(true);
    });
    Ok(())
}
