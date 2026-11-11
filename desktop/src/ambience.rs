//! Rust copy of `common/ambience.ts`: twelve dark color families, their animated background
//! motions and logos, and the OKLab rule that picks one from cover art. The TypeScript module is
//! the source of truth; `tests::matches_the_shared_fixture` checks this copy against
//! `common/tests/fixtures/ambience.json`.
//!
//! Everything here is plain data and math (no GPUI), so it is tested in every configuration.
use image::{RgbaImage, imageops};
use serde::{Deserialize, Serialize};
use std::{
    f32::consts::{PI, TAU},
    sync::LazyLock,
    time::{Duration, Instant},
};

/// Side of the square the cover is reduced to before matching.
pub const SAMPLE_SIZE: u32 = 32;
/// `heure-bleue`: used with no cover, a failed fetch, or no room.
pub const DEFAULT: usize = 0;
/// `None`: the logo follows the ambience (logo N with ambience N, the gallery default).
/// `Some(index)` pins the logo of that ambience everywhere, whatever the cover.
pub const PINNED_LOGO: Option<usize> = None;

/// The logo shown with an ambience, honouring [`PINNED_LOGO`].
pub fn logo_for(ambience: usize) -> usize {
    PINNED_LOGO.unwrap_or(ambience).min(AMBIENCES.len() - 1)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Motion {
    Drift,
    Rise,
    Sway,
    Ripple,
    Orbit,
    Breathe,
    Curtain,
    Pendulum,
    Aurora,
    Halo,
    Call,
    Sweep,
}
impl Motion {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Drift => "drift",
            Self::Rise => "rise",
            Self::Sway => "sway",
            Self::Ripple => "ripple",
            Self::Orbit => "orbit",
            Self::Breathe => "breathe",
            Self::Curtain => "curtain",
            Self::Pendulum => "pendulum",
            Self::Aurora => "aurora",
            Self::Halo => "halo",
            Self::Call => "call",
            Self::Sweep => "sweep",
        }
    }
}

