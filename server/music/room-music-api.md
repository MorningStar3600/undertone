# Music Room integration contract

This implements the Room/protocol/storage portion of `docs/undertone-spec.md` on the
catalogue and scheduler foundations. Run the normal Sequelize migrations, including
`20261109200000-create-music-rooms.js`, before enabling `QueueMode.Music` (`"music"`).
No provider cache is imported into a personal library. No frontend view is added by this lot.

## UI and wire interfaces

Use the existing `OttRoomConnection` through `useRoomApi(connection)`:

```ts
const api = useRoomApi(connection);
// Command inputs use MusicRoomActionInput; parsed server commands use MusicRoomAction.
const unsubscribe = api.onMusicResult(result => {
    // Match result.correlationId; refresh expectedRevision from sync/result.
});
api.music({
    action: "request",
    expectedRevision: store.state.room.music!.revision,
    correlationId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    reference: { service: "youtube", id: "provider-id" },
    extras: { startAt: 12, endAt: 120, subtitleUrl: "https://example.org/subs.vtt" },
    intent: "next",
});
// Dispose the listener when the view/composable is disposed.
unsubscribe();
```

This sends `{ action: "req", request: { type: 20, command } }` over the existing OTT
connection. `RoomRequestType` values 0–19 are unchanged; the appended value 20 is
`MusicRoomRequest`. Rust's balancer transports room payloads as opaque JSON and its
room metadata uses `serde_json::Value` for queue mode; there is no Rust request enum
or queue-mode mirror to change. Existing `BalancerClient.send` already supports a
`client_id`, so results remain targeted with both direct sockets and balancers.
The small new ClientManager `send` command uses that existing transport.

Every action has `expectedRevision` (nonnegative integer) and `correlationId` (1–256
characters). Mutations compare the revision under the business mutex. A stale action
returns `revision-conflict`; it is not silently replayed with a newer intent. Each
result contains the committed revision. Reads return the revision of their page and
ignore a stale expected revision. Refresh the first page if the revision changes
between page reads. There is no second REST/control channel for music commands.

| `command.action` | Additional input | Grant / behavior |
| --- | --- | --- |
| `preferences` | `includeMoodIds`, `excludeMoodIds`, `content: "keep" \| "renew"` | Caller changes only their own room preference; arrays hold up to 100 UUIDs |
| `settings` | `settings: { fairShare?, autoAdmitOnJoin?, removeDepartedEntries? }` | `configure-room.other`; no internal weighting settings accepted from the client |
| `replan` | `content: "keep" \| "renew"` | `manage-queue.order` |
| `request` | `requestId`, `reference: { service, id }`, optional `extras`, `intent: "mix" \| "next"` | `manage-queue.add`; `next` additionally requires `manage-queue.order` |
| `confirm` | `requestId`, `trackId`, `conflicts: [{ participantId, moodId }]` | Request author only; same add/order grants as the request |
| `cancel` | `requestId` | Request author only, including their own reserved next slot |
| `remove` | `entryId` | `manage-queue.remove`; one occurrence, never the current playback |
| `requests` | `offset` (default 0), `limit` (default 25, maximum 100) | Page of caller's requests only |
| `queue` | Same pagination | Public admitted occurrence page |

`MusicRoomActionSchema` in `common/models/music-room.ts` rejects unknown fields,
including forged contributor/participant IDs. `requestId` is 1–128 characters;
use a UUID and reuse it only for retransmission of the same intent. Another explicit
play of the same track requires a fresh request/occurrence ID. A request is bound to
its authenticated author, track and intent. Reusing another participant's request ID
cannot confirm or cancel it. Grants and membership are rechecked after provider I/O.
All catalogue IDs are UUID strings; account IDs are numbers internally.

Private replies are `{ action: "music-result", result }`. `result` has `status`,
`correlationId`, `revision`, optional `request`, and optional `page`. Request summaries
contain only `requestId`, `entryId`, `trackId`, `intent`, `status` and current unaccepted
`conflicts`. A page is `{ items, total, offset, limit }`; DTO conversion occurs only
for the requested slice. No automatic quota limits manual admissions or page offsets.
Typical statuses are `applied`, `duplicate`, `revision-conflict`, `confirmation-required`,
`slot-conflict`, `request-conflict`, `source-unavailable`, `not-found`, `invalid-confirmation`.
Permission/validation failures return a safe targeted `rejected` result when a valid
correlation ID is available, then follow the existing OTT exception/logging behavior.
No upstream error text or private media reference is copied to the reply.

