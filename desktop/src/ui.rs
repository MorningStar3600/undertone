//! Native presentation only. Transport, timeline projection and provider activation stay in
//! their existing owners. Optional metadata must be populated from validated room data.
//!
//! Layout of the main window (880 x 680): the ambience sky fills the window; over it, a 52 px
//! top bar, then a left column with the current track (or one open panel under a compact track
//! strip) and a fixed right column with the lazily created YouTube provider and the upcoming
//! queue. Cards are translucent so the room's mood shows through. The widget shares the same
//! tokens, glyphs, typography and track/progress vocabulary.
use super::{
    Control, Player,
    ui_music::{Action, Panel},
};
use crate::{sky, theme};
use gpui::{
    AnyElement, AssetSource, Bounds, Context, Div, FontWeight, IntoElement, Pixels, Render,
    SharedString, Stateful, Window, canvas, div, prelude::*, px, relative, svg,
};
use std::{borrow::Cow, cell::Cell, rc::Rc};
use undertone_desktop::{ambience::AMBIENCES, music::ICON_KEYS, text};

pub(super) use crate::theme::{Tok, rgb};
pub(super) const BACKGROUND: Tok = Tok::Background;
pub(super) const TEXT: Tok = Tok::Text;
pub(super) const TEXT_SOFT: Tok = Tok::TextSoft;
pub(super) const CARD: Tok = Tok::Card;
pub(super) const POPOVER: Tok = Tok::Popover;
pub(super) const TOOLTIP: Tok = Tok::Tooltip;
pub(super) const SECONDARY: Tok = Tok::Secondary;
pub(super) const MUTED: Tok = Tok::Muted;
pub(super) const FAINT: Tok = Tok::Faint;
pub(super) const BORDER: Tok = Tok::Border;
pub(super) const AMBER: Tok = Tok::Accent;
pub(super) const AMBER_HOVER: Tok = Tok::AccentHover;
pub(super) const AMBER_TEXT: Tok = Tok::OnAccent;
pub(super) const AMBER_SURFACE: Tok = Tok::AccentSurface;
pub(super) const PERSONAL: Tok = Tok::Personal;
pub(super) const PERSONAL_SURFACE: Tok = Tok::PersonalSurface;
pub(super) const PERSONAL_BORDER: Tok = Tok::PersonalBorder;
pub(super) const DANGER: Tok = Tok::Danger;
pub(super) const DANGER_SURFACE: Tok = Tok::DangerSurface;
pub(super) const LIVE: Tok = Tok::Live;
pub(super) const GLASS_STRONG: Tok = Tok::GlassStrong;

pub const PLAYER_SIZE: (f32, f32) = (880., 680.);
pub const HEADER_HEIGHT: f32 = 52.;
pub const GUTTER: f32 = 16.;
pub const SIDE_WIDTH: f32 = 320.;
/// YouTube requires an embedded viewport of at least 200 x 200.
pub const PROVIDER_HEIGHT: f32 = 224.;