/// Palette strings exactly as in `common/ambience.ts`.
pub struct Palette {
    /// Background gradient, top then bottom.
    pub background: [&'static str; 2],
    pub ink: &'static str,
    pub ink_soft: &'static str,
    pub muted: &'static str,
    pub accent: &'static str,
    pub on_accent: &'static str,
    pub glows: [&'static str; 3],
}

pub struct Ambience {
    pub id: &'static str,
    /// 1-based number, as shown in the design gallery.
    pub number: u8,
    /// Display name, lower case as in the widget's mood line.
    pub name: &'static str,
    pub motion: Motion,
    /// OKLCH hue anchor in degrees, or `None` for the neutral ambiences.
    pub hue: Option<f64>,
    pub palette: Palette,
    /// Inner SVG markup of the 24 x 24 logo, stroked with currentColor.
    pub logo: &'static str,
}

pub static AMBIENCES: [Ambience; 12] = [
    Ambience {
        id: "heure-bleue",
        number: 1,
        name: "heure bleue",
        motion: Motion::Drift,
        hue: Some(285.),
        palette: Palette {
            background: ["#0f1226", "#1c1529"],
            ink: "#f1ecf7",
            ink_soft: "#dbd4ec",
            muted: "#bdb7d3",
            accent: "#f2ae92",
            on_accent: "#2a1620",
            glows: [
                "rgba(124,98,206,0.5)",
                "rgba(232,140,128,0.3)",
                "rgba(70,96,200,0.42)",
            ],
        },
        logo: r#"<path d="M2 12h20"/><path d="M5.5 12a6.5 6.5 0 0 1 13 0"/><path d="M7 14.2h10a5 5 0 0 1-10 0z" fill="currentColor" stroke="none"/>"#,
    },
    Ambience {
        id: "braise",
        number: 2,
        name: "braise",
        motion: Motion::Rise,
        hue: Some(44.),
        palette: Palette {
            background: ["#160d0a", "#2a1510"],
            ink: "#f7ede3",
            ink_soft: "#e8d6c6",
            muted: "#cdb7a6",
            accent: "#f0c27a",
            on_accent: "#2b1707",
            glows: [
                "rgba(214,90,46,0.45)",
                "rgba(240,160,70,0.3)",
                "rgba(170,50,34,0.45)",
            ],
        },
        logo: r#"<path d="M7.5 17.5V8.5a4.5 4.5 0 0 1 9 0v9"/><path d="M7.5 18.6h9l4.3 3.4H3.2z" fill="currentColor" stroke="none"/>"#,
    },
    Ambience {
        id: "sous-bois",
        number: 3,
        name: "sous-bois",
        motion: Motion::Sway,
        hue: Some(125.),
        palette: Palette {
            background: ["#0d130c", "#1a2214"],
            ink: "#eef1e4",
            ink_soft: "#d6dcc6",
            muted: "#b6bfa4",
            accent: "#dcc56c",
            on_accent: "#1e1c08",
            glows: [
                "rgba(170,196,96,0.32)",
                "rgba(232,212,124,0.26)",
                "rgba(64,118,62,0.45)",
            ],
        },
        logo: r#"<path d="M12 11.2a1.75 1.75 0 0 1 3.5 0a3.5 3.5 0 0 1-7 0a5.25 5.25 0 0 1 10.5 0a7 7 0 0 1-14 0"/>"#,
    },
    Ambience {
        id: "lagune",
        number: 4,
        name: "lagune",
        motion: Motion::Ripple,
        hue: Some(205.),
        palette: Palette {
            background: ["#071a1e", "#0d2a2e"],
            ink: "#e9f5f3",
            ink_soft: "#cde4e1",
            muted: "#a9c9c5",
            accent: "#ecd6a6",
            on_accent: "#1f1a0c",
            glows: [
                "rgba(92,196,196,0.42)",
                "rgba(236,214,166,0.24)",
                "rgba(30,110,130,0.5)",
            ],
        },
        logo: r#"<path d="M12 2.8c2.7 3.5 4.3 5.9 4.3 8a4.3 4.3 0 0 1-8.6 0c0-2.1 1.6-4.5 4.3-8z" fill="currentColor" stroke="none"/><ellipse cx="12" cy="19.2" rx="8.5" ry="2.4"/>"#,
    },
    Ambience {
        id: "aurore",
        number: 5,
        name: "aurore",
        motion: Motion::Orbit,
        hue: Some(350.),
        palette: Palette {
            background: ["#1a0b17", "#2b1024"],
            ink: "#f8ecf3",
            ink_soft: "#ebd2e0",
            muted: "#d0b0c2",
            accent: "#f6b4c8",
            on_accent: "#2d0f1d",
            glows: [
                "rgba(214,90,150,0.45)",
                "rgba(150,84,206,0.4)",
                "rgba(250,170,150,0.24)",
            ],
        },
        logo: r#"<path d="M2.5 12c3.2-6.5 6.3-6.5 9.5 0s6.3 6.5 9.5 0"/><path d="M2.5 12c3.2 6.5 6.3 6.5 9.5 0s6.3-6.5 9.5 0"/>"#,
    },
    Ambience {
        id: "brume",
        number: 6,
        name: "brume",
        motion: Motion::Breathe,
        hue: None,
        palette: Palette {
            background: ["#121315", "#1d1e21"],
            ink: "#f0efec",
            ink_soft: "#d9d8d3",
            muted: "#b8b7b1",
            accent: "#e6e2d6",
            on_accent: "#1b1b1a",
            glows: [
                "rgba(214,212,204,0.24)",
                "rgba(150,158,172,0.26)",
                "rgba(255,250,240,0.14)",
            ],
        },
        logo: r#"<path d="M3.8 16a8.2 8.2 0 0 1 16.4 0"/><circle cx="12" cy="15.6" r="2.4" fill="currentColor" stroke="none"/>"#,
    },
    Ambience {
        id: "grenat",
        number: 7,
        name: "grenat",
        motion: Motion::Curtain,
        hue: Some(22.),
        palette: Palette {
            background: ["#170609", "#2a0b12"],
            ink: "#f9eaec",
            ink_soft: "#ecd0d4",
            muted: "#d3acb2",
            accent: "#ff9f8c",
            on_accent: "#2c0a0c",
            glows: [
                "rgba(196,40,72,0.42)",
                "rgba(236,96,96,0.3)",
                "rgba(120,22,44,0.55)",
            ],
        },
        logo: r#"<path d="M7 4.5v6.3a5 5 0 0 0 10 0M17 4.5v11.3"/><path d="M4.5 20.3c2.5-2.2 5-2.2 7.5 0s5 2.2 7.5 0"/>"#,
    },
    Ambience {
        id: "tabac",
        number: 8,
        name: "tabac",
        motion: Motion::Pendulum,
        hue: Some(72.),
        palette: Palette {
            background: ["#15100a", "#241a0f"],
            ink: "#f6efe2",
            ink_soft: "#e6d9c2",
            muted: "#c9b99c",
            accent: "#eac35e",
            on_accent: "#261b04",
            glows: [
                "rgba(226,168,74,0.4)",
                "rgba(176,116,44,0.38)",
                "rgba(255,222,150,0.16)",
            ],
        },
        logo: r#"<path d="M12 2.5v4.2"/><path d="M5.5 13a6.5 6.3 0 0 1 13 0z" fill="currentColor"/><path d="M12 16.2v4.3M7.6 15.6l-2.1 3.3M16.4 15.6l2.1 3.3"/>"#,
    },
    Ambience {
        id: "jade",
        number: 9,
        name: "jade",
        motion: Motion::Aurora,
        hue: Some(162.),
        palette: Palette {
            background: ["#081612", "#0f2620"],
            ink: "#eaf6f0",
            ink_soft: "#cfe6dc",
            muted: "#a8c8ba",
            accent: "#a8ead0",
            on_accent: "#08251a",
            glows: [
                "rgba(64,204,144,0.38)",
                "rgba(84,164,206,0.32)",
                "rgba(160,240,200,0.16)",
            ],
        },
        logo: r#"<path d="M7.5 5.5a9.5 9.5 0 0 0 0 13M16.5 5.5a9.5 9.5 0 0 1 0 13"/><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/>"#,
    },
    Ambience {
        id: "amethyste",
        number: 10,
        name: "améthyste",
        motion: Motion::Halo,
        hue: Some(307.),
        palette: Palette {
            background: ["#120b1f", "#1f1235"],
            ink: "#f2ecfb",
            ink_soft: "#ddd3f0",
            muted: "#bfb3da",
            accent: "#d4bdff",
            on_accent: "#1e1033",
            glows: [
                "rgba(146,96,232,0.48)",
                "rgba(206,124,222,0.3)",
                "rgba(96,70,196,0.45)",
            ],
        },
        logo: r#"<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="15" r="5.5"/><circle cx="12" cy="18.1" r="2.4" fill="currentColor" stroke="none"/>"#,
    },
    Ambience {
        id: "cendre",
        number: 11,
        name: "cendre",
        motion: Motion::Call,
        hue: None,
        palette: Palette {
            background: ["#171312", "#241e1c"],
            ink: "#f5eeea",
            ink_soft: "#e2d6d0",
            muted: "#c4b6ae",
            accent: "#e8b9a3",
            on_accent: "#2a1a12",
            glows: [
                "rgba(206,152,130,0.3)",
                "rgba(176,142,156,0.28)",
                "rgba(240,210,190,0.14)",
            ],
        },
        logo: r#"<g fill="currentColor" stroke="none"><circle cx="12" cy="4.5" r="1.7"/><circle cx="18.1" cy="8" r="1.7"/><circle cx="18.1" cy="15" r="1.7"/><circle cx="5.9" cy="15" r="1.7"/><circle cx="5.9" cy="8" r="1.7"/><circle cx="12" cy="18.6" r="2.7"/></g>"#,
    },
    Ambience {
        id: "route-de-nuit",
        number: 12,
        name: "route de nuit",
        motion: Motion::Sweep,
        hue: Some(258.),
        palette: Palette {
            background: ["#070d1a", "#0d1830"],
            ink: "#ecf1fa",
            ink_soft: "#d0dbef",
            muted: "#aab9d4",
            accent: "#ffcf7a",
            on_accent: "#24190a",
            glows: [
                "rgba(255,196,110,0.26)",
                "rgba(54,104,206,0.45)",
                "rgba(130,176,255,0.2)",
            ],
        },
        logo: r#"<path d="M12 21.5v-7M12 14.5C12 11 7 10.7 7 7.2M12 14.5c0-3.5 5-3.8 5-7.3"/><circle cx="7" cy="5.3" r="2.3" fill="currentColor" stroke="none"/><circle cx="17" cy="5.3" r="2.3" fill="currentColor" stroke="none"/>"#,
    },
];

pub fn index_of(id: &str) -> Option<usize> {
    AMBIENCES.iter().position(|a| a.id == id)
}

/// Matching thresholds, mirrored from `AMBIENCE_RULES`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rules {
    pub min_lightness: f64,
    pub max_lightness: f64,
    pub min_chroma: f64,
    pub min_colorful_share: f64,
    pub warm_neutral_chroma: f64,
    pub warm_neutral_hue: [f64; 2],
}
pub const RULES: Rules = Rules {
    min_lightness: 0.12,
    max_lightness: 0.95,
    min_chroma: 0.04,
    min_colorful_share: 0.15,
    warm_neutral_chroma: 0.012,
    warm_neutral_hue: [15., 110.],
};

fn to_linear(channel: u8) -> f64 {
    let c = f64::from(channel) / 255.;
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// OKLab `(l, a, b)` of an sRGB color.
pub fn srgb_to_oklab(r: u8, g: u8, b: u8) -> (f64, f64, f64) {
    let (lr, lg, lb) = (to_linear(r), to_linear(g), to_linear(b));
    let l = (0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb).cbrt();
    let m = (0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb).cbrt();
    let s = (0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb).cbrt();
    (
        0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    )
}

fn hue_degrees(a: f64, b: f64) -> f64 {
    let h = b.atan2(a).to_degrees();
    if h < 0. { h + 360. } else { h }
}

fn hue_distance(x: f64, y: f64) -> f64 {
    let d = (x - y).abs() % 360.;
    if d > 180. { 360. - d } else { d }
}

/// Picks the ambience closest to a cover from RGBA pixels (4 bytes each), already reduced to
/// about [`SAMPLE_SIZE`]² pixels. Same votes, thresholds and tie-breaking as the TypeScript
/// `pickAmbienceFromPixels`: colored pixels vote for the nearest hue anchor weighted by chroma,
/// covers with too little color fall back to a warm or cool neutral. Returns an index into
/// [`AMBIENCES`].
pub fn pick_from_rgba(rgba: &[u8]) -> usize {
    let rules = RULES;
    let chromatic: Vec<(usize, f64)> = AMBIENCES
        .iter()
        .enumerate()
        .filter_map(|(index, ambience)| ambience.hue.map(|hue| (index, hue)))
        .collect();
    let mut votes = vec![0f64; chromatic.len()];
    let (mut kept, mut colorful) = (0usize, 0usize);
    let (mut sum_a, mut sum_b) = (0f64, 0f64);
    for pixel in rgba.chunks_exact(4) {
        if pixel[3] < 128 {
            continue;
        }
        let (l, a, b) = srgb_to_oklab(pixel[0], pixel[1], pixel[2]);
        if l < rules.min_lightness || l > rules.max_lightness {
            continue;
        }
        kept += 1;
        sum_a += a;
        sum_b += b;
        let chroma = a.hypot(b);
        if chroma < rules.min_chroma {
            continue;
        }
        colorful += 1;
        let hue = hue_degrees(a, b);
        let mut best = 0;
        let mut best_distance = f64::INFINITY;
        for (index, (_, anchor)) in chromatic.iter().enumerate() {
            let distance = hue_distance(hue, *anchor);
            if distance < best_distance {
                best_distance = distance;
                best = index;
            }
        }
        votes[best] += chroma;
    }
    let brume = index_of("brume").expect("brume");
    if kept == 0 {
        return brume;
    }
    if (colorful as f64) / (kept as f64) < rules.min_colorful_share {
        let (mean_a, mean_b) = (sum_a / kept as f64, sum_b / kept as f64);
        let mean_hue = hue_degrees(mean_a, mean_b);
        let warm = mean_a.hypot(mean_b) >= rules.warm_neutral_chroma
            && mean_hue >= rules.warm_neutral_hue[0]
            && mean_hue <= rules.warm_neutral_hue[1];
        return if warm {
            index_of("cendre").expect("cendre")
        } else {
            brume
        };
    }
    let mut winner = 0;
    for index in 1..votes.len() {
        if votes[index] > votes[winner] {
            winner = index;
        }
    }
    chromatic[winner].0
}

/// The central 16:9 band of a cover: YouTube `hqdefault` stills are 4:3 with letterbox bars.
pub fn cover_band(image: &RgbaImage) -> RgbaImage {
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        return image.clone();
    }
    let (band_width, band_height) = if u64::from(width) * 9 <= u64::from(height) * 16 {
        (width, (width * 9 / 16).max(1))
    } else {
        ((height * 16 / 9).max(1), height)
    };
    imageops::crop_imm(
        image,
        (width - band_width) / 2,
        (height - band_height) / 2,
        band_width,
        band_height,
    )
    .to_image()
}

/// Ambience of a cover band (see [`cover_band`]): reduced to 32 x 32 (Triangle), then matched.
pub fn pick_from_cover(band: &RgbaImage) -> usize {
    if band.width() == 0 || band.height() == 0 {
        return DEFAULT;
    }
    let sample = imageops::resize(
        band,
        SAMPLE_SIZE,
        SAMPLE_SIZE,
        imageops::FilterType::Triangle,
    );
    pick_from_rgba(sample.as_raw())
}

/// Straight (non-premultiplied) color, components in `0..=1`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rgba {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}
impl Rgba {
    pub const fn hex(value: u32) -> Self {
        Self {
            r: ((value >> 16) & 0xff) as f32 / 255.,
            g: ((value >> 8) & 0xff) as f32 / 255.,
            b: (value & 0xff) as f32 / 255.,
            a: 1.,
        }
    }
    pub fn alpha(self, a: f32) -> Self {
        Self { a, ..self }
    }
    /// Linear interpolation of every component, `p` in `0..=1`.
    pub fn lerp(self, other: Self, p: f32) -> Self {
        let p = p.clamp(0., 1.);
        Self {
            r: self.r + (other.r - self.r) * p,
            g: self.g + (other.g - self.g) * p,
            b: self.b + (other.b - self.b) * p,
            a: self.a + (other.a - self.a) * p,
        }
    }
}

/// `#rrggbb` or `rgba(r,g,b,a)`, as used by the palettes.
pub fn parse_color(value: &str) -> Option<Rgba> {
    if let Some(hex) = value.strip_prefix('#') {
        return (hex.len() == 6)
            .then(|| u32::from_str_radix(hex, 16).ok())
            .flatten()
            .map(Rgba::hex);
    }
    let inner = value.strip_prefix("rgba(")?.strip_suffix(')')?;
    let parts: Vec<f32> = inner
        .split(',')
        .map(|part| part.trim().parse::<f32>())
        .collect::<Result<_, _>>()
        .ok()?;
    let [r, g, b, a] = parts.as_slice() else {
        return None;
    };
    Some(Rgba {
        r: r / 255.,
        g: g / 255.,
        b: b / 255.,
        a: *a,
    })
}

/// A palette parsed into colors, interpolable during the 0.9 s crossfade.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Colors {
    pub background: [Rgba; 2],
    pub ink: Rgba,
    pub ink_soft: Rgba,
    pub muted: Rgba,
    pub accent: Rgba,
    pub on_accent: Rgba,
    pub glows: [Rgba; 3],
}
impl Colors {
    pub fn lerp(&self, other: &Self, p: f32) -> Self {
        let l = |a: Rgba, b: Rgba| a.lerp(b, p);
        Self {
            background: [
                l(self.background[0], other.background[0]),
                l(self.background[1], other.background[1]),
            ],
            ink: l(self.ink, other.ink),
            ink_soft: l(self.ink_soft, other.ink_soft),
            muted: l(self.muted, other.muted),
            accent: l(self.accent, other.accent),
            on_accent: l(self.on_accent, other.on_accent),
            glows: [
                l(self.glows[0], other.glows[0]),
                l(self.glows[1], other.glows[1]),
                l(self.glows[2], other.glows[2]),
            ],
        }
    }
}

