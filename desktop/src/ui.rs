//! Native presentation only. Transport, timeline projection and provider activation stay in
//! their existing owners. Optional metadata must be populated from validated room data.
use super::{Control, Player};
use gpui::{
    AssetSource, Context, Div, IntoElement, Render, SharedString, Stateful, Window, canvas, div,
    prelude::*, px, relative, rgb, svg,
};
use std::{borrow::Cow, cell::Cell, rc::Rc};
use undertone_desktop::text;

const BACKGROUND: u32 = 0x100f0e;
const TEXT: u32 = 0xf7f0e6;
const CARD: u32 = 0x1b1917;
const POPOVER: u32 = 0x24211e;
const SECONDARY: u32 = 0x302b24;
const MUTED: u32 = 0xaaa296;
const BORDER: u32 = 0x39342e;
const AMBER: u32 = 0xffbe3d;
const AMBER_TEXT: u32 = 0x271b07;
const SUCCESS: u32 = 0xa9c6a1;
const PERSONAL: u32 = 0x8bc0ff;
const PERSONAL_SURFACE: u32 = 0x20354c;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Mode {
    #[default]
    Full,
    Compact,
}

#[derive(Debug)]
pub struct ProviderRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl Mode {
    pub fn toggled(self) -> Self {
        match self {
            Self::Full => Self::Compact,
            Self::Compact => Self::Full,
        }
    }

    pub fn window_size(self, provider: bool) -> (f32, f32) {
        match self {
            Self::Full => (840., 620.),
            Self::Compact => (440., if provider { 704. } else { 480. }),
        }
    }

    pub fn padding(self) -> f32 {
        if self == Self::Compact { 20. } else { 24. }
    }

    /// Keep a visible provider surface in both modes, above YouTube's 200×200 minimum.
    /// Coordinates match the fixed native slots below; mode changes only move this surface.
    pub fn provider_rect(self, width: f32) -> ProviderRect {
        match self {
            Self::Full => ProviderRect {
                x: width - 344.,
                y: 124.,
                width: 320.,
                height: 224.,
            },
            Self::Compact => ProviderRect {
                x: 20.,
                y: 448.,
                width: width - 40.,
                height: 224.,
            },
        }
    }
}

/// Integration seam: no inferred artist, invented tags, or guest-owned personal tags.
#[derive(Default)]
pub struct TrackDetails {
    pub artist: Option<String>,
    pub tags: Vec<String>,
    /// Populate only from an authenticated account's own track tags.
    pub personal_tags: Option<Vec<String>>,
}

#[derive(Default)]
pub struct RoomPreferences {
    pub include: Vec<String>,
    pub exclude: Vec<String>,
}

impl RoomPreferences {
    pub fn is_empty(&self) -> bool {
        self.include.is_empty() && self.exclude.is_empty()
    }
}

pub struct UpcomingTrack {
    pub title: String,
    pub artist: Option<String>,
}

pub fn progress(position: f64, duration: f64) -> f32 {
    if position.is_finite() && duration.is_finite() && duration > 0. {
        (position / duration).clamp(0., 1.) as f32
    } else {
        0.
    }
}

pub fn safe_seek(position: f64, duration: f64, available: bool) -> Option<f64> {
    (available && position.is_finite() && duration.is_finite() && duration > 0.)
        .then(|| position.clamp(0., duration.min(1e9)))
}

fn time(seconds: f64) -> String {
    let seconds = if seconds.is_finite() {
        seconds.max(0.) as u64
    } else {
        0
    };
    format!("{}:{:02}", seconds / 60, seconds % 60)
}

