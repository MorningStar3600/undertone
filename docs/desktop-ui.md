# Undertone native player and Windows widget

The native GPUI presentation follows the existing Windows widget design reference
(`node_modules/.cache/undertone-widget-design/widget.html`), without its demonstration
tracks, images or actions. Both sizes use warm dark surfaces, amber playback controls,
Segoe UI, 8/12/16/24 spacing, round transport buttons, 12 px cards, quiet borders and
neutral record artwork. Blue is reserved for account-owned personal mood summaries
and native input selection/composition. No external fonts, artwork requests, animation,
UI framework or additional dependencies were added.

## Working controls

- **Widget / Full player** changes the size and native composition of the same window.
  The room connection, player, volume and browser controller are retained. Full mode
  places the provider next to the now-playing card; the widget stacks it below the
  controls. The widget becomes shorter without a provider. Window sizes are bounded
  presets rather than an arbitrarily resizable layout.
- **Join room** accepts the native room-link field; Enter in the field also joins. An
  empty field keeps the original clipboard-join fallback. Room URL validation remains
  in `RoomAddress`. Disconnect releases the existing connection and provider.
- The circular primary control submits play/pause. Previous/next use the same timeline
  command path. Controls remain disabled without an available host/session. The server
  retains permission enforcement; no new playback IPC messages were introduced.
- Progress displays the host's actual position, without an extra native clock. Clicking
  the bar seeks only when controls are available and duration is known and finite.
  Focus the bar and press Left/Right for a bounded ten-second seek.
- Mute, volume buttons and the volume bar affect this device. Volume-bar Left/Right
  changes volume by five; pointer input uses measured native element bounds. Raising
  volume unmutes. Unmuting at zero restores the default volume of 50.
- The app explicitly routes Tab/Shift+Tab through GPUI's focus traversal, with enabled
  controls and input focus handles registered as tab stops. GPUI supplies Enter/Space
  button activation. Icons are small embedded
  SVGs with localized tooltips; the join, disconnect and mode controls also have labels.

Empty rooms and disconnected states have a native now-playing card instead of a black
video placeholder. Connected states contain no CLI instructions. Playback failures and
room rejections use human-readable English text. Successful commands do not create a
persistent success notice.

## Provider lifecycle and limits

The single lazy WebView allocation still requires an observed, validated YouTube source.
Full mode keeps a 320 × 224 provider surface; the widget keeps a 400 × 224 surface.
Changing size moves that controller with `set_bounds`; it does not hide the iframe,
load a new document, reconnect the socket or recreate audio. The local **Enable playback
on this device** DOM control remains present and usable when activation is required.
Only its CSS changed. The local activation and IPC overflow protections from `10185d90`
remain intact. No audio-only, resolution-selection or successful live playback claim
is made.

Always-on-top is omitted: pinned GPUI 0.2.2 has no public Windows topmost setter. This
implementation does not add platform-specific window manipulation or replace the normal
window with a popup. The widget is a compact Windows window, not a mobile implementation.

## Native integration seams

`desktop/src/ui.rs` owns presentation; `main.rs` retains the existing lifecycle and
command routing. The parent integration can populate these fields from its typed,
validated native events, then call `sync_layout(window)` and `cx.notify()`:

- `Player.details: ui::TrackDetails`: optional artist, aggregate `tags`, and optional
  `personal_tags`. `personal_tags` must only be `Some` after resolving the authenticated
  account's own tags for the current track. It uses blue chips labelled **Your moods**;
  otherwise aggregate tags use neutral chips labelled **Track moods**. A guest is never
  assigned fabricated personal tags. Source changes clear current track details.
- `Player.room_preferences: ui::RoomPreferences`: separate `include` and `exclude`
  summaries, with distinct labels. These are not personal track tags.
- `Player.up_next: Vec<ui::UpcomingTrack>`: title and optional artist. Only supplied data
  is shown, up to two entries in full mode. A header control toggles visibility when
  entries exist. Disconnect clears metadata and queue summaries.

These summaries are read-only. Add/login/mood mutations and their permission checks
remain with the parent's typed native integration. No speculative HTTP contract,
authentication path, fake management control or additional IPC was added.

`desktop/src/ui_input.rs` provides `NativeInput::new(localized_placeholder, masked, cx)`
for room links and future add/login/create-mood forms. Use `value()` for an in-memory
native submit, `clear(cx)` after handling sensitive values, and subscribe to the
payload-free `InputEvent::{Changed, Submit}` using `cx.subscribe_in`. It implements
`Focusable` and GPUI's `EntityInputHandler`, including UTF-16 range conversion, marked
composition, IME candidate bounds, selection, mouse placement, horizontal scrolling,
Home/End, Delete/Backspace and Ctrl+A. Inputs are single-line and bounded to 8192 UTF-8
bytes. Left/Right deletion moves by Unicode scalar boundaries. Enter does not submit
during an active IME composition.
Text edits invalidate cached shaping before the next pointer event, and incoming
hit-test indices are clamped to current UTF-8 character boundaries.

Masked fields paint bullets and return masked text to native text-range queries; they
reject clipboard paste. No field exports values to the clipboard. Ordinary fields
support Ctrl+V. Values are ordinary native in-memory strings, without persistence or
logging; this is not a secure-memory/zeroization facility. Password form wiring must
keep credentials in the native API path, never the playback WebView or its IPC.

## Verification

Terminal-only checks use `node scripts/build-desktop-player.mjs` first, then Cargo with
`--locked --jobs 2`. Native tests cover safe seeking, bounded progress, provider bounds
in both modes, time formatting, Unicode/UTF-16 mapping, input size limits and masked
password presentation. Existing offline bridge and transport tests cover source fencing,
strict message validation, bounded IPC overflow and fixture-based guest connections.

For this implementation, the embedded-host bundle, `cargo fmt --check`, strict
`cargo clippy --all-targets -- -D warnings`, and `cargo build` passed. All 19 Rust tests
and all 9 existing mocked desktop host/adapter tests passed. Cargo used two jobs and
the previously built target cache; no Cargo dependency or lockfile change was needed.

No GUI, browser, CUA, clipboard automation, audible playback or existing-room operations
were used for this implementation. The binary was not launched, including smoke mode.
Compilation and pure/fixture tests do not establish visual layout quality, interactive
IME behavior or live YouTube playback; those still require a separate authorized manual
verification session.