After a public revision changes, reread the caller's request page to discover newly
pending confirmations; private request data is never added to that public sync.

A confirmation must echo only server-offered conflicts for that request/track. There
is no `ignoreExclusions` flag. The server refreshes annotations before admission;
only newly uncovered conflicts remain to confirm. A conflict that disappeared does
not require another prompt. Manual requests never need to match inclusion filters.
A reserved `next` occurrence does not invoke `playNow` or interrupt current playback.

## Public state and identity

The normal `sync` message gains `music: MusicRoomPublic | null`; Vuex stores it at
`store.state.room.music`. It contains `revision`, `planRevision`, at most ten public
queue entries, `queueTotal`, current occurrence/playback provenance, deduplicated
participants with public preferences, display names/client IDs, and settings.
The public entry DTO contains occurrence/track/source/contributor IDs, origin,
optional request ID/title and catalogue artists. The resolved legacy `currentSource` still feeds the
existing player, includes optional music identity/provenance fields on `QueueItem`,
and preserves provider metadata, `startAt`, `endAt`, `subtitleUrl`.
Music sync sets the legacy `queue` to `[]` and suppresses `prevQueue`; the future UI
must use `music.queue` and request pages instead of rendering the old queue array.
`music.current.contributorMoodIds` and `music.current.contributorMoods: Mood[]` provide
complete metadata for TrackMoods, including custom mood name/icon/normalizedName.
These fields expose only the current contributor's annotations for the admitted track,
not other accounts' tags or library candidates. They refresh after annotation changes
and are rebuilt from SQL on restore. Mood-only replans do not republish `currentSource` or reset its playback position.

Full scheduler snapshots, all candidate libraries, per-track tags, personal requests,
RNG state and history NEVER appear in sync. Do not expose `Room.musicState` to clients.
The full snapshot is explicitly in Redis `storableProps`; `music` is explicitly in
`syncableProps`. A music-only dirty update also triggers Redis persistence.

Accounts use `account:<numeric user ID>` across tokens/connections/restarts. Guests
use `guest:<SHA-256 of authenticated guest token>`; the raw token is never public.
Two tabs for the same account or guest token count once for Q(N), rules and debt.
A new guest token is a new guest identity; there is no durable account/library for
an anonymous browser after it discards that token. Guests can contribute manual
public references, but have no account library/tags. A returning account retains
its score within the durable room music session. Session UUIDs persist in SQL.
Music joins derive account identity from token sessions, not supplied `ClientInfo`.
WebSocket `req` cannot impersonate internal Join/Leave/UpdateUser events.

## Atomicity, playback and recovery

`RoomMusic` owns a room business mutex across read → reducer → SQL CAS transaction →
public projection/publication. A second lock serializes advances while provider I/O
runs outside the business lock. It closes the old occurrence and publishes any plan
produced by ending an unstarted load before resolving a new head. Loading consumes
exactly the published head; source I/O is revalidated against revisions, membership
changes and catalogue versions before commit. A concurrent replan causes a retry,
with a bounded five-attempt failure instead of playing stale metadata.

A real start is the authoritative OTT server timeline entering playing state with a
resolved usable source. A paused load is free. Before its first `started`, and on
resume, the source is resolved again and revalidated with `update-source`. `started`
is followed by replan/refill before another advance. Seek, pause/resume, repeated
play commands and equivalent-source fallback reuse the same occurrence/playback ID.
Fallback tries only trusted catalogue sources of the same already authorized track,
preserving opaque playback extras; it changes `actualSourceId`, never creates another
play. If no source resolves, an unstarted load ends as an error without a fake event.
Current playback is unaffected by moods, participant departure or manual `next`.
Current source and timeline changes are persisted with the scheduler before publication.

The additional catalogue cleanup migration `20261109210000-redact-music-url-titles.js`
from manager commit `4507e5b5` must also run. Room titles are taken from sanitized catalogue
Track DTOs, never raw provider fallback titles. Shared transactions preserve that fix
and its SQLite IMMEDIATE writes with up to three whole-transaction retries.

Migration tables:

- `MusicRoomStates`: lowercased room key, CAS revision, durable scheduler/playback data
  (including pending/consumed/cancelled requests and loaded playback IDs).
- `MusicRoomEvents`: one row per `(roomId, playbackId)`, also unique per room/entry ID,
  with explicit durable ordinal and full event; ending/fallback updates that row.
