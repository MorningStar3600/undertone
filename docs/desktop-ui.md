# Undertone native player and Windows widget

The native GPUI UI uses warm dark `#100f0e`, card `#1b1917`, amber `#ffbe3d`
controls, Segoe UI, and blue `#8bc0ff` only for confirmed personal Active tags
(and native input selection). No external artwork, fonts, UI framework or new
runtime dependency is introduced. This is a Windows desktop window and widget.

## Layout and provider ownership

Full player is 880 x 680 logical pixels. The widget is 440 x 680 with a provider,
or 440 x 480 without one. Opening a widget detail panel widens the same window to
840 x 680; closing it restores the compact width. Full-player panels occupy the
bounded space below playback. Widget panels occupy a scrolling side column.
Panel navigation, playback and the visible provider remain separate native slots.
All detail contents use native vertical scrolling; forms do not grow window height.

Full provider bounds are `(width - 336, 88, 320, 224)`. Widget provider bounds
are `(12, 278, 416, 224)`, unchanged when its side panel opens. These child-HWND
slots never scroll beneath native content. Switching presentation and opening
panels only move the existing controller with `set_bounds`; they do not allocate
another browser, reload its document, reconnect the room or duplicate sound.
The lazy allocation site still requires a validated YouTube attachment. The
provider activation control stays visible and usable. No native overlay tries
to paint over WebView2.

## Working native flows

-   Join accepts a typed room link and Enter, retaining the empty-field clipboard
    fallback. Disconnect drops the one connection/host and clears native forms,
    private summaries and drafts. The title bar and header use Undertone.
-   Playback, seeking, mute and local volume retain the playback-only host path.
    Transport buttons and sliders explicitly opt into Tab traversal. The root
    handles Tab / Shift+Tab; the independently maintained input handles IME and
    Unicode boundaries. Enter/Space activates focused GPUI buttons.
    Scrolling panels reveal newly focused buttons and text fields. Page Up / Page Down
    scroll the panel while leaving playback in place; ordinary repainting does not
    override manual scrolling. Opening another panel starts at its top.
-   Account has username/email and masked password fields. Submit copies the
    native input into the command and immediately clears its display before
    dispatch. Credentials never enter browser markup, IPC, diagnostics or events.
    Guest, account, pending and expired states are distinct. Only password account
    login is offered. Errors localize HTTPS requirements, 401, 429 and numeric
    Retry-After. Check account and Refresh room are explicit recovery operations.
-   Track moods is available from both modes. It displays contributor priority
    moods and the complement of loaded own tags/favorite shortcuts. Only confirmed
    own Active tags use blue. Unknown tags cannot be toggled until an explicit
    refresh or Load more establishes their state. Tags require the current stable
    catalogue UUID and captured track generation. Guests can inspect public moods
    and see why personal writes need an account. No ID is inferred or imported.
-   First tags, favorites and vocabulary pages load sequentially when needed.
    Search filters loaded vocabulary locally. Load more never drains subsequent
    pages automatically. Failed pages need explicit refresh; failed writes do not
    automatically retry. Successful tag/favorite writes reload their stale first
    page once, including when the user has closed the panel. Creating a named mood
    uses a native selection from the allowed icon keys and performs no tag or
    favorite write. The created row offers those two separate explicit actions.
-   Room preferences are a separate draft: Include, Neutral and Exclude are visible
    buttons, including a keyboard-accessible exclusion action. Defaults, server
    public custom vocabulary and loaded catalogue moods are available. Unknown
    saved IDs remain in the draft and visible until explicitly changed. Save Keep
    and Save Renew are distinct operations with an explanation of Renew. Live
    membership, Music mode and `can.preferences` gate writes. Conflicts/uncertainty
    expose Retry saved intent and Refresh room; no mutation is automatically replayed.
-   Add music previews one URL and displays the real title. Mix and Next are explicit,
    permission-gated actions using the native stored reference; no whole preview
    payload or library checkbox is submitted. Displayed previews have a local
    version, so editing the URL invalidates their actions. New requests receive a
    new ID; native Retry preserves the original request ID and reference.
