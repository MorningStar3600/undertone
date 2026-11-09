# Playback timeline core, version 1

`ott-common/playback/index.js` exports a pure, provider/UI-independent playback contract. This
foundation does not change existing messages, room persistence, players, authentication, or YouTube
behavior. No subscription or login is introduced. Server/client adapters are separate integration work.

## Units and public data

-   `effectiveAtMs`, baseline times and query times are **integer server Unix milliseconds**, from zero
    through `Number.MAX_SAFE_INTEGER`. Inject clock readings/clock-offset estimates outside the core.
-   `positionSeconds` is **media seconds**, including fractions, matching `common/timestamp.ts` and
    `Room.realPlaybackPosition`. Position is bounded to `[0, 1_000_000_000]`; extrapolation saturates at
    that maximum. Rate is a finite multiplier in `[0.1, 16]`. This is a contract bound, not a claim about
    every provider's supported rates. There is no microsecond accuracy or device synchronization promise.
-   A media reference is exactly `{ service, id }`. `service` is a lowercase token (maximum 64 characters);
    `id` is a public opaque identifier of 1–256 ASCII letters, digits, `.`, `_`, `~`, or `-`. A YouTube video
    ID fits directly. Resolve raw URLs, local paths, signed URLs and private provider payloads through an
    adapter to a public source ID. These are identifiers, never admission grants. Zod rejects unknown
    keys, URL-shaped IDs, credentials fields, coercion, NaN, infinity and out-of-range numbers. The server
    must still ensure opaque IDs do not themselves contain secrets and authorize source resolution.

## Identity and ordering

`epoch` is an injected, opaque random room-incarnation token, distinct from Redis routing `loadEpoch`.
Sequence starts at 1 in each epoch and increases exactly by 1. A receiver accepts only the next
sequence. Gaps require replay of a suffix or an authoritative snapshot; this core does not buffer
out-of-order deliveries or guess missing events. Scheduler revision is not playback sequence.

`occurrenceId` is a positive increasing integer scoped to the epoch. Every `load` must use exactly
`lastOccurrenceId + 1`; the first is 1. The canonical transport occurrence identity is
`(epoch, occurrenceId)`, not media service/ID. The last ordinal survives `clear` and compaction, so
uniqueness does not require retaining an ever-growing ID set. Legacy DJ/Loop repeats and undo restores
must issue a new `load` ordinal even when media identification is unchanged.

Music's persistent `current.playbackId` is a separate domain identity. The integrating server maps a
transport occurrence to that playbackId; playback sequence changes do not award fairness credit.
On Room restart, generate a fresh transport epoch and force a trusted snapshot, rebuilding the current
transport occurrence from persisted music playback state **without changing music playbackId or
recording another start**. Do not infer a music start from a load, source replacement, or new epoch.
An event with another epoch never switches the receiver; installing a new epoch snapshot is an explicit
authorized transport action. The caller must reject stale snapshots and cross-room snapshot delivery.

Effective times must be nondecreasing in sequence order; equal times run in sequence order. They need
not be ahead of receipt time. Events delivered late after SQL commit are applied at their original
effective time and extrapolated to the query time. A snapshot retains the last-event anchor, so a late
following event may predate its compaction/query horizon, provided it does not predate the **last
accepted event**, including accepted future events. This preserves deterministic replay. A caller
that has scheduled a future event cannot insert an earlier-effective command after it; queue that
command at or after the receipt tail's effective time, or explicitly establish a new epoch/snapshot.
Cancellation/reordering of already accepted future events is outside version 1.

## Events

All events carry `{ epoch, sequence, effectiveAtMs, occurrenceId, type }`.

| Type     | Additional fields                               | Effective behavior                                                                           |
| -------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `load`   | `media`, `positionSeconds`, `isPlaying`, `rate` | Starts a new transport occurrence with an explicit complete initial state                    |
| `play`   | —                                               | Advances position to the effective time, then starts/resumes                                 |
| `pause`  | —                                               | Advances position to the effective time, then freezes it                                     |
| `seek`   | `positionSeconds`                               | Replaces position, preserving play state and rate                                            |
| `rate`   | `rate`                                          | Advances using the old rate, then installs the new rate                                      |
| `source` | `media`                                         | Replaces the public provider reference, preserving occurrence, position, play state and rate |
| `clear`  | —                                               | Removes the current rendering state; retains the occurrence ordinal watermark                |

Every non-load event must target the current occurrence **at the receipt tail**, which may contain a
future load not yet effective for rendering. Controls for an old occurrence, including delayed ended
notifications after a repeat, are rejected. A `source` event supports music fallback/refresh across
providers without replay credit or a new transport occurrence. Use it instead of reusing `load`.

`clear` can represent natural end, explicit removal, or transient unload while the next source
resolves. A null rendering state does **not** mean the server's desired playback intent is paused.
The integrating server must preserve intended playing state independently across such clears and
pass it into the eventual `load.isPlaying`. Controls while cleared have no active occurrence and are
rejected; update queued/server intent outside this renderer core. Duration/end policy is external:
the core does not auto-end, advance a queue, or interpret device notifications as authority. `next`
is a server command resulting in `load` (and, where necessary, `clear`), never a client-authored event.

## API

```ts
createPlaybackTimeline(epoch: string, serverTimeMs: number): PlaybackTimeline
parsePlaybackTimeline(input: unknown): PlaybackTimeline
acceptPlaybackEvent(timeline: PlaybackTimeline, event: unknown): PlaybackAcceptance
expectedPlaybackAt(timeline: PlaybackTimeline, serverTimeMs: number): PlaybackProjection
compactPlaybackTimeline(timeline: PlaybackTimeline, serverTimeMs: number): PlaybackTimeline
```

