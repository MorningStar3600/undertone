#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use async_channel::Sender;
use gpui::{
    App, Application, Bounds, Context, IntoElement, Render, TitlebarOptions, Window, WindowBounds,
    WindowOptions, div, prelude::*, px, rgb, size,
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
    text,
};
use wry::{WebView, WebViewBuilder, WebViewBuilderExtWindows};

#[derive(Clone, Copy)]
enum Control {
    Join,
    Disconnect,
    PlayPause,
    Previous,
    Next,
    Back,
    Forward,
    Mute,
    Quieter,
    Louder,
}

struct Player {
    network: Network,
    events: Sender<Event>,
    connection: Option<Connection>,
    generation: u64,
    host_generation: u64,
    observer: Observer,
    webview: Option<WebView>,
    host_ready: bool,
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
                let _ = view.set_bounds(Self::video_bounds(window));
            }
        })
        .detach();
        Self {
            network: Network::new().expect("desktop network runtime"),
            events,
            connection: None,
            generation: 0,
            host_generation: 0,
            observer: Observer::default(),
            webview: None,
            host_ready: false,
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
        }
    }

    fn video_bounds(window: &Window) -> wry::Rect {
        let viewport = window.viewport_size();
        wry::Rect {
            position: wry::dpi::LogicalPosition::new(16., 132.).into(),
            size: wry::dpi::LogicalSize::new(
                (f64::from(viewport.width) - 32.).max(1.),
                (f64::from(viewport.height) - 324.).max(1.),
            )
            .into(),
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
        self.ipc_overflow = Arc::new(AtomicBool::new(false));
        self.available = false;
        self.position = 0.;
        self.duration = 0.;
        self.playing = false;
    }

    fn disconnect(&mut self) {
        self.generation += 1;
        self.connection = None;
        self.dispose_host();
        self.observer = Observer::default();
        self.status = text("idle");
        self.title.clear();
        self.notice.clear();
    }

    fn join(&mut self, input: &str) {
        let Some(address) = RoomAddress::parse(input) else {
            self.notice = text("invalidRoom");
            return;
        };
        self.disconnect();
        self.observer = Observer::new(self.generation);
        self.status = text("connecting");
        self.connection = Some(
            self.network
                .connect(self.generation, address, self.events.clone()),
        );
    }

    fn fail(&mut self, code: &str) {
        self.disconnect();
        self.status = text(code);
    }

    fn start_host(&mut self, window: &Window) -> Result<(), wry::Error> {
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
            .with_bounds(Self::video_bounds(window))
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

    fn send(&mut self, message: Value) {
        if !self.connection.as_ref().is_some_and(|c| c.send(message)) {
            self.fail("bridgeFailed");
        }
    }

    fn event(&mut self, event: Event, window: &mut Window, cx: &mut Context<Self>) {
        // A full channel already has a wakeup pending. Check before consuming any authority.
        if self.ipc_overflow.swap(false, Ordering::AcqRel) {
            self.fail("bridgeFailed");
            cx.notify();
            return;
        }
        if event.generation != self.generation {
            return;
        }
        match event.kind {
            EventKind::Failed(code) => self.fail(code),
            EventKind::Message(message) => {
                match self.observer.observe(&message) {
                    Ok(Observation::Capability) => {
                        self.status = text("connected");
                        self.send(self.observer.subscribe());
                    }
                    Ok(Observation::Source(source)) => {
                        self.title = source.as_ref().map(|s| s.title.clone()).unwrap_or_default();
                        if source.as_ref().is_some_and(|s| s.youtube) {
                            if self.title.is_empty() {
                                self.title = text("untitled");
                            }
                            // Keep exactly one host across consecutive YouTube tracks.
                            if self.webview.is_none() {
                                if self.start_host(window).is_err() {
                                    self.fail("browserFailed");
                                } else {
                                    let generation = self.generation;
                                    let host = self.host_generation;
                                    cx.spawn(async move |this, cx| {
                                        gpui::Timer::after(Duration::from_secs(15)).await;
                                        let _ = this.update(cx, |player, cx| {
                                            if bridge::current_generation(
                                                player.generation,
                                                player.host_generation,
                                                generation,
                                                host,
                                            ) && !player.host_ready
                                            {
                                                player.fail("bridgeFailed");
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
                    }
                    Ok(Observation::Ignore) => {}
                    Err(code) => {
                        self.fail(code);
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
                if !bridge::current_generation(
                    self.generation,
                    self.host_generation,
                    event.generation,
                    host,
                ) || self.webview.is_none()
                {
                    return;
                }
                match data {
                    Ipc::Ready if !self.host_ready => {
                        self.host_ready = true;
                        self.script("setVolume", json!(if self.muted { 0 } else { self.volume }));
                        self.script("start", Value::Null);
                    }
                    Ipc::Send { message } if self.host_ready => self.send(message),
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
        cx.notify();
    }

    fn control(&mut self, control: Control, cx: &mut Context<Self>) {
        let command = match control {
            Control::Join => {
                if let Some(input) = cx.read_from_clipboard().and_then(|item| item.text()) {
                    self.join(&input);
                } else {
                    self.notice = text("invalidRoom");
                }
                None
            }
            Control::Disconnect => {
                self.disconnect();
                None
            }
            Control::PlayPause => {
                Some(json!({"command":if self.playing { "pause" } else { "play" }}))
            }
            Control::Previous => Some(json!({"command":"previous"})),
            Control::Next => Some(json!({"command":"next"})),
            Control::Back | Control::Forward => {
                let delta = if matches!(control, Control::Back) {
                    -10.
                } else {
                    10.
                };
                let mut position = (self.position + delta).max(0.);
                if self.duration > 0. {
                    position = position.min(self.duration);
                }
                Some(json!({"command":"seek", "positionSeconds":position}))
            }
            Control::Mute => {
                self.muted = !self.muted;
                self.update_volume();
                None
            }
            Control::Quieter => {
                self.volume = self.volume.saturating_sub(10);
                self.update_volume();
                None
            }
            Control::Louder => {
                self.volume = self.volume.saturating_add(10).min(100);
                self.update_volume();
                None
            }
        };
        if let Some(command) = command {
            if self.available && self.host_ready {
                self.script("command", command);
            } else {
                self.notice = text("commandUnavailable");
            }
        }
        cx.notify();
    }

    fn update_volume(&mut self) {
        self.script("setVolume", json!(if self.muted { 0 } else { self.volume }));
    }

    fn button(
        &self,
        id: &'static str,
        control: Control,
        enabled: bool,
        cx: &Context<Self>,
    ) -> impl IntoElement {
        div()
            .id(id)
            .px_3()
            .py_2()
            .rounded_md()
            .bg(rgb(if enabled { 0x303b4b } else { 0x20242c }))
            .text_color(rgb(if enabled { 0xf1f4f8 } else { 0x777d89 }))
            .cursor_pointer()
            .child(text(id))
            .on_click(cx.listener(move |player, _, _, cx| {
                if enabled {
                    player.control(control, cx);
                }
            }))
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        self.connection = None;
        self.dispose_host();
    }
}

fn time(seconds: f64) -> String {
    let seconds = seconds as u64;
    format!("{}:{:02}", seconds / 60, seconds % 60)
}

impl Render for Player {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let controls = self.available && self.host_ready;
        div()
            .size_full()
            .flex()
            .flex_col()
            .p_4()
            .gap_4()
            .bg(rgb(0x12161e))
            .text_color(rgb(0xe5eaf1))
            .text_sm()
            .child(
                div()
                    .h(px(100.))
                    .flex_shrink_0()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(div().text_xl().child(text("app")))
                    .child(
                        div()
                            .flex()
                            .gap_2()
                            .child(self.button("join", Control::Join, true, cx))
                            .child(self.button(
                                "disconnect",
                                Control::Disconnect,
                                self.connection.is_some(),
                                cx,
                            )),
                    )
                    .child(div().text_color(rgb(0xa4afbf)).child(text("joinHint"))),
            )
            .child(
                div()
                    .flex_1()
                    .overflow_hidden()
                    .flex()
                    .items_center()
                    .justify_center()
                    .bg(rgb(0x0b0d12))
                    .child(if self.webview.is_none() {
                        self.status.clone()
                    } else {
                        String::new()
                    }),
            )
            .child(
                div()
                    .h(px(160.))
                    .flex_shrink_0()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(div().truncate().text_lg().child(self.title.clone()))
                    .child(div().truncate().child(self.status.clone()))
                    .child(
                        div()
                            .flex()
                            .gap_2()
                            .child(format!("{} / {}", time(self.position), time(self.duration)))
                            .child(if self.muted {
                                text("muted")
                            } else {
                                format!("{} {}%", text("volume"), self.volume)
                            }),
                    )
                    .child(
                        div()
                            .flex()
                            .gap_2()
                            .child(self.button("previous", Control::Previous, controls, cx))
                            .child(self.button("back", Control::Back, controls, cx))
                            .child(self.button(
                                if self.playing { "pause" } else { "play" },
                                Control::PlayPause,
                                controls,
                                cx,
                            ))
                            .child(self.button("forward", Control::Forward, controls, cx))
                            .child(self.button("next", Control::Next, controls, cx))
                            .child(self.button(
                                if self.muted { "unmute" } else { "mute" },
                                Control::Mute,
                                true,
                                cx,
                            ))
                            .child(self.button("quieter", Control::Quieter, true, cx))
                            .child(self.button("louder", Control::Louder, true, cx)),
                    )
                    .child(
                        div()
                            .truncate()
                            .text_color(rgb(0xe4bc80))
                            .child(self.notice.clone()),
                    ),
            )
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
    Application::new().run(move |cx: &mut App| {
        cx.on_window_closed(|cx| { if cx.windows().is_empty() { cx.quit(); } }).detach();
        let bounds = Bounds::centered(None, size(px(960.), px(700.)), cx);
        cx.open_window(WindowOptions {
            titlebar: Some(TitlebarOptions { title: Some(text("app").into()), ..Default::default() }),
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            window_min_size: Some(size(px(900.), px(600.))),
            ..Default::default()
        }, move |window, cx| cx.new(|cx| {
            let mut player = Player::new(window, cx, muted);
            if !smoke && let Some(initial) = initial { player.join(&initial); }
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