#[derive(Debug)]
pub struct ProviderRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}
/// Top of the right column. Must match `Player::body` (header + gutter, right gutter).
pub fn provider_rect(width: f32) -> ProviderRect {
    ProviderRect {
        x: width - GUTTER - SIDE_WIDTH,
        y: HEADER_HEIGHT + GUTTER,
        width: SIDE_WIDTH,
        height: PROVIDER_HEIGHT,
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

pub(super) fn time(seconds: f64) -> String {
    let seconds = if seconds.is_finite() {
        seconds.max(0.) as u64
    } else {
        0
    };
    format!("{}:{:02}", seconds / 60, seconds % 60)
}

/// Fraction of a measured slider. Uses the painted bounds, so borders and flex shrink are exact.
pub(super) fn slider_fraction(x: Pixels, bounds: Bounds<Pixels>) -> Option<f32> {
    let width = f32::from(bounds.size.width);
    let offset = f32::from(x - bounds.origin.x);
    (width.is_finite() && width > 0. && offset.is_finite()).then(|| (offset / width).clamp(0., 1.))
}

// Small, original monochrome glyphs, embedded in the binary; no font or asset fetches.
// Mood glyphs use the server's icon keys verbatim. Transport and window glyphs follow the
// "twelve moods" design (24 x 24 grid, round caps).
pub struct Assets;

fn glyph(path: &str) -> Option<&'static str> {
    Some(match path {
        "play" => "<path d='M8.5 5.5v13l10.5-6.5z' fill='black'/>",
        "pause" => "<path d='M8.5 5.5v13M15.5 5.5v13' stroke-width='2.6'/>",
        "previous" => "<path d='M18 6v12L8 12zM5.5 5.5v13'/>",
        "next" => "<path d='M6 6v12l10-6zM18.5 5.5v13'/>",
        "volume" => {
            "<path d='M4 9.5v5h3.5L12 18.5v-13L7.5 9.5zM15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11'/>"
        }
        "mute" => "<path d='M4 9.5v5h3.5L12 18.5v-13L7.5 9.5zM16 9.5l5 5M21 9.5l-5 5'/>",
        "minus" => "<path d='M6 12H18'/>",
        "plus" => "<path d='M6 12H18M12 6V18'/>",
        "compact" => {
            "<rect x='3' y='5' width='18' height='14' rx='3'/><rect x='12' y='11' width='6' height='5' rx='1'/>"
        }
        "expand" => "<path d='M9 3H3V9M15 3H21V9M3 15V21H9M21 15V21H15'/>",
        "open" => "<path d='M7 17L17 7M9 7H17V15'/>",
        "queue" => "<path d='M4 6H20M4 12H20M4 18H12'/>",
        "brand" => "<path d='M3 10V14M7 6V18M12 3V21M17 7V17M21 10V14'/>",
        "link" => {
            "<path d='M10 8L14 4Q17 1 21 5Q24 8 21 11L17 15M14 16L10 20Q7 23 3 19Q0 16 3 13L7 9M8 16L16 8'/>"
        }
        "disconnect" => "<path d='M9 5H4V19H9M12 12H22M18 8L22 12L18 16'/>",
        "power" => "<path d='M12 3V11M7 6A8 8 0 1 0 17 6'/>",
        "pin" => "<path d='M9 3.5h6l-1 6 3 3.5H7l3-3.5zM12 13v7.5'/>",
        "fold" => "<path d='M6.5 9.5 12 15l5.5-5.5'/>",
        "unfold" => "<path d='M6.5 14.5 12 9l5.5 5.5'/>",
        "settings" => {
            "<path d='M3 7H7M13 7H21M3 17H13M19 17H21'/><circle cx='10' cy='7' r='3'/><circle cx='16' cy='17' r='3'/>"
        }
        "close" => "<path d='M6 6L18 18M18 6L6 18'/>",
        "user" => {
            "<circle cx='12' cy='8' r='4'/><path d='M4 21C4 16 8 14 12 14C16 14 20 16 20 21'/>"
        }
        "refresh" => "<path d='M20 12A8 8 0 1 1 17.7 6.3M20 4V9H15'/>",
        "search" => "<circle cx='11' cy='11' r='6.5'/><path d='M16 16L21 21'/>",
        "chevron" => "<path d='M9 6L15 12L9 18'/>",
        "check" => "<path d='M5.5 12.5l4.2 4.2L18.5 8' stroke-width='2.2'/>",
        "info" => "<circle cx='12' cy='12' r='9'/><path d='M12 11V16M12 8V8.2'/>",
        "heart-fill" => {
            "<path d='M12 20L4.5 12.5C1 9 3 4 7.5 4C9.5 4 11 5.2 12 7C13 5.2 14.5 4 16.5 4C21 4 23 9 19.5 12.5Z' fill='black'/>"
        }
        // Mood icon keys (music::ICON_KEYS).
        "heart" => {
            "<path d='M12 20L4.5 12.5C1 9 3 4 7.5 4C9.5 4 11 5.2 12 7C13 5.2 14.5 4 16.5 4C21 4 23 9 19.5 12.5Z'/>"
        }
        "headphones" => {
            "<path d='M4 15V12A8 8 0 0 1 20 12V15'/><rect x='3' y='13' width='4' height='7' rx='2'/><rect x='17' y='13' width='4' height='7' rx='2'/>"
        }
        "bolt" => "<path d='M13 2L5 14H12L11 22L19 10H12Z'/>",
        "sun" => {
            "<circle cx='12' cy='12' r='4'/><path d='M12 2V4M12 20V22M2 12H4M20 12H22M5 5L6.5 6.5M17.5 17.5L19 19M5 19L6.5 17.5M17.5 6.5L19 5'/>"
        }
        "cloud-rain" => {
            "<path d='M7 15A4 4 0 0 1 6.5 7A6 6 0 0 1 17.5 8A3.5 3.5 0 0 1 17.5 15Z'/><path d='M8 18L7 21M12 18L11 21M16 18L15 21'/>"
        }
        "moon" => "<path d='M20 15A9 9 0 0 1 9 3A9 9 0 1 0 20 15Z'/>",
        "sparkles" => {
            "<path d='M10 3L12 9L18 11L12 13L10 19L8 13L2 11L8 9Z'/><path d='M19 3V7M17 5H21'/>"
        }
        "coffee" => {
            "<path d='M4 9H16V15A5 5 0 0 1 11 20H9A5 5 0 0 1 4 15Z'/><path d='M16 11H18A2.5 2.5 0 0 1 18 16H16M8 3V6M12 3V6'/>"
        }
        "flame" => {
            "<path d='M12 22A7 7 0 0 0 19 15C19 10 14 8 13 3C10 6 9 8 9 10C7 9 6 8 6 7C5 9 5 12 5 15A7 7 0 0 0 12 22Z'/>"
        }
        _ => return None,
    })
}

/// One of the twelve logos ("logo-01" ... "logo-12"), from the shared ambience data.
fn logo_markup(path: &str) -> Option<&'static str> {
    let number: usize = path.strip_prefix("logo-")?.parse().ok()?;
    AMBIENCES
        .get(number.checked_sub(1)?)
        .map(|ambience| ambience.logo)
}

