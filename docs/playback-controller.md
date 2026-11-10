# Playback rendering controller

`client/src/playback/playback-controller.ts` is an opt-in, framework/provider/transport-independent
renderer for the [timeline contract](playback-timeline-contract.md). It consumes the existing
[server clock](playback-clock.md); it does not implement another clock estimator. The playback session
wires it to the room connection and captured provider surfaces. Ordinary public YouTube playback
needs no new login.

## Integration API

`createPlaybackController<Source>(options)` accepts:

-   `clock`: the existing server clock's `getEstimate()` interface.
-   `now()`: local monotonic milliseconds for scheduling/cooldowns only.
-   `resolveSource(publicMedia, context)`: sync or async resolution of separately authorized source
    metadata. `Source` is adapter-owned and never becomes a timeline payload. For ordinary YouTube an
    adapter can resolve the public ID directly. No source resolver URL or network envelope is assumed.
-   `createAdapter(context)`: synchronous creation of a silent, isolated provider instance. Context
    includes public media, epoch, occurrence, local generation, an AbortSignal, and a captured `report`.
-   `onRecovery(recovery)`, optional `onStatus(status)`: synchronous, nonthrowing host callbacks. Status
    codes are machine-facing; the integrating UI supplies localized messages. Reports contain public
    scope, plus local errors that callers must sanitize before logging or forwarding.
-   Optional injected `scheduler` with asynchronous `setTimeout` and `clearTimeout`. Without it, the
    caller owns periodic `tick()` calls. No global clock, DOM, network, or timers are accessed.

Methods:

| Method                              | Responsibility                                                                                                                    |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `installSnapshot(unknown): boolean` | Validate a trusted complete common timeline and start rendering when the clock is ready.                                          |
| `acceptEvent(unknown)`              | Validate/accept through the common core; return `accepted`, `duplicate`, `stale`, or `rejected`.                                  |
| `tick()`                            | Observe clock changes, effective transitions and local drift; call after clock reply/reset and on the regular scheduling cadence. |
| `userActivated()`                   | Retry a locally blocked play using the latest authoritative state. Call directly in the browser gesture handler.                  |
| `retry()`                           | Explicitly recreate a failed adapter/resolver generation. No automatic failure retry occurs.                                      |
| `getStatus()`                       | Read local rendering status and scoped identity.                                                                                  |
| `whenIdle()`                        | Observe the currently running worker; does not advance timers or await scheduled events.                                          |
| `dispose()`                         | Terminal, idempotent cancellation and teardown, including all owned timers.                                                       |

The transport must validate room identity, connection/request/snapshot identity, and explicit authority
to switch epochs **before** calling `installSnapshot`. The controller rejects same-epoch receipt-cursor,
occurrence-watermark, and last-effective-time rollback. It rejects conflicting overlapping retained
events and inconsistent equal-cursor snapshots (comparing safely compacted snapshots at a common
horizon). A delayed consistent snapshot with an older horizon is allowed; the local horizon is retained.
Newer trusted snapshots may summarize history no longer locally retained; the controller cannot prove
the contents of that lost history. A new epoch snapshot explicitly replaces the old one; it cannot infer
whether that epoch is a stale room response. The transport owns that check.

Gaps, conflicts, epoch mismatch, malformed inputs and missing snapshots fail closed: immediately
dispose local rendering, notify `onRecovery` once, and reject further events until a valid snapshot is
installed. Recovery reports include the old epoch and **received** sequence (including pending future
events). This implementation requires snapshot recovery; it does not resume from an injected replay
suffix while recovery is latched. Transport may reconstruct a snapshot externally using the core.

## Adapter ownership and cancellation requirements

The existing `MediaPlayer` signatures understate SDK asynchrony: Vimeo position reads return promises,
and play/pause can be async. This adapter therefore allows synchronous or Promise results for readiness,
load, position, seek, rate, play and pause. `supportsRate` is a synchronous capability check after load.
`ready(signal)` waits for the captured instance's API; `load(source, signal)` cues silently and resolves
only once that source is usable for seek/rate/play/pause. It must support paused joins without autoplay.

**Do not pass the existing mutable `useMediaPlayer()` facade directly.** Every generation must capture
its own provider/element/component instance. All methods and SDK callbacks must remain bound to that
instance, including after an await. `dispose()` must synchronously and idempotently stop/detach its
render surface, disable its callbacks, and ensure old SDK work cannot resume audio, mutate a shared
element, or load into a replacement. If an SDK cannot cancel a command, isolate and destroy/detach
that SDK instance instead of reusing its element. The factory must not return a live instance from an
older generation. Even `source` events with identical public media allocate a fresh generation.