// Small, original monochrome glyphs, embedded in the binary; no font or asset fetches.
pub struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> anyhow::Result<Option<Cow<'static, [u8]>>> {
        let shape = match path {
            "play" => "<path d='M8 5L20 12L8 19Z' fill='black' stroke='none'/>",
            "pause" => "<path d='M8 5V19M16 5V19' stroke-width='4'/>",
            "previous" => "<path d='M6 5V19M18 5L8 12L18 19Z'/>",
            "next" => "<path d='M18 5V19M6 5L16 12L6 19Z'/>",
            "volume" => "<path d='M3 9H7L12 5V19L7 15H3ZM16 8Q20 12 16 16M19 5Q26 12 19 19'/>",
            "mute" => "<path d='M3 9H7L12 5V19L7 15H3ZM17 9L23 15M23 9L17 15'/>",
            "minus" => "<path d='M6 12H18'/>",
            "plus" => "<path d='M6 12H18M12 6V18'/>",
            "compact" => {
                "<rect x='4' y='4' width='16' height='16' rx='3'/><path d='M10 4V20M10 13H20'/>"
            }
            "expand" => "<path d='M9 3H3V9M15 3H21V9M3 15V21H9M21 15V21H15'/>",
            "queue" => "<path d='M4 6H20M4 12H20M4 18H12'/>",
            "brand" => "<path d='M3 10V14M7 6V18M12 3V21M17 7V17M21 10V14'/>",
            "link" => {
                "<path d='M10 8L14 4Q17 1 21 5Q24 8 21 11L17 15M14 16L10 20Q7 23 3 19Q0 16 3 13L7 9M8 16L16 8'/>"
            }
            "disconnect" => "<path d='M9 5H4V19H9M12 12H22M18 8L22 12L18 16'/>",
            _ => return Ok(None),
        };
        Ok(Some(Cow::Owned(format!(
            "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'>{shape}</svg>"
        ).into_bytes())))
    }

    fn list(&self, _: &str) -> anyhow::Result<Vec<SharedString>> {
        Ok(Vec::new())
    }
}

fn icon(name: &'static str, size: f32) -> impl IntoElement {
    svg().path(name).size(px(size)).flex_shrink_0()
}

fn row() -> Div {
    div().flex().items_center().gap(px(12.))
}
fn column() -> Div {
    div().flex().flex_col().gap(px(8.))
}
fn muted_label(value: String) -> Div {
    div().text_size(px(12.)).text_color(rgb(MUTED)).child(value)
}

fn artwork(edge: f32) -> Div {
    div()
        .size(px(edge))
        .flex_shrink_0()
        .rounded(px(12.))
        .bg(rgb(SECONDARY))
        .border_1()
        .border_color(rgb(BORDER))
        .flex()
        .items_center()
        .justify_center()
        .child(
            div()
                .size(px(edge * 0.72))
                .rounded_full()
                .border_1()
                .border_color(rgb(BORDER))
                .flex()
                .items_center()
                .justify_center()
                .bg(rgb(CARD))
                .child(
                    div()
                        .text_color(rgb(AMBER))
                        .child(icon("brand", edge * 0.30)),
                ),
        )
}

struct Tip(String);
impl Render for Tip {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .px(px(12.))
            .py(px(8.))
            .rounded(px(8.))
            .bg(rgb(POPOVER))
            .border_1()
            .border_color(rgb(BORDER))
            .text_color(rgb(TEXT))
            .text_size(px(12.))
            .child(self.0.clone())
    }
}

impl Player {
    fn ui_button(
        &self,
        id: &'static str,
        glyph: &'static str,
        control: Control,
        enabled: bool,
        primary: bool,
        cx: &Context<Self>,
    ) -> Stateful<Div> {
        let label = text(id);
        div()
            .id(id)
            .size(px(if primary { 56. } else { 36. }))
            .flex_shrink_0()
            .rounded_full()
            .flex()
            .items_center()
            .justify_center()
            .bg(rgb(if primary && enabled { AMBER } else { CARD }))
            .text_color(rgb(if !enabled {
                BORDER
            } else if primary {
                AMBER_TEXT
            } else {
                TEXT
            }))
            .border_1()
            .border_color(rgb(if primary && enabled { AMBER } else { BORDER }))
            .when(enabled, |button| {
                button
                    .cursor_pointer()
                    .focusable()
                    .tab_stop(true)
                    .hover(|s| s.bg(rgb(if primary { 0xffcf70 } else { SECONDARY })))
                    .focus(|s| s.border_color(rgb(AMBER)))
            })
            .tooltip(move |_, cx| cx.new(|_| Tip(label.clone())).into())
            .child(icon(glyph, if primary { 24. } else { 18. }))
            .on_click(cx.listener(move |player, _, window, cx| {
                if enabled {
                    player.control(control, window, cx);
                }
            }))
    }