impl AssetSource for Assets {
    fn load(&self, path: &str) -> anyhow::Result<Option<Cow<'static, [u8]>>> {
        if let Some(logo) = logo_markup(path) {
            return Ok(Some(Cow::Owned(format!(
                "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' color='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>{logo}</svg>"
            ).into_bytes())));
        }
        Ok(glyph(path).map(|shape| {
            Cow::Owned(format!(
                "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'>{shape}</svg>"
            ).into_bytes())
        }))
    }

    fn list(&self, _: &str) -> anyhow::Result<Vec<SharedString>> {
        Ok(Vec::new())
    }
}

/// The embedded glyph for a server mood icon key. Unknown keys use the Undertone mark.
pub(super) fn mood_glyph(key: &str) -> &'static str {
    ICON_KEYS
        .iter()
        .copied()
        .find(|known| *known == key)
        .unwrap_or("brand")
}

pub(super) fn icon(name: &'static str, size: f32) -> gpui::Svg {
    // GPUI's SVG painter reads its own style color, not the inherited text color.
    svg()
        .path(name)
        .size(px(size))
        .flex_shrink_0()
        .text_color(rgb(TEXT))
}

/// The logo of the current ambience, in the accent color.
pub(super) fn logo(size: f32) -> gpui::Svg {
    icon(theme::logo(), size).text_color(rgb(AMBER))
}

/// Logo plus the "undertone" wordmark (display face, light).
pub(super) fn lockup(size: f32) -> Div {
    row()
        .gap(px(size * 0.45))
        .flex_shrink_0()
        .child(logo(size * 1.42))
        .child(
            div()
                .font_family(theme::display())
                .font_weight(FontWeight(350.))
                .text_size(px(size))
                .text_color(rgb(TEXT))
                .child(text("wordmark")),
        )
}

/// The ambience's italic name and number ("heure bleue  ambiance 01").
pub(super) fn mood_line(ambience: usize, size: f32) -> Div {
    let ambience = &AMBIENCES[ambience.min(AMBIENCES.len() - 1)];
    div()
        .flex()
        .items_end()
        .gap(px(8.))
        .min_w_0()
        .child(
            div()
                .font_family(theme::voice())
                .italic()
                .text_size(px(size))
                .line_height(px(size * 1.15))
                .text_color(rgb(TEXT_SOFT))
                .truncate()
                .child(ambience.name),
        )
        .child(
            div()
                .flex_shrink_0()
                .pb(px(2.))
                .text_size(px(11.5))
                .text_color(rgb(MUTED))
                .child(format!("{} {:02}", text("ambienceNumber"), ambience.number)),
        )
}

/// "brought by <name>" in the italic voice.
pub(super) fn dedication(name: String, size: f32) -> Div {
    row()
        .gap(px(7.))
        .min_w_0()
        .font_family(theme::voice())
        .italic()
        .text_size(px(size))
        .text_color(rgb(TEXT_SOFT))
        .child(avatar(&name))
        .child(div().flex_shrink_0().child(text("broughtBy")))
        .child(div().min_w_0().truncate().text_color(rgb(TEXT)).child(name))
}

/// Initial in a small round badge.
pub(super) fn avatar(name: &str) -> Div {
    div()
        .size(px(18.))
        .flex_shrink_0()
        .rounded_full()
        .flex()
        .items_center()
        .justify_center()
        .bg(rgb(TEXT_SOFT))
        .text_color(rgb(BACKGROUND))
        .font_family(theme::text())
        .font_weight(FontWeight::SEMIBOLD)
        .not_italic()
        .text_size(px(9.5))
        .child(
            name.chars()
                .find(|c| c.is_alphanumeric())
                .map(|c| c.to_uppercase().to_string())
                .unwrap_or_default(),
        )
}