AbortSignal is a cancellation **notification**, not proof an arbitrary SDK promise was cancelled.
The controller owns one serialized worker and awaits each method's settlement, checking ownership and
current authority before/after each async boundary. `play(signal)` receives a separate command signal:
new effective pause, unsupported rate, clear, replacement, clock loss or disposal aborts a pending play.
Adapters must stop pending playback and settle on this signal. YouTube cancels its pending play promise,
clears the autoplay timeout/listener, issues pause, and rejects late PLAYING callbacks while pause is
still intended. The captured surface and OmniPlayer forward the signal to the exact provider instance.
The worker consumes cancellation without publishing stale autoplay failure or starting another worker.
Other SDKs that ignore per-play abort can still delay subsequent work until their promise settles.
Local clear/replacement/disposal immediately aborts and disposes the captured adapter during the wait.
All injected resolver/adapter operations must settle promptly on abort/dispose (resolve or reject),
remove readiness watchers/listeners, and drain their own work. A noncooperative never-settling promise
blocks subsequent source startup; it cannot spawn replacement pipelines or unbounded detached
promises. This is a deliberate boundedness tradeoff, not an SDK cancellation guarantee. `dispose()`
returns synchronously and cannot await cleanup from a violating adapter.

An adapter may implement synchronous `activate()` to capture a gesture/unlock provider resources.
`userActivated()` invokes it directly while the gesture is active, then schedules reconciliation.
Actual play still follows readiness, latest alignment, and rate. Browser/SDK transient gesture policy
is provider-specific: retry is not a guarantee of autoplay permission. `activate` must stay bound to the
captured instance, honor disposal and not create room commands or change server play intent.

Startup is source resolution → API ready → silent load → latest expected rate/position → play/pause.
Play/seek/rate changes during startup do not reload that source; a new occurrence, effective source
refresh, clear, snapshot replacement, or loss of clock readiness invalidates the generation. Old
completions/failures/notifications cannot issue commands against the replacement or report its failure.

## Projection, scheduling and local playback policy

Projection always calls common `expectedPlaybackAt` with `Math.floor(serverNowMs)` in server Unix
milliseconds. The integrating server clock must use the same advancing Unix-millisecond domain as
the timeline (the estimator itself also supports non-Unix origins). Invalid/non-ready readings never
fall back to local time: dispose rendering and wait for calibration, then reload and align to authority.
Call `tick()` immediately on connection reset/suspend/resume; without notification, invalidation is
observed at the next periodic tick or async completion.

Each refresh safely compacts only effective events and retains the entire future suffix. If a new
calibration moves backwards below the baseline horizon, clamp the query to that horizon until the
estimate catches up. This freezes authoritative projection rather than undoing already effective
events or querying before the core's supported range; a playing local device may drift while projection
is frozen and is corrected under normal drift policy. There is no accumulated media-time integration.

There is one controller timer and one worker. Defaults: 250 ms periodic reconciliation (minimum
configurable interval 50 ms), 0.3 s drift detection, 0.1 s release band, 1 s routine seek cooldown, and
0.1 s paused-anchor/slow-command tolerance. Drift must remain outside the release band for at least
one sample interval after detection before correction, in the same direction; an isolated noisy sample
or oscillating sample direction cannot trigger a routine seek.
Newly effective authority, generation startup and activation bypass the periodic throttle. Duplicates,
ordinary ticks and provider telemetry do not. New authority supersedes work after its current awaited
operation settles; cooperative play cancellation avoids waiting for the YouTube 4 s autoplay timeout.
The session supplies a scheduler; its next deadline is the earlier of the periodic tick and the next
future event's effective time. Extra ticks never postpone an existing earlier deadline. Browser timer
granularity/throttling, clock uncertainty and in-flight SDK calls can still delay application.
Source invalidation/clear/clock loss are synchronous on observation even if the worker is blocked.
Tick/event storms only mark pending work; they do not run parallel reconciliations. At most one new
routine pass starts per interval. Explicit tick owners must continue ticking when work is deferred by the
interval. Provider callbacks must represent actual state changes, not continuously emitted telemetry.

Initial alignment, authoritative seek and activation retries force alignment. A change from paused to
playing aligns once to the latest projected server position, including delivery latency smaller than
the routine tolerance; repeated play events with unchanged intent do not force another alignment.
Pause issues the SDK pause before reading position, then corrects the fixed authoritative pause anchor
only if error exceeds 0.1 s. It never adds delivery/elapsed time to a paused anchor. Resume while already
buffering sends play first and consumes that control alignment, preserving cued-provider recovery.
Following a slow seek/play operation, refresh authority and take at most one extra measured catch-up
seek for that operation if both elapsed media time and residual error exceed 0.1 s. A catch-up seek does
not recursively trigger another catch-up check. A startup pass can therefore issue the initial seek
plus at most two catch-ups if both its original seek and play were slow. Buffering suppresses these
checks; further residuals use routine measured drift and cooldown. There is no fine-grained rate nudge.
Routine position drift uses detection/release bands, sample confirmation and cooldown; it does not
seek on every position read. The bounds limit correction churn rather than guaranteeing physical sync.
Rate support is explicit: an unsupported desired rate pauses/holds locally and reports
`unsupported-rate`. No play, rate setter, or correction seeks emulate that rate. A later supported rate
resumes normal reconciliation. Adapters must accurately advertise rate 1 if supported and apply the
requested supported rate; the controller does not pretend a no-op setter works.

