# Client playback integration

Room uses the [v1 transport](playback-protocol.md), the existing server clock and the existing
rendering controller. Public YouTube videos use the existing iframe SDK and need no new login.
Connected Music and OAuth are unsupported. No resolver endpoint or credential exchange is added.
Common/server code and the pure controller/clock are unchanged by this client integration.

## Subscription and authority

`plugins/connection.ts` caches a valid capability only within the authenticated socket lifetime.
Open/close/message/error callbacks capture their socket and generation. Socket replacement,
disconnect, close and every outgoing auth (including an identical token) clear capability and notify
owned `onLifecycle` listeners. It also caches only the current generation's merged legacy playback
sync fields, so authentication evidence received before Room mounts is retained. Registration returns an unsubscribe; at most 64 listeners are allowed,
and listener exceptions cannot interrupt other listeners. The mock supplies `mockLifecycle()`.

`createPlaybackSession` installs every handler before inspecting cached capability or subscribing.
Each Room session has a random request namespace. Only the latest subscription nonce can establish
an epoch. Before installation and during recovery, at most 128 event envelopes are buffered. The
session parses core snapshots/events and strict transport/attachment envelopes, rejects cursor
rollback and attachment conflicts, and applies contiguous arrivals following its snapshot. Events
cannot establish a new epoch. Overflow invalidates the outstanding nonce. Recovery requests back off
to eight seconds; missing snapshots are also retried. There is no command replay on recovery.

`attachment.item` is the only player source. Its epoch, sequence, occurrence and opaque media reference
must match; snapshot attachment sequence can predate the receipt cursor. The map is scoped by epoch,
occurrence and opaque ID. Clear removes it. No opaque adapter ID is passed to a provider. A bounded
receipt cache also catches conflicting duplicates after local core compaction.

The current server compacts effective events immediately and sends one active attachment. Historical
events are parsed by the core; rendering starts at the snapshot horizon. Snapshots requiring
unavailable future source mappings fail closed and resubscribe. This integration
does not invent mappings for a future scheduling protocol. Queue, users, Music admission, mix/moods,
library and other room fields continue through existing sync. Each generation begins negotiating:
`ownsPlayback` and `room.playbackEstablished` hold legacy rendering/commands, clear the old source,
and filter legacy source/position/rate/play fields. `session.established` separately indicates that
this generation has installed a valid requested timeline snapshot; it resets on every lifecycle change.

A valid room sync is authentication evidence (the server sends sync only after authentication).
Its first arrival starts a one-second capability deadline, while the session buffers and merges only
that generation's legacy playback fields. Disconnect, open, outgoing auth, or silence alone cannot
start fallback. Without a valid capability by the deadline, ownership returns to legacy and Room
projects the merged fields through `room/sync`, restoring both player and existing request controls.
Room also reapplies buffered play/pause through its guarded legacy handler, so a browser autoplay
rejection exposes the local Play gesture immediately without waiting for another server sync.
This applies on first connection and reconnect. There is no temporary legacy autoplay before the
deadline. Invalid capability envelopes cannot extend it. A valid capability, including one cached
before Room mounts or arriving after legacy fallback, clears the legacy buffer, holds rendering and
commands, and requests a fresh nonce-correlated snapshot and clock. Once modern is selected, snapshot
timeouts or recovery never downgrade to legacy within that generation. Auth, room/connection changes
and disposal cancel pending fallback and clear all generation-owned state.

## Clock and commands

Clock probes contain only generation and nonce; the estimator retains local send time. Probes start
with subscription and repeat every five seconds. The client sends at most 16 new-protocol envelopes
per ten seconds, reserving margin below the server's 20-envelope limit. A saturated/failed send never
queues probe timestamps or commands. A 250 ms session tick observes stale estimates, controller
reconciliation and position projection. Returning to a visible page or a scheduling gap above five
seconds requests a rate-limited clock refresh without discarding a fresh estimate or the playing provider.
Hiding the page does not reset playback. The clock estimator still rejects expired samples and clock
discontinuities; auth and connection changes invalidate calibration. Rendering never falls back to wall time.