static COLORS: LazyLock<Vec<Colors>> = LazyLock::new(|| {
    AMBIENCES
        .iter()
        .map(|ambience| {
            let p = &ambience.palette;
            let c = |s: &str| parse_color(s).expect("valid palette color");
            Colors {
                background: [c(p.background[0]), c(p.background[1])],
                ink: c(p.ink),
                ink_soft: c(p.ink_soft),
                muted: c(p.muted),
                accent: c(p.accent),
                on_accent: c(p.on_accent),
                glows: [c(p.glows[0]), c(p.glows[1]), c(p.glows[2])],
            }
        })
        .collect()
});

pub fn colors(ambience: usize) -> Colors {
    COLORS[ambience.min(AMBIENCES.len() - 1)]
}

/// UI tokens derived from an ambience palette. Cards are translucent over the animated sky.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tokens {
    pub background: Rgba,
    pub background_end: Rgba,
    pub text: Rgba,
    pub text_soft: Rgba,
    pub card: Rgba,
    pub popover: Rgba,
    /// Opaque surface for floating tooltips.
    pub tooltip: Rgba,
    pub secondary: Rgba,
    pub muted: Rgba,
    pub faint: Rgba,
    pub border: Rgba,
    pub accent: Rgba,
    pub accent_hover: Rgba,
    pub on_accent: Rgba,
    pub accent_surface: Rgba,
    pub personal: Rgba,
    pub personal_surface: Rgba,
    pub personal_border: Rgba,
    pub danger: Rgba,
    pub danger_surface: Rgba,
    pub live: Rgba,
    /// Round chrome buttons over the sky (`--glassx`).
    pub glass_strong: Rgba,
}
impl Tokens {
    pub fn from_colors(c: &Colors) -> Self {
        let bg = c.background[0];
        let ink = c.ink;
        Self {
            background: bg,
            background_end: c.background[1],
            text: ink,
            text_soft: c.ink_soft,
            card: bg.alpha(0.56),
            popover: ink.alpha(0.07),
            tooltip: bg.lerp(ink, 0.12).alpha(1.),
            secondary: ink.alpha(0.13),
            muted: c.muted,
            faint: c.muted.alpha(0.5),
            border: ink.alpha(0.13),
            accent: c.accent,
            accent_hover: c.accent.lerp(ink, 0.3),
            on_accent: c.on_accent,
            accent_surface: c.accent.alpha(0.16),
            personal: ink,
            personal_surface: ink.alpha(0.15),
            personal_border: ink.alpha(0.42),
            danger: Rgba::hex(0xf0957c),
            danger_surface: Rgba::hex(0xf0957c).alpha(0.16),
            live: Rgba::hex(0xa9c6a1),
            glass_strong: bg.alpha(0.7),
        }
    }
}