pub(super) fn row() -> Div {
    div().flex().items_center().gap(px(12.))
}
pub(super) fn column() -> Div {
    div().flex().flex_col().gap(px(8.))
}
pub(super) fn quiet(value: impl Into<SharedString>, size: f32) -> Div {
    div()
        .text_size(px(size))
        .text_color(rgb(MUTED))
        .truncate()
        .child(value.into())
}
/// Section label ("UP NEXT").
pub(super) fn section_label(label: String) -> Div {
    div()
        .text_size(px(12.5))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(rgb(TEXT))
        .child(label)
}
/// Translucent surface over the sky.
pub(super) fn card() -> Div {
    div()
        .bg(rgb(CARD))
        .rounded(px(18.))
        .border_1()
        .border_color(rgb(BORDER))
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum Tone {
    Info,
    Warn,
    Error,
}
/// One status message. Actions may be appended as further children.
pub(super) fn banner(tone: Tone, message: String) -> Div {
    let (surface, foreground) = match tone {
        Tone::Info => (POPOVER, MUTED),
        Tone::Warn => (AMBER_SURFACE, AMBER),
        Tone::Error => (DANGER_SURFACE, DANGER),
    };
    div()
        .flex()
        .items_center()
        .flex_wrap()
        .gap(px(8.))
        .px(px(12.))
        .py(px(8.))
        .rounded(px(10.))
        .bg(rgb(surface))
        .text_size(px(12.))
        .text_color(rgb(foreground))
        .child(icon("info", 14.).text_color(rgb(foreground)))
        .child(div().flex_1().min_w(px(160.)).child(message))
}

pub(super) fn artwork(edge: f32, image: Option<std::sync::Arc<gpui::RenderImage>>) -> Div {
    let radius = (edge * 0.16).clamp(6., 14.);
    if let Some(image) = image {
        return div()
            .size(px(edge))
            .flex_shrink_0()
            .rounded(px(radius))
            .overflow_hidden()
            .border_1()
            .border_color(rgb(BORDER))
            .child(
                gpui::img(image)
                    .size_full()
                    .object_fit(gpui::ObjectFit::Cover),
            );
    }
    div()
        .size(px(edge))
        .flex_shrink_0()
        .rounded(px(radius))
        .bg(rgb(SECONDARY))
        .border_1()
        .border_color(rgb(BORDER))
        .flex()
        .items_center()
        .justify_center()
        .child(logo((edge * 0.42).max(12.)))
}

/// Visual track for progress and volume. `fraction` is already clamped.
pub(super) fn track_bar(fraction: f32, fill: Tok, thumb: f32) -> Div {
    div()
        .relative()
        .w_full()
        .h(px(4.))
        .rounded_full()
        .bg(rgb(BORDER))
        .child(
            div()
                .h_full()
                .w(relative(fraction))
                .rounded_full()
                .bg(rgb(fill)),
        )
        .when(thumb > 0., |s| {
            s.child(
                div()
                    .absolute()
                    .top(px(2. - thumb / 2.))
                    .left(relative(fraction))
                    .ml(px(-thumb / 2.))
                    .size(px(thumb))
                    .rounded_full()
                    .bg(rgb(fill)),
            )
        })
}

pub(super) struct Tip(pub String);
impl Render for Tip {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .max_w(px(280.))
            .px(px(12.))
            .py(px(8.))
            .rounded(px(8.))
            .bg(rgb(TOOLTIP))
            .border_1()
            .border_color(rgb(BORDER))
            .text_color(rgb(TEXT))
            .text_size(px(12.))
            .child(self.0.clone())
    }
}

/// Tab and Shift+Tab move focus inside a window.
pub(super) fn tab_navigation(event: &gpui::KeyDownEvent, window: &mut Window) -> bool {
    let modifiers = &event.keystroke.modifiers;
    if event.keystroke.key == "tab" && !modifiers.control && !modifiers.alt && !modifiers.platform {
        if modifiers.shift {
            window.focus_prev();
        } else {
            window.focus_next();
        }
        return true;
    }
    false
}

impl Player {
    /// Name of the current track's contributor, only from authoritative participant metadata.
    pub(super) fn contributor_name(&self) -> Option<String> {
        let music = self.native.room.music.as_ref()?;
        let current = music.current.as_ref()?;
        music
            .participants
            .iter()
            .find(|p| p.participant_id == current.entry.contributor_id)?
            .name
            .clone()
    }

    pub(super) fn listener_count(&self) -> Option<usize> {
        self.native
            .room
            .music
            .as_ref()
            .map(|m| m.participants.len())
            .filter(|count| *count > 0)
    }

    /// Round icon control for playback/local actions; the tooltip is the localized `id`.
    pub(super) fn ui_button(
        &self,
        id: &'static str,
        glyph: &'static str,
        control: Control,
        enabled: bool,
        primary: bool,
        cx: &Context<Self>,
    ) -> Stateful<Div> {
        let label = text(id);
        let authority = self.native.authority();
        let foreground = if !enabled {
            FAINT
        } else if primary {
            AMBER_TEXT
        } else {
            TEXT_SOFT
        };
        div()
            .id(id)
            .size(px(if primary { 52. } else { 36. }))
            .flex_shrink_0()
            .rounded_full()
            .flex()
            .items_center()
            .justify_center()
            .when(primary, |s| {
                s.bg(rgb(if enabled { AMBER } else { SECONDARY }))
            })
            .text_color(rgb(foreground))
            .border_1()
            .border_color(gpui::transparent_black())
            .when(enabled, |button| {
                button
                    .cursor_pointer()
                    .focusable()
                    .tab_stop(true)
                    .hover(move |s| s.bg(rgb(if primary { AMBER_HOVER } else { SECONDARY })))
                    .focus(|s| s.border_color(rgb(TEXT)))
            })
            .tooltip(move |_, cx| cx.new(|_| Tip(label.clone())).into())
            .child(icon(glyph, if primary { 23. } else { 21. }).text_color(rgb(foreground)))
            .on_click(cx.listener(move |player, _, window, cx| {
                if enabled {
                    player.control(control, authority, window, cx);
                }
            }))
    }

    /// Accent, labelled primary control (Join).
    fn primary_control(
        &self,
        id: &'static str,
        glyph: &'static str,
        control: Control,
        cx: &Context<Self>,
    ) -> Stateful<Div> {
        self.ui_button(id, glyph, control, true, true, cx)
            .w_auto()
            .h(px(44.))
            .px(px(18.))
            .gap(px(8.))
            .rounded(px(12.))
            .text_size(px(14.))
            .font_weight(FontWeight::SEMIBOLD)
            .child(text(id))
    }

