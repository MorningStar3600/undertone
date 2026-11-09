# Browser estimate of server time

`client/src/playback/server-clock.ts` is a transport-independent millisecond clock estimator. It has no framework/provider dependencies, timers, network access, or wall-clock reads. It starts uncalibrated; a non-ready result has `serverNowMs: null`, never a local timestamp disguised as server time.

## API and lifecycle

```ts
const clock = createServerClock({ now: () => performance.now() });

clock.reset(); // Returns a new numeric generation; clears all calibration and probes.
const probe = clock.createProbe(); // { generation, nonce, sentAtMs } | null
// Send { generation: probe.generation, nonce: probe.nonce } immediately.
// Server echoes both fields, plus serverReceiveMs and serverSendMs.
clock.acceptReply(reply, receivedAtMs); // boolean; unknown input is validated.
const estimate = clock.getEstimate(); // ServerClockEstimate
```

Keep one instance for the connection/controller lifetime. Call `reset()` on every new connection, room change, and explicit suspend/resume (including lifecycle events where the monotonic clock may stop during OS sleep). The factory already starts an initial generation. A reset makes the estimate non-ready until another valid reply arrives. Nonces are increasing decimal strings within each generation and require no randomness. Preserve the **echoed** generation: never replace it with the current generation when handling a delayed response. Do not route old callbacks into a newly created clock instance, whose ID space is separate.

`createProbe()` records the injected local time and returns `null` at the in-flight limit or when the local clock is nonfinite. Do not queue a probe for later transmission: any local send queue delay contributes to its measured round trip. The returned `sentAtMs` is local bookkeeping, not server time. Capture optional `receivedAtMs` at the start of the application-message handler using the same monotonic clock; omitting it samples `now()` on acceptance. It cannot be before the send, after `now()`, or already expired. A native WebSocket ping is not required; transport wiring must supply an application probe/reply exchange later.

`getEstimate()` returns `generation`, `sampleCount`, `pendingProbeCount`, and a discriminated `ready` result:

-   Ready: `serverNowMs`, `uncertaintyMs`, `sampleAgeMs`, and processing-adjusted `roundTripMs`, all in milliseconds.
-   Non-ready: all four measurement fields are `null`. Defer server-timeline projection and request calibration instead of falling back to `performance.now()` or `Date.now()`.

All maintenance happens on API calls. No background work is scheduled. A rejected matching reply consumes its nonce, including one with invalid timestamps; an unsolicited or stale-generation reply cannot consume a current probe. Each probe can produce at most one sample. Reordered replies are accepted if their own probe is still pending and valid.

## Calibration and correction policy

For local send/receipt times `t0`, `t3` and server receipt/send times `t1`, `t2`:

```text
processing = t2 - t1
network RTT = (t3 - t0) - processing
client midpoint = t0 + (t3 - t0) / 2
server midpoint = t1 + processing / 2
server now = server midpoint + (local now - client midpoint)
uncertainty = network RTT / 2
            + (local now - client midpoint) * maxDriftPpm / 1_000_000
```

Reject nonfinite values, backwards server processing, negative adjusted RTT, invalid local timing, expired/replayed/unsolicited probes, and stale generations. Zero network RTT is permitted. Server timestamps must share one advancing clock domain with the authoritative timeline and use milliseconds; they need not be Unix epoch values. Processing exclusion assumes server and local milliseconds run at approximately the same rate.

Select the smallest adjusted RTT among retained, unexpired samples; newest receipt wins ties. Keep the newest receipts when the sample window fills. This resists a high-latency outlier without preserving an old low-RTT sample indefinitely. Expiring or evicting the preferred sample can select a different estimate.

Apply calibration changes immediately, with no slew and no monotonic clamp. **The estimate can decrease** when a better calibration corrects a previously high offset. Between calibrations it advances one millisecond per injected millisecond. A clamp could freeze the estimate for an arbitrarily long correction, so playback smoothing belongs in the later controller. Consumers should re-project authoritative timeline anchors rather than integrate deltas across calibration changes. This module estimates server clock time, not media position or playback rate; convert to media seconds only at that boundary.

Half the adjusted RTT describes the ambiguity caused by unknown outbound/inbound delay asymmetry. The drift allowance is a configurable assumption, not a measured bound. Timer quantization, server clock adjustments, and drift beyond that allowance add error. This is not a precision-time service and makes no microsecond accuracy claim.

## Defaults and expiry

| Option             | Default | Policy                                                                         |
| ------------------ | ------: | ------------------------------------------------------------------------------ |
| `probeTimeoutMs`   |   5,000 | Reject at or after this age from send, including buffered replies.             |
| `sampleMaxAgeMs`   |  30,000 | Expire at or after this age from captured receipt, even with continuous reads. |
| `maxClockGapMs`    |  30,000 | A larger gap between API observations resets the generation.                   |
| `maxPendingProbes` |       8 | Refuse new probes at capacity; accepted/expired probes free space.             |
| `maxSamples`       |       8 | Retain the newest receipts.                                                    |
| `maxDriftPpm`      |     100 | Grow uncertainty from the client midpoint; zero disables the allowance.        |

Timeouts must be finite and positive; capacities must be positive safe integers; drift must be finite and between 0 and 1,000,000 ppm. Invalid configuration throws `RangeError`. Nonce capacity exhaustion returns `null` until reset; generation exhaustion throws rather than reusing an ID (both require roughly nine quadrillion increments).

A backwards or nonfinite local clock also resets calibration. A large forward jump expires samples and triggers the gap reset. A monotonic clock that stops throughout sleep cannot reveal that sleep through elapsed time alone: **the integration must reset on suspend/resume**. Check `ready` on each use, and periodically probe under a future lifecycle/connection owner; this module never schedules probes itself. Server restarts or changes of clock origin likewise require a connection-generation reset.

## Focused verification

Tests in `client/tests/unit/server-clock.spec.ts` inject local time and cover arbitrary offsets, server processing, asymmetry, latency selection/expiry, reordering, replay, old generations with reused nonce strings, bounded storage, explicit and detected suspension, invalid input, wall-clock independence, and elapsed-time mapping.

Run these pure Node tests with an isolated Vitest config rather than `client/vite.config.js`, which selects the application env directory. Disable env loading with `envFile: false` in the inline Vite overrides (the fourth argument to `startVitest` from `vitest/node`), set `config: false` in its Vitest options, use an empty `envDir`, and select only the clock test. Use `environment: "node"`; no provider, server, Redis, or browser is needed. No transport or controller wiring is included here.