// ── Motion: the twelve animated skies ───────────────────────────────────────────────────────

/// One soft glow of the sky, in pixels of the painted area. `tone` indexes the palette glows;
/// `alpha` multiplies that glow color's own alpha.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Glow {
    pub x: f32,
    pub y: f32,
    pub rx: f32,
    pub ry: f32,
    pub tone: usize,
    pub alpha: f32,
}

/// Duration of the crossfade between two ambiences.
pub const CROSSFADE: Duration = Duration::from_millis(900);
/// Animation time used for the static frame (animations off): a balanced composition.
pub const STATIC_TIME: f32 = 4.5;

/// CSS `ease-in-out`, close enough for slow ambient motion.
fn ease(x: f32) -> f32 {
    0.5 - 0.5 * (PI * x.clamp(0., 1.)).cos()
}
/// Eased progress of `animation: <dur> <delay> infinite alternate` (or `alternate-reverse`).
fn alt(t: f32, duration: f32, delay: f32, reverse: bool) -> f32 {
    let x = (t - delay) / duration;
    let iteration = x.floor();
    let fraction = x - iteration;
    let forward = ((iteration as i64).rem_euclid(2) == 0) != reverse;
    ease(if forward { fraction } else { 1. - fraction })
}
/// Linear progress of `animation: <dur> <delay> linear infinite`.
fn lin(t: f32, duration: f32, delay: f32) -> f32 {
    ((t - delay) / duration).rem_euclid(1.)
}
fn mix(a: f32, b: f32, p: f32) -> f32 {
    a + (b - a) * p
}

/// Overlap compensation for chains of beads (rings and beams).
const BEAD_ALPHA: f32 = 0.5;

fn blob(out: &mut Vec<Glow>, x: f32, y: f32, rx: f32, ry: f32, tone: usize, alpha: f32) {
    out.push(Glow {
        x,
        y,
        rx: rx.max(1.),
        ry: ry.max(1.),
        tone,
        alpha: alpha.clamp(0., 1.),
    });
}

/// A soft beam from `(x0, y0)` to `(x1, y1)`: overlapping round glows whose radius tapers by
/// `taper` and whose alpha goes from `a0` to `a1`.
#[expect(clippy::too_many_arguments, reason = "geometry stays explicit")]
fn beam(
    out: &mut Vec<Glow>,
    (x0, y0): (f32, f32),
    (x1, y1): (f32, f32),
    half_width: f32,
    taper: f32,
    tone: usize,
    a0: f32,
    a1: f32,
) {
    let length = (x1 - x0).hypot(y1 - y0);
    let count = ((length / (half_width * 0.8)).ceil() as usize).clamp(2, 24);
    for i in 0..count {
        let s = i as f32 / (count - 1) as f32;
        let r = half_width * (1. - taper * s);
        blob(
            out,
            mix(x0, x1, s),
            mix(y0, y1, s),
            r,
            r,
            tone,
            mix(a0, a1, s) * BEAD_ALPHA,
        );
    }
}

/// A soft ring of beads.
fn ring(out: &mut Vec<Glow>, (x, y): (f32, f32), radius: f32, half: f32, tone: usize, alpha: f32) {
    if alpha <= 0.001 || radius <= 0. {
        return;
    }
    let count = ((TAU * radius / (half * 1.1)).ceil() as usize).clamp(8, 32);
    for i in 0..count {
        let angle = TAU * i as f32 / count as f32;
        blob(
            out,
            x + radius * angle.cos(),
            y + radius * angle.sin(),
            half,
            half,
            tone,
            alpha * BEAD_ALPHA,
        );
    }
}

