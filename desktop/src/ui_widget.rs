//! A second native window. It observes Player and routes captured commands to that window;
//! it never renders Player, owns forms, a connection, observer, or a WebView.
//!
//! Composition follows the "twelve moods" design: the whole card is the animated ambience
//! surface; header lockup and window controls, room line, the ambience's name in the italic
//! voice, an 88 px cover hero, progress and transport, one-click moods, the next tracks and a
//! status footer. Folded, it becomes a single bar. The card can be dragged from anywhere that
//! is not a control.
use super::{
    Control, Player, native_window, sky,
    ui::{self, rgb},
    ui_music::{Action, Panel},
    ui_queue,
};
use crate::theme;
use gpui::{
    AnyElement, App, AppContext, Bounds, Context, Div, Entity, FocusHandle, FontWeight,
    IntoElement, Pixels, Render, Stateful, TitlebarOptions, WeakEntity, Window, WindowBounds,
    WindowControlArea, WindowHandle, WindowOptions, canvas, div, point, prelude::*, px, relative,
    size,
};
use std::{cell::Cell, rc::Rc};
use undertone_desktop::{
    artwork::YoutubeId,
    music::ActiveTag,
    prefs::{self, WidgetPlacement},
    session::CommandAuthority,
    text,
};

/// Tall enough for two played tracks, the current one and one upcoming under the moods.
pub const WIDGET_SIZE: (f32, f32) = (410., 720.);
/// Folded: one bar with the cover, title, play and unfold.
pub const MINI_SIZE: (f32, f32) = (410., 68.);
const RADIUS: f32 = 22.;

pub fn keep_owner_on_close(widget_open: bool) -> bool {
    widget_open
}

#[derive(Clone)]
enum Route {
    Playback(Control),
    Native(Action),
    Restore,
    Quit,
}

pub struct Widget {
    owner: WeakEntity<Player>,
    main: WindowHandle<Player>,
    focus: FocusHandle,
    pinned: bool,
    folded: bool,
    error: String,
    layers: Option<sky::Layers<Widget>>,
    /// Where this window's now-playing bars are; painted over its cached body.
    bars: ui_queue::Bars,
}

/// Bounds to open the widget with: the remembered place, moved fully onto a display, or the
/// center of the primary display.
fn opening_bounds(
    placement: Option<WidgetPlacement>,
    cx: &App,
) -> (Option<gpui::DisplayId>, Bounds<Pixels>) {
    let folded = placement.is_some_and(|p| p.folded);
    let (width, height) = if folded { MINI_SIZE } else { WIDGET_SIZE };
    let displays = cx.displays();
    let areas: Vec<prefs::Area> = displays
        .iter()
        .map(|display| {
            let b = display.bounds();
            (
                f32::from(b.origin.x),
                f32::from(b.origin.y),
                f32::from(b.size.width),
                f32::from(b.size.height),
            )
        })
        .collect();
    match placement.and_then(|p| prefs::clamp_origin((p.x, p.y), (width, height), &areas)) {
        Some((index, (x, y))) => (
            Some(displays[index].id()),
            Bounds::new(point(px(x), px(y)), size(px(width), px(height))),
        ),
        None => (
            None,
            Bounds::centered(None, size(px(width), px(height)), cx),
        ),
    }
}

impl Player {
    pub(super) fn widget_open(&self, cx: &App) -> bool {
        self.widget_open_pending || self.widget.is_some_and(|widget| widget.read(cx).is_ok())
    }
    pub(super) fn toggle_widget(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.widget_open_pending {
            return;
        }
        if let Some(widget) = self.widget.take()
            && widget
                .update(cx, |_, window, _| window.remove_window())
                .is_ok()
        {
            self.save_prefs();
            return;
        }
        let main = window
            .window_handle()
            .downcast::<Player>()
            .expect("player root");
        let owner = cx.entity();
        let placement = self.prefs.widget;
        self.widget_open_pending = true;
        // GPUI open_window draws the new root synchronously. Defer outside Player's mutable
        // entity lease so the first Widget::render can safely read its owner.
        cx.defer(move |cx| {
            if main.read(cx).is_err() {
                return;
            }
            let folded = placement.is_some_and(|p| p.folded);
            let (display_id, bounds) = opening_bounds(placement, cx);
            let result = cx.open_window(
                WindowOptions {
                    titlebar: Some(TitlebarOptions {
                        title: Some(text("widgetTitle").into()),
                        appears_transparent: true,
                        ..Default::default()
                    }),
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    window_min_size: Some(size(px(MINI_SIZE.0), px(MINI_SIZE.1))),
                    window_background: gpui::WindowBackgroundAppearance::Transparent,
                    display_id,
                    is_resizable: false,
                    focus: false,
                    ..Default::default()
                },
                move |window, cx| cx.new(|cx| Widget::new(owner, main, folded, window, cx)),
            );
            let _ = main.update(cx, |player, _, cx| {
                player.widget_open_pending = false;
                match result {
                    Ok(widget) => {
                        player.widget = Some(widget);
                        player.drive_pages();
                    }
                    Err(_) => player.notice = text("widgetFailed"),
                }
                cx.notify();
            });
        });
    }
    pub(super) fn clear_artwork(&mut self) {
        self.artwork_selection.replace(None);
        self.artwork_task = None; // drops Request and aborts HTTP
        self.artwork = None;
    }
    pub(super) fn select_artwork(
        &mut self,
        id: Option<YoutubeId>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.clear_artwork();
        let serial = self.artwork_selection.replace(id.clone());
        let Some(id) = id else {
            // No cover: the default ambience.
            theme::set_ambience(undertone_desktop::ambience::DEFAULT, cx);
            return;
        };
        let authority = self.native.authority();
        let mut request = self.artwork_loader.load(id);
        self.artwork_task = Some(cx.spawn_in(window, async move |this, cx| {
            let image = (&mut request.result).await.ok().flatten();
            let _ = this.update_in(cx, |player, _, cx| {
                if player.artwork_selection.accepts(serial)
                    && player.connection.as_ref().is_some_and(|c| {
                        let state = c.native_state();
                        state.connected
                            && !state.account.expired
                            && authority.matches_session(&state)
                    })
                {
                    // Decoded, cropped to its 16:9 band and matched off the UI thread; a failed
                    // fetch falls back to the default ambience.
                    theme::set_ambience(
                        image
                            .as_ref()
                            .map_or(undertone_desktop::ambience::DEFAULT, |art| art.ambience),
                        cx,
                    );
                    // The band is already BGRA (GPUI RenderImage order) and free of letterbox bars.
                    player.artwork = image.map(|art| {
                        std::sync::Arc::new(gpui::RenderImage::new(vec![image::Frame::new(
                            art.band_bgra.clone(),
                        )]))
                    });
                    cx.notify();
                }
            });
        }));
    }
}