- `MusicRoomScores`: per-room participant normalization base and real play count,
  with an explicit ordinal. No historical contributor is invented for legacy queues.
- `MusicCatalogueVersions`: per-account invalidation counter.

SQL transactions persist snapshot, events and counters together, for SQLite and
PostgreSQL dialects. Loading uses normalized SQL history/scores, validates the reducer
snapshot, then restores Room before the first choice. Redis is an active snapshot,
not the only source of debt or idempotency. Missing durable state alongside existing
SQL history is an error, never an implicit score reset. A failing SQL commit publishes
nothing from that transition and leaves in-memory scores unchanged. Repeated starts
are idempotent. CAS rejects two stale monolith writers; normal ownership remains the
existing OTT balancer's responsibility. Deleting a persistent room deletes its music
state/history/counters in the same transaction. Expiry/unload does not erase debt.

Legacy modes keep their original queue semantics. In Music, legacy add/playNow,
service+ID remove/edit, arbitrary reorder/vote, restore and undo fail explicitly;
shuffle delegates to music replan. Entering/leaving Music requires no current source
and an empty active queue; legacy entries require explicit adoption through a new
manual request. There is no implicit contributor assignment or historical undo.

## Catalogue invalidation and operational limits

`MusicCatalogue.roomSnapshot(authenticatedPresentAccountIds, occurrenceTrackIds, annotationUserIds = authenticatedPresentAccountIds)` is
a trusted batch API for Room adapters, not a public endpoint. It fetches libraries,
sources and tags in bounded track batches, independently of REST pagination limits.
`roomVersions(accountIds)` fetches the durable version fingerprint. A snapshot read
uses PostgreSQL repeatable-read so tags and their invalidation version cannot be
observed from different commits. SQLite uses the shared connection transaction mutex.
Catalogue imports/annotation writes and room persistence share that mutex to avoid
nested SQLite transactions. Existing catalogue APIs remain available.

Actual library/tag additions and removals increment the user's version in the same
SQL transaction as the mutation. Favorites/no-ops never increment it. The existing
committed catalogue hook invalidates loaded local rooms. Other monoliths compare
versions for only their present accounts and contributors with retained/current occurrences every five seconds; there is no catalogue
or library scan at the 250 ms/one-second playback tick. Relevant contexts are refreshed
before music mutations; advancement rechecks versions after network work. SQL versions
survive pub/sub outages and process restarts, so no second control bus or lossy-only
notification is required. Remote idle-room convergence is bounded by that polling
interval plus one RoomManager update. Favorites never touch scheduling.

Automatic candidates contain only present participants' generation libraries.
Queued/pending sources outside libraries are refreshed as `occurrenceCandidates` and
never promoted into the automatic pool. Retained departed contributions keep their
provenance; no further generation uses an absent participant's library.

Initial defaults use the spec proposals: fair share, automatic library admission and
remove-on-departure enabled; compatible automatic proposals kept on preference change
unless `renew` is requested. Departures are immediate (no reconnect grace delay),
but returning identities retain debt. There is no public session reset action.
SQL snapshots/history/requests are retained without pruning in this first integration;
retention policy and SQL compaction are future operational work. No UI, provider-live,
PostgreSQL-service or real-Redis validation is implied by mocked adapter/Redis tests.

## Validation of this integration lot

Implementation checks (not independent review):

- `tsc --noEmit` passes in common, server and client.
- Focused server Vitest: 214 tests in ten suites pass, including 22 Room music tests,
  legacy Room/RoomManager, ClientManager direct/balancer privacy, room REST/storage,
  catalogue/API and the corrected scheduler/history suites.
- Common Vitest: 71 tests pass; focused client protocol/store + legacy settings: 6 pass.
- Targeted Biome check passes. Targeted ESLint passes; the four existing
  `restrict-template-expressions` warnings in Room/ClientManager remain.
- Real SQLite migrations, rollback, failed history write, reopened-file SQL restore,
  confirmed manual requests, idempotency and stale-writer CAS were exercised.
  Redis uses the project's Redis mock; provider adapters are mocked.

Live PostgreSQL, live Redis, browser/multi-device playback and live providers were
not available/exercised here. Yarn's native SQLite install could not fetch/build its
binary in the sandbox; tests used the matching existing local SQLite binary from
the parent checkout, without any package/lockfile change. The two explicitly
allowed manager fixes are included as cherry-picks; no UI commit was imported.