/// The glows of `motion` at animation time `t` (seconds) on a `w` x `h` area. Mirrors the CSS
/// keyframes of the validated gallery (layers `.l1`-`.l5`, radial glows of the three palette
/// colors), translated to positioned soft glows: rotations become arcs, beams and rings become
/// chains of overlapping glows. Amplitude and speed are the gallery's defaults (`--a`, `--s` = 1).
pub fn scene(motion: Motion, t: f32, w: f32, h: f32, out: &mut Vec<Glow>) {
    out.clear();
    let (deg, sin, cos) = (f32::to_radians, f32::sin, f32::cos);
    // k-breathe: opacity .35 -> 1, scaleX .88 -> 1.08
    let breathe = |p: f32| (mix(0.35, 1., p), mix(0.88, 1.08, p));
    match motion {
        Motion::Drift => {
            let p = alt(t, 9., 0., false);
            let (ew, eh) = (1.3 * w, 0.7 * h);
            let s = mix(1., 1.06, p);
            blob(
                out,
                0.30 * w + mix(-0.14, 0.14, p) * ew,
                0.17 * h + mix(0., 0.06, p) * eh,
                0.65 * w * s,
                0.35 * h * s,
                0,
                1.,
            );
            let p = alt(t, 11., -4., false);
            let (ew, eh) = (1.35 * w, 0.62 * h);
            let s = mix(1., 1.1, p);
            blob(
                out,
                0.725 * w + mix(0.14, -0.16, p) * ew,
                0.83 * h + mix(0., -0.07, p) * eh,
                0.675 * w * s,
                0.31 * h * s,
                2,
                1.,
            );
            let (a, sx) = breathe(alt(t, 6., 0., false));
            blob(out, 0.5 * w, 0.55 * h, 0.75 * w * sx, 0.13 * h, 1, a);
        }
        Motion::Rise => {
            let side = 0.95 * w;
            let p = alt(t, 10., 0., false);
            let s = mix(1., 1.08, p);
            blob(
                out,
                0.255 * w + mix(0., 0.06, p) * side,
                1.38 * h - side / 2. + mix(0.10, -0.38, p) * side,
                side / 2. * s,
                side / 2. * s,
                0,
                1.,
            );
            let side = 0.72 * w;
            let p = alt(t, 8., -3., false);
            let s = mix(0.92, 1.06, p);
            blob(
                out,
                0.86 * w + mix(0., -0.08, p) * side,
                1.30 * h - side / 2. + mix(0.12, -0.46, p) * side,
                side / 2. * s,
                side / 2. * s,
                1,
                1.,
            );
            let side = 0.5 * w;
            let p = alt(t, 7., -5., false);
            blob(
                out,
                0.51 * w + mix(0., 0.05, p) * side,
                1.22 * h - side / 2. + mix(0.2, -0.7, p) * side,
                side / 2.,
                side / 2.,
                2,
                mix(0.3, 1., p),
            );
        }
        Motion::Sway => {
            // Light shafts under leaves, swinging around their top (transform-origin 50% 0).
            for (left, width, tone, duration, delay, reverse) in [
                (0.04, 0.24, 0, 7., -2., false),
                (0.38, 0.32, 0, 9., -6., true),
                (0.70, 0.18, 1, 6., -1., false),
            ] {
                let p = alt(t, duration, delay, reverse);
                let angle = deg(mix(-10., 10., p));
                let pivot = ((left + width / 2.) * w, -0.3 * h);
                let length = 1.5 * h;
                let end = (pivot.0 - length * sin(angle), pivot.1 + length * cos(angle));
                beam(
                    out,
                    pivot,
                    end,
                    width / 2. * w,
                    0.6,
                    tone,
                    mix(0.5, 1., p),
                    0.,
                );
            }
            let (a, sx) = breathe(alt(t, 8., 0., false));
            blob(out, 0.5 * w, 0.93 * h, 0.70 * w * sx, 0.25 * h, 2, a);
        }
        Motion::Ripple => {
            // Rings widening from a low point, three in flight.
            for (delay, tone) in [(0., 0), (-3., 0), (-6., 1)] {
                let q = lin(t, 9., delay);
                let scale = mix(0.15, 1.2, q);
                let opacity = if q < 0.22 {
                    q / 0.22
                } else {
                    1. - (q - 0.22) / 0.78
                };
                ring(
                    out,
                    (0.5 * w, 0.70 * h),
                    0.46 * w * scale,
                    (0.0975 * w * scale).max(6.),
                    tone,
                    opacity,
                );
            }
            let (a, sx) = breathe(alt(t, 7., 0., false));
            blob(out, 0.5 * w, 0.93 * h, 0.65 * w * sx, 0.23 * h, 2, a);
        }
        Motion::Orbit => {
            // Two glows orbiting each other, a third circling the other way.
            let side = 1.25 * w;
            let angle = TAU * lin(t, 18., 0.);
            let center = (0.5 * w, 0.42 * h);
            let radius = 0.331 * side;
            for (dx, dy, tone) in [(-0.22, -0.20, 0), (0.22, 0.20, 1)] {
                let (ox, oy) = (dx * side, dy * side);
                let (rx, ry) = (
                    ox * cos(angle) - oy * sin(angle),
                    ox * sin(angle) + oy * cos(angle),
                );
                blob(out, center.0 + rx, center.1 + ry, radius, radius, tone, 1.);
            }
            let side = 1.65 * w;
            let angle = -TAU * lin(t, 26., -9.);
            let offset = -0.28 * side;
            blob(
                out,
                0.5 * w - offset * sin(angle),
                0.62 * h + offset * cos(angle),
                0.26 * side,
                0.26 * side,
                2,
                1.,
            );
        }
        Motion::Breathe => {
            let p = alt(t, 7., 0., false);
            let r = 0.62 * w * mix(0.75, 1.12, p);
            blob(out, 0.5 * w, 0.08 * h + 0.62 * w, r, r, 0, mix(0.3, 1., p));
            let side = 0.95 * w;
            let p = alt(t, 12., -3., false);
            let r = side / 2. * mix(1., 1.06, p);
            blob(
                out,
                0.075 * w + mix(-0.14, 0.14, p) * side,
                0.52 * h + side / 2. + mix(0., 0.06, p) * side,
                r,
                r,
                1,
                1.,
            );
            let (a, sx) = breathe(alt(t, 5., -2., false));
            let r = 0.36 * w;
            blob(out, 0.58 * w, -0.24 * h + r, r * sx, r, 2, a);
        }
        Motion::Curtain => {
            // Velvet folds: vertical glows widening and swaying.
            for (left, tone, delay) in [
                (-0.14, 0, 0.),
                (0.13, 2, -2.2),
                (0.41, 0, -4.4),
                (0.69, 2, -1.1),
            ] {
                let p = alt(t, 7., delay, false);
                let width = 0.32 * w;
                blob(
                    out,
                    left * w + width / 2. + mix(-0.12, 0.12, p) * width,
                    0.5 * h,
                    width / 2. * mix(0.72, 1.2, p),
                    0.6 * h,
                    tone,
                    mix(0.45, 1., p),
                );
            }
            let (a, sx) = breathe(alt(t, 8., 0., false));
            blob(out, 0.5 * w, 0.94 * h, 0.70 * w * sx, 0.26 * h, 1, a);
        }
        Motion::Pendulum => {
            // A low lamp swinging from a pivot above the window.
            let angle = deg(mix(-16., 16., alt(t, 6., 0., false)));
            let r = 0.46 * w;
            let pivot = (0.5 * w, -0.06 * h - 0.6 * 0.92 * w);
            let length = r + 0.6 * 0.92 * w;
            blob(
                out,
                pivot.0 - length * sin(angle),
                pivot.1 + length * cos(angle),
                r,
                r,
                0,
                1.,
            );
            let p = alt(t, 6., 0., false);
            blob(
                out,
                0.5 * w + mix(-0.14, 0.14, p) * 1.24 * w,
                0.91 * h,
                0.62 * w,
                0.21 * h,
                1,
                1.,
            );
            let (a, sx) = breathe(alt(t, 9., 0., false));
            blob(out, 0.5 * w, 0., 0.80 * w * sx, 0.20 * h, 2, a);
        }
        Motion::Aurora => {
            // Curtains of light rising from a line, leaning and stretching.
            for (top, tone, duration, delay, reverse) in
                [(0., 0, 8., 0., false), (0.20, 1, 10., -4., true)]
            {
                let p = alt(t, duration, delay, reverse);
                let alpha = mix(0.5, 1., p);
                let (ew, eh) = (1.44 * w, 0.56 * h);
                let dx = mix(-0.12, 0.12, p) * ew;
                let dy = mix(0., 0.04, p) * eh;
                let skew = deg(mix(-16., 16., p)).tan();
                let sy = mix(0.85, 1.15, p);
                let center_y = top * h + eh / 2. + dy;
                let base = center_y + eh / 2. * sy;
                let (rx, ry) = (0.6 * 0.78 * ew, 0.5 * 0.78 * eh * sy);
                const RAYS: usize = 9;
                for k in 0..RAYS {
                    let u = -1. + 2. * (k as f32 + 0.5) / RAYS as f32;
                    let x = 0.5 * w + dx + u * rx;
                    let height = ry * (1. - u * u).sqrt();
                    let lean = |y: f32| skew * (center_y - y);
                    beam(
                        out,
                        (x + lean(base), base),
                        (x + lean(base - height), base - height),
                        rx / RAYS as f32 * 1.5,
                        0.3,
                        tone,
                        alpha * (1. - u.abs()),
                        0.,
                    );
                }
            }
            let (a, sx) = breathe(alt(t, 7., 0., false));
            blob(out, 0.5 * w, 0.95 * h, 0.70 * w * sx, 0.23 * h, 2, a);
        }
        Motion::Halo => {
            // Three colored sectors turning around a low center.
            let center = (0.5 * w, 0.64 * h);
            let radius = 0.875 * w;
            let turn = 360. * lin(t, 20., 0.);
            for (tone, at) in [(0, 0.), (1, 122.), (2, 245.)] {
                let angle = deg(turn + at);
                for (distance, size, alpha) in [(0.22, 0.26, 0.85), (0.48, 0.2, 0.6)] {
                    blob(
                        out,
                        center.0 + distance * radius * sin(angle),
                        center.1 - distance * radius * cos(angle),
                        size * radius,
                        size * radius,
                        tone,
                        alpha,
                    );
                }
            }
            let p = alt(t, 6., 0., false);
            let r = 0.35 * w * mix(0.75, 1.12, p);
            blob(out, center.0, center.1, r, r, 0, mix(0.3, 1., p));
        }
        Motion::Call => {
            // Two glows answering each other.
            let r = 0.44 * w;
            for (x, y, tone, reverse) in [(0.16, 0.14, 0, false), (0.84, 0.40, 1, true)] {
                let p = alt(t, 5., 0., reverse);
                let s = mix(0.8, 1.08, p);
                blob(out, x * w, y * h + r, r * s, r * s, tone, mix(0.2, 1., p));
            }
            let p = alt(t, 5., 0., true);
            blob(
                out,
                0.5 * w + mix(-0.14, 0.14, p) * 1.2 * w,
                0.54 * h,
                0.60 * w,
                0.16 * h,
                2,
                1.,
            );
        }
        Motion::Sweep => {
            // Wide headlight beams crossing slowly, tilted by 20 degrees.
            let tilt = deg(20.);
            for (width, tone, delay) in [(0.40, 0, 0.), (0.24, 2, -5.)] {
                let q = ease(lin(t, 10., delay));
                let element = width * w;
                let x = element / 2. + mix(-1.7, 3.3, q) * element;
                let half_length = h;
                let (ux, uy) = (sin(tilt), -cos(tilt));
                beam(
                    out,
                    (x - ux * half_length, 0.5 * h - uy * half_length),
                    (x + ux * half_length, 0.5 * h + uy * half_length),
                    element / 2.,
                    0.,
                    tone,
                    1.,
                    1.,
                );
            }
            let p = alt(t, 12., 0., false);
            let s = mix(1., 1.1, p);
            blob(
                out,
                0.5 * w + mix(0.14, -0.16, p) * 1.6 * w,
                0.90 * h + mix(0., -0.07, p) * 0.52 * h,
                0.80 * w * s,
                0.26 * h * s,
                1,
                1.,
            );
        }
    }
}

