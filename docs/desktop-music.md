# Native desktop session/music integration

`desktop/src/session.rs` and `music.rs` are native Rust state and commands. They do
not use the player WebView. Music search and result actions are in `ui_music.rs`;
`main.rs`, `ui.rs` and `ui_widget.rs` are unchanged by the search fix. There are no
provider/server changes or new dependencies. English labels use desktop-en.json.

## Integration API

Keep the existing `Network::connect(generation, address, playback_events)` and
`Connection::send(CommandAuthority, Value)` playback transport. `EventKind` is unchanged. New APIs:

```rust,ignore
use undertone_desktop::session::NativeCommand;
use undertone_desktop::music::{MusicCommand, Content, Intent};

let mut native = connection.subscribe_native(); // tokio::sync::watch::Receiver<NativeState>
let initial = native.borrow_and_update().clone();
// Capture in the originating control/host, not from a newer state at send time.
let authority = initial.authority();
// On the UI executor, without holding the watch borrow across an await:
while native.changed().await.is_ok() {
    let state = native.borrow_and_update().clone();
    // Update native GPUI state only; check state.generation against the mounted room.
}
connection.send_native(authority, NativeCommand::RefreshAccount);
connection.send_native(authority, NativeCommand::Login {
    user: username,
    password, // move out of the UI password input and clear its display immediately
});
connection.send_native(authority, NativeCommand::Music(MusicCommand::Preferences {
    include: selected_include_ids,
    exclude: selected_exclude_ids,
    content: Content::Keep,
}));
connection.send_native(authority, NativeCommand::SearchMusic { input }); // title/artist or URL
// Capture result_authority from the snapshot that rendered the chosen result.
// Never resolve the latest result or manufacture fresh authority on click.
connection.send_native(result_authority, NativeCommand::Music(MusicCommand::RequestPreview {
    request_id: stable_request_id,
    intent: Intent::Next, // reserves upcoming; does not interrupt playback
    reference: displayed_result.reference.clone(),
}));
// On input edits, revoke results even before another query is submitted.
connection.send_native(authority, NativeCommand::InvalidatePreview);
```

`CommandAuthority` is captured from the snapshot that created the host or rendered
control. Pass it unchanged to both send methods. Enqueue and dequeue reject a
different room/account/socket; result admission also rejects a different query/result
generation, and tag actions reject a different track generation,
even A -> B -> A. Playback hosts may survive track changes, but never identity or
socket changes. Do not manufacture fresh authority when an old callback fires.

`send_native` returns queue admission, not server success. The native inbox holds
eight commands; check false and keep input for explicit retry. State is a bounded,
coalesced watch snapshot, not an event history. Consume `NativeState.error`,
`http_busy`, `room.busy`, `room.status`, and `room.retry_available`. Never infer
success from a true send return. Disable HTTP controls while `http_busy`; concurrent
operations return Busy. A new music query or input edit cancels only pending search
work. Login/logout can supersede account reads/tag/search work, but an
in-flight login/logout cannot be superseded by another identity operation.

`NativeState.can()` returns preferences/add_mix/add_next/settings/confirm/account_write.
Use it together with the busy fields; native code independently checks permissions.
All error/status enum variants need localized labels from the UI-owned locale file.
No UI strings, icons, artwork or fabricated durations are supplied here.

Native commands (all fixed routes, no raw JSON/URL API):

| Command                                             | Result/state                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Login { user, password }, Logout, RefreshAccount    | AccountState, account_generation; fresh same-token socket on success                       |
| RefreshRoom                                         | Explicit same-token reconnect for full sync; socket_generation increments                  |
| LoadMoods { offset }, LoadFavorites { offset }      | moods/favorites pages (100 per HTTP page)                                                  |
| LoadTrackMoods { track_id, offset }                 | tags page, only for the current catalogue track UUID                                       |
| SetTag { track_id, mood_id, active }                | PUT/DELETE own tag; marks tags stale on success                                            |
| SetFavorite { mood_id, active }                     | PUT/DELETE own shortcut; marks favorites stale                                             |
| CreateMood { name, icon_key }                       | created_mood and stale vocabulary; no implicit tag/favorite                                |
| SearchMusic { input }                               | preview.items: up to ten results with title and stable reference; preview.truncated marks the cap |
| InvalidatePreview                                   | Revokes result authority and cancels pending search on input edits                         |
| Music(Preferences { include, exclude, content })    | Own room preferences, up to 100 UUIDs each, disjoint                                       |
| Music(Settings(Settings { ... }))                   | Only fair_share/auto_admit_on_join/remove_departed_entries options                         |
| Music(RequestPreview { request_id, intent, reference }) | Requires the displayed result's authority and exact stored reference; no implicit library addition |
| Music(Confirm(offer))                               | Exact displayed offer handle from room.confirmation_offer(); rejects replacement           |
| Music(Cancel { request_id })                        | Cancel own pending/reserved request                                                        |
| Music(Queue { offset }), Music(Requests { offset }) | Separate queue/pending-only pages, 25 entries                                              |
| Music(Retry)                                        | Explicit replay of saved intent with fresh correlation/revision, same request ID/reference |