impl Widget {
    fn new(
        owner: Entity<Player>,
        main: WindowHandle<Player>,
        folded: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        cx.observe(&owner, |_, _, cx| cx.notify()).detach();
        let handle = window
            .window_handle()
            .downcast::<Widget>()
            .expect("widget root");
        window.on_window_should_close(cx, move |_, cx| {
            forget_widget(main, handle, cx);
            true
        });
        // Remember where the widget was dragged; written to disk when it closes.
        cx.observe_window_bounds(window, |widget, window, cx| widget.remember(window, cx))
            .detach();
        let focus = cx.focus_handle();
        let pinned = native_window::pin(window, true).is_ok();
        Self {
            owner: owner.downgrade(),
            main,
            focus,
            pinned,
            folded,
            error: if pinned {
                String::new()
            } else {
                text("widgetPinFailed")
            },
            layers: None,
            bars: ui_queue::Bars::default(),
        }
    }
    /// Frames drawn by this widget's sky (debug counter).
    #[cfg(debug_assertions)]
    pub(super) fn sky_frames(&self, cx: &App) -> Option<u64> {
        self.layers
            .as_ref()
            .map(|layers| sky::frames(&layers.sky, cx))
    }
    fn remember(&self, window: &mut Window, cx: &mut Context<Self>) {
        if !native_window::visibility(window).visible() {
            return; // a minimized window reports a parking position, not a place
        }
        let origin = window.bounds().origin;
        let placement = WidgetPlacement {
            x: f32::from(origin.x),
            y: f32::from(origin.y),
            folded: self.folded,
        };
        let main = self.main;
        cx.defer(move |cx| {
            let _ = main.update(cx, |player, _, _| player.prefs.widget = Some(placement));
        });
    }
    fn set_folded(&mut self, folded: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.folded = folded;
        let (width, height) = if folded { MINI_SIZE } else { WIDGET_SIZE };
        window.resize(size(px(width), px(height)));
        self.remember(window, cx);
        cx.notify();
    }
    fn route(&self, route: Route, authority: CommandAuthority, cx: &mut Context<Self>) {
        let main = self.main;
        // Deferred so the main root is never updated during a widget read/render or window removal.
        cx.defer(move |cx| {
            let _ = main.update(cx, |player, window, cx| match route {
                Route::Playback(control) => player.control(control, authority, window, cx),
                Route::Native(action) => {
                    // Panels open in the main window; Show never toggles an open panel shut.
                    if matches!(action, Action::Show(_)) && native_window::restore(window).is_err()
                    {
                        player.notice = text("widgetRestoreFailed");
                    }
                    player.music_action(action, authority, window, cx);
                }
                Route::Restore => {
                    if native_window::restore(window).is_err() {
                        player.notice = text("widgetRestoreFailed");
                    }
                    cx.notify();
                }
                Route::Quit => {
                    player.save_prefs();
                    cx.quit();
                }
            });
        });
    }
    /// Round icon control (`.ib`); it occludes the drag area under the card.
    #[expect(
        clippy::too_many_arguments,
        reason = "icon controls keep label, glyph, origin authority and enabled state explicit"
    )]
    fn button(
        &self,
        id: impl Into<gpui::ElementId>,
        key: &'static str,
        glyph: &'static str,
        route: Route,
        authority: CommandAuthority,
        enabled: bool,
        cx: &Context<Self>,
    ) -> Stateful<Div> {
        let foreground = if enabled { ui::TEXT_SOFT } else { ui::FAINT };
        self.control(id, key, route, authority, enabled, ui::SECONDARY, cx)
            .child(ui::icon(glyph, 21.).text_color(rgb(foreground)))
    }
    /// Shared behaviour of the widget's controls: tooltip, focus, keyboard, captured authority.
    /// GPUI allows one hover style per element, so callers pass theirs here.
    #[allow(clippy::too_many_arguments)]
    fn control(
        &self,
        id: impl Into<gpui::ElementId>,
        key: &'static str,
        route: Route,
        authority: CommandAuthority,
        enabled: bool,
        hover: ui::Tok,
        cx: &Context<Self>,
    ) -> Stateful<Div> {
        let label = text(key);
        let foreground = if enabled { ui::TEXT_SOFT } else { ui::FAINT };
        div()
            .id(id)
            .occlude()
            .size(px(36.))
            .flex_shrink_0()
            .rounded_full()
            .flex()
            .items_center()
            .justify_center()
            .border_1()
            .border_color(gpui::transparent_black())
            .text_color(rgb(foreground))
            .when(enabled, |s| {
                s.cursor_pointer()
                    .focusable()
                    .tab_stop(true)
                    .hover(move |s| s.bg(rgb(hover)))
                    .focus(|s| s.border_color(rgb(ui::TEXT)))
            })
            .tooltip(move |_, cx| cx.new(|_| ui::Tip(label.clone())).into())
            .on_click(cx.listener(move |widget, _, _, cx| {
                if enabled {
                    widget.route(route.clone(), authority, cx);
                }
            }))
    }
    /// The accent play/pause disc.
    fn play(
        &self,
        edge: f32,
        playing: bool,
        live: bool,
        authority: CommandAuthority,
        cx: &Context<Self>,
    ) -> Stateful<Div> {
        let key = if playing { "pause" } else { "play" };
        let foreground = if live { ui::AMBER_TEXT } else { ui::FAINT };
        self.control(
            "widget-play",
            key,
            Route::Playback(Control::PlayPause),
            authority,
            live,
            ui::AMBER_HOVER,
            cx,
        )
        .size(px(edge))
        .bg(rgb(if live { ui::AMBER } else { ui::SECONDARY }))
        .text_color(rgb(foreground))
        .child(ui::icon(key, edge * 0.44).text_color(rgb(foreground)))
    }
    /// Window chrome (`.rb`): 32 px, glass, pressed state filled with ink.
    fn chrome(
        &self,
        id: &'static str,
        key: &'static str,
        glyph: &'static str,
        pressed: bool,
    ) -> Stateful<Div> {
        let label = text(key);
        let foreground = if pressed { ui::BACKGROUND } else { ui::TEXT };
        div()
            .id(id)
            .occlude()
            .size(px(32.))
            .flex_shrink_0()
            .rounded_full()
            .flex()
            .items_center()
            .justify_center()
            .bg(rgb(if pressed { ui::TEXT } else { ui::GLASS_STRONG }))
            .border_1()
            .border_color(rgb(if pressed { ui::TEXT } else { ui::BORDER }))
            .cursor_pointer()
            .focusable()
            .tab_stop(true)
            .when(!pressed, |s| s.hover(|s| s.bg(rgb(ui::POPOVER))))
            .focus(|s| s.border_color(rgb(ui::AMBER)))
            .tooltip(move |_, cx| cx.new(|_| ui::Tip(label.clone())).into())
            .child(ui::icon(glyph, 17.).text_color(rgb(foreground)))
    }

    fn header(&self, cx: &Context<Self>) -> Div {
        row()
            .gap(px(6.))
            .pt(px(12.))
            .pr(px(12.))
            .pl(px(16.))
            .child(ui::lockup(15.5))
            .child(div().flex_1())
            .child(
                self.chrome("widget-pin", "widgetPin", "pin", self.pinned)
                    .on_click(cx.listener(|widget, _, window, cx| {
                        if native_window::pin(window, !widget.pinned).is_ok() {
                            widget.pinned = !widget.pinned;
                            widget.error.clear();
                        } else {
                            widget.error = text("widgetPinFailed");
                        }
                        cx.notify();
                    })),
            )
            .child(
                self.chrome("widget-fold", "widgetFold", "fold", false)
                    .on_click(
                        cx.listener(|widget, _, window, cx| widget.set_folded(true, window, cx)),
                    ),
            )
            .child(
                self.chrome("widget-minimize", "widgetMinimize", "minus", false)
                    .on_click(|_, window, _| window.minimize_window()),
            )
            .child(
                self.chrome("widget-close", "widgetClose", "close", false)
                    .on_click(cx.listener(|widget, _, window, cx| {
                        let handle = window
                            .window_handle()
                            .downcast::<Widget>()
                            .expect("widget root");
                        forget_widget(widget.main, handle, cx);
                        window.remove_window();
                    })),
            )
    }

    fn footer(&self, player: &Player, authority: CommandAuthority, cx: &Context<Self>) -> Div {
        let live = player.available && player.host_ready;
        let status = footer_status(&self.error, &player.notice, &player.status, live);
        let tip = status.clone();
        row()
            .gap(px(6.))
            .pt(px(10.))
            .pb(px(11.))
            .px(px(14.))
            .child(
                self.button(
                    "widget-settings",
                    "settings",
                    "settings",
                    Route::Native(Action::Show(Panel::Settings)),
                    authority,
                    true,
                    cx,
                )
                .size(px(26.)),
            )
            .child(
                div()
                    .id("widget-status")
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .justify_center()
                    .tooltip(move |_, cx| cx.new(|_| ui::Tip(tip.clone())).into())
                    .child(quiet(status, 11.5)),
            )
            .child(
                self.button(
                    "widget-quit",
                    "widgetQuit",
                    "power",
                    Route::Quit,
                    authority,
                    true,
                    cx,
                )
                .size(px(26.)),
            )
    }

    /// The window's content, a cached view over the sky (see `sky::Body`).
    fn body(&mut self, _: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        // The bars are laid out again with the body; the overlay reads where they are.
        self.bars.clear();
        let Some(owner) = self.owner.upgrade() else {
            return div().into_any_element();
        };
        let player = owner.read(cx);
        let authority = player.native.authority();
        if self.folded {
            return self.mini(player, authority, cx).into_any_element();
        }
        let root = column().size_full().child(self.header(cx));
        if player.connection.is_none() {
            // Not in a room: one clear way back to the player, no disabled controls.
            return root
                .child(
                    column()
                        .flex_1()
                        .px(px(36.))
                        .gap(px(12.))
                        .items_center()
                        .justify_center()
                        .child(ui::mood_line(theme::current(cx), 19.))
                        .child(
                            div()
                                .font_family(theme::display())
                                .font_weight(FontWeight(300.))
                                .text_size(px(28.))
                                .child(text("widgetNoRoom")),
                        )
                        .child(
                            div()
                                .text_size(px(13.))
                                .text_color(rgb(ui::TEXT_SOFT))
                                .child(text("widgetNoRoomHint")),
                        )
                        .child(
                            self.button(
                                "widget-open-app",
                                "widgetOpenApp",
                                "expand",
                                Route::Restore,
                                authority,
                                true,
                                cx,
                            )
                            .w_auto()
                            .h(px(40.))
                            .mt(px(8.))
                            .px(px(18.))
                            .gap(px(8.))
                            .rounded(px(12.))
                            .border_color(rgb(ui::BORDER))
                            .bg(rgb(ui::POPOVER))
                            .text_color(rgb(ui::TEXT))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(text("widgetOpenApp")),
                        ),
                )
                .child(self.footer(player, authority, cx))
                .into_any_element();
        }
        root.child(self.room(player, authority, cx))
            .child(
                div()
                    .min_h(px(56.))
                    .flex()
                    .items_end()
                    .px(px(20.))
                    .pb(px(10.))
                    .child(ui::mood_line(theme::current(cx), 19.)),
            )
            .child(self.hero(player))
            .child(
                column()
                    .px(px(20.))
                    .pt(px(16.))
                    .child(self.timeline(player, authority, cx))
                    .child(self.transport(player, authority, cx))
                    .child(self.moods(player, authority, cx))
                    .child(self.queue(player, authority, cx)),
            )
            .child(div().flex_1())
            .child(self.footer(player, authority, cx))
            .into_any_element()
    }

    fn room(&self, player: &Player, authority: CommandAuthority, cx: &Context<Self>) -> Div {
        let names: Vec<String> = player
            .native
            .room
            .music
            .as_ref()
            .map(|music| {
                music
                    .participants
                    .iter()
                    .filter_map(|p| p.name.clone())
                    .take(4)
                    .collect()
            })
            .unwrap_or_default();
        let mut line = if player.room_name.is_empty() {
            text("noRoom")
        } else {
            player.room_name.clone()
        };
        if let Some(count) = player.listener_count() {
            line = format!("{line} · {count} {}", text("listeners"));
        }
        row()
            .gap(px(8.))
            .pt(px(14.))
            .px(px(20.))
            .text_size(px(12.))
            .text_color(rgb(ui::TEXT_SOFT))
            .child(div().size(px(6.)).flex_shrink_0().rounded_full().bg(rgb(
                if player.native.connected {
                    ui::LIVE
                } else {
                    ui::MUTED
                },
            )))
            .child(div().min_w_0().flex_1().truncate().child(line))
            .child(
                row().children(names.iter().enumerate().map(|(index, name)| {
                    ui::avatar(name)
                        .border_1()
                        .border_color(rgb(ui::BACKGROUND))
                        .when(index > 0, |s| s.ml(px(-5.)))
                })),
            )
            .child(
                self.button(
                    "widget-open-room",
                    "widgetOpenRoom",
                    "expand",
                    Route::Restore,
                    authority,
                    true,
                    cx,
                )
                .size(px(26.)),
            )
    }

    fn hero(&self, player: &Player) -> Div {
        let title = if player.title.is_empty() {
            text("waitingTitle")
        } else {
            player.title.clone()
        };
        let long = title.chars().count() > 12;
        let contributor = player
            .native
            .room
            .music
            .as_ref()
            .and_then(|m| m.current.as_ref())
            .and_then(|_| player.contributor_name());
        row()
            .items_end()
            .gap(px(16.))
            .px(px(20.))
            .child(ui::artwork(88., player.artwork.clone()))
            .child(
                column()
                    .min_w_0()
                    .flex_1()
                    .child(
                        div()
                            .font_family(theme::display())
                            .font_weight(FontWeight(if long { 350. } else { 300. }))
                            .text_size(px(if long { 24. } else { 30. }))
                            .line_height(px(if long { 26. } else { 31. }))
                            .line_clamp(2)
                            .child(title),
                    )
                    .when_some(player.details.artist.clone(), |s, artist| {
                        s.child(
                            div()
                                .mt(px(3.))
                                .font_family(theme::display())
                                .text_size(px(15.))
                                .text_color(rgb(ui::TEXT_SOFT))
                                .truncate()
                                .child(artist),
                        )
                    })
                    .when_some(contributor, |s, name| {
                        s.child(ui::dedication(name, 14.5).mt(px(6.)))
                    }),
            )
    }

    fn timeline(
        &self,
        player: &Player,
        authority: CommandAuthority,
        cx: &Context<Self>,
    ) -> Stateful<Div> {
        let live = player.available && player.host_ready;
        let duration = player.duration;
        let seeking = ui::safe_seek(player.position, duration, live).is_some();
        let bounds = Rc::new(Cell::new(None::<Bounds<Pixels>>));
        let measured = bounds.clone();
        div()
            .id("widget-seek")
            .occlude()
            .relative()
            .h(px(20.))
            .w_full()
            .flex()
            .items_center()
            .rounded(px(4.))
            .child(
                canvas(move |b, _, _| measured.set(Some(b)), |_, _, _, _| {})
                    .absolute()
                    .size_full(),
            )
            .when(seeking, |s| {
                s.cursor_pointer()
                    .focusable()
                    .tab_stop(true)
                    .focus(|s| s.bg(rgb(ui::SECONDARY)))
            })
            .tooltip(|_, cx| cx.new(|_| ui::Tip(text("seekHint"))).into())
            .child(ui::track_bar(
                ui::progress(player.position, duration),
                if seeking { ui::AMBER } else { ui::FAINT },
                if seeking { 10. } else { 0. },
            ))
            .on_click(cx.listener(move |widget, event: &gpui::ClickEvent, _, cx| {
                if seeking
                    && let Some(point) = event.mouse_position()
                    && let Some(bounds) = bounds.get()
                    && let Some(fraction) = ui::slider_fraction(point.x, bounds)
                {
                    widget.route(
                        Route::Playback(Control::Seek(f64::from(fraction) * duration)),
                        authority,
                        cx,
                    );
                }
            }))
            .on_key_down(
                cx.listener(move |widget, event: &gpui::KeyDownEvent, _, cx| {
                    let delta = match event.keystroke.key.as_str() {
                        "left" => -10.,
                        "right" => 10.,
                        _ => return,
                    };
                    if seeking && let Some(owner) = widget.owner.upgrade() {
                        let position = owner.read(cx).position;
                        widget.route(
                            Route::Playback(Control::Seek(position + delta)),
                            authority,
                            cx,
                        );
                        cx.stop_propagation();
                    }
                }),
            )
    }

    fn transport(&self, player: &Player, authority: CommandAuthority, cx: &Context<Self>) -> Div {
        let live = player.available && player.host_ready;
        let volume = player.volume;
        let audible = if player.muted { 0 } else { volume };
        let bounds = Rc::new(Cell::new(None::<Bounds<Pixels>>));
        let measured = bounds.clone();
        let time = format!(
            "{} / {}",
            ui::time(player.position),
            if player.duration > 0. {
                ui::time(player.duration)
            } else {
                text("unknownTime")
            }
        );
        let side = |content: Div| content.w(px(104.)).flex_shrink_0();
        row()
            .mt(px(4.))
            .justify_between()
            .child(
                side(row().gap(px(2.)))
                    .child(
                        self.button(
                            "widget-mute",
                            if player.muted { "unmute" } else { "mute" },
                            if audible == 0 { "mute" } else { "volume" },
                            Route::Playback(Control::Mute),
                            authority,
                            true,
                            cx,
                        )
                        .size(px(30.)),
                    )
                    .child(
                        div()
                            .id("widget-volume")
                            .occlude()
                            .relative()
                            .w(px(56.))
                            .h(px(28.))
                            .flex()
                            .items_center()
                            .cursor_pointer()
                            .focusable()
                            .tab_stop(true)
                            .rounded(px(4.))
                            .focus(|s| s.bg(rgb(ui::SECONDARY)))
                            .tooltip(|_, cx| cx.new(|_| ui::Tip(text("localVolume"))).into())
                            .child(
                                canvas(move |b, _, _| measured.set(Some(b)), |_, _, _, _| {})
                                    .absolute()
                                    .size_full(),
                            )
                            .child(ui::track_bar(f32::from(audible) / 100., ui::TEXT, 10.))
                            .on_click(cx.listener(
                                move |widget, event: &gpui::ClickEvent, _, cx| {
                                    if let Some(point) = event.mouse_position()
                                        && let Some(bounds) = bounds.get()
                                        && let Some(fraction) = ui::slider_fraction(point.x, bounds)
                                    {
                                        let volume = (fraction * 100.).round() as u8;
                                        widget.route(
                                            Route::Playback(Control::Volume(volume)),
                                            authority,
                                            cx,
                                        );
                                    }
                                },
                            ))
                            .on_key_down(cx.listener(
                                move |widget, event: &gpui::KeyDownEvent, _, cx| {
                                    let volume = match event.keystroke.key.as_str() {
                                        "left" => volume.saturating_sub(5),
                                        "right" => volume.saturating_add(5).min(100),
                                        _ => return,
                                    };
                                    widget.route(
                                        Route::Playback(Control::Volume(volume)),
                                        authority,
                                        cx,
                                    );
                                    cx.stop_propagation();
                                },
                            )),
                    ),
            )
            .child(
                row()
                    .gap(px(8.))
                    .child(self.button(
                        "widget-previous",
                        "previous",
                        "previous",
                        Route::Playback(Control::Previous),
                        authority,
                        player.previous_enabled(),
                        cx,
                    ))
                    .child(self.play(52., player.playing, live, authority, cx))
                    .child(self.button(
                        "widget-next",
                        "next",
                        "next",
                        Route::Playback(Control::Next),
                        authority,
                        live,
                        cx,
                    )),
            )
            .child(
                side(div().flex().justify_end())
                    .text_size(px(12.))
                    .text_color(rgb(ui::MUTED))
                    .child(time),
            )
    }

    fn moods(&self, player: &Player, authority: CommandAuthority, cx: &Context<Self>) -> Div {
        let groups = player.native.mood_groups();
        let can_tag = player.native.can().account_write && !player.music_ui.blocked(&player.native);
        let mut pills = div().flex().flex_wrap().gap(px(6.));
        let mut shown = 0;
        for chip in groups.complement.iter().chain(&groups.priority).take(3) {
            shown += 1;
            let active = can_show_personal(&player.native, chip.active);
            let action = Action::Tag {
                track: player.native.room.track_id().unwrap_or_default().into(),
                epoch: player.native.track_generation,
                mood: chip.mood.id.clone(),
                active: !active,
            };
            let enabled = can_tag
                && player.native.room.track_id().is_some()
                && chip.active != ActiveTag::Unknown;
            pills = pills.child(self.pill(
                gpui::SharedString::from(format!("widget-mood-{}", chip.mood.id)),
                if active { "tagRemoveTip" } else { "tagAddTip" },
                ui::mood_glyph(&chip.mood.icon_key),
                Some(chip.mood.name.clone()),
                active,
                Route::Native(action),
                authority,
                enabled,
                cx,
            ));
        }
        pills = pills.child(self.pill(
            "widget-all-moods",
            "allMoods",
            "plus",
            (shown == 0).then(|| text("allMoods")),
            false,
            Route::Native(Action::Show(Panel::Moods)),
            authority,
            true,
            cx,
        ));
        let hint = if !player.native.room.active() {
            text("musicModeShort")
        } else if !player.native.can().account_write {
            text("signInToTag")
        } else {
            text("myMoodsHint")
        };
        column()
            .mt(px(16.))
            .gap(px(8.))
            .child(section(text("widgetMoods"), quiet(hint, 11.5)))
            .child(pills)
    }

    /// A mood pill (`.pill`): glass, hairline; pressed shows a tint, bold label and a check.
    #[expect(
        clippy::too_many_arguments,
        reason = "label, glyph, state and route stay explicit"
    )]
    fn pill(
        &self,
        id: impl Into<gpui::ElementId>,
        key: &'static str,
        glyph: &'static str,
        label: Option<String>,
        pressed: bool,
        route: Route,
        authority: CommandAuthority,
        enabled: bool,
        cx: &Context<Self>,
    ) -> Stateful<Div> {
        let foreground = if pressed {
            ui::TEXT
        } else if enabled {
            ui::TEXT_SOFT
        } else {
            ui::MUTED
        };
        self.control(id, key, route, authority, enabled, ui::SECONDARY, cx)
            .w_auto()
            .max_w(px(150.))
            .h(px(32.))
            .pl(px(10.))
            .pr(px(11.))
            .gap(px(6.))
            .bg(rgb(if pressed {
                ui::PERSONAL_SURFACE
            } else {
                ui::POPOVER
            }))
            .border_color(rgb(if pressed {
                ui::PERSONAL_BORDER
            } else {
                ui::BORDER
            }))
            .text_size(px(13.))
            .text_color(rgb(foreground))
            .when(pressed, |s| s.font_weight(FontWeight::SEMIBOLD))
            .child(ui::icon(glyph, 16.).text_color(rgb(foreground)))
            .when_some(label, |s, label| {
                s.child(div().min_w_0().truncate().child(label))
            })
            .when(pressed, |s| {
                s.child(ui::icon("check", 14.).text_color(rgb(ui::TEXT)))
            })
    }

    /// A played track: a click (or Enter) brings it back for the room. Like `control`, but
    /// the row's own layout sets its single hover and tooltip.
    fn played(
        &self,
        player: &Player,
        index: usize,
        track: &ui_queue::QueueTrack,
        authority: CommandAuthority,
        cx: &Context<Self>,
    ) -> Stateful<Div> {
        let steps = player.queue.steps(index);
        let enabled = player.go_back_enabled() && steps.is_some();
        let route = Route::Playback(Control::GoBack(steps.unwrap_or(1)));
        let base = div()
            .id(("widget-played", index))
            .occlude()
            .border_1()
            .border_color(gpui::transparent_black())
            .when(enabled, |s| {
                s.cursor_pointer()
                    .focusable()
                    .tab_stop(true)
                    .focus(|s| s.border_color(rgb(ui::TEXT)))
            })
            .on_click(cx.listener(move |widget, _, _, cx| {
                if enabled {
                    widget.route(route.clone(), authority, cx);
                }
            }));
        let image = player.covers.get(track.cover.as_ref());
        ui_queue::played_row(base, track, image, 26., false, enabled)
    }

    /// The last played tracks, the current one and the next ones, kept compact.
    fn queue(&self, player: &Player, authority: CommandAuthority, cx: &Context<Self>) -> Div {
        let queue = &player.queue;
        let (played_rows, upcoming_rows) = widget_rows(queue.played.len());
        let mut list = column().gap(px(2.));
        for (index, track) in queue.recent(played_rows) {
            list = list.child(self.played(player, index, track, authority, cx));
        }
        if let Some(current) = &queue.current {
            let image = player
                .covers
                .get(current.cover.as_ref())
                .or_else(|| player.artwork.clone());
            list = list.child(ui_queue::now_card(
                current,
                &player.title,
                image,
                player.playing,
                &self.bars,
                40.,
                true,
            ));
        }
        if !player.show_up_next {
            list = list.child(quiet(text("upcomingHidden"), 12.).py(px(4.)).px(px(6.)));
        } else if queue.upcoming.is_empty() {
            list = list.child(quiet(text("queueEmpty"), 12.).py(px(4.)).px(px(6.)));
        } else {
            for track in queue.upcoming.iter().take(upcoming_rows) {
                let image = player.covers.get(track.cover.as_ref());
                list = list.child(ui_queue::upcoming_row(track, image, 30.));
            }
        }
        column()
            .mt(px(16.))
            .gap(px(4.))
            .child(section(
                text(if queue.history() {
                    "queueHeading"
                } else {
                    "upNext"
                }),
                self.link(
                    "widget-see-queue",
                    "widgetSeeQueue",
                    Route::Native(Action::Show(Panel::Queue)),
                    authority,
                    cx,
                ),
            ))
            .child(list)
            .child(
                self.pill(
                    "widget-add",
                    "widgetAdd",
                    "plus",
                    Some(text("widgetAdd")),
                    false,
                    Route::Native(Action::Show(Panel::Add)),
                    authority,
                    true,
                    cx,
                )
                .mt(px(4.))
                .max_w(px(200.)),
            )
    }

    fn link(
        &self,
        id: &'static str,
        key: &'static str,
        route: Route,
        authority: CommandAuthority,
        cx: &Context<Self>,
    ) -> Stateful<Div> {
        self.control(id, key, route, authority, true, ui::SECONDARY, cx)
            .w_auto()
            .h(px(22.))
            .px(px(4.))
            .gap(px(2.))
            .rounded(px(6.))
            .text_size(px(11.5))
            .text_color(rgb(ui::MUTED))
            .child(text(key))
            .child(ui::icon("chevron", 13.).text_color(rgb(ui::MUTED)))
    }

    /// Folded: logo, cover, title, play, unfold, and a hairline of progress.
    fn mini(&self, player: &Player, authority: CommandAuthority, cx: &Context<Self>) -> Div {
        let live = player.available && player.host_ready;
        let title = if player.title.is_empty() {
            text("waitingTitle")
        } else {
            player.title.clone()
        };
        let subtitle = [player.details.artist.clone(), player.contributor_name()]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" · ");
        div()
            .size_full()
            .relative()
            .child(
                row()
                    .size_full()
                    .gap(px(10.))
                    .pt(px(10.))
                    .pb(px(12.))
                    .px(px(12.))
                    .child(ui::logo(20.).mx(px(2.)))
                    .child(ui::artwork(44., player.artwork.clone()).rounded(px(10.)))
                    .child(
                        column()
                            .min_w_0()
                            .flex_1()
                            .child(
                                div()
                                    .font_family(theme::display())
                                    .text_size(px(16.))
                                    .truncate()
                                    .child(title),
                            )
                            .when(!subtitle.is_empty(), |s| s.child(quiet(subtitle, 12.))),
                    )
                    .child(self.play(38., player.playing, live, authority, cx))
                    .child(
                        self.chrome("widget-unfold", "widgetUnfold", "unfold", false)
                            .on_click(cx.listener(|widget, _, window, cx| {
                                widget.set_folded(false, window, cx)
                            })),
                    ),
            )
            .child(
                div()
                    .absolute()
                    .left_0()
                    .bottom_0()
                    .w_full()
                    .h(px(2.))
                    .bg(rgb(ui::BORDER))
                    .child(
                        div()
                            .h_full()
                            .w(relative(ui::progress(player.position, player.duration)))
                            .bg(rgb(ui::AMBER)),
                    ),
            )
    }
}