// ── Pacing: frames only while something visible needs them ─────────────────────────────────

/// What the OS says about a window, sampled on the UI thread.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Visibility {
    pub minimized: bool,
    pub hidden: bool,
    /// DWM cloaked: another virtual desktop, or suspended by the shell.
    pub cloaked: bool,
}
impl Visibility {
    pub fn visible(self) -> bool {
        !self.minimized && !self.hidden && !self.cloaked
    }
}

/// In-app override of the Windows "Show animations in Windows" setting.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MotionPreference {
    /// Follow Windows (SPI_GETCLIENTAREAANIMATION).
    #[default]
    System,
    On,
    Off,
}
impl MotionPreference {
    pub fn animate(self, system_animations: bool) -> bool {
        match self {
            Self::System => system_animations,
            Self::On => true,
            Self::Off => false,
        }
    }
}

/// About 30 frames per second: smooth for 5-26 s cycles, half the cost of per-vsync drawing.
pub const FRAME_INTERVAL: Duration = Duration::from_millis(33);
/// How often a paused (minimized, hidden, cloaked) animated window checks whether it is back.
/// A probe never draws.
pub const PROBE_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    /// Draw one frame, then step again after this delay.
    Frame(Duration),
    /// Draw nothing; sample visibility again after this delay.
    Probe(Duration),
    /// Draw nothing and stop until an event (setting, ambience, window) wakes the sky.
    Idle,
}