After a successful tag/favorite mutation explicitly reload its page at offset zero.
For HTTP Load more use `page.next_offset()` only when `page.has_more()`. HTTP pages
append contiguously up to offset 10000; refresh starts at zero. Search only loaded
`moods.items` locally; `/moods` has no search parameter. Pages expose loaded,
loading, failed, stale, total, offset, limit, complete(), has_more(), next_offset().
Room queue/request pages replace their visible slice; request another offset to
navigate. `room.pending_count` is distinct from the visible slice length.

`state.mood_groups()` gives priority contributor moods and complement (own loaded
tags union loaded favorites minus priority). A chip is Active only for a confirmed
own tag, Inactive only when all own tags are known, otherwise Unknown. Shared
defaults/custom rule vocabulary is available through `room.public_moods()` even to
guests. Tags, favorites and room include/exclude choices are independent.

## Socket refresh and player integration

Identity is `you.info.id`; `user` updates are projected into a bounded 1024-client
map, including updates before `you`. Own participant membership requires that
participant's `clientIds` contain this exact ID. Partial sync merges by field
presence: omitted music remains; explicit null clears it. Only known native DTO
fields are retained, including at most ten public queue entries plus queueTotal.
Legacy currentSource contributes only a catalogue track UUID. Without one,
annotation controls must display unavailable; no import is attempted.

**UI integration requirement:** observe account_generation/socket_generation
changes and reset the player observer/host subscription lifecycle when the socket
changes. Fresh capabilities arrive through the unchanged playback EventKind path;
subscribe with a fresh nonce/snapshot before accepting fresh playback authority.
Native refresh does not synthesize a player snapshot, host or browser. The UI owns
generation filtering and discarding playback events already queued before a
refresh. Network playback events carry `Event.authority = Some((account_generation,
socket_generation))`; reject mismatches against the current native state before
processing them. Local captured-host IPC uses `None`. Outbound playback messages
retain their caller-captured authority and reject replacement at enqueue and dequeue;
identity transitions disable playback transport until fresh socket authority.
Dropping Connection aborts its socket and HTTP future. Network owns one
active room; connecting another aborts the previous connection.

`RefreshRoom` is refused while HTTP is busy. It drops old correlations and keeps
only a music retry intent (never automatically replays it). Login/logout/account
refresh fences private caches and old commands immediately when processed. HTTP
work and queued commands capture account generation; tag work additionally captures
track generation/UUID, so replacement and A→B→A cannot restore an old completion.
Music correlations include outer, socket and account generations. Pages older
than the highest sync/result revision are rejected. Any sync or result that advances
the revision invalidates older pages and confirmation offers before installing its
own response data; a later equal-revision sync cannot refresh old consent. Only one music command is
pending at once; after 20 seconds mutation outcome is Uncertain, with explicit
retry. RevisionConflict, SlotConflict, RequestConflict, SourceUnavailable,
InvalidConfirmation, Rejected and NotFound remain distinct; no automatic replay.

`Confirm(offer)` requires the opaque handle from `room.confirmation_offer()` captured
when rendering the confirmation. Retain it in the callback; never resolve the latest
offer on click or at dequeue. It binds revision, request, entry, track, intent and
exact conflict pairs. A changed offer returns InvalidConfirmation and requires fresh
consent. Missing authoritative participant names or mood details disables it.
New server conflicts replace the previous offer. After
a newer public revision, explicitly reload pending requests before confirming.
If that page has several offers, this scoped API exposes its first pending
conflicted request; other requests remain visible/cancellable by ID.

