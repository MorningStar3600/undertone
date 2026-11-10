# Native desktop session/music integration

`desktop/src/session.rs` and `music.rs` are native Rust state and commands. They do
not use the player WebView. `main.rs` is deliberately unchanged for the UI owner.
There are no server/common/client changes or new dependencies.

## Integration API

Keep the existing `Network::connect(generation, address, playback_events)` and
`Connection::send(Value)` playback transport. `EventKind` is unchanged. New APIs:

```rust,ignore
use undertone_desktop::session::NativeCommand;
use undertone_desktop::music::{MusicCommand, Content, Intent};

let mut native = connection.subscribe_native(); // tokio::sync::watch::Receiver<NativeState>
let initial = native.borrow_and_update().clone();
// On the UI executor, without holding the watch borrow across an await:
while native.changed().await.is_ok() {
    let state = native.borrow_and_update().clone();
    // Update native GPUI state only; check state.generation against the mounted room.
}
connection.send_native(NativeCommand::RefreshAccount);
connection.send_native(NativeCommand::Login {
    user: username,
    password, // move out of the UI password input and clear its display immediately
});
connection.send_native(NativeCommand::Music(MusicCommand::Preferences {
    include: selected_include_ids,
    exclude: selected_exclude_ids,
    content: Content::Keep,
}));
connection.send_native(NativeCommand::PreviewUrl { url });
// Only after successful preview and an explicit user action. Generate a fresh ID
// per new intent; retain the ID if offering that same intent after a new Join.
connection.send_native(NativeCommand::Music(MusicCommand::RequestPreview {
    request_id: stable_request_id,
    intent: Intent::Next, // reserves upcoming; does not interrupt playback
}));
```

`send_native` returns queue admission, not server success. The native inbox holds
eight commands; check false and keep input for explicit retry. State is a bounded,
coalesced watch snapshot, not an event history. Consume `NativeState.error`,
`http_busy`, `room.busy`, `room.status`, and `room.retry_available`. Never infer
success from a true send return. Disable HTTP controls while `http_busy`; concurrent
operations return Busy. Login/logout can supersede account reads/tag work, but an
in-flight login/logout cannot be superseded by another identity operation.

`NativeState.can()` returns preferences/add_mix/add_next/settings/confirm/account_write.
Use it together with the busy fields; native code independently checks permissions.
All error/status enum variants need localized labels from the UI-owned locale file.
No UI strings, icons, artwork or fabricated durations are supplied here.

Native commands (all fixed routes, no raw JSON/URL API):

| Command | Result/state |
| --- | --- |
| Login { user, password }, Logout, RefreshAccount | AccountState, account_generation; fresh same-token socket on success |
| RefreshRoom | Explicit same-token reconnect for full sync; socket_generation increments |
| LoadMoods { offset }, LoadFavorites { offset } | moods/favorites pages (100 per HTTP page) |
| LoadTrackMoods { track_id, offset } | tags page, only for the current catalogue track UUID |
| SetTag { track_id, mood_id, active } | PUT/DELETE own tag; marks tags stale on success |
| SetFavorite { mood_id, active } | PUT/DELETE own shortcut; marks favorites stale |
| CreateMood { name, icon_key } | created_mood and stale vocabulary; no implicit tag/favorite |
| PreviewUrl { url } | One preview with title and stable reference; multiple results rejected |
| Music(Preferences { include, exclude, content }) | Own room preferences, up to 100 UUIDs each, disjoint |
| Music(Settings(Settings { ... })) | Only fair_share/auto_admit_on_join/remove_departed_entries options |
| Music(RequestPreview { request_id, intent }) | Uses the stored preview; no implicit library addition |
| Music(Confirm) | Exact latest server-offered pairs, track ID and request ID |
| Music(Cancel { request_id }) | Cancel own pending/reserved request |
| Music(Queue { offset }), Music(Requests { offset }) | Separate queue/pending-only pages, 25 entries |
| Music(Retry) | Explicit replay of saved intent with fresh correlation/revision, same request ID/reference |

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
refresh. Dropping Connection aborts its socket and HTTP future. Network owns one
active room; connecting another aborts the previous connection.

`RefreshRoom` is refused while HTTP is busy. It drops old correlations and keeps
only a music retry intent (never automatically replays it). Login/logout/account
refresh fences private caches and old commands immediately when processed. HTTP
work and queued commands capture account generation; tag work additionally captures
track generation/UUID, so replacement and A→B→A cannot restore an old completion.
Music correlations include outer, socket and account generations. Pages older
than the highest sync/result revision are rejected. Only one music command is
pending at once; after 20 seconds mutation outcome is Uncertain, with explicit
retry. RevisionConflict, SlotConflict, RequestConflict, SourceUnavailable,
InvalidConfirmation, Rejected and NotFound remain distinct; no automatic replay.

`Confirm` has no caller-supplied pairs. Missing authoritative participant names or
mood details disables it. New server conflicts replace the previous offer. After
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

## Verification

Only no-default-features library and isolated ephemeral loopback HTTP/WebSocket
fixtures are used. Coverage includes token retention/login/logout/401/429,
redaction, partial sync/identity ordering, guest/account routes and grants,
correlations/revisions/uncertainty, exact confirmation, stable original preview
references, partial-page unknown tags and replacement-track completion fencing.
Existing playback bridge/IPC/transport tests remain applicable. No native GUI,
browser, audio, running development service, database, Redis or real credential
has been touched. Parent review and native UI wiring/build remain required.