/// Per-window animation clock and scheduler. Pure logic: the caller samples [`Visibility`] and
/// performs the returned [`Step`]. Animation time only advances while frames are drawn, so a
/// paused sky resumes where it stopped.
#[derive(Debug)]
pub struct Pacer {
    banked: Duration,
    running_since: Option<Instant>,
    /// Frames requested so far (debug counter, asserted by the tests).
    pub frames: u64,
    /// Visibility samples taken while paused.
    pub probes: u64,
}
impl Default for Pacer {
    fn default() -> Self {
        Self {
            banked: Duration::from_secs_f32(STATIC_TIME),
            running_since: None,
            frames: 0,
            probes: 0,
        }
    }
}
impl Pacer {
    fn pause(&mut self, now: Instant) {
        if let Some(since) = self.running_since.take() {
            self.banked += now.saturating_duration_since(since);
        }
    }
    /// Decides the next step. `animate` is the effective motion setting; `transitioning` is
    /// true while a palette crossfade is in progress.
    pub fn step(
        &mut self,
        now: Instant,
        visibility: Visibility,
        animate: bool,
        transitioning: bool,
    ) -> Step {
        if !visibility.visible() {
            self.pause(now);
            if animate {
                self.probes += 1;
                return Step::Probe(PROBE_INTERVAL);
            }
            return Step::Idle;
        }
        if animate {
            if self.running_since.is_none() {
                self.running_since = Some(now);
            }
            self.frames += 1;
            return Step::Frame(FRAME_INTERVAL);
        }
        self.pause(now);
        if transitioning {
            self.frames += 1;
            return Step::Frame(FRAME_INTERVAL);
        }
        Step::Idle
    }
    /// Animation time in seconds; frozen while paused.
    pub fn time(&self, now: Instant) -> f32 {
        let running = self
            .running_since
            .map(|since| now.saturating_duration_since(since))
            .unwrap_or_default();
        (self.banked + running).as_secs_f32()
    }
}

/// The current ambience and the crossfade from the previous one.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Crossfade {
    pub from: usize,
    pub to: usize,
    pub started: Option<Instant>,
}
impl Default for Crossfade {
    fn default() -> Self {
        Self {
            from: DEFAULT,
            to: DEFAULT,
            started: None,
        }
    }
}
impl Crossfade {
    /// Starts a crossfade to `next`; returns false when it is already the target.
    pub fn retarget(&mut self, next: usize, now: Instant, animate: bool) -> bool {
        let next = next.min(AMBIENCES.len() - 1);
        if next == self.to {
            return false;
        }
        self.from = if animate { self.to } else { next };
        self.to = next;
        self.started = animate.then_some(now);
        true
    }
    /// Eased progress in `0..=1`; instant when animations are off.
    pub fn progress(&self, now: Instant, animate: bool) -> f32 {
        match self.started {
            Some(started) if animate && self.from != self.to => {
                ease(now.saturating_duration_since(started).as_secs_f32() / CROSSFADE.as_secs_f32())
            }
            _ => 1.,
        }
    }
    pub fn active(&self, now: Instant, animate: bool) -> bool {
        self.progress(now, animate) < 1.
    }
    /// Palette colors at `now`.
    pub fn colors(&self, now: Instant, animate: bool) -> Colors {
        colors(self.from).lerp(&colors(self.to), self.progress(now, animate))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn fixture() -> Value {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../common/tests/fixtures/ambience.json"
        );
        serde_json::from_str(&std::fs::read_to_string(path).expect("shared fixture"))
            .expect("fixture JSON")
    }

    fn pixels(runs: &Value) -> Vec<u8> {
        let mut out = Vec::new();
        for run in runs.as_array().unwrap() {
            let run = run.as_array().unwrap();
            let color = parse_color(run[0].as_str().unwrap()).unwrap();
            let count = run[1].as_u64().unwrap();
            let alpha = run.get(2).and_then(Value::as_u64).unwrap_or(255) as u8;
            for _ in 0..count {
                out.extend([
                    (color.r * 255.).round() as u8,
                    (color.g * 255.).round() as u8,
                    (color.b * 255.).round() as u8,
                    alpha,
                ]);
            }
        }
        out
    }

    #[test]
    fn matches_the_shared_fixture() {
        let fixture = fixture();
        let rules: Rules = serde_json::from_value(fixture["rules"].clone()).unwrap();
        assert_eq!(rules, RULES);
        let ambiences = fixture["ambiences"].as_array().unwrap();
        assert_eq!(ambiences.len(), AMBIENCES.len());
        for (expected, ambience) in ambiences.iter().zip(&AMBIENCES) {
            assert_eq!(expected["id"], ambience.id);
            assert_eq!(expected["number"], u64::from(ambience.number));
            assert_eq!(expected["motion"], ambience.motion.as_str());
            assert_eq!(expected["hue"].as_f64(), ambience.hue, "{}", ambience.id);
            assert_eq!(expected["logo"], ambience.logo, "{}", ambience.id);
            let p = &expected["palette"];
            let palette = &ambience.palette;
            assert_eq!(p["background"][0], palette.background[0]);
            assert_eq!(p["background"][1], palette.background[1]);
            assert_eq!(p["ink"], palette.ink);
            assert_eq!(p["inkSoft"], palette.ink_soft);
            assert_eq!(p["muted"], palette.muted);
            assert_eq!(p["accent"], palette.accent);
            assert_eq!(p["onAccent"], palette.on_accent);
            for (index, glow) in palette.glows.iter().enumerate() {
                assert_eq!(p["glows"][index], *glow, "{}", ambience.id);
            }
        }
        let vectors = fixture["vectors"].as_array().unwrap();
        assert!(vectors.len() >= 12);
        for vector in vectors {
            assert_eq!(
                AMBIENCES[pick_from_rgba(&pixels(&vector["pixels"]))].id,
                vector["expected"],
                "{}",
                vector["name"]
            );
        }
    }