## Credential and permission boundaries

Network retains at most one origin/base-path bearer session, in memory only,
across room reconnects. Switching base path/origin discards it. Login upgrades the
same token; logout uses that token and obtains fresh account/public identity. GET
user is explicit on initial Join (so the UI should request RefreshAccount once).
There is no cookie jar, persistence, CLI/config token, Discord/OAuth handoff or
credential-bearing Debug/Serialize implementation. Password input is moved into
the request builder and dropped after request preparation; memory is not claimed
to be cryptographically zeroized. Remote password login requires HTTPS; literal
loopback IPs and localhost permit HTTP for development.

REST 401 clears private state, fences native writes, and invalidates the cached
credential for the next explicit Join. A failed login also fences until explicit
account revalidation/Join. Errors expose only an enum and numeric Retry-After
seconds (429), never response bodies/URLs. REST uses a ten-second timeout, disabled
redirects/proxies, fixed same-server paths and 256 KiB response bound. WebSocket
frame/message bounds, playback send rate/queue bounds, captured host overflow
flags and lazy browser ownership are preserved. `bridge::forwarded`,
`allowed_outbound` and `parse_ipc` are unchanged and playback-only.

Guests can set room preferences and request music with live membership/add/order
grants; personal API calls require a validated logged-in account. Existing rooms
are never cleared or migrated automatically. Mode enablement, replan/remove-entry
controls, arbitrary provider selection, OAuth, personal library management and
automatic pagination are outside this scoped API.

## Native music search

The Add music panel accepts a title/artist query or URL through the existing
`GET /api/data/previewAdd?input=...` API. The server chooses its configured search
provider; native code never invokes a provider directly. Input is trimmed, bounded
to 2048 bytes and rejects control characters. Existing response/time limits apply.
The first ten results are retained, in server order. Each row has its own Mix and
Next actions; no first result, highlighted result or entire collection is admitted
implicitly. Empty results have an explicit localized message; failures retain only
the existing sanitized error and Retry-After. Unsupported/disabled provider search
is reported through that existing error path.

`originalReference` takes precedence over playback service/id (including adapter
aliases and expiring stream URLs). For compatible older responses without it,
service/id remains the fallback. An invalid supplied original reference fails the
response rather than silently choosing playback metadata. Selection binds the
exact reference plus the query generation captured by `CommandAuthority`. A new
query, input edit, room/grant loss, disconnect or account transition revokes older
result authority. Queued old choices fail again at dequeue; delayed HTTP work is
cancelled and generation checked before application. A rejected busy operation
cannot leave an otherwise successful search marked failed.

Music-only membership and live add/order grants remain required for both search
and admission. A legacy room keeps the existing clear Music-room requirement;
search never converts the room or changes its queue mode. Generate a fresh request
ID for each explicit choice; the existing explicit retry retains that choice's
request ID/reference and permission checks.

## Verification

No-default-features library and isolated ephemeral loopback HTTP/WebSocket
fixtures cover token retention/login/logout/401/429,
redaction, partial sync/identity ordering, guest/account routes and grants,
correlations/revisions/uncertainty, exact confirmation, stable original preview
references, title/artist queries, multiple per-result selections, query/edit/room/
account fencing, empty/failure/busy recovery, bounded results, partial-page unknown
tags and replacement-track completion fencing.
Existing playback bridge/IPC/transport tests remain applicable. No native GUI,
browser, audio, running development service, database, Redis or real credential
has been touched. Native compilation is checked separately when generated player
assets and the Windows toolchain are available; parent independent review remains required.

## Floating widget integration

The separate native widget observes the existing Player owner. Its quick tag
callbacks retain the rendered CommandAuthority, track UUID and track generation
and route through the same music_action/SetTag guards; Unknown tags cannot write.
Opening the widget admits only bounded initial mood/favorite/vocabulary pages,
with the same failure and explicit Load more policy as the main panel. Personal
Active coloring requires a validated signed-in account. Add, See queue, Settings
and mood-picker actions restore the corresponding main panel; no forms, account
state, connection, observer or provider are duplicated. Current artwork uses only
the atomic playback attachment YouTube ID, not an HTTP/music payload URL. Public
thumbnail work receives no session client or credentials and is fenced on current
room/account/socket/track replacement. See [native UI](desktop-ui.md).