    /// Bordered secondary control with a visible label.
    pub(super) fn labeled_control(
        &self,
        id: &'static str,
        glyph: &'static str,
        control: Control,
        cx: &Context<Self>,
    ) -> Stateful<Div> {
        self.ui_button(id, glyph, control, true, false, cx)
            .w_auto()
            .h(px(32.))
            .px(px(12.))
            .gap(px(8.))
            .rounded(px(9.))
            .bg(rgb(POPOVER))
            .border_color(rgb(BORDER))
            .text_size(px(12.))
            .text_color(rgb(TEXT))
            .child(text(id))
    }

    fn progress_bar(&self, cx: &Context<Self>) -> impl IntoElement {
        let authority = self.native.authority();
        let enabled = safe_seek(
            self.position,
            self.duration,
            self.available && self.host_ready,
        )
        .is_some();
        let bounds = Rc::new(Cell::new(None::<Bounds<Pixels>>));
        let measured = bounds.clone();
        div()
            .id("seek")
            .relative()
            .h(px(20.))
            .w_full()
            .flex_shrink_0()
            .flex()
            .items_center()
            .rounded(px(4.))
            .child(
                canvas(move |b, _, _| measured.set(Some(b)), |_, _, _, _| {})
                    .absolute()
                    .size_full(),
            )
            .when(enabled, |s| {
                s.cursor_pointer()
                    .focusable()
                    .tab_stop(true)
                    .focus(|s| s.bg(rgb(SECONDARY)))
            })
            .tooltip(|_, cx| cx.new(|_| Tip(text("seekHint"))).into())
            .child(track_bar(
                progress(self.position, self.duration),
                if enabled { AMBER } else { FAINT },
                if enabled { 10. } else { 0. },
            ))
            .on_click(
                cx.listener(move |player, event: &gpui::ClickEvent, window, cx| {
                    if enabled
                        && let Some(point) = event.mouse_position()
                        && let Some(b) = bounds.get()
                        && let Some(fraction) = slider_fraction(point.x, b)
                    {
                        player.control(
                            Control::Seek(f64::from(fraction) * player.duration),
                            authority,
                            window,
                            cx,
                        );
                    }
                }),
            )
            .on_key_down(
                cx.listener(move |player, event: &gpui::KeyDownEvent, window, cx| {
                    if enabled {
                        let delta = match event.keystroke.key.as_str() {
                            "left" => -10.,
                            "right" => 10.,
                            _ => return,
                        };
                        cx.stop_propagation();
                        player.control(
                            Control::Seek(player.position + delta),
                            authority,
                            window,
                            cx,
                        );
                    }
                }),
            )
    }

    fn time_label(&self) -> String {
        format!(
            "{} / {}",
            time(self.position),
            if self.duration > 0. {
                time(self.duration)
            } else {
                text("unknownTime")
            }
        )
    }

    fn volume_control(&self, cx: &Context<Self>) -> Div {
        let authority = self.native.authority();
        let audible = if self.muted { 0 } else { self.volume };
        let bounds = Rc::new(Cell::new(None::<Bounds<Pixels>>));
        let measured = bounds.clone();
        row()
            .gap(px(4.))
            .child(
                self.ui_button(
                    if self.muted { "unmute" } else { "mute" },
                    if audible == 0 { "mute" } else { "volume" },
                    Control::Mute,
                    true,
                    false,
                    cx,
                )
                .size(px(30.)),
            )
            .child(
                div()
                    .id("volume-slider")
                    .relative()
                    .w(px(88.))
                    .h(px(24.))
                    .flex()
                    .items_center()
                    .rounded(px(4.))
                    .cursor_pointer()
                    .focusable()
                    .tab_stop(true)
                    .focus(|s| s.bg(rgb(SECONDARY)))
                    .tooltip(move |_, cx| {
                        cx.new(|_| Tip(format!("{} · {audible}%", text("localVolume"))))
                            .into()
                    })
                    .child(
                        canvas(move |b, _, _| measured.set(Some(b)), |_, _, _, _| {})
                            .absolute()
                            .size_full(),
                    )
                    .child(track_bar(f32::from(audible) / 100., TEXT_SOFT, 10.))
                    .on_click(
                        cx.listener(move |player, event: &gpui::ClickEvent, window, cx| {
                            if let Some(point) = event.mouse_position()
                                && let Some(b) = bounds.get()
                                && let Some(fraction) = slider_fraction(point.x, b)
                            {
                                let volume = (fraction * 100.).round() as u8;
                                player.control(Control::Volume(volume), authority, window, cx);
                            }
                        }),
                    )
                    .on_key_down(cx.listener(
                        move |player, event: &gpui::KeyDownEvent, window, cx| {
                            let volume = match event.keystroke.key.as_str() {
                                "left" => player.volume.saturating_sub(5),
                                "right" => player.volume.saturating_add(5).min(100),
                                _ => return,
                            };
                            cx.stop_propagation();
                            player.control(Control::Volume(volume), authority, window, cx);
                        },
                    )),
            )
    }