fn row() -> Div {
    div().flex().items_center()
}
fn column() -> Div {
    div().flex().flex_col()
}
fn quiet(value: String, font: f32) -> Div {
    div()
        .text_size(px(font))
        .text_color(rgb(ui::MUTED))
        .truncate()
        .child(value)
}
/// Section heading (`.sh`): title left, hint or link right.
fn section(title: String, aside: impl IntoElement) -> Div {
    row()
        .justify_between()
        .gap(px(10.))
        .child(
            div()
                .text_size(px(12.5))
                .font_weight(FontWeight::SEMIBOLD)
                .child(title),
        )
        .child(aside)
}

impl Render for Widget {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        theme::frame(cx);
        let layers = self
            .layers
            .get_or_insert_with(|| sky::Layers::new(RADIUS, Widget::body, window, cx));
        let (sky, body) = (layers.sky.clone(), layers.body());
        let playing = self
            .owner
            .upgrade()
            .is_some_and(|owner| owner.read(cx).playing);
        let bars = self
            .bars
            .overlay(playing && theme::animate(cx), rgb(ui::AMBER));
        div()
            .size_full()
            .relative()
            .font_family(theme::text())
            .text_size(px(13.))
            .text_color(rgb(ui::TEXT))
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|_, event: &gpui::KeyDownEvent, window, cx| {
                if ui::tab_navigation(event, window) {
                    cx.stop_propagation();
                }
            }))
            .child(sky)
            // Drag the widget from anywhere: every control in the body occludes this underlay.
            // It lives outside the cached body because GPUI does not replay window-control
            // hitboxes of a reused view.
            .child(
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full()
                    .window_control_area(WindowControlArea::Drag),
            )
            .child(body)
            .child(bars)
            .child(
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full()
                    .rounded(px(RADIUS))
                    .border_1()
                    .border_color(rgb(ui::BORDER)),
            )
    }
}

