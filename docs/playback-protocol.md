# Playback transport v1 (server contract)

This is the server transport for [the timeline core](playback-timeline-contract.md) and
[the browser clock](playback-clock.md). It does not implement a player/controller, OAuth, or
validate Connected Music. Ordinary YouTube and guest playback retain the existing controls.
No client files or Rust protocol changes are included. Existing numeric room requests (0–20),
Music admission requestIds, and legacy `sync` continue unchanged.

Types and client-input Zod schemas: `ott-common/playback/transport.js`. Timeline schemas remain
in `ott-common/playback/index.js`. All examples are application JSON on the authenticated room
WebSocket, either direct or via the balancer's existing opaque JSON forwarding. Commands cannot
choose an actor, timestamp, sequence, media URL or effective time. These new envelopes are not
numeric `req` requests or REST endpoints.

## Capability and subscription

After authentication/join, the owning monolith sends:

```json
{ "action": "playback-capabilities", "version": 1, "recovery": "snapshot" }
```

The client must install its event handler and start buffering **before** sending:

```json
{ "action": "playback-subscribe", "version": 1, "nonce": "connection3-recovery1" }
```

Recovery/resume uses the same request, optionally with the last **received**, not merely applied,
sequence:

```json
{
	"action": "playback-subscribe",
	"version": 1,
	"nonce": "connection3-recovery2",
	"resume": { "epoch": "old-epoch", "lastSequence": 17 }
}
```

This implementation always returns a full snapshot, including on same-epoch resume. There is no
retained suffix endpoint. `resume` is validated but does not select a different response. The
server registers the subscriber before synchronous snapshot capture/send; there is no await
between those operations. If concurrent subscription authorizations finish out of order, only
the latest request sends a snapshot. The nonce is mandatory, 1–128 ASCII letters/digits/`._~-`.

```json
{
	"action": "playback-snapshot",
	"nonce": "connection3-recovery2",
	"timeline": {
		"version": 1,
		"epoch": "room-incarnation-uuid",
		"baseline": {
			"serverTimeMs": 1794260000000,
			"sequence": 4,
			"lastEffectiveAtMs": 1794260000000,
			"lastOccurrenceId": 1,
			"state": {
				"occurrenceId": 1,
				"media": { "service": "adapter", "id": "mapping-uuid" },
				"positionSeconds": 12,
				"isPlaying": true,
				"rate": 1
			}
		},
		"events": []
	},
	"attachment": {
		"epoch": "room-incarnation-uuid",
		"sequence": 1,
		"occurrenceId": 1,
		"media": { "service": "adapter", "id": "mapping-uuid" },
		"item": { "service": "youtube", "id": "video-id", "length": 180 }
	}
}
```

The baseline retains the exact last-event anchor. Extrapolate at estimated server time; do not
interpret `serverTimeMs` as a new position anchor. The server immediately compacts effective events,
so its log is bounded to the baseline; `events` is currently empty. The wire retains the complete
core snapshot shape, including its pending-event array. No future commands are accepted/scheduled
by this implementation. Future scheduling would require preserving **all** pending events and
their adapter mappings, plus changes to legacy/Music commit semantics; it must not be enabled by
merely adding a lead time.

Only opted-in connections receive `playback-event`; this filtering also applies to each balancer
client (targeted `room_msg`, not an unfiltered room broadcast). Legacy messages still arrive.
Reauthentication/disconnection clears subscription. Old servers have no capability message:
stay on legacy playback unless a valid requested snapshot establishes the new timeline. After
establishment, ignore legacy playback fields for rendering, including legacy `currentSource`.
Other sync fields and room events remain useful for queue/UI updates.

On reconnect/room change reset the clock and subscription generation, request a new snapshot, and
ignore replies/events belonging to the previous connection. Install snapshots only for the latest
outstanding nonce on the expected authenticated room connection. For the same epoch, never replace
a higher receipt cursor with an older snapshot: buffer arrivals until snapshot installation, then
apply only its contiguous following suffix. On epoch change require an explicit current snapshot,
discard the old epoch buffer, and rebuild adapters. An event alone never authorizes epoch change.
Recover on a gap, conflicting duplicate, invalid attachment or epoch mismatch. At equal sequence,
use the core's payload validation rather than treating all duplicates as authentic.

## Events and adapter data

