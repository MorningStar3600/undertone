# Client playback integration

Room uses the [v1 transport](playback-protocol.md), the existing server clock and the existing
rendering controller. Public YouTube videos use the existing iframe SDK and need no new login.
Connected Music and OAuth are unsupported. No resolver endpoint or credential exchange is added.
Common/server code and the pure controller/clock are unchanged by this client integration.

## Subscription and authority

`plugins/connection.ts` caches a valid capability only within the authenticated socket lifetime.
Open/close/message/error callbacks capture their socket and generation. Socket replacement,
disconnect, close and every outgoing auth (including an identical token) clear capability and notify
owned `onLifecycle` listeners. Registration returns an unsubscribe; at most 64 listeners are allowed,
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
library and other room fields continue through existing sync. After a valid requested snapshot,
`room.playbackEstablished` filters legacy source/position/rate/play fields, including across reconnect
until the fresh capability/snapshot arrives. A server with no capability retains legacy playback.

## Clock and commands

Clock probes contain only generation and nonce; the estimator retains local send time. Probes start
with subscription and repeat every five seconds. The client sends at most 16 new-protocol envelopes
per ten seconds, reserving margin below the server's 20-envelope limit. A saturated/failed send never
queues probe timestamps or commands. A 250 ms session tick observes stale estimates, controller
reconciliation and position projection. Visibility/pageshow, a local scheduling gap above five
seconds, auth and connection changes invalidate calibration. Rendering never falls back to wall time.

`useRoomApi` routes play/pause/seek/rate/next through the selected session, covering bottom controls,
keyboard and Media Session. Each intention receives a unique request ID and the effective state’s
epoch/occurrence. Permission checks remain local and server-authoritative. Clear, recovery and an
unready clock cannot target an old occurrence. Pending results are bounded to 64, expire after fifteen
seconds, are discarded on occurrence/generation change and recover on correlated stale results.
Repeated next votes are suppressed for the same occurrence. Commands are never automatically retried.
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
plus captured mock providers for interleavings and cancellation. Existing Room, YouTube, bottom
controls, rate, layout and local-media regressions are included. Run from the repository root:

```powershell
node .yarn/releases/yarn-4.1.0.cjs exec node node_modules/vitest/vitest.mjs run --config client/tests/playback.config.mjs client/tests/unit/playback-session.spec.ts client/tests/unit/playback-room.component.spec.ts client/tests/unit/playback-connection.spec.ts
node .yarn/releases/yarn-4.1.0.cjs workspace ott-client exec tsc --noEmit
```

Build with `configFile:false`, `envFile:false`, `envDir:false`, `root:"client"` and the explicit plugins,
aliases and static commit define from that test configuration; do not import the default Vite config.
Scoped Biome, ESLint and Prettier checks apply.

These tests do not establish real browser autoplay permissions, streaming/iframe buffering behavior,
provider network playback, Vimeo/PeerTube SDK behavior against live services, or Connected Music.
Destroyed iframe/element isolation prevents old operations from affecting the replacement; it cannot
cancel work inside a remote provider. PeerTube’s existing reported position reliability still needs
a real-provider check. Provider-specific restrictions may still require a gesture inside its iframe.