    #[test]
    fn palettes_parse_and_logo_follows_the_ambience() {
        for (index, ambience) in AMBIENCES.iter().enumerate() {
            assert_eq!(usize::from(ambience.number), index + 1);
            assert_eq!(index_of(ambience.id), Some(index));
            let c = colors(index);
            assert!(c.glows.iter().all(|g| g.a > 0. && g.a <= 0.55));
            assert_eq!(c.background[0].a, 1.);
            assert_eq!(logo_for(index), PINNED_LOGO.unwrap_or(index));
        }
        assert_eq!(
            parse_color("rgba(124,98,206,0.5)"),
            Some(Rgba {
                r: 124. / 255.,
                g: 98. / 255.,
                b: 206. / 255.,
                a: 0.5
            })
        );
        assert_eq!(parse_color("#zz0000"), None);
        assert_eq!(parse_color("rgb(1,2,3)"), None);
    }

    #[test]
    fn covers_are_matched_on_their_central_16_9_band() {
        // A 480 x 360 hqdefault still: black letterbox bars around a teal picture.
        let mut cover = RgbaImage::from_pixel(480, 360, image::Rgba([0, 0, 0, 255]));
        for y in 45..315 {
            for x in 0..480 {
                cover.put_pixel(x, y, image::Rgba([0x13, 0x8a, 0x8a, 255]));
            }
        }
        let band = cover_band(&cover);
        assert_eq!(band.dimensions(), (480, 270));
        assert!(band.pixels().all(|p| p.0 == [0x13, 0x8a, 0x8a, 255]));
        assert_eq!(AMBIENCES[pick_from_cover(&band)].id, "lagune");
        // Wider than 16:9: keep the full height, crop the sides.
        let wide = RgbaImage::new(400, 100);
        assert_eq!(cover_band(&wide).dimensions(), (177, 100));
        assert_eq!(pick_from_cover(&RgbaImage::new(0, 0)), DEFAULT);
    }

    #[test]
    fn every_motion_moves_visibly_within_three_seconds_and_stays_soft() {
        let (w, h) = (880., 680.);
        let mut a = Vec::new();
        let mut b = Vec::new();
        for ambience in &AMBIENCES {
            scene(ambience.motion, 10., w, h, &mut a);
            assert!(!a.is_empty() && a.len() <= 120, "{}", ambience.id);
            assert!(
                a.iter()
                    .all(|g| g.alpha >= 0. && g.alpha <= 1. && g.tone < 3 && g.rx >= 1.),
                "{}",
                ambience.id
            );
            // Perceptible motion: some glow travels at least 2% of the width (or fades
            // noticeably) within 2.5 s, from any starting phase.
            for start in [0., 3.3, 7.9] {
                scene(ambience.motion, start, w, h, &mut a);
                scene(ambience.motion, start + 2.5, w, h, &mut b);
                let moved = a.iter().zip(&b).any(|(x, y)| {
                    (x.x - y.x).hypot(x.y - y.y) > 0.02 * w
                        || (x.rx - y.rx).abs() > 0.02 * w
                        || (x.alpha - y.alpha).abs() > 0.1
                });
                assert!(moved, "{} barely moves from t={start}", ambience.id);
            }
        }
    }

    #[test]
    fn paused_windows_schedule_no_frames() {
        let start = Instant::now();
        let mut pacer = Pacer::default();
        let visible = Visibility::default();
        let paused = [
            Visibility {
                minimized: true,
                ..visible
            },
            Visibility {
                hidden: true,
                ..visible
            },
            Visibility {
                cloaked: true,
                ..visible
            },
        ];
        // Minimized, hidden or cloaked: probes only, never a frame, animation clock frozen.
        for (i, state) in paused.iter().enumerate() {
            let now = start + Duration::from_secs(i as u64);
            assert_eq!(
                pacer.step(now, *state, true, true),
                Step::Probe(PROBE_INTERVAL)
            );
            assert_eq!(pacer.step(now, *state, false, false), Step::Idle);
        }
        assert_eq!(pacer.frames, 0);
        assert_eq!(pacer.time(start + Duration::from_secs(60)), STATIC_TIME);
        // Animations off and nothing to crossfade: a static frame, then nothing.
        assert_eq!(pacer.step(start, visible, false, false), Step::Idle);
        assert_eq!(pacer.frames, 0);
        // Animations off still finish a crossfade with frames, without advancing motion time.
        assert_eq!(
            pacer.step(start, visible, false, true),
            Step::Frame(FRAME_INTERVAL)
        );
        assert_eq!(pacer.frames, 1);
        assert_eq!(pacer.time(start + Duration::from_secs(5)), STATIC_TIME);
        // Visible and animated: about 30 frames per second, clock running.
        assert_eq!(
            pacer.step(start, visible, true, false),
            Step::Frame(FRAME_INTERVAL)
        );
        assert!(FRAME_INTERVAL >= Duration::from_millis(30));
        let later = start + Duration::from_secs(2);
        assert!((pacer.time(later) - (STATIC_TIME + 2.)).abs() < 0.01);
        // Minimizing banks the time; it resumes from there.
        assert_eq!(
            pacer.step(later, paused[0], true, false),
            Step::Probe(PROBE_INTERVAL)
        );
        let frames = pacer.frames;
        let much_later = later + Duration::from_secs(600);
        assert!((pacer.time(much_later) - (STATIC_TIME + 2.)).abs() < 0.01);
        assert_eq!(pacer.frames, frames);
    }

    #[test]
    fn crossfades_are_eased_and_instant_without_animation() {
        let now = Instant::now();
        let mut fade = Crossfade::default();
        assert!(!fade.retarget(DEFAULT, now, true));
        assert!(fade.retarget(3, now, true));
        assert_eq!((fade.from, fade.to), (DEFAULT, 3));
        assert_eq!(fade.progress(now, true), 0.);
        assert!(fade.active(now + Duration::from_millis(450), true));
        let half = fade.colors(now + Duration::from_millis(450), true);
        assert!((half.ink.r - colors(0).ink.lerp(colors(3).ink, 0.5).r).abs() < 0.01);
        assert_eq!(fade.progress(now + CROSSFADE, true), 1.);
        assert!(!fade.active(now + CROSSFADE, true));
        assert!(fade.retarget(7, now, false));
        assert_eq!((fade.from, fade.to), (7, 7));
        assert_eq!(fade.progress(now, false), 1.);
        assert_eq!(fade.colors(now, false), colors(7));
    }

    #[test]
    fn tokens_keep_cards_translucent_and_text_readable() {
        for index in 0..AMBIENCES.len() {
            let tokens = Tokens::from_colors(&colors(index));
            assert!(tokens.card.a < 0.8 && tokens.card.a > 0.3);
            assert_eq!(tokens.tooltip.a, 1.);
            assert_eq!(tokens.text.a, 1.);
            assert_eq!(tokens.accent, colors(index).accent);
        }
    }
}
