//! A second native window. It observes Player and routes captured commands to that window;
//! it never renders Player, owns forms, a connection, observer, or a WebView.
use super::{
    Control, Player, native_window, ui,
    ui_music::{Action, Panel},
};
use gpui::{
    App, AppContext, Bounds, Context, Div, Entity, FocusHandle, IntoElement, Render, Stateful,
    TitlebarOptions, WeakEntity, Window, WindowBounds, WindowControlArea, WindowHandle,
    WindowOptions, div, prelude::*, px, relative, rgb, size,
};
use undertone_desktop::{artwork::YoutubeId, music::ActiveTag, session::CommandAuthority, text};

pub const WIDGET_SIZE: (f32, f32) = (410., 661.);
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
    error: String,
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
            return;
        }
        let main = window
            .window_handle()
            .downcast::<Player>()
            .expect("player root");
        let owner = cx.entity();
        self.widget_open_pending = true;
        // GPUI open_window draws the new root synchronously. Defer outside Player's mutable
        // entity lease so the first Widget::render can safely read its owner.
        cx.defer(move |cx| {
            if main.read(cx).is_err() {
                return;
            }
            let bounds = Bounds::centered(None, size(px(WIDGET_SIZE.0), px(WIDGET_SIZE.1)), cx);
            let result = cx.open_window(
                WindowOptions {
                    titlebar: Some(TitlebarOptions {
                        title: Some(text("widgetTitle").into()),
                        appears_transparent: true,
                        ..Default::default()
                    }),
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    window_min_size: Some(size(px(WIDGET_SIZE.0), px(WIDGET_SIZE.1))),
                    window_background: gpui::WindowBackgroundAppearance::Transparent,
                    is_resizable: false,
                    focus: false,
                    ..Default::default()
                },
                move |window, cx| cx.new(|cx| Widget::new(owner, main, window, cx)),
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
                    player.artwork = image.map(|image| {
                        let mut pixels = (*image).clone();
                        // GPUI RenderImage expects BGRA, not image's RGBA. Thumbnail is opaque.
                        for pixel in pixels.chunks_exact_mut(4) {
                            pixel.swap(0, 2);
                        }
                        std::sync::Arc::new(gpui::RenderImage::new(vec![image::Frame::new(pixels)]))
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
        let focus = cx.focus_handle();
        let pinned = native_window::pin(window, true).is_ok();
        Self {
            owner: owner.downgrade(),
            main,
            focus,
            pinned,
            error: if pinned {
                String::new()
            } else {
                text("widgetPinFailed")
            },
        }
    }
    fn route(&self, route: Route, authority: CommandAuthority, cx: &mut Context<Self>) {
        let main = self.main;
        // Deferred so the main root is never updated during a widget read/render or window removal.
        cx.defer(move |cx| {
            let _ = main.update(cx, |player, window, cx| match route {
                Route::Playback(control) => player.control(control, authority, window, cx),
                Route::Native(action) => {
                    if matches!(action, Action::Panel(_)) && native_window::restore(window).is_err()
                    {
                        player.notice = text("widgetRestoreFailed");
                    }
                    // Opening a panel is idempotent from the widget, rather than toggling it shut.
                    if let Action::Panel(panel) = action
                        && player.music_ui.panel == Some(panel)
                    {
                        return;
                    }
                    player.music_action(action, authority, window, cx);
                }
                Route::Restore => {
                    if native_window::restore(window).is_err() {
                        player.notice = text("widgetRestoreFailed");
                    }
                    cx.notify();
                }
                Route::Quit => cx.quit(),
            });
        });
    }
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
        let label = text(key);
        div()
            .id(id)
            .size(px(32.))
            .flex_shrink_0()
            .rounded(px(9.))
            .flex()
            .items_center()
            .justify_center()
            .text_color(rgb(if enabled { ui::MUTED } else { ui::BORDER }))
            .when(enabled, |s| {
                s.cursor_pointer()
                    .focusable()
                    .tab_stop(true)
                    .hover(|s| s.bg(rgb(ui::SECONDARY)))
                    .focus(|s| s.bg(rgb(ui::SECONDARY)))
            })
            .tooltip(move |_, cx| cx.new(|_| ui::Tip(label.clone())).into())
            .child(ui::icon(glyph, 18.))
            .on_click(cx.listener(move |widget, _, _, cx| {
                if enabled {
                    widget.route(route.clone(), authority, cx);
                }
            }))
    }
}

fn row() -> Div {
    div().flex().items_center()
}
fn column() -> Div {
    div().flex().flex_col()
}
fn slot(y: f32, height: f32) -> Div {
    div()
        .absolute()
        .left(px(20.))
        .top(px(y))
        .w(px(370.))
        .h(px(height))
}
fn quiet(value: String, font: f32) -> Div {
    div()
        .text_size(px(font))
        .text_color(rgb(ui::MUTED))
        .truncate()
        .child(value)
}

impl Render for Widget {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(owner) = self.owner.upgrade() else {
            return div().into_any_element();
        };
        let player = owner.read(cx);
        let authority = player.native.authority();
        let live = player.available && player.host_ready;
        let panel = |panel| Route::Native(Action::Panel(panel));
        let icon_button =
            |key, glyph, route| self.button(key, key, glyph, route, authority, true, cx);
        let current = player
            .native
            .room
            .music
            .as_ref()
            .and_then(|m| m.current.as_ref());
        let contributor = current.and_then(|c| {
            player
                .native
                .room
                .music
                .as_ref()?
                .participants
                .iter()
                .find(|p| p.participant_id == c.entry.contributor_id)?
                .name
                .clone()
        });
        let chrome = row()
            .gap(px(3.))
            .child(self.button(
                "widget-add-header",
                "widgetAdd",
                "plus",
                panel(Panel::Add),
                authority,
                true,
                cx,
            ))
            .child(
                div()
                    .id("widget-pin")
                    .size(px(32.))
                    .rounded(px(9.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_color(rgb(if self.pinned { ui::AMBER } else { ui::MUTED }))
                    .when(self.pinned, |s| s.bg(rgb(ui::SECONDARY)))
                    .cursor_pointer()
                    .focusable()
                    .tab_stop(true)
                    .focus(|s| s.border_1().border_color(rgb(ui::AMBER)))
                    .tooltip(|_, cx| cx.new(|_| ui::Tip(text("widgetPin"))).into())
                    .child(ui::icon("pin", 18.))
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
            .child(icon_button("settings", "settings", panel(Panel::Settings)))
            .child(
                div()
                    .id("widget-minimize")
                    .size(px(32.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .focusable()
                    .tab_stop(true)
                    .child(ui::icon("minus", 18.))
                    .tooltip(|_, cx| cx.new(|_| ui::Tip(text("widgetMinimize"))).into())
                    .on_click(|_, window, _| window.minimize_window()),
            );
        let header = row()
            .absolute()
            .top_0()
            .left_0()
            .w_full()
            .h(px(52.))
            .px(px(17.))
            .justify_between()
            .border_b_1()
            .border_color(rgb(ui::BORDER))
            .child(
                row()
                    .gap(px(8.))
                    .flex_1()
                    .h_full()
                    .window_control_area(WindowControlArea::Drag)
                    .child(
                        div()
                            .text_color(rgb(ui::AMBER))
                            .child(ui::icon("brand", 18.)),
                    )
                    .child(
                        div()
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .child(text("app")),
                    ),
            )
            .child(chrome);
        let room =
            slot(72., 20.)
                .flex()
                .items_center()
                .justify_between()
                .child(
                    row()
                        .gap(px(7.))
                        .min_w_0()
                        .flex_1()
                        .child(div().size(px(5.)).rounded_full().bg(rgb(
                            if player.native.connected {
                                0xa9c6a1
                            } else {
                                ui::MUTED
                            },
                        )))
                        .child(quiet(
                            if player.room_name.is_empty() {
                                text("noRoom")
                            } else {
                                player.room_name.clone()
                            },
                            11.,
                        )),
                )
                .child(
                    icon_button("widgetOpenRoom", "expand", Route::Restore)
                        .w_auto()
                        .px(px(2.))
                        .gap(px(4.))
                        .child(quiet(text("widgetOpenRoom"), 11.)),
                );
        let now = slot(110., 94.)
            .flex()
            .items_center()
            .gap(px(17.))
            .child(ui::artwork(94., player.artwork.clone()))
            .child(
                column()
                    .min_w_0()
                    .flex_1()
                    .gap(px(5.))
                    .child(
                        div()
                            .text_size(px(9.))
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .text_color(rgb(ui::AMBER))
                            .child(text("nowPlaying")),
                    )
                    .child(
                        div()
                            .text_size(px(25.))
                            .line_height(px(29.))
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .truncate()
                            .child(if player.title.is_empty() {
                                text("waitingTitle")
                            } else {
                                player.title.clone()
                            }),
                    )
                    .when_some(player.details.artist.clone(), |s, a| s.child(quiet(a, 14.)))
                    .when_some(contributor.clone(), |s, name| {
                        s.child(quiet(format!("{} {name}", text("widgetAddedBy")), 10.))
                    }),
            );
        let duration = player.duration;
        let seeking = ui::safe_seek(player.position, duration, live).is_some();
        let timeline = slot(218., 36.)
            .flex()
            .flex_col()
            .gap(px(4.))
            .child(
                div()
                    .id("widget-seek")
                    .w_full()
                    .h(px(14.))
                    .flex()
                    .items_center()
                    .when(seeking, |s| s.cursor_pointer().focusable().tab_stop(true))
                    .child(
                        div()
                            .relative()
                            .h(px(3.))
                            .w_full()
                            .rounded_full()
                            .bg(rgb(ui::SECONDARY))
                            .child(
                                div()
                                    .h_full()
                                    .rounded_full()
                                    .w(relative(ui::progress(player.position, duration)))
                                    .bg(rgb(ui::AMBER)),
                            )
                            .child(
                                div()
                                    .absolute()
                                    .top(px(-2.5))
                                    .left(relative(ui::progress(player.position, duration)))
                                    .ml(px(-4.))
                                    .size(px(8.))
                                    .rounded_full()
                                    .bg(rgb(ui::AMBER)),
                            ),
                    )
                    .on_click(cx.listener(move |widget, event: &gpui::ClickEvent, _, cx| {
                        if seeking && let Some(point) = event.mouse_position() {
                            let fraction = ((f32::from(point.x) - 20.) / 370.).clamp(0., 1.);
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
                    ),
            )
            .child(
                row()
                    .justify_between()
                    .child(quiet(ui::time(player.position), 10.))
                    .child(quiet(
                        if duration > 0. {
                            ui::time(duration)
                        } else {
                            text("unknownTime")
                        },
                        10.,
                    )),
            );
        let volume = player.volume;
        let audible = if player.muted { 0 } else { volume };
        let transport = slot(258., 44.)
            .flex()
            .items_center()
            .justify_between()
            .child(
                row()
                    .w(px(94.))
                    .gap(px(3.))
                    .child(icon_button(
                        if player.muted { "unmute" } else { "mute" },
                        if player.muted { "mute" } else { "volume" },
                        Route::Playback(Control::Mute),
                    ))
                    .child(
                        div()
                            .id("widget-volume")
                            .w(px(60.))
                            .h(px(28.))
                            .flex()
                            .items_center()
                            .cursor_pointer()
                            .focusable()
                            .tab_stop(true)
                            .tooltip(|_, cx| cx.new(|_| ui::Tip(text("localVolume"))).into())
                            .child(
                                div()
                                    .relative()
                                    .w_full()
                                    .h(px(3.))
                                    .rounded_full()
                                    .bg(rgb(ui::SECONDARY))
                                    .child(
                                        div()
                                            .w(relative(f32::from(audible) / 100.))
                                            .h_full()
                                            .bg(rgb(ui::MUTED)),
                                    )
                                    .child(
                                        div()
                                            .absolute()
                                            .top(px(-1.5))
                                            .left(relative(f32::from(audible) / 100.))
                                            .ml(px(-3.))
                                            .size(px(6.))
                                            .rounded_full()
                                            .bg(rgb(ui::MUTED)),
                                    ),
                            )
                            .on_click(cx.listener(
                                move |widget, event: &gpui::ClickEvent, _, cx| {
                                    if let Some(point) = event.mouse_position() {
                                        let volume = (((f32::from(point.x) - 55.) / 60.)
                                            .clamp(0., 1.)
                                            * 100.)
                                            .round()
                                            as u8;
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
                    .absolute()
                    .left(px(106.))
                    .gap(px(13.))
                    .child(
                        self.button(
                            "widget-previous",
                            "previous",
                            "previous",
                            Route::Playback(Control::Previous),
                            authority,
                            live,
                            cx,
                        )
                        .size(px(24.)),
                    )
                    .child(
                        self.button(
                            "widget-play",
                            if player.playing { "pause" } else { "play" },
                            if player.playing { "pause" } else { "play" },
                            Route::Playback(Control::PlayPause),
                            authority,
                            live,
                            cx,
                        )
                        .size(px(44.))
                        .rounded_full()
                        .bg(rgb(ui::AMBER))
                        .text_color(rgb(ui::AMBER_TEXT)),
                    )
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
                self.button(
                    "widget-add-transport",
                    "widgetAdd",
                    "plus",
                    panel(Panel::Add),
                    authority,
                    true,
                    cx,
                )
                .border_1()
                .border_color(rgb(ui::BORDER)),
            );
        let groups = player.native.mood_groups();
        let mut chips = row().gap(px(7.)).overflow_hidden();
        let can_tag = player.native.can().account_write && !player.music_ui.busy(&player.native);
        for chip in groups.complement.iter().chain(&groups.priority).take(3) {
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
            chips = chips.child(
                self.button(
                    gpui::SharedString::from(format!("widget-mood-{}", chip.mood.id)),
                    if active { "tagActive" } else { "tagAdd" },
                    mood_icon(&chip.mood.icon_key),
                    Route::Native(action),
                    authority,
                    enabled,
                    cx,
                )
                .w_auto()
                .max_w(px(101.))
                .px(px(8.))
                .gap(px(5.))
                .border_1()
                .border_color(rgb(ui::BORDER))
                .when(active, |s| {
                    s.bg(rgb(ui::PERSONAL_SURFACE))
                        .text_color(rgb(ui::PERSONAL))
                })
                .child(
                    div()
                        .truncate()
                        .text_size(px(12.))
                        .child(chip.mood.name.clone()),
                ),
            );
        }
        chips = chips.child(
            icon_button("trackMoods", "plus", panel(Panel::Moods))
                .border_1()
                .border_color(rgb(ui::BORDER)),
        );
        let suggestions = player.details.tags.join(" · ");
        let moods = slot(326., 88.)
            .flex()
            .flex_col()
            .gap(px(10.))
            .child(
                row()
                    .justify_between()
                    .child(
                        div()
                            .text_size(px(11.))
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .child(text("widgetMoods")),
                    )
                    .child(quiet(text("widgetTagHint"), 10.)),
            )
            .child(chips)
            .child(quiet(
                if suggestions.is_empty() {
                    text(if player.native.can().account_write {
                        "widgetMoodsHint"
                    } else {
                        "accountNeeded"
                    })
                } else {
                    format!("{} {suggestions}", text("widgetSuggestions"))
                },
                10.,
            ));
        let mut queue = slot(430., 132.)
            .border_t_1()
            .border_color(rgb(ui::BORDER))
            .pt(px(12.))
            .flex()
            .flex_col()
            .gap(px(10.))
            .child(
                row()
                    .h(px(22.))
                    .justify_between()
                    .child(quiet(text("upNext"), 10.))
                    .child(
                        icon_button("widgetSeeQueue", "queue", panel(Panel::Queue))
                            .w_auto()
                            .gap(px(4.))
                            .child(quiet(text("widgetSeeQueue"), 10.)),
                    ),
            );
        for track in player.up_next.iter().take(2) {
            queue = queue.child(
                row()
                    .h(px(34.))
                    .gap(px(10.))
                    // Queue DTO has no validated provider ID/art URL or duration. Use embedded fallback.
                    .child(ui::artwork(33., None))
                    .child(
                        column()
                            .min_w_0()
                            .flex_1()
                            .gap(px(2.))
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .font_weight(gpui::FontWeight::SEMIBOLD)
                                    .truncate()
                                    .child(track.title.clone()),
                            )
                            .when_some(track.artist.clone(), |s, a| s.child(quiet(a, 10.))),
                    ),
            );
        }
        if player.up_next.is_empty() {
            queue = queue.child(quiet(text("queueEmpty"), 11.));
        }
        let footer_text = if !self.error.is_empty() {
            self.error.clone()
        } else if !player.notice.is_empty() {
            player.notice.clone()
        } else if live {
            text("widgetPlaybackHint")
        } else {
            player.status.clone()
        };
        let footer_tip = footer_text.clone();
        div()
            .size_full()
            .relative()
            .rounded(px(20.))
            .overflow_hidden()
            .bg(rgb(ui::CARD))
            .border_1()
            .border_color(rgb(ui::BORDER))
            .font_family("Segoe UI")
            .text_size(px(13.))
            .text_color(rgb(ui::TEXT))
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|_, event: &gpui::KeyDownEvent, window, cx| {
                if event.keystroke.key == "tab"
                    && !event.keystroke.modifiers.control
                    && !event.keystroke.modifiers.alt
                    && !event.keystroke.modifiers.platform
                {
                    if event.keystroke.modifiers.shift {
                        window.focus_prev();
                    } else {
                        window.focus_next();
                    }
                    cx.stop_propagation();
                }
            }))
            .child(header)
            .child(room)
            .child(now)
            .child(timeline)
            .child(transport)
            .child(moods)
            .child(queue)
            .child(
                slot(573., 39.).child(
                    self.button(
                        "widget-add-bottom",
                        "widgetAdd",
                        "plus",
                        panel(Panel::Add),
                        authority,
                        true,
                        cx,
                    )
                    .size_full()
                    .gap(px(7.))
                    .border_1()
                    .border_color(rgb(ui::BORDER))
                    .bg(rgb(ui::POPOVER))
                    .child(text("widgetAdd")),
                ),
            )
            .child(
                slot(614., 18.)
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(
                        icon_button("widgetRestore", "expand", Route::Restore)
                            .w_auto()
                            .h(px(18.))
                            .gap(px(4.))
                            .child(quiet(text("widgetRestore"), 9.)),
                    )
                    .child(
                        div()
                            .id("widget-close")
                            .h(px(18.))
                            .flex()
                            .items_center()
                            .gap(px(4.))
                            .cursor_pointer()
                            .focusable()
                            .tab_stop(true)
                            .child(ui::icon("close", 14.))
                            .child(quiet(text("widgetClose"), 9.))
                            .on_click(cx.listener(|widget, _, window, cx| {
                                let handle = window
                                    .window_handle()
                                    .downcast::<Widget>()
                                    .expect("widget root");
                                forget_widget(widget.main, handle, cx);
                                window.remove_window();
                            })),
                    )
                    .child(
                        icon_button("widgetQuit", "disconnect", Route::Quit)
                            .w_auto()
                            .h(px(18.))
                            .gap(px(4.))
                            .child(quiet(text("widgetQuit"), 9.)),
                    ),
            )
            .child(
                row()
                    .id("widget-status")
                    .tooltip(move |_, cx| cx.new(|_| ui::Tip(footer_tip.clone())).into())
                    .absolute()
                    .top(px(632.))
                    .left_0()
                    .w_full()
                    .h(px(29.))
                    .px(px(12.))
                    .gap(px(6.))
                    .justify_center()
                    .border_t_1()
                    .border_color(rgb(ui::BORDER))
                    .bg(rgb(ui::BACKGROUND))
                    .child(ui::icon("headphones", 11.))
                    .child(quiet(footer_text, 9.)),
            )
            .into_any_element()
    }
}

fn forget_widget(main: WindowHandle<Player>, widget: WindowHandle<Widget>, cx: &mut App) {
    cx.defer(move |cx| {
        let _ = main.update(cx, |player, _, cx| {
            // A delayed close from an earlier widget must not forget its replacement.
            if player.widget == Some(widget) {
                player.widget = None;
                cx.notify();
            }
        });
    });
}

fn mood_icon(key: &str) -> &'static str {
    match key {
        "heart" => "heart",
        "headphones" => "headphones",
        "moon" => "moon",
        _ => "brand",
    }
}
fn can_show_personal(state: &undertone_desktop::session::NativeState, active: ActiveTag) -> bool {
    state.account.logged_in && !state.account.expired && active == ActiveTag::Active
}

#[cfg(test)]
mod tests {
    use super::*;
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
}