    fn transport(&self, cx: &Context<Self>) -> Div {
        let enabled = self.available && self.host_ready;
        row()
            .gap(px(8.))
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

    pub(super) fn display_title(&self) -> String {
        if self.title.is_empty() {
            text(if self.native.connected {
                "waitingTitle"
            } else {
                "connecting"
            })
        } else {
            self.title.clone()
        }
    }

    /// The main "now playing" card: the widget's composition at a larger size.
    fn now_card(&self, cx: &Context<Self>) -> Div {
        let contributor = self.contributor_name();
        let title = self.display_title();
        let long = title.chars().count() > 22;
        card()
            .flex_shrink_0()
            .px(px(22.))
            .pt(px(14.))
            .pb(px(16.))
            .flex()
            .flex_col()
            .gap(px(14.))
            .child(mood_line(theme::current(cx), 21.))
            .child(
                row()
                    .gap(px(18.))
                    .items_end()
                    .child(artwork(128., self.artwork.clone()))
                    .child(
                        column()
                            .gap(px(4.))
                            .min_w_0()
                            .flex_1()
                            .child(
                                div()
                                    .font_family(theme::display())
                                    .font_weight(FontWeight(if long { 350. } else { 300. }))
                                    .text_size(px(if long { 26. } else { 34. }))
                                    .line_height(px(if long { 30. } else { 37. }))
                                    .line_clamp(2)
                                    .child(title),
                            )
                            .when_some(self.details.artist.clone(), |s, artist| {
                                s.child(
                                    div()
                                        .font_family(theme::display())
                                        .text_size(px(16.))
                                        .text_color(rgb(TEXT_SOFT))
                                        .truncate()
                                        .child(artist),
                                )
                            })
                            .when_some(contributor, |s, name| {
                                s.child(dedication(name, 15.).mt(px(4.)))
                            }),
                    ),
            )
            .child(self.progress_bar(cx))
            .child(
                row()
                    .justify_between()
                    .mt(px(-6.))
                    .child(self.volume_control(cx).w(px(140.)))
                    .child(self.transport(cx))
                    .child(
                        div()
                            .w(px(140.))
                            .flex()
                            .justify_end()
                            .text_size(px(12.))
                            .text_color(rgb(MUTED))
                            .child(self.time_label()),
                    ),
            )
    }

    /// Compact track strip above an open panel, so playback stays in view.
    fn now_strip(&self, cx: &Context<Self>) -> Div {
        let enabled = self.available && self.host_ready;
        card()
            .flex_shrink_0()
            .h(px(68.))
            .px(px(12.))
            .flex()
            .items_center()
            .gap(px(12.))
            .child(artwork(44., self.artwork.clone()))
            .child(
                column()
                    .gap(px(2.))
                    .min_w_0()
                    .flex_1()
                    .child(
                        div()
                            .font_family(theme::display())
                            .text_size(px(16.))
                            .truncate()
                            .child(self.display_title()),
                    )
                    .child(quiet(
                        self.details
                            .artist
                            .clone()
                            .unwrap_or_else(|| self.status.clone()),
                        12.,
                    )),
            )
            .child(
                row()
                    .gap(px(6.))
                    .child(self.ui_button(
                        "previous",
                        "previous",
                        Control::Previous,
                        enabled,
                        false,
                        cx,
                    ))
                    .child(
                        self.ui_button(
                            if self.playing { "pause" } else { "play" },
                            if self.playing { "pause" } else { "play" },
                            Control::PlayPause,
                            enabled,
                            true,
                            cx,
                        )
                        .size(px(40.)),
                    )
                    .child(self.ui_button("next", "next", Control::Next, enabled, false, cx)),
            )
    }

    /// Right column list of the public upcoming preview, with the add entry point.
    fn up_next_card(&self, rows: usize, cx: &Context<Self>) -> Div {
        let music = self.native.room.active();
        let mut list = column().gap(px(0.));
        if !self.show_up_next {
            list = list.child(quiet(text("upcomingHidden"), 12.));
        } else if self.up_next.is_empty() {
            list = list.child(
                div()
                    .py(px(8.))
                    .text_size(px(12.))
                    .text_color(rgb(MUTED))
                    .child(text(if music {
                        "queueEmptyHint"
                    } else {
                        "musicModeShort"
                    })),
            );
        } else {
            for (index, track) in self.up_next.iter().take(rows).enumerate() {
                list = list.child(
                    row()
                        .h(px(48.))
                        .gap(px(10.))
                        .when(index > 0, |s| s.border_t_1().border_color(rgb(BORDER)))
                        // Queue DTO has no validated provider ID/art URL or duration.
                        .child(artwork(34., None))
                        .child(
                            column()
                                .gap(px(1.))
                                .min_w_0()
                                .flex_1()
                                .child(
                                    div()
                                        .text_size(px(13.5))
                                        .font_weight(FontWeight::MEDIUM)
                                        .truncate()
                                        .child(track.title.clone()),
                                )
                                .when_some(track.artist.clone(), |s, a| s.child(quiet(a, 12.))),
                        ),
                );
            }
        }
        card()
            .flex_1()
            .min_h_0()
            .p(px(16.))
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(
                row()
                    .justify_between()
                    .child(section_label(text("upNext")))
                    .child(self.link_action(
                        "see-queue",
                        text("widgetSeeQueue"),
                        Action::Show(Panel::Queue),
                        true,
                        cx,
                    )),
            )
            .child(list.flex_1().min_h_0().overflow_hidden())
            .child(self.wide_action(
                "up-next-add",
                "plus",
                text("widgetAdd"),
                Action::Show(Panel::Add),
                true,
                cx,
            ))
    }

    fn header(&self, cx: &Context<Self>) -> Div {
        let connected = self.connection.is_some();
        let panel = self.music_ui.panel;
        let account = &self.native.account;
        let account_label = if account.logged_in && !account.expired {
            account.username.clone().unwrap_or_else(|| text("account"))
        } else {
            text("signIn")
        };
        let room = row()
            .gap(px(8.))
            .min_w_0()
            .flex_shrink()
            .h(px(30.))
            .px(px(12.))
            .rounded_full()
            .bg(rgb(POPOVER))
            .border_1()
            .border_color(rgb(BORDER))
            .child(
                div()
                    .size(px(7.))
                    .flex_shrink_0()
                    .rounded_full()
                    .bg(rgb(if self.native.connected { LIVE } else { FAINT })),
            )
            .child(div().min_w_0().truncate().text_size(px(12.)).child(
                if self.room_name.is_empty() {
                    text("noRoom")
                } else {
                    self.room_name.clone()
                },
            ))
            .when_some(self.listener_count(), |s, count| {
                s.child(quiet(format!("· {count} {}", text("listeners")), 12.))
            })
            .when(connected, |s| {
                s.child(
                    self.icon_action(
                        "header-refresh",
                        "refresh",
                        text("refreshRoomTip"),
                        Action::RefreshRoom,
                        !self.native.search_blocked(),
                        false,
                        cx,
                    )
                    .size(px(22.))
                    .rounded_full(),
                )
            });
        let chrome = |button: Stateful<Div>, active: bool| {
            button
                .size(px(32.))
                .rounded_full()
                .bg(rgb(if active { TEXT } else { GLASS_STRONG }))
                .border_color(rgb(BORDER))
        };
        row()
            .h(px(HEADER_HEIGHT))
            .flex_shrink_0()
            .px(px(GUTTER))
            .gap(px(12.))
            .justify_between()
            .border_b_1()
            .border_color(rgb(BORDER))
            .child(
                row()
                    .gap(px(14.))
                    .min_w_0()
                    .flex_1()
                    .child(lockup(16.))
                    .when(connected, |s| s.child(room)),
            )
            .child(
                row()
                    .gap(px(6.))
                    .flex_shrink_0()
                    .when(connected, |s| {
                        s.child(self.pill_action(
                            "header-add",
                            "plus",
                            text("addMusic"),
                            Action::Panel(Panel::Add),
                            panel == Some(Panel::Add),
                            true,
                            cx,
                        ))
                        .child(self.pill_action(
                            "header-account",
                            "user",
                            account_label,
                            Action::Panel(Panel::Account),
                            panel == Some(Panel::Account),
                            false,
                            cx,
                        ))
                    })
                    .child(self.icon_action(
                        "header-settings",
                        "settings",
                        text("settings"),
                        Action::Panel(Panel::Settings),
                        true,
                        panel == Some(Panel::Settings),
                        cx,
                    ))
                    .child({
                        let open = self.widget.is_some();
                        let button = self.ui_button(
                            if open { "closeWidget" } else { "openWidget" },
                            "compact",
                            Control::ToggleWidget,
                            true,
                            false,
                            cx,
                        );
                        chrome(button, open).when(open, |s| s.text_color(rgb(BACKGROUND)))
                    })
                    .when(connected, |s| {
                        s.child(chrome(
                            self.ui_button(
                                "disconnect",
                                "disconnect",
                                Control::Disconnect,
                                true,
                                false,
                                cx,
                            ),
                            false,
                        ))
                    }),
            )
    }

    /// Disconnected start screen: one obvious task, joining a room.
    fn welcome(&self, cx: &Context<Self>) -> Div {
        let failure = self.status != text("idle");
        div()
            .flex_1()
            .min_h_0()
            .flex()
            .items_center()
            .justify_center()
            .child(
                card()
                    .w(px(500.))
                    .p(px(32.))
                    .flex()
                    .flex_col()
                    .gap(px(14.))
                    .child(mood_line(theme::current(cx), 21.))
                    .child(
                        div()
                            .font_family(theme::display())
                            .font_weight(FontWeight(300.))
                            .text_size(px(34.))
                            .line_height(px(38.))
                            .child(text("welcomeTitle")),
                    )
                    .child(
                        div()
                            .text_size(px(14.))
                            .text_color(rgb(TEXT_SOFT))
                            .child(text("welcomeBody")),
                    )
                    .child(
                        row()
                            .gap(px(8.))
                            .mt(px(6.))
                            .child(div().flex_1().min_w_0().child(self.join_input.clone()))
                            .child(self.primary_control("join", "link", Control::Join, cx)),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(rgb(MUTED))
                            .child(text("joinHint")),
                    )
                    .when(!self.notice.is_empty(), |s| {
                        s.child(banner(Tone::Warn, self.notice.clone()))
                    })
                    .when(failure && self.notice.is_empty(), |s| {
                        s.child(banner(Tone::Error, self.status.clone()))
                    }),
            )
    }

    /// Playback status line plus notices; native errors come from `status_banners`.
    fn status_area(&self, cx: &Context<Self>) -> Div {
        let blocked = self.status == text("autoplay-blocked");
        column()
            .gap(px(8.))
            .flex_shrink_0()
            .when_some(self.status_banners(cx), |s, banners| s.child(banners))
            .child(
                row()
                    .gap(px(8.))
                    .px(px(4.))
                    .text_size(px(12.))
                    .text_color(rgb(if blocked { AMBER } else { MUTED }))
                    .child(icon("headphones", 14.).text_color(rgb(if blocked {
                        AMBER
                    } else {
                        MUTED
                    })))
                    .child(div().flex_1().min_w_0().child(self.status.clone())),
            )
    }

    /// The window's content, rendered as a cached view over the sky (see `sky::Body`).
    pub(super) fn body(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        self.music_ui.scrolling.begin_frame(window, cx);
        self.music_ui.rendered_authority = self.native.authority();
        let body = if self.connection.is_none() {
            self.welcome(cx)
        } else {
            let provider = self.webview.is_some();
            let left = if self.music_ui.panel.is_some() {
                column()
                    .gap(px(12.))
                    .child(self.now_strip(cx))
                    .child(self.detail_panel(cx))
            } else {
                column()
                    .gap(px(12.))
                    .child(self.now_card(cx))
                    .child(self.mood_strip(cx))
                    .child(div().flex_1().min_h_0())
                    .child(self.status_area(cx))
            };
            let mut right = column().gap(px(12.)).w(px(SIDE_WIDTH)).flex_shrink_0();
            if provider {
                // The WebView child window is positioned over this slot by provider_rect.
                right = right.child(
                    div()
                        .h(px(PROVIDER_HEIGHT))
                        .flex_shrink_0()
                        .rounded(px(12.))
                        .bg(rgb(BACKGROUND)),
                );
            }
            right = right.child(self.up_next_card(if provider { 4 } else { 8 }, cx));
            row()
                .items_start()
                .gap(px(GUTTER))
                .min_h_0()
                .flex_1()
                .p(px(GUTTER))
                .child(left.flex_1().min_w_0().h_full())
                .child(right.h_full())
        };
        div()
            .size_full()
            .flex()
            .flex_col()
            .overflow_hidden()
            .child(self.header(cx))
            .child(body)
            .into_any_element()
    }
}

impl Render for Player {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        theme::frame(cx);
        let layers = self
            .layers
            .get_or_insert_with(|| sky::Layers::new(0., Player::body, window, cx));
        let (sky, body) = (layers.sky.clone(), layers.body());
        div()
            .size_full()
            .relative()
            .overflow_hidden()
            .bg(rgb(BACKGROUND))
            .font_family(theme::text())
            .text_color(rgb(TEXT))
            .text_size(px(13.))
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|_, event: &gpui::KeyDownEvent, window, cx| {
                if tab_navigation(event, window) {
                    cx.stop_propagation();
                }
            }))
            .child(sky)
            .child(body)
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
    fn main_provider_slot_is_the_top_of_the_right_column() {
        let rect = provider_rect(PLAYER_SIZE.0);
        // YouTube's embedded player minimum viewport.
        assert!(rect.width >= 200. && rect.height >= 200.);
        assert_eq!(rect.y, HEADER_HEIGHT + GUTTER);
        assert_eq!(rect.x + rect.width + GUTTER, PLAYER_SIZE.0);
        // Left column (now playing / panels) never sits under the native child window.
        assert!(rect.x - GUTTER >= 480.);
        // Room left in the right column for the upcoming list and its Add button.
        assert!(PLAYER_SIZE.1 - (rect.y + rect.height) >= 300.);
    }

    #[test]
    fn time_handles_unknown_and_long_tracks() {
        assert_eq!(time(f64::NAN), "0:00");
        assert_eq!(time(-1.), "0:00");
        assert_eq!(time(3661.), "61:01");
    }

    #[test]
    fn every_mood_icon_key_has_an_embedded_glyph() {
        for key in ICON_KEYS {
            assert_eq!(mood_glyph(key), *key);
            assert!(glyph(key).is_some(), "{key}");
        }
        assert_eq!(mood_glyph("unknown"), "brand");
    }

    #[test]
    fn every_logo_is_an_embedded_asset() {
        for (index, path) in theme::LOGOS.iter().enumerate() {
            assert_eq!(logo_markup(path), Some(AMBIENCES[index].logo));
            let svg = Assets.load(path).unwrap().unwrap();
            assert!(
                std::str::from_utf8(&svg)
                    .unwrap()
                    .contains(AMBIENCES[index].logo)
            );
        }
        assert!(logo_markup("logo-00").is_none() && logo_markup("logo-13").is_none());
        for name in ["fold", "unfold", "pin", "play", "pause"] {
            assert!(glyph(name).is_some());
        }
    }

    #[test]
    fn sliders_use_rendered_endpoints_after_border_and_flex_shrink() {
        let bounds = Bounds::new(gpui::point(px(56.), px(0.)), gpui::size(px(59.), px(28.)));
        for (x, expected) in [(55., 0.), (56., 0.), (85.5, 0.5), (115., 1.), (116., 1.)] {
            assert_eq!(slider_fraction(px(x), bounds), Some(expected));
        }
        let empty = Bounds::new(bounds.origin, gpui::size(px(0.), px(28.)));
        assert_eq!(slider_fraction(px(56.), empty), None);
    }
}
