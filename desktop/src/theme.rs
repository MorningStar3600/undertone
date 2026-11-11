//! The current ambience as UI state: palette tokens (interpolated during a crossfade), the
//! motion setting and the resolved font families. One app-wide value; each window's sky and
//! body read it at render time.
use gpui::{App, BorrowAppContext, Global, Hsla, SharedString};
use std::{
    cell::{Cell, RefCell},
    time::Instant,
};
use undertone_desktop::ambience::{self, Crossfade, MotionPreference, Rgba, Tokens};

/// A palette slot. The UI names colors by role; the value follows the ambience.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tok {
    Background,
    Text,
    TextSoft,
    Card,
    Popover,
    Tooltip,
    Secondary,
    Muted,
    Faint,
    Border,
    Accent,
    AccentHover,
    OnAccent,
    AccentSurface,
    Personal,
    PersonalSurface,
    PersonalBorder,
    Danger,
    DangerSurface,
    Live,
    GlassStrong,
}

fn pick(tokens: &Tokens, tok: Tok) -> Rgba {
    match tok {
        Tok::Background => tokens.background,
        Tok::Text => tokens.text,
        Tok::TextSoft => tokens.text_soft,
        Tok::Card => tokens.card,
        Tok::Popover => tokens.popover,
        Tok::Tooltip => tokens.tooltip,
        Tok::Secondary => tokens.secondary,
        Tok::Muted => tokens.muted,
        Tok::Faint => tokens.faint,
        Tok::Border => tokens.border,
        Tok::Accent => tokens.accent,
        Tok::AccentHover => tokens.accent_hover,
        Tok::OnAccent => tokens.on_accent,
        Tok::AccentSurface => tokens.accent_surface,
        Tok::Personal => tokens.personal,
        Tok::PersonalSurface => tokens.personal_surface,
        Tok::PersonalBorder => tokens.personal_border,
        Tok::Danger => tokens.danger,
        Tok::DangerSurface => tokens.danger_surface,
        Tok::Live => tokens.live,
        Tok::GlassStrong => tokens.glass_strong,
    }
}

pub fn hsla(color: Rgba) -> Hsla {
    gpui::Rgba {
        r: color.r,
        g: color.g,
        b: color.b,
        a: color.a,
    }
    .into()
}

thread_local! {
    // GPUI renders on one thread; `frame` refreshes these before each window body is built.
    static CURRENT: Cell<Tokens> =
        Cell::new(Tokens::from_colors(&ambience::colors(ambience::DEFAULT)));
    static LOGO: Cell<usize> = const { Cell::new(ambience::DEFAULT) };
    static FONTS: RefCell<Option<Fonts>> = const { RefCell::new(None) };
}

fn family(pick: fn(&Fonts) -> &SharedString) -> SharedString {
    FONTS.with(|fonts| {
        fonts
            .borrow()
            .as_ref()
            .map(|fonts| pick(fonts).clone())
            .unwrap_or_else(|| "Segoe UI".into())
    })
}
/// Display family (large titles, wordmark) for the frame being built.
pub fn display() -> SharedString {
    family(|fonts| &fonts.display)
}
/// Body text family.
pub fn text() -> SharedString {
    family(|fonts| &fonts.text)
}
/// Italic serif "voice" (mood names, dedications).
pub fn voice() -> SharedString {
    family(|fonts| &fonts.voice)
}

/// Asset paths of the twelve logos (see `ui::Assets`).
pub const LOGOS: [&str; 12] = [
    "logo-01", "logo-02", "logo-03", "logo-04", "logo-05", "logo-06", "logo-07", "logo-08",
    "logo-09", "logo-10", "logo-11", "logo-12",
];

/// The logo shown with the ambience being rendered.
pub fn logo() -> &'static str {
    LOGOS[LOGO.with(Cell::get).min(LOGOS.len() - 1)]
}

/// The color of `tok` in the ambience being rendered.
pub fn rgb(tok: Tok) -> Hsla {
    CURRENT.with(|current| hsla(pick(&current.get(), tok)))
}

/// Font families resolved once against the installed fonts (Windows 11 first, then fallbacks).
#[derive(Clone)]
pub struct Fonts {
    /// Large titles and the wordmark: Segoe UI Variable Display.
    pub display: SharedString,
    /// Body text: Segoe UI Variable Text.
    pub text: SharedString,
    /// The italic "voice" of mood names and dedications: Sitka.
    pub voice: SharedString,
}
impl Fonts {
    fn resolve(cx: &App) -> Self {
        let installed = cx.text_system().all_font_names();
        let first = |candidates: &[&str]| -> SharedString {
            candidates
                .iter()
                .find(|name| installed.iter().any(|font| font.eq_ignore_ascii_case(name)))
                .copied()
                .unwrap_or("Segoe UI")
                .to_owned()
                .into()
        };
        Self {
            display: first(&["Segoe UI Variable Display", "Segoe UI Variable", "Segoe UI"]),
            text: first(&["Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI"]),
            voice: first(&[
                "Sitka Heading",
                "Sitka Display",
                "Sitka Text",
                "Sitka",
                "Palatino Linotype",
                "Georgia",
                "Cambria",
            ]),
        }
    }
}

/// App-wide ambience state.
pub struct Mood {
    pub crossfade: Crossfade,
    pub preference: MotionPreference,
    /// Windows "Show animations in Windows", sampled at start and on window activation.
    pub system_animations: bool,
    pub fonts: Fonts,
}
impl Global for Mood {}

pub fn init(cx: &mut App, preference: MotionPreference) {
    let fonts = Fonts::resolve(cx);
    cx.set_global(Mood {
        crossfade: Crossfade::default(),
        preference,
        system_animations: crate::native_window::system_animations(),
        fonts,
    });
}

pub fn mood(cx: &App) -> &Mood {
    cx.global::<Mood>()
}
pub fn animate(cx: &App) -> bool {
    let mood = mood(cx);
    mood.preference.animate(mood.system_animations)
}
pub fn current(cx: &App) -> usize {
    mood(cx).crossfade.to
}

/// Refreshes the tokens used by [`rgb`] for the frame being built.
pub fn frame(cx: &App) {
    let colors = mood(cx).crossfade.colors(Instant::now(), animate(cx));
    CURRENT.with(|current| current.set(Tokens::from_colors(&colors)));
    LOGO.with(|logo| logo.set(ambience::logo_for(current(cx))));
    FONTS.with(|fonts| {
        if fonts.borrow().is_none() {
            *fonts.borrow_mut() = Some(mood(cx).fonts.clone());
        }
    });
}

/// Moves to `ambience`, crossfading when animations are on. Observers of [`Mood`] (the skies
/// and bodies) wake up only when it actually changes.
pub fn set_ambience(ambience: usize, cx: &mut App) {
    let animate = animate(cx);
    if mood(cx).crossfade.to != ambience {
        cx.update_global::<Mood, _>(|mood, _| {
            mood.crossfade.retarget(ambience, Instant::now(), animate);
        });
    }
}

pub fn set_preference(preference: MotionPreference, cx: &mut App) {
    cx.update_global::<Mood, _>(|mood, _| mood.preference = preference);
}

/// Re-reads the Windows animation setting; notifies observers only on change.
pub fn refresh_system_animations(cx: &mut App) {
    let system = crate::native_window::system_animations();
    if mood(cx).system_animations != system {
        cx.update_global::<Mood, _>(|mood, _| mood.system_animations = system);
    }
}