```json
{
	"action": "playback-event",
	"event": {
		"type": "seek",
		"epoch": "room-incarnation-uuid",
		"sequence": 5,
		"effectiveAtMs": 1794260001000,
		"occurrenceId": 1,
		"positionSeconds": 25.5
	}
}
```

Every accepted transition is journaled at its owning commit boundary, independently of debounced
sync/dirty property setters. Legacy play/pause, seekRaw/SponsorBlock, rate, next in every queue mode,
auto-end/endAt, successful skip quorum, playNow, undo restoration/clear, and subsequent queue loads
use that boundary. DJ and Loop repetitions and undo restoration mint new occurrence ordinals even
for the same source. Seeks to zero are valid. Rate events preserve position using the previous rate.
No-op play/pause and votes short of quorum need not produce an event. Trusted constructor restore
rebuilds the initial occurrence; arbitrary property assignments outside these transition APIs are
not supported as playback commands.

Every load/source event includes `attachment` in the **same message**, with matching epoch,
sequence, occurrence and media. A snapshot includes only the active attachment, or null when cleared.
Its attachment.sequence is the last load/source sequence and can be less than baseline.sequence.
Check media/occurrence equality against the snapshot's active state. Clear discards the active
attachment. Other controls preserve it.

The core media is always `{service:"adapter",id:<random UUID>}`, including YouTube. Resolve it only
through that event/snapshot's attachment.item (the existing QueueItem adapter data: underlying
service/id, URLs, metadata, trims/subtitles, etc.). It is not a playable provider ID by itself.
There is no open resolver, historical mapping fetch or authorization grant encoded in the UUID.
A changed/renewed URL or metadata reference gets a fresh mapping UUID even when the underlying
identifier is unchanged. The server holds at most one active mapping; snapshots never return all
historical private URLs. Connected room members can already access the current adapter source;
the attachment does not confer access to any other library/source. Guest session fingerprint
contributor IDs are omitted from attachments. Dedupe fingerprints are never fields on this wire.

Music attachments additionally carry the persistent `playbackId`, which is separate from transport
`(epoch,occurrenceId)`. Source fallback/refresh emits `source` for the same occurrence and preserves
playbackId, position, rate, play state and fairness history. A resume can emit `source` then `play`
at equal effective times. New loads do not themselves award contribution credit. Snapshot,
reconnect/restart, paused load and fallback never synthesize a music `started` operation.

`clear` means the renderer has no source; it does not imply paused server intent. Music next commits
clear before resolving the next source and preserves intended playing through that interval.
The eventual load carries that intent. Controls targeting the cleared occurrence are stale; a
client must wait for the next load. Legacy queue exhaustion retains its existing stop behavior.

## Commands, results and retries

```json
{
	"action": "playback-command",
	"command": {
		"requestId": "seek-1",
		"epoch": "room-incarnation-uuid",
		"occurrenceId": 1,
		"command": "seek",
		"positionSeconds": 25.5
	}
}
```

| command          | Additional fields | Existing permission   |
| ---------------- | ----------------- | --------------------- |
| `play` / `pause` | none              | `playback.play-pause` |
| `seek`           | `positionSeconds` | `playback.seek`       |
| `rate`           | `rate`            | `playback.speed`      |
| `next`           | none              | `playback.skip`       |

All commands require requestId, expected epoch and expected positive integer occurrenceId. RequestId
uses the nonce character/length bounds. Positions are finite seconds in [0,1e9], rates finite
multipliers in [0.1,16], and counters safe integers. Unknown fields/coercion/NaN/infinity are rejected.
No actor or account ID is accepted. Membership/token/principal/permission and occurrence are rechecked
after source/SQL waits before commit. The room uses the authenticated session, never client status
account claims, to authorize. Music next explicitly tracks its own committed clear for subsequent
authorization; another command cannot claim that clear. Legacy transition decisions are serialized;
Music owns its SQL save → install → publication mutex. Room update loops cannot overlap.

```json
{
	"action": "playback-result",
	"result": {
		"requestId": "seek-1",
		"epoch": "room-incarnation-uuid",
		"sequence": 5,
		"status": "applied"
	}
}
```