    fn labeled_button(
        &self,
        id: &'static str,
        glyph: &'static str,
        control: Control,
        cx: &Context<Self>,
    ) -> impl IntoElement {
        self.ui_button(id, glyph, control, true, false, cx)
            .w_auto()
            .px(px(12.))
            .gap(px(8.))
            .rounded(px(8.))
            .child(text(id))
    }

    fn progress_bar(&self, window: &Window, cx: &Context<Self>) -> impl IntoElement {
        let enabled = safe_seek(
            self.position,
            self.duration,
            self.available && self.host_ready,
        )
        .is_some();
        let width = f32::from(window.viewport_size().width) - 2. * self.mode.padding();
        let padding = self.mode.padding();
        column()
            .h(px(44.))
            .flex_shrink_0()
            .gap(px(4.))
            .child(
                div()
                    .id("seek")
                    .h(px(20.))
                    .w_full()
                    .flex()
                    .items_center()
                    .when(enabled, |s| {
                        s.cursor_pointer()
                            .focusable()
                            .tab_stop(true)
                            .focus(|s| s.bg(rgb(SECONDARY)))
                    })
                    .tooltip(|_, cx| cx.new(|_| Tip(text("seekHint"))).into())
                    .child(
                        div()
                            .w_full()
                            .h(px(4.))
                            .rounded_full()
                            .bg(rgb(BORDER))
                            .child(
                                div()
                                    .h_full()
                                    .w(relative(progress(self.position, self.duration)))
                                    .rounded_full()
                                    .bg(rgb(AMBER)),
                            ),
                    )
                    .on_click(
                        cx.listener(move |player, event: &gpui::ClickEvent, window, cx| {
                            if enabled && let Some(position) = event.mouse_position() {
                                let fraction =
                                    ((f32::from(position.x) - padding) / width).clamp(0., 1.);
                                player.control(
                                    Control::Seek(f64::from(fraction) * player.duration),
                                    window,
                                    cx,
                                );
                            }
                        }),
                    )
                    .on_key_down(cx.listener(
                        move |player, event: &gpui::KeyDownEvent, window, cx| {
                            if enabled {
                                let delta = match event.keystroke.key.as_str() {
                                    "left" => -10.,
                                    "right" => 10.,
                                    _ => return,
                                };
                                cx.stop_propagation();
                                player.control(Control::Seek(player.position + delta), window, cx);
                            }
                        },
                    )),
            )
            .child(
                row()
                    .justify_between()
                    .text_size(px(11.))
                    .text_color(rgb(MUTED))
                    .child(time(self.position))
                    .child(if self.duration > 0. {
                        time(self.duration)
                    } else {
                        text("unknownTime")
                    }),
            )
    }

    fn transport(&self, cx: &Context<Self>) -> impl IntoElement {
        let enabled = self.available && self.host_ready;
        row()
            .h(px(56.))
            .flex_shrink_0()
            .justify_center()
            .gap(px(24.))
            .child(self.ui_button(
                "previous",
                "previous",
                Control::Previous,
                enabled,
                false,
                cx,
            ))
            .child(self.ui_button(
                if self.playing { "pause" } else { "play" },
                if self.playing { "pause" } else { "play" },
                Control::PlayPause,
                enabled,
                true,
                cx,
            ))
            .child(self.ui_button("next", "next", Control::Next, enabled, false, cx))
    }