Schemas and inferred types are exported from the same entry point. `PlaybackEventSchema` validates an
individual event; `PlaybackTimelineSchema` validates the entire snapshot, including ordered future
transitions. `PlaybackTimelineShapeSchema` only validates structure/baseline constraints; prefer the
full schema or `parsePlaybackTimeline` at trust boundaries. Public helpers revalidate their inputs,
return new data, and read no clock, RNG, environment, storage, provider, DOM or network state.

`acceptPlaybackEvent` returns `{ status, timeline }`:

-   `accepted`: appended the next valid event without advancing rendering time.
-   `duplicate`: a retained sequence has the exact same validated payload; no change.
-   `stale`: the sequence is already folded into the baseline; ignored. Its old payload cannot be
    authenticated as identical without retained history. This is not proof of command idempotency.

Malformed payloads/snapshots throw Zod errors. Structurally valid new-event conflicts throw
`PlaybackTimelineException` (an `OttException`) with a stable `code`: `epoch-mismatch`, `sequence-gap`,
`sequence-conflict`, `effective-time-regression`, `stale-occurrence`, `capacity`, or `before-baseline`.
Rejections leave input data untouched. A different retained payload at an old sequence is a conflict,
not a second event. Foreign epochs are rejected even for compacted sequences.

`expectedPlaybackAt` returns `{ epoch, serverTimeMs, receivedSequence, appliedSequence, state }`.
`receivedSequence` includes all accepted future events; `appliedSequence` includes only events effective
at or before the query time. `state` is null or `{ occurrenceId, media, positionSeconds, isPlaying, rate }`
projected to that time. Queries support any validated server time **at or after** the baseline horizon.
Queries do not mutate the timeline, consume pending events, or compact it automatically.

## Snapshot, suffix and retention rules

A `PlaybackTimeline` is the portable snapshot:

```ts
{
  version: 1,
  epoch,
  baseline: { serverTimeMs, sequence, lastEffectiveAtMs, lastOccurrenceId, state },
  events: [/* every accepted event after baseline.sequence, including future events */]
}
```

The baseline state is anchored at `lastEffectiveAtMs`, **not** `serverTimeMs`. The latter is the earliest
supported query horizon. Retaining the exact last-event anchor avoids accumulating floating-point
rounding errors on repeated compaction. Between effective events, position is
`anchor.positionSeconds + (queryMs - lastEffectiveAtMs) / 1000 * rate` if playing, otherwise unchanged.

`compactPlaybackTimeline(timeline, cutoffMs)` folds only events effective at or before the cutoff;
it preserves **every** accepted later-effective event in `events`. Never serialize only the current
projection or advance the receipt cursor while dropping that pending suffix. That would silently lose
scheduled transitions. A snapshot with its pending events plus a later contiguous suffix reconstructs
the same state and cursors as full replay for all supported query times, including when a suffix event
arrives late. A snapshot represents the authority's knowledge at its receipt cursor, not omniscience
about uncommitted transactions or undelivered events.

Receivers may request a suffix starting at `receivedSequence + 1`, not `appliedSequence + 1`. The core
exposes data/cursors but does not implement persistence or a replay endpoint. If the suffix is no
longer retained by the authority, require a full snapshot. After compaction, earlier queries are rejected;
use a separately bounded durable log for historical audit if needed.

At most `MAX_PLAYBACK_EVENTS` (1024) events may remain after the baseline. Compact regularly with an
injected current server time. When all retained events are future work, reject/backpressure at capacity;
do not drop them or fold them early. There is no unbounded automatic history, duplicate-ID set, or
reorder buffer. Sequence and ordinal exhaustion also require a fresh authorized epoch/snapshot.

## Server/client integration responsibilities

1. Serialize room playback commands and authorize them using server-derived identity/grants. Do not
   trust client actor IDs, permission claims, effective timestamps, epochs or event sequence numbers.
   Command `requestId` deduplication and the storage scope of idempotency keys belong to the server.
2. Resolve providers before committing authoritative transitions, preserving the latest committed
   state and occurrence when asynchronous work returns. SQL retryable finalizers must not publish
   events or consume live sequence numbers. Stage a candidate timeline from transaction-local state,
   then install/publish it once after successful commit under room serialization. Failed retries must
   not produce gaps. Effective time may precede publication; choose it monotonically against the
   latest committed/accepted playback event. Do not derive it from scheduler revision.
3. Map committed changes to events using public IDs only. Preserve music playbackId/fairness on
   source replacement, refresh, reconnection, restart and resumed play. Keep server intended play
   state across transient clears; mint new occurrences for repeats and undo. Persist enough adapter
   mapping to restore the music domain identity independently of transport epochs.
4. Deliver a trusted complete snapshot for join/reconnect/restart, then contiguous events. On a gap,
   epoch mismatch or conflicting duplicate, recover through an authorized suffix/snapshot flow.
   Selecting/replacing snapshots and preventing stale snapshot rollback are transport responsibilities.
5. Estimate server time outside the core and render `expectedPlaybackAt(...)`. Local buffering,
   autoplay denial, seek/rate support, drift correction and provider end notifications remain adapter
   concerns. This library supplies expected authoritative state, not evidence a device played it.

The current sync protocol remains untouched by this lot. Import via the existing wildcard common
package export (`ott-common/playback/index.js`); no edits to `common/index.ts` are required.