/// Played and upcoming rows of the widget: at most two played tracks, three rows in all.
fn widget_rows(played: usize) -> (usize, usize) {
    let played = played.min(2);
    (played, (3 - played).min(2))
}

fn forget_widget(main: WindowHandle<Player>, widget: WindowHandle<Widget>, cx: &mut App) {
    cx.defer(move |cx| {
        let _ = main.update(cx, |player, _, cx| {
            // A delayed close from an earlier widget must not forget its replacement.
            if player.widget == Some(widget) {
                player.widget = None;
                player.save_prefs();
                cx.notify();
            }
        });
    });
}

fn footer_status(error: &str, notice: &str, status: &str, live: bool) -> String {
    if !error.is_empty() {
        error.to_owned()
    } else if status == text("autoplay-blocked") {
        text("widgetEnablePlayback")
    } else if [
        "waiting-snapshot",
        "waiting-clock",
        "recovering",
        "loading",
        "buffering",
        "unsupported-rate",
        "error",
        "connectionFailed",
        "protocolRequired",
        "invalidTimeline",
        "unsupportedTimeline",
        "unsupportedSource",
        "browserFailed",
        "bridgeFailed",
    ]
    .iter()
    .any(|key| status == text(key))
    {
        status.to_owned()
    } else if !notice.is_empty() {
        notice.to_owned()
    } else if live {
        text("widgetPlaybackHint")
    } else {
        status.to_owned()
    }
}
fn can_show_personal(state: &undertone_desktop::session::NativeState, active: ActiveTag) -> bool {
    state.account.logged_in && !state.account.expired && active == ActiveTag::Active
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn available_provider_still_exposes_recovery_before_success_notices() {
        assert_eq!(
            footer_status("", "Command applied", &text("autoplay-blocked"), true),
            text("widgetEnablePlayback")
        );
        for key in ["buffering", "recovering", "loading", "error"] {
            assert_eq!(
                footer_status("", "Command applied", &text(key), true),
                text(key)
            );
        }
        for key in ["playing", "paused"] {
            assert_eq!(
                footer_status("", "", &text(key), true),
                text("widgetPlaybackHint")
            );
        }
        assert_eq!(
            footer_status("Window error", "", &text("autoplay-blocked"), true),
            "Window error"
        );
    }

    #[test]
    fn neutral_status_does_not_hide_actionable_notices() {
        for key in [
            "idle",
            "connecting",
            "connected",
            "empty",
            "disposed",
            "playing",
            "paused",
        ] {
            for notice in ["invalidRoom", "widgetRestoreFailed"] {
                for live in [false, true] {
                    assert_eq!(
                        footer_status("", &text(notice), &text(key), live),
                        text(notice)
                    );
                }
            }
        }
        assert_eq!(footer_status("", "", &text("idle"), false), text("idle"));
    }

    #[test]
    fn closing_main_preserves_playback_owner_only_while_widget_exists() {
        assert!(keep_owner_on_close(true));
        assert!(!keep_owner_on_close(false));
    }
    #[test]
    fn public_or_unknown_tags_never_look_like_confirmed_personal_tags() {
        let mut state = undertone_desktop::session::NativeState::default();
        assert!(!can_show_personal(&state, ActiveTag::Active));
        state.account.logged_in = true;
        assert!(can_show_personal(&state, ActiveTag::Active));
        assert!(!can_show_personal(&state, ActiveTag::Unknown));
        state.account.expired = true;
        assert!(!can_show_personal(&state, ActiveTag::Active));
    }
    #[test]
    fn the_widget_queue_stays_compact() {
        assert_eq!(widget_rows(0), (0, 2));
        assert_eq!(widget_rows(1), (1, 2));
        assert_eq!(widget_rows(10), (2, 1));
    }
    #[test]
    fn folded_and_full_sizes_fit_the_card() {
        assert!(MINI_SIZE.1 < WIDGET_SIZE.1 && MINI_SIZE.0 == WIDGET_SIZE.0);
        assert!(RADIUS * 2. < MINI_SIZE.1);
    }
}