-   Confirmation renders the authoritative participant names and moods from the
    offer. Its action captures the opaque `ConfirmationOffer` shown at render and
    requires `can.confirm`. Native code rejects replaced offers/revisions. Cancel,
    pending count, explicit pending-page refresh and page navigation support recovery.
    Missing conflict metadata disables confirmation. Other requests remain cancellable.
-   Upcoming uses actual public queue entries and optional supplied artists. The
    expanded Queue panel navigates real native pages. Show/Hide upcoming works in
    both modes and only affects this window. Local Settings stays separate from
    room preferences. No fabricated duration, artwork or inactive management control
    is shown. Legacy/non-Music rooms retain playback and explain collective-control
    restrictions; no room mode or content is changed automatically.

## Native session and authority wiring

`main.rs` owns the one Network/Connection, observer and lazy host. `ui.rs` owns
presentation and bounded geometry. `ui_music.rs` owns forms, localized status,
small projection/action helpers, page admission and preference drafts.
`ui_input.rs` remains the parent's independently reviewed native input.

Each Join subscribes to the native watch channel. Values are cloned before GUI
updates; no watch borrow crosses an await. Every task checks the outer room
generation. GUI deliveries read the current connection snapshot rather than
applying an older queued watch value. Initial RefreshAccount is requested once
per outer Join at a connected safe point, including with a cached account. It is
not retriggered by account-generation changes.

Before consuming any playback message, both event authority values are compared
against current native account/socket authority. Watch and playback paths share
one last-applied pair, so a fresh capability processed before a delayed watch
notification is not reset a second time. Changed authority and connected-false
reset observer, old host/IPC generation, availability and position. Native identity
requests proactively fence/drop the old host before enqueue and wait for fresh
capabilities. A deliberately refused playback send does not permanently disconnect
a login transition.

Rendered controls retain the originating `CommandAuthority`; native input Submit
uses the last rendered form authority. Automatic page decisions capture the
snapshot that produced the decision. Every host retains its creation authority
for all outgoing IPC, surviving track changes while fenced across account/socket
changes. Connection rejects stale commands both at enqueue and dequeue. Confirmation
retains its displayed opaque offer. Browser forwarding and IPC remain playback-only.
Account/socket context changes clear private UI drafts/forms and preview choices;
track changes fence track actions and reset tag-page loading without changing room
preferences. The typed native server API remains authoritative for permissions.

Local admission latches disable repeated actions before a busy snapshot arrives.
State watch delivery is coalesced; an identical refresh result can omit both its
intermediate busy state and a distinguishable completion. A 25-second GUI timeout
releases only the local admission latch and shows an outcome-unknown refresh hint.
It neither marks success nor replays anything; native busy state still gates actions.
Failed identity requests may leave playback fenced until explicit Check account or
Refresh room recovery establishes a fresh socket.

Always-on-top and opacity hacks are omitted; pinned GPUI has no public Windows
topmost setter. Native input memory is not a cryptographic zeroization facility.
Masked-field paste behavior stays with the parent's input implementation.

## Verification

Terminal-only validation builds the embedded host first with
`node scripts/build-desktop-player.mjs`, then uses Cargo `--locked --jobs 2` and
the existing shared target cache. Pure UI tests cover bounded provider/panel
geometry, seeking/progress, input boundaries, partial-page Unknown states, failed
page recovery without pagination draining, preserving unknown draft IDs, stale
account/socket playback and capability-before-watch ordering. Existing native
library and isolated loopback HTTP/WebSocket fixture tests cover typed actions,
credential/session fencing, exact confirmation consent and transport behavior.

No GUI, native app/smoke mode, browser, CUA, audio, existing room, running development
server, database or Redis is used. The root executable is not replaced. Compilation
and pure/fixture tests do not establish visual polish, interactive IME behavior,
provider activation or live YouTube playback; those require a separately authorized
manual check. The host bundle, format check, strict all-target Clippy and native build passed.
The complete Rust suite passed 44 tests; the final focused native binary suite
passed 15 tests after adding the participant-sync regression (45 tests across
these suites). No Cargo dependency or lockfile change was needed.