`NotAllowedError` from play reports `autoplay-blocked` and suppresses automatic play/seek retries until
activation (or authoritative paused state/new generation). Other current-generation failures report
`error` with the occurrence scope and stop the adapter; only explicit `retry` or replacement recreates
it. Buffering suppresses position/rate correction, while authoritative play/pause remains usable.
After `report({type: "resumed"})`, measured drift and the latest
authoritative intent determine which corrections are needed. Recovery alone never forces another seek:
seeks can themselves trigger buffering. Playback/rate observations retain actual provider state to avoid
repeating successful commands. Use captured reports for `buffering`, `resumed`, `playback-change`,
`rate-change`, and `error`; route a
provider ready-after-buffer/remount notification appropriately. A physical remount needs a new adapter,
through explicit snapshot/retry integration, rather than silently changing a captured instance.

All these events/statuses are local observations. The controller sends no server pause, next, ended,
queue, or fairness commands. Clear unloads rendering and says nothing about server play intent.
Occurrence replacement restarts even identical media; same-occurrence source refresh preserves domain
identity. Neither awards music playback credit. Volume/captions/quality remain outside this controller.

## Local verification

The controller tests inject clocks, timers, resolvers and adapters; they do not contact providers or
run the application. Client typecheck and scoped Biome/ESLint checks apply. Run Vitest through pinned
Yarn with `config: false`, Node environment, `cache: false`, and inline Vite `envFile: false` plus an
empty/nonexistent `envDir`, avoiding the application's env-loading Vite config. Alias
`ott-common/playback/index.js` to this checkout's `common/playback/index.ts` if using shared local
dependencies. A reusable invocation from the repository root (PowerShell):

```powershell
@'
import { startVitest } from "vitest/node";
import { resolve } from "node:path";
const ctx = await startVitest("test", ["client/tests/unit/playback-controller.spec.ts"],
  { config: false, watch: false, cache: false, environment: "node",
    poolOptions: { threads: { singleThread: true } } },
  { envFile: false, envDir: resolve(".no-playback-env"), resolve: { alias: {
    "ott-common/playback/index.js": resolve("common/playback/index.ts")
  } } });
if (!ctx) process.exitCode = 1;
else {
  process.exitCode = ctx.state.getFiles().some(f => f.result?.state === "fail") ||
    ctx.state.getUnhandledErrors().length ? 1 : 0;
  await ctx.close();
}
'@ | node .yarn/releases/yarn-4.1.0.cjs exec node --input-type=module
```

No end-to-end/browser/provider behavior is established until adapters and transport are integrated and
verified separately.

### Deterministic two-client evidence

`client/tests/unit/playback-sync.spec.ts` uses two controllers with independent provider state and
different local monotonic origins, a shared simulated server time estimate, delayed event delivery,
and delayed SDK readiness/position/seek/play operations. It performs no network or browser actions.

- A play effective at server-relative ms 1 and delivered at ms 15 issues the receiver's play at receipt
  with no added controller polling delay, seeking to anchor + 0.014 s at rate 1 (0.028 s at rate 2).
- Pause delayed 140 ms stops on receipt and realigns both providers to the fixed pause anchor; two
  seconds paused adds no media time. Resume delayed 150 ms again projects to the common server time.
- A future pause effective at ms 123 is applied by both clients at ms 123, between periodic ticks,
  with no early pause. In the real session, a future play at ms 123 also runs before its 250 ms tick.
- Startup delayed 80 ms seeks to anchor + 0.080 s. An additional 400 ms seek delay and 150 ms play
  delay are measured and compensated with two bounded catch-ups, bringing the simulated positions
  together. A 40 ms position read and delayed explicit seek likewise use the projection at completion.
- A 0.6 s sustained offset is corrected after two 250 ms samples, within 500 ms of the injected offset
  in the fixture. Alternating 450 ms/20 ms or +450 ms/-450 ms sampling noise causes no extra seeks.
  Continuous injected drift cannot cause routine correction seeks more often than once per second.
- New pause received while play waits 4 s cancels play and issues pause at receipt in both clients;
  pending replacement cancels the old generation before starting its successor. Neither late work nor
  seek-induced buffering starts another audible instance or repeatedly sends play/rate commands.

These are simulation observations with an exact injected clock and cooperative provider, not live
audible-output bounds. Production clock estimates have uncertainty, SDK position reads may be cached
or coarse, seek completion and decoder/audio-device latency are provider/browser dependent, and
background throttling may delay timers. Corrections remain thresholded and bounded, so a residual under
the threshold can remain. The official YouTube API exposes no separate audio/video presentation
timestamps or precise audible-output clock. No sample-perfect sync, millisecond physical-output
guarantee, forced 144p, audio-only stream, or new browser measurement is claimed.
