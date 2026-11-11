//! Small local preferences: where the widget was, whether it was folded, and the animation
//! setting. One bounded JSON file in the user's application data folder; nothing about rooms,
//! accounts or tracks is ever written.
use crate::ambience::MotionPreference;
use serde::{Deserialize, Serialize};
use std::{
    io,
    path::{Path, PathBuf},
};

const MAX_BYTES: u64 = 16 * 1024;

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Prefs {
    pub widget: Option<WidgetPlacement>,
    pub motion: MotionPreference,
}

/// Top-left corner of the widget in logical screen pixels.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WidgetPlacement {
    pub x: f32,
    pub y: f32,
    pub folded: bool,
}

/// `%APPDATA%\Undertone\desktop.json`, or nothing (session-only) when unknown.
pub fn default_path() -> Option<PathBuf> {
    std::env::var_os("APPDATA")
        .filter(|dir| !dir.is_empty())
        .map(|dir| PathBuf::from(dir).join("Undertone").join("desktop.json"))
}

/// Missing, oversized or unreadable files give the defaults.
pub fn load(path: &Path) -> Prefs {
    std::fs::metadata(path)
        .ok()
        .filter(|meta| meta.len() <= MAX_BYTES)
        .and_then(|_| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice::<Prefs>(&bytes).ok())
        .map(Prefs::sanitized)
        .unwrap_or_default()
}

/// Written next to the target, then renamed, so a crash never leaves half a file.
pub fn save(path: &Path, prefs: &Prefs) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, serde_json::to_vec_pretty(prefs)?)?;
    std::fs::rename(&temporary, path)
}

impl Prefs {
    fn sanitized(mut self) -> Self {
        if self.widget.is_some_and(|w| {
            !w.x.is_finite() || !w.y.is_finite() || w.x.abs() > 1e6 || w.y.abs() > 1e6
        }) {
            self.widget = None;
        }
        self
    }
}

/// A display's work area in logical pixels: `(x, y, width, height)`.
pub type Area = (f32, f32, f32, f32);

/// Where to reopen a window of `size` last seen at `origin`: the display it overlaps most (or
/// the nearest one), with the window moved fully inside it. Returns the display index and the
/// clamped origin, or `None` when there is no display.
pub fn clamp_origin(
    origin: (f32, f32),
    size: (f32, f32),
    displays: &[Area],
) -> Option<(usize, (f32, f32))> {
    let overlap = |&(x, y, w, h): &Area| {
        let dx = (origin.0 + size.0).min(x + w) - origin.0.max(x);
        let dy = (origin.1 + size.1).min(y + h) - origin.1.max(y);
        dx.max(0.) * dy.max(0.)
    };
    let distance = |&(x, y, w, h): &Area| {
        let cx = origin.0 + size.0 / 2.;
        let cy = origin.1 + size.1 / 2.;
        let dx = (x - cx).max(cx - (x + w)).max(0.);
        let dy = (y - cy).max(cy - (y + h)).max(0.);
        dx.hypot(dy)
    };
    let index = displays
        .iter()
        .enumerate()
        .max_by(|(_, a), (_, b)| overlap(a).total_cmp(&overlap(b)))
        .filter(|(_, area)| overlap(area) > 0.)
        .or_else(|| {
            displays
                .iter()
                .enumerate()
                .min_by(|(_, a), (_, b)| distance(a).total_cmp(&distance(b)))
        })?
        .0;
    let (x, y, w, h) = displays[index];
    let clamp = |value: f32, start: f32, extent: f32, size: f32| {
        value.min(start + extent - size).max(start)
    };
    Some((
        index,
        (clamp(origin.0, x, w, size.0), clamp(origin.1, y, h, size.1)),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn widget_positions_are_clamped_onto_a_display() {
        let displays = [(0., 0., 1920., 1080.), (1920., 0., 1280., 1024.)];
        // Inside: unchanged.
        assert_eq!(
            clamp_origin((100., 200.), (410., 620.), &displays),
            Some((0, (100., 200.)))
        );
        // Straddling: the display with the larger share, fully inside it.
        assert_eq!(
            clamp_origin((1800., 500.), (410., 620.), &displays),
            Some((1, (1920., 404.)))
        );
        // A display that disappeared: the nearest one.
        assert_eq!(
            clamp_origin((-3000., 100.), (410., 620.), &displays),
            Some((0, (0., 100.)))
        );
        assert_eq!(clamp_origin((0., 0.), (10., 10.), &[]), None);
    }

    #[test]
    fn preferences_round_trip_and_reject_damaged_files() {
        let dir = std::env::temp_dir().join(format!("undertone-prefs-{}", std::process::id()));
        let path = dir.join("desktop.json");
        let prefs = Prefs {
            widget: Some(WidgetPlacement {
                x: 12.5,
                y: -40.,
                folded: true,
            }),
            motion: MotionPreference::Off,
        };
        save(&path, &prefs).unwrap();
        assert_eq!(load(&path), prefs);
        std::fs::write(&path, b"{not json").unwrap();
        assert_eq!(load(&path), Prefs::default());
        std::fs::write(&path, br#"{"widget":{"x":1e30,"y":0},"motion":"on"}"#).unwrap();
        assert_eq!(
            load(&path),
            Prefs {
                widget: None,
                motion: MotionPreference::On
            }
        );
        std::fs::write(&path, vec![b' '; MAX_BYTES as usize + 1]).unwrap();
        assert_eq!(load(&path), Prefs::default());
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(load(&path), Prefs::default());
    }
}