    fn volume_control(&self, cx: &Context<Self>) -> impl IntoElement {
        let audible = if self.muted { 0 } else { self.volume };
        let slider_bounds = Rc::new(Cell::new(None::<gpui::Bounds<gpui::Pixels>>));
        let measured_bounds = slider_bounds.clone();
        row()
            .h(px(36.))
            .flex_shrink_0()
            .justify_center()
            .gap(px(8.))
            .child(self.ui_button(
                if self.muted { "unmute" } else { "mute" },
                if audible == 0 { "mute" } else { "volume" },
                Control::Mute,
                true,
                false,
                cx,
            ))
            .child(self.ui_button(
                "quieter",
                "minus",
                Control::Quieter,
                self.volume > 0,
                false,
                cx,
            ))
            .child(
                div()
                    .id("volume-slider")
                    .w(px(100.))
                    .h(px(28.))
                    .flex()
                    .items_center()
                    .cursor_pointer()
                    .focusable()
                    .tab_stop(true)
                    .focus(|s| s.bg(rgb(SECONDARY)))
                    .tooltip(|_, cx| cx.new(|_| Tip(text("localVolume"))).into())
                    .relative()
                    .child(
                        canvas(
                            move |bounds, _, _| measured_bounds.set(Some(bounds)),
                            |_, _, _, _| {},
                        )
                        .absolute()
                        .size_full(),
                    )
                    .child(
                        div()
                            .w_full()
                            .h(px(4.))
                            .rounded_full()
                            .bg(rgb(BORDER))
                            .child(
                                div()
                                    .w(relative(f32::from(audible) / 100.))
                                    .h_full()
                                    .rounded_full()
                                    .bg(rgb(MUTED)),
                            ),
                    )
                    .on_click(
                        cx.listener(move |player, event: &gpui::ClickEvent, window, cx| {
                            if let (Some(position), Some(bounds)) =
                                (event.mouse_position(), slider_bounds.get())
                            {
                                let fraction = f32::from(position.x - bounds.origin.x)
                                    / f32::from(bounds.size.width);
                                let volume = (fraction.clamp(0., 1.) * 100.).round() as u8;
                                player.control(Control::Volume(volume), window, cx);
                            }
                        }),
                    )
                    .on_key_down(
                        cx.listener(|player, event: &gpui::KeyDownEvent, window, cx| {
                            let volume = match event.keystroke.key.as_str() {
                                "left" => player.volume.saturating_sub(5),
                                "right" => player.volume.saturating_add(5),
                                _ => return,
                            };
                            cx.stop_propagation();
                            player.control(Control::Volume(volume), window, cx);
                        }),
                    ),
            )
            .child(self.ui_button(
                "louder",
                "plus",
                Control::Louder,
                self.volume < 100,
                false,
                cx,
            ))
            .child(
                div()
                    .w(px(44.))
                    .text_size(px(11.))
                    .text_color(rgb(MUTED))
                    .child(format!("{audible}%")),
            )
    }

    fn now_playing(&self) -> Div {
        let compact = self.mode == Mode::Compact;
        let title = if self.title.is_empty() {
            text(if self.connection.is_some() {
                "waitingTitle"
            } else {
                "welcomeTitle"
            })
        } else {
            self.title.clone()
        };
        let mut metadata = column()
            .min_w_0()
            .flex_1()
            .child(muted_label(text(if self.title.is_empty() {
                "listeningTogether"
            } else {
                "nowPlaying"
            })))
            .child(
                div()
                    .text_size(px(if compact { 18. } else { 26. }))
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .line_height(relative(1.15))
                    .truncate()
                    .child(title),
            )
            .when_some(self.details.artist.clone(), |s, artist| {
                s.child(muted_label(artist))
            });
        if !compact && self.details.personal_tags.is_none() && !self.details.tags.is_empty() {
            metadata = metadata.child(muted_label(text("trackMoods"))).child(
                row()
                    .gap(px(8.))
                    .flex_wrap()
                    .children(self.details.tags.iter().take(4).map(|tag| {
                        div()
                            .px(px(8.))
                            .py(px(4.))
                            .rounded_full()
                            .bg(rgb(SECONDARY))
                            .text_size(px(11.))
                            .text_color(rgb(TEXT))
                            .child(tag.clone())
                    })),
            );
        }
        if !compact && let Some(tags) = &self.details.personal_tags {
            metadata = metadata.child(muted_label(text("personalMoods"))).child(
                row()
                    .gap(px(8.))
                    .flex_wrap()
                    .children(tags.iter().take(3).map(|tag| {
                        div()
                            .px(px(8.))
                            .py(px(4.))
                            .rounded_full()
                            .bg(rgb(PERSONAL_SURFACE))
                            .text_size(px(11.))
                            .text_color(rgb(PERSONAL))
                            .child(tag.clone())
                    })),
            );
        }
        row()
            .h(px(if compact { 72. } else { 224. }))
            .flex_shrink_0()
            .gap(px(16.))
            .when(!compact, |s| {
                s.p(px(16.))
                    .bg(rgb(CARD))
                    .border_1()
                    .border_color(rgb(BORDER))
                    .rounded(px(12.))
            })
            .child(artwork(if compact { 72. } else { 96. }))
            .child(metadata)
    }
}

