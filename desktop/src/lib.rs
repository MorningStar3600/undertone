pub mod ambience;
pub mod artwork;
pub mod bridge;
pub mod connection;
pub mod music;
pub mod prefs;
pub mod session;

use std::{collections::HashMap, sync::LazyLock};

static STRINGS: LazyLock<HashMap<String, String>> = LazyLock::new(|| {
    let mut strings: HashMap<String, String> =
        serde_json::from_str(include_str!("../../client/src/locales/desktop-en.json"))
            .expect("valid desktop English strings");
    // Desktop-only strings not yet in the shared locale file; the shared file wins.
    let local: HashMap<String, String> =
        serde_json::from_str(include_str!("strings-en.json")).expect("valid desktop strings");
    for (key, value) in local {
        strings.entry(key).or_insert(value);
    }
    strings
});

pub fn text(key: &str) -> String {
    STRINGS.get(key).cloned().unwrap_or_else(|| key.to_owned())
}