Or status `rejected` with code `request-conflict`, `capacity`, `stale-epoch`, `stale-occurrence`,
`unauthorized`, or `failed`. Sequence is the receipt cursor at result construction, not the scheduler
revision. Applied means the command completed; it does not guarantee a new event, playback on a
device, or exclusive ownership of that sequence. A vote can be applied with no event. A next can
commit clear and later reject its load after authorization/source failure; recover from its reported
cursor. Never roll back a committed clear because the overall command later reports rejection.
Malformed, oversized, unauthenticated/unsubscribed or rate-limited input is dropped without a
correlated result. Retry valid envelopes using the same ID; recover if there is no response.

Room-local reservations are scoped by fresh transport epoch, private session fingerprint, resolved
principal and requestId (room scope comes from the owning Room object). The captured principal must
still match the live resolved session; a switch is rejected, never silently reassigned. Reservations
are installed before authentication/transition awaits. Concurrent identical validated payloads share
one promise/result; a changed payload conflicts. Both successful and rejected completed results are
cached. Duplicate skip requests therefore cannot toggle votes twice, including zero-event votes.
This does not change Music's separate persistent admission requestIds.

The cache holds at most 512 reservations per room, for five minutes from reservation time. Completed
entries expire lazily on a new command. Pending entries are never evicted; capacity returns rejection.
After expiry the ID may execute again: use a fresh ID for each intention and never rely on indefinite
dedupe. A cached result keeps its original cursor even when later room events have advanced.

## Application clock

Authenticated room members can probe without opting into playback. Send only the clock's returned
generation and nonce; `sentAtMs` is local bookkeeping and is not sent:

```json
{ "action": "clock-probe", "generation": 3, "nonce": "12" }
```

```json
{
	"action": "clock-reply",
	"generation": 3,
	"nonce": "12",
	"serverReceiveMs": 1794260001000,
	"serverSendMs": 1794260001002
}
```

Generation is echoed as the exact numeric safe nonnegative integer, nonce as the exact string
(no parsing/reformatting). Times are integer Unix milliseconds on the owning monolith: receive at
application handler ingress, send immediately before targeted reply. Balancer/network transit is
part of RTT, never a client-authoritative timestamp. Feed the echoed generation into acceptReply;
do not substitute the current connection generation. Snapshot horizon/effective time is Unix time,
so defer projection if the estimator is not ready or its fractional estimate precedes that horizon.

All three new input envelopes share a per-connection limit of 20 attempts per 10 seconds and a
2048-character JSON limit. Limits run before session I/O. Strict schemas bound field sizes; replies
are targeted to the authenticated member, never broadcast. Reauth/session/room membership changes
invalidate access. This is an application estimate, not a split-brain or precision-time service.

## Durability and remaining work

Transport journal, receipts, occurrence IDs and adapter mapping are in memory. Every Room incarnation
gets a fresh random transport epoch, unrelated to routing loadEpoch. Rebuild from trusted existing
room/Music state and force snapshot recovery on restart. Music playbackId/fairness remains durable
in its existing SQL state. Legacy playback durability remains its existing Redis contract.

Music SQL retry finalizers stage independent journal candidates. They do not consume live sequences,
publish or mutate the shared timeline. Only successful SQL commit installs/publishes the selected
candidate; rolled-back attempts produce no speculative events or gaps. No separate durable transport
event log/receipt table or atomically persisted future commands are introduced. Accepted transport
receipts and future work are **not durable** across restart. Existing SQL ownership/CAS protections
remain; a random epoch does not fix distributed ownership/split brain.

The client lot still needs capability selection, lifecycle/nonce buffering, clock probes, timeline
validation/recovery, attachment-backed player adapters, controls with command IDs, and drift/autoplay
handling. Native provider errors and actual listening evidence are separate concerns. No whole-app
completion or Connected Music validation is claimed here.

Focused regression suites: `server/tests/unit/playback-transport.spec.ts`, `room.spec.ts`,
`room-music.spec.ts`, `room-music-boundaries.spec.ts`, `room-music-persistence.spec.ts`. Run Vitest with
`envFile:false` in startVitest's fourth (Vite override) argument, `config:false`, an empty envDir,
Node environment and the Redis mock setup to avoid loading application env files. Music tests use
isolated SQLite fixtures. Legacy room unit checks can mock loadModels (they do not assert storage).
Run files in separate forks/processes because prom-client's external registry can survive Vitest
module isolation. PostgreSQL/real Redis and browser/player behavior are not verified by these tests.