impl Render for Player {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let compact = self.mode == Mode::Compact;
        let provider = self.webview.is_some();
        let room_label = if self.room_name.is_empty() {
            text("noRoom")
        } else {
            self.room_name.clone()
        };
        let mut body = column()
            .p(px(self.mode.padding()))
            .gap(px(16.))
            .child(
                row()
                    .h(px(20.))
                    .flex_shrink_0()
                    .justify_between()
                    .child(
                        row()
                            .min_w_0()
                            .gap(px(8.))
                            .child(div().size(px(6.)).flex_shrink_0().rounded_full().bg(rgb(
                                if self.connection_ready {
                                    SUCCESS
                                } else {
                                    MUTED
                                },
                            )))
                            .child(
                                div()
                                    .truncate()
                                    .text_size(px(12.))
                                    .text_color(rgb(MUTED))
                                    .child(room_label),
                            ),
                    )
                    .child(self.labeled_button(
                        if self.connection.is_some() {
                            "disconnect"
                        } else {
                            "join"
                        },
                        if self.connection.is_some() {
                            "disconnect"
                        } else {
                            "link"
                        },
                        if self.connection.is_some() {
                            Control::Disconnect
                        } else {
                            Control::Join
                        },
                        cx,
                    )),
            )
            .child(if compact {
                self.now_playing()
            } else {
                row()
                    .h(px(224.))
                    .flex_shrink_0()
                    .items_start()
                    .gap(px(16.))
                    .child(div().min_w_0().flex_1().child(self.now_playing()))
                    .when(provider, |s| {
                        s.child(
                            div()
                                .w(px(320.))
                                .h(px(224.))
                                .flex_shrink_0()
                                .bg(rgb(CARD))
                                .rounded(px(12.)),
                        )
                    })
            })
            .child(self.progress_bar(window, cx))
            .child(self.transport(cx))
            .child(self.volume_control(cx))
            .child(
                column()
                    .h(px(48.))
                    .flex_shrink_0()
                    .gap(px(4.))
                    .text_size(px(12.))
                    .child(
                        div()
                            .text_color(rgb(if self.notice.is_empty() { MUTED } else { AMBER }))
                            .child(if self.notice.is_empty() {
                                self.status.clone()
                            } else {
                                self.notice.clone()
                            }),
                    )
                    .when(self.connection.is_none() && self.notice.is_empty(), |s| {
                        s.child(muted_label(text("joinHint")))
                    }),
            );
        if compact && provider {
            body = body.child(
                div()
                    .h(px(224.))
                    .flex_shrink_0()
                    .bg(rgb(CARD))
                    .rounded(px(12.)),
            );
        }
        if self.connection.is_none() {
            body = body.child(self.join_input.clone());
        }
        // Separate room preference summaries from track metadata. Neither claims ownership
        // of personal tags, and neither offers a mutation without a real authorization path.
        if !compact && !self.room_preferences.is_empty() {
            body = body.child(
                column()
                    .gap(px(4.))
                    .when(!self.room_preferences.include.is_empty(), |s| {
                        s.child(muted_label(format!(
                            "{}: {}",
                            text("roomInclude"),
                            self.room_preferences.include.join(" · ")
                        )))
                    })
                    .when(!self.room_preferences.exclude.is_empty(), |s| {
                        s.child(muted_label(format!(
                            "{}: {}",
                            text("roomExclude"),
                            self.room_preferences.exclude.join(" · ")
                        )))
                    }),
            );
        }
        if !compact && self.show_up_next && !self.up_next.is_empty() {
            body = body.child(column().child(muted_label(text("upNext"))).children(
                self.up_next.iter().take(2).map(|track| {
                    row().child(artwork(36.)).child(
                        column()
                            .min_w_0()
                            .child(div().truncate().child(track.title.clone()))
                            .when_some(track.artist.clone(), |s, artist| {
                                s.child(muted_label(artist))
                            }),
                    )
                }),
            ));
        }
        div()
            .track_focus(&self.focus)
            .on_key_down(|event, window, cx| {
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
            })
            .size_full()
            .flex()
            .flex_col()
            .overflow_hidden()
            .bg(rgb(BACKGROUND))
            .when(compact, |s| s.bg(rgb(CARD)).rounded(px(20.)))
            .font_family("Segoe UI")
            .text_color(rgb(TEXT))
            .text_size(px(13.))
            .child(
                row()
                    .h(px(if compact { 56. } else { 64. }))
                    .flex_shrink_0()
                    .px(px(self.mode.padding()))
                    .justify_between()
                    .border_b_1()
                    .border_color(rgb(BORDER))
                    .child(
                        row()
                            .gap(px(8.))
                            .child(div().text_color(rgb(AMBER)).child(icon("brand", 22.)))
                            .child(
                                div()
                                    .font_weight(gpui::FontWeight::SEMIBOLD)
                                    .text_size(px(16.))
                                    .child(text("app")),
                            ),
                    )
                    .child(
                        row()
                            .gap(px(8.))
                            .when(!self.up_next.is_empty() && !compact, |s| {
                                s.child(self.ui_button(
                                    "upNext",
                                    "queue",
                                    Control::ToggleUpNext,
                                    true,
                                    false,
                                    cx,
                                ))
                            })
                            .child(self.labeled_button(
                                if compact { "expand" } else { "compact" },
                                if compact { "expand" } else { "compact" },
                                Control::ToggleMode,
                                cx,
                            )),
                    ),
            )
            .child(
                div()
                    .id("player-body")
                    .min_h_0()
                    .flex_1()
                    .overflow_hidden()
                    .child(body),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seek_requires_live_controls_and_known_finite_duration() {
        assert_eq!(safe_seek(20., 60., false), None);
        assert_eq!(safe_seek(20., 0., true), None);
        assert_eq!(safe_seek(f64::NAN, 60., true), None);
        assert_eq!(safe_seek(20., f64::INFINITY, true), None);
        assert_eq!(safe_seek(-10., 60., true), Some(0.));
        assert_eq!(safe_seek(80., 60., true), Some(60.));
        assert_eq!(safe_seek(12.5, 60., true), Some(12.5));
    }

    #[test]
    fn progress_never_paints_outside_the_track() {
        assert_eq!(progress(120., 60.), 1.);
        assert_eq!(progress(-5., 60.), 0.);
        assert_eq!(progress(10., 0.), 0.);
        assert_eq!(progress(f64::NAN, 60.), 0.);
        assert_eq!(progress(30., 60.), 0.5);
    }

    #[test]
    fn modes_keep_the_provider_visible_and_do_not_reserve_it_when_idle() {
        for mode in [Mode::Full, Mode::Compact] {
            let (width, height) = mode.window_size(true);
            let rect = mode.provider_rect(width);
            assert!(rect.width >= 200. && rect.height >= 200.);
            assert!(rect.x >= 0. && rect.y >= 0.);
            assert!(rect.x + rect.width <= width && rect.y + rect.height <= height);
            assert_eq!(mode.toggled().toggled(), mode);
        }
        assert!(Mode::Compact.window_size(false).1 < Mode::Compact.window_size(true).1);
    }

    #[test]
    fn time_handles_unknown_and_long_tracks() {
        assert_eq!(time(f64::NAN), "0:00");
        assert_eq!(time(-1.), "0:00");
        assert_eq!(time(3661.), "61:01");
    }
}
