pub mod bridge;
pub mod connection;

use std::{collections::HashMap, sync::LazyLock};

static STRINGS: LazyLock<HashMap<String, String>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../client/src/locales/desktop-en.json"))
        .expect("valid desktop English strings")
});

pub fn text(key: &str) -> String {
    STRINGS.get(key).cloned().unwrap_or_else(|| key.to_owned())
}
