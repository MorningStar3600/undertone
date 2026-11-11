# Undertone native player and Windows widget

The native GPUI UI uses warm dark `#100f0e`, card `#1b1917`, amber `#ffbe3d`
controls, Segoe UI, and blue `#8bc0ff` only for confirmed personal Active tags
(and native input selection). Soft red `#f0957c` marks exclusions and errors.
English UI strings live in desktop-en.json. Tokens, glyphs, cards, banners,
progress/volume tracks and slider hit-testing are shared by both windows (ui.rs).

## Main window composition

The 880 x 680 player is organised around five short journeys: join, listen,
tag a mood, search and add, and switch to the widget and back.

-   Disconnected: a single centred card (title, one sentence, room-link field with
    an amber Join button, link/clipboard hint, failure banner). No disabled player.
-   Top bar (52 px): Undertone mark, a room pill (live dot, room name, authoritative
    listener count, quiet Refresh room icon), then Add music (amber pill), the
    account pill (username or Sign in), Settings, Widget toggle and Leave room.
-   Left column, no panel open: the current-track card (128 px artwork, NOW PLAYING
    eyebrow, two-line title, artist, Added by contributor, measured seek bar,
    volume icon + measured slider, centred previous/play/next), the
    "My moods on this track" one-click chip strip (your moods first, then the
    contributor's suggestions, with All moods), and the status line with banners
    that appear only when something needs attention.
-   Left column, panel open: a compact track strip (artwork, title, transport) stays
    above one panel card. Moods has two tabs, This track and Room preferences.
-   Right column (320 px): the lazily created YouTube provider at the top, then the
    upcoming list (See queue) and a full-width Add a track button.

Panels: Account (avatar, state, sign-in form or sign out), Moods (contributor
suggestions, your moods and favorites, search, create with all nine icons),
Room preferences (Include / Any / Exclude per mood, Save / Save & renew /
Discard bar outside the scroll area), Add music (search field + Search, results
with provider and duration when the server supplies them, Add to mix / Play next
with explanatory tooltips, highlighted confirmation card, pending requests only
when there are any), Queue (numbered rows, pagination only when needed) and
Settings (this device: upcoming visibility, widget, leave room).
Page states for moods appear only when a page failed, is not loaded or has more
entries. Mood chips: the body toggles your tag, the heart toggles the favorite.
Search results reuse the embedded artwork glyph: result thumbnails are not fetched.

## Separate windows and provider ownership

The full player stays 880 x 680 logical pixels. **Widget** toggles one separate
410 x 661 native GPUI top-level window. Its 20 px rounded card follows the supplied
widget reference: 52 px draggable header (Add, pin, Settings, minimize, close),
20 px content padding, 94 px current artwork, title/artist, progress, local volume,
centred transport, mood chips, two upcoming rows, one Add a track button and a quiet
status footer with a Quit icon. Outside a room it shows only "Not in a room" and an
Open Undertone action. There is no video block in the widget. Missing artists, contributor names, durations and images are never invented.
Current contributor names are shown only when authoritative participant metadata
is available. Queue DTOs supply no provider video ID/art URL or duration, so queue
rows use the embedded Undertone artwork and omit duration. Open room, Add a track,
See queue, Settings and All moods restore the main window and open (never toggle
shut) the matching panel.
Quick tags remain in the widget and capture account/session/track authority; only
confirmed own Active tags appear blue. Unknown tags stay disabled.

The pin defaults on. Pinned GPUI 0.2.2's Windows implementation does not implement
Floating as topmost: its normal creation path only sets WS_EX_APPWINDOW. The small
native_window.rs wrapper instead borrows this window's raw-window-handle on the
UI thread and calls SetWindowPos(HWND_TOPMOST/HWND_NOTOPMOST) with SWP_NOACTIVATE,
SWP_NOMOVE, SWP_NOSIZE and SWP_NOOWNERZORDER. It never retains an HWND or changes
another process's windows. Failure is localized in the widget footer. Pin and
ordinary state/art/progress updates never activate a window. The custom header's
GPUI WindowControlArea::Drag maps to native Windows HTCAPTION for moving it.
This is a floating desktop window, not the Windows 11 Widgets feed. Other topmost
windows, exclusive fullscreen and the secure desktop are subject to Windows rules.

Closing the widget leaves the player and playback alone. Closing the main window
while a widget exists minimizes the main window, preserving its owner and provider;
its taskbar button remains available. Open room and Quit Undertone are explicit
widget actions. With no widget, closing the main window exits as before. Minimizing
either window never disposes playback. No hidden owner or tray-only orphan is created.

Player owns the only Network/Connection, observer and lazy WebView2, in the main
window. Widget holds a weak Player entity and a typed main WindowHandle, observes
notifications, and defers captured commands back to that owner. It never renders
Player in a second window, clones forms/focus handles or allocates a browser.
Opening is deferred outside Player's mutable entity lease because GPUI draws a
new window synchronously; a pending-open guard prevents duplicate windows.
The main provider sits at the top of the right column, (width - 336, 68, 320, 224)
(YouTube's 200 x 200 minimum is respected), never over the left column or panels. Widget lifecycle and pin changes neither reconnect the
room nor recreate/reparent the iframe or duplicate sound. YouTube's activation
button remains accessible in the main player, with its status hint in the widget.

## Current-track artwork

Only the exact YouTube ID from a validated atomic protocol attachment can construct
https://i.ytimg.com/vi/ID/hqdefault.jpg. Arbitrary artwork URLs, credentials, paths
and browser input are not accepted. A separate credential-free reqwest client uses
the existing Tokio runtime, HTTPS only, no proxies/redirects, a 3 s connect timeout
and 5 s total request timeout. Bodies are capped at 512 KiB even with chunked HTTP.
Decoding accepts JPEG/PNG still images only, at most 1024 x 1024 with an 8 MiB
best-effort decoder allocation budget, then bounds the displayed image to 480 x 480.
The four-entry in-memory cache includes misses. There is no disk cache, remote
GPUI img URL, new HTTP client inside GPUI, animation, SVG decode or browser fetch.
One decoded GPUI RenderImage is shared by the main and widget artwork slots.
Absent, loading, rejected and unavailable artwork use the embedded Undertone glyph.
A replacement request aborts HTTP. Monotonic atomic playback-source selection fences
track completions, including A -> B -> A; fresh native account/socket/room authority
is checked again on delivery. Clear, disconnect, authority fencing and atomic
playback-source replacement clear displayed art. Catalogue sync ordering does not
replace playback-source authority or invalidate a newer matching source thumbnail.
Only cached dependencies were promoted to direct dependencies (image,
raw-window-handle and windows); the lockfile adds no package versions.

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
-   Track moods is available from the player and widget. It displays contributor priority
    moods and the complement of loaded own tags/favorite shortcuts. Only confirmed
    own Active tags use blue. Unknown tags cannot be toggled until an explicit
    refresh or Load more establishes their state. Tags require the current stable
    catalogue UUID and captured track generation. Guests can inspect public moods
    and see why personal writes need an account. No ID is inferred or imported.
-   First tags, favorites and vocabulary pages load sequentially, once, while a mood
    surface is visible (main mood strip, Moods/Room preferences, or the widget).
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
    expanded Queue panel navigates real native pages. Settings can hide upcoming tracks. The widget retains its two-row peek. Local Settings stays separate from
    room preferences. Unavailable metadata is omitted; embedded artwork is used when needed. Legacy/non-Music rooms retain playback and explain collective-control
    restrictions; no room mode or content is changed automatically.

## Native session and authority wiring

`main.rs` owns the one Network/Connection, observer and lazy host. `ui.rs` owns
main presentation and bounded geometry. ui_widget.rs owns the independent widget and routed controls. artwork.rs owns bounded public thumbnails. `ui_music.rs` owns forms, localized status,
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

The widget pin uses the narrowly scoped native Windows wrapper described above.
Opacity customization is omitted. Native input memory is not a cryptographic zeroization facility.
Masked-field paste behavior stays with the parent's input implementation.

## Verification

Terminal-only validation builds the embedded host first with
`node scripts/build-desktop-player.mjs`, then uses Cargo `--locked --jobs 2` and
the existing shared target cache. Pure UI tests cover bounded main-provider
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
Check results for this change are recorded in the implementation handoff. No GUI
was launched: actual z-order, screenshot fidelity, minimize/restore behavior and
continued live playback while minimized require a separate interactive check.