`useRoomApi` routes play/pause/seek/rate/next through the selected session, covering bottom controls,
keyboard and Media Session. Each intention receives a unique request ID and the effective state’s
epoch/occurrence. Permission checks remain local and server-authoritative. Clear, recovery and an
unready clock cannot target an old occurrence. Pending results are bounded to 64, expire after fifteen
seconds, are discarded on occurrence/generation change and recover on correlated stale results.
Concurrent next clicks are suppressed only while a next command is pending for the same epoch and
occurrence. A correlated applied or rejected result releases that command; a later intentional
vote/unvote or retry receives a fresh request ID. Late results cannot release a newer pending next.
Timeouts and recovery discard pending commands and hold further actions until authority recovers.
Commands are never automatically retried, and transport retries must retain the original request ID.
New admission/playNow operations still use their existing room/Music interfaces.

## Captured provider surfaces

`createPlayerSurfaces()` allocates a keyed surface for every controller generation. OmniPlayer binds
the captured provider object to that surface. The adapter’s `ready` allocates the initially silent
surface; `load` supplies the resolved item and waits for the captured API and usable media readiness.
Readiness has a fifteen-second local timeout. Position/rate setters and reads support SDK promises.
Every operation settles promptly on disposal, while underlying SDK completions are consumed and
remain isolated to the detached old provider. Disposal synchronously stops/destroys the provider,
detaches media, cancels waits and removes the render surface. Vue then unmounts that keyed tree.

YouTube uses `cueVideoById` for initial and silent-mode source loads. A paused join does not autoplay.
Its autoplay-blocked callback rejects the captured play operation with `NotAllowedError`; a four-second
play-confirmation timeout also reports local blocking when no playing callback arrives. The existing
localized Play gesture calls controller `userActivated` directly. It does not pause or skip the room.
Direct/HLS/DASH keep legacy initial autoplay only in legacy mode; timeline mode waits for usable media,
then applies rate and position before play/pause. Vimeo advertises rate 1 only. PeerTube exposes its
SDK rates and async position/rate methods. Unsupported rates hold locally rather than emulating them.

Buffering/resumed and actual provider playback changes report only to the controller. Native YouTube
rate changes force local alignment; position drift uses controller policy. Changing native controls
invalidates clock/rendering and creates a new captured surface after recalibration. It does not swap
the instance behind an existing adapter. Local volume, mute, audio boost, captions and quality retain
their existing controls; the timeline owns synchronized rate. Localized clock/recovery/rate/error
status is displayed in Room, with explicit retry for provider errors. Status telemetry sends no
business playback commands or listening credit.

All session intervals, snapshot retries, readiness waits, probe state and handlers are owned and
disposed on Room teardown. ServerMessageHandler removes only its own handlers.

## Verification and limits

`client/tests/playback.config.mjs` bypasses application configuration and env loading. Focused tests
exercise the actual session/Room/OmniPlayer/YouTube component wiring with mock transport, clock and SDK,
including fake-timer negotiation, legacy reconnect projection, delayed capability, repeated auth,
old socket callbacks, intentional vote/unvote and rejected/timed-out next retries,
plus captured mock providers for interleavings and cancellation. Existing Room, YouTube, bottom
controls, rate, layout and local-media regressions are included. Run from the repository root:

```powershell
node .yarn/releases/yarn-4.1.0.cjs exec node node_modules/vitest/vitest.mjs run --config client/tests/playback.config.mjs client/tests/unit/playback-session.spec.ts client/tests/unit/playback-room.component.spec.ts client/tests/unit/playback-connection.spec.ts
node .yarn/releases/yarn-4.1.0.cjs workspace ott-client exec tsc --noEmit
```

Build with `configFile:false`, `envFile:false`, `envDir:false`, `root:"client"` and the explicit plugins,
aliases and static commit define from that test configuration; do not import the default Vite config.
Scoped Biome, ESLint and Prettier checks apply.

A bounded live YouTube check on 2026-11-10 reproduced seek/rate/play commands roughly every 275 ms:
seek-triggered buffering was forcing another seek. After the recovery correction, the same browser
advanced six seconds during a six-second observation with no new seek/play/pause/rate commands.
Visibility preservation and delayed timer handling have regression coverage with simulated events;
this check does not establish long-running playback under real background-tab throttling.

These tests do not establish real browser autoplay permissions, streaming/iframe buffering behavior,
provider network playback, Vimeo/PeerTube SDK behavior against live services, or Connected Music.
Destroyed iframe/element isolation prevents old operations from affecting the replacement; it cannot
cancel work inside a remote provider. PeerTube’s existing reported position reliability still needs
a real-provider check. Provider-specific restrictions may still require a gesture inside its iframe.
