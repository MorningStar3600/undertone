import { describe, expect, it, vi } from "vitest";
import {
	acceptPlaybackEvent,
	compactPlaybackTimeline,
	createPlaybackTimeline,
	type PlaybackEvent,
	type PlaybackTimeline,
} from "ott-common/playback/index.js";
import {
	createPlaybackController,
	PlaybackDeferredError,
	type PlaybackAdapterContext,
	type PlaybackControllerOptions,
	type PlaybackControllerStatus,
	type PlaybackRecovery,
	type PlaybackResult,
} from "../../src/playback/playback-controller.js";
import type { ServerClockEstimate } from "../../src/playback/server-clock.js";

const media = { service: "youtube", id: "ordinary-video" };
const load = (
	overrides: Partial<Extract<PlaybackEvent, { type: "load" }>> = {},
): PlaybackEvent => ({
	epoch: "room-epoch",
	sequence: 1,
	effectiveAtMs: 1_000,
	occurrenceId: 1,
	type: "load",
	media,
	positionSeconds: 10,
	isPlaying: true,
	rate: 1,
	...overrides,
});

const control = (
	type: "pause" | "play" | "clear",
	sequence = 2,
	effectiveAtMs = 1_000,
	occurrenceId = 1,
): PlaybackEvent => ({ epoch: "room-epoch", type, sequence, effectiveAtMs, occurrenceId });

const snapshot = (...events: PlaybackEvent[]): PlaybackTimeline =>
	events.reduce(
		(timeline, event) => acceptPlaybackEvent(timeline, event).timeline,
		createPlaybackTimeline("room-epoch", 1_000),
	);

const deferred = <T = void>() => {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
};

const fakeAdapter = () => {
	let position = 0;
	return {
		ready: vi.fn<[AbortSignal], PlaybackResult<void>>(() => undefined),
		load: vi.fn<[string, AbortSignal], PlaybackResult<void>>(() => undefined),
		getPosition: vi.fn<[AbortSignal], PlaybackResult<number>>(() => position),
		seek: vi.fn<[number, AbortSignal], PlaybackResult<void>>(value => {
			position = value;
		}),
		supportsRate: vi.fn((rate: number) => [1, 2].includes(rate)),
		setRate: vi.fn<[number, AbortSignal], PlaybackResult<void>>(() => undefined),
		play: vi.fn<[AbortSignal], PlaybackResult<void>>(() => undefined),
		pause: vi.fn<[AbortSignal], PlaybackResult<void>>(() => undefined),
		dispose: vi.fn(() => undefined),
		setPosition: (value: number) => {
			position = value;
		},
	};
};

const setup = (overrides: Partial<PlaybackControllerOptions<string>> = {}) => {
	let localMs = 0;
	let serverMs = 1_000;
	let ready = true;
	let clockGeneration = 1;
	let nextTimer = 0;
	const timers = new Map<number, { callback: () => void; dueMs: number }>();
	const adapters: ReturnType<typeof fakeAdapter>[] = [];
	const contexts: PlaybackAdapterContext[] = [];
	const recoveries: PlaybackRecovery[] = [];
	const statuses: PlaybackControllerStatus[] = [];
	const options: PlaybackControllerOptions<string> = {
		clock: {
			getEstimate: (): ServerClockEstimate => ({
				generation: clockGeneration,
				sampleCount: ready ? 1 : 0,
				pendingProbeCount: 0,
				...(ready
					? {
							ready: true,
							serverNowMs: serverMs,
							uncertaintyMs: 0,
							sampleAgeMs: 0,
							roundTripMs: 0,
						}
					: {
							ready: false,
							serverNowMs: null,
							uncertaintyMs: null,
							sampleAgeMs: null,
							roundTripMs: null,
						}),
			}),
		},
		now: () => localMs,
		scheduler: {
			setTimeout: (callback, delayMs) => {
				const handle = ++nextTimer;
				timers.set(handle, { callback, dueMs: localMs + delayMs });
				return handle;
			},
			clearTimeout: handle => timers.delete(handle as number),
		},
		resolveSource: vi.fn(publicMedia => publicMedia.id),
		createAdapter: context => {
			const adapter = fakeAdapter();
			contexts.push(context);
			adapters.push(adapter);
			return adapter;
		},
		onRecovery: recovery => recoveries.push(recovery),
		onStatus: status => statuses.push(status),
		...overrides,
	};
	const controller = createPlaybackController(options);
	const idle = async () => {
		await controller.whenIdle();
		await controller.whenIdle();
	};
	return {
		controller,
		adapters,
		contexts,
		recoveries,
		statuses,
		timers,
		options,
		idle,
		setServer: (value: number) => {
			serverMs = value;
		},
		setReady: (value: boolean) => {
			ready = value;
			clockGeneration += 1;
		},
		advance: async (milliseconds = 250) => {
			localMs += milliseconds;
			serverMs += milliseconds;
			for (const [handle, timer] of [...timers]) {
				if (timer.dueMs <= localMs) {
					timers.delete(handle);
					timer.callback();
				}
			}
			controller.tick();
			await idle();
		},
	};
};

describe("playback controller timeline and scheduling", () => {
	it.each([true, false])("joins an ordinary public video, playing=%s", async isPlaying => {
		const s = setup();
		s.setServer(2_250.9);
		expect(s.controller.installSnapshot(snapshot(load({ isPlaying })))).toBe(true);
		await s.idle();
		const a = s.adapters[0];
		expect(a.load).toHaveBeenCalledWith(media.id, s.contexts[0].signal);
		expect(a.ready.mock.invocationCallOrder[0]).toBeLessThan(
			a.load.mock.invocationCallOrder[0],
		);
		expect(a.seek).toHaveBeenCalledWith(isPlaying ? 11.25 : 10, s.contexts[0].signal);
		expect(a.setRate).toHaveBeenCalledWith(1, s.contexts[0].signal);
		expect(a.play).toHaveBeenCalledTimes(isPlaying ? 1 : 0);
		expect(a.pause).toHaveBeenCalledTimes(isPlaying ? 0 : 1);
		expect(s.controller.getStatus().code).toBe(isPlaying ? "playing" : "paused");
	});

	it("does nothing until both a valid snapshot and clock calibration exist", async () => {
		const s = setup();
		s.controller.tick();
		expect(s.controller.getStatus().code).toBe("waiting-snapshot");
		s.setReady(false);
		s.controller.installSnapshot(snapshot(load()));
		await s.idle();
		expect(s.adapters).toHaveLength(0);
		expect(s.controller.getStatus().code).toBe("waiting-clock");
		s.setReady(true);
		await s.advance();
		expect(s.adapters[0].play).toHaveBeenCalledOnce();
	});

	it("retains future pause and load through compaction and applies only at effective times", async () => {
		const s = setup();
		s.controller.installSnapshot(
			snapshot(
				load(),
				control("pause", 2, 2_000),
				load({ sequence: 3, occurrenceId: 2, effectiveAtMs: 3_000, isPlaying: false }),
			),
		);
		await s.idle();
		await s.advance(500);
		expect(s.adapters).toHaveLength(1);
		expect(s.adapters[0].pause).not.toHaveBeenCalled();
		await s.advance(500);
		expect(s.adapters[0].pause).toHaveBeenCalledOnce();
		await s.advance(1_000);
		expect(s.adapters).toHaveLength(2);
		expect(s.adapters[0].dispose).toHaveBeenCalledOnce();
		expect(s.adapters[1].seek).toHaveBeenCalledWith(10, s.contexts[1].signal);
		expect(s.contexts[1].occurrenceId).toBe(2);
	});

	it("restarts an identical source on a new occurrence and refreshes a source within one", async () => {
		const s = setup();
		s.controller.installSnapshot(snapshot(load()));
		await s.idle();
		s.controller.acceptEvent(load({ sequence: 2, occurrenceId: 2 }));
		expect(s.adapters[0].dispose).toHaveBeenCalledOnce();
		await s.advance();
		s.controller.acceptEvent({ ...control("play", 3, 1_250, 2), type: "source", media });
		expect(s.adapters[1].dispose).toHaveBeenCalledOnce();
		await s.advance();
		expect(s.adapters).toHaveLength(3);
		expect(s.contexts.map(c => c.occurrenceId)).toEqual([1, 2, 2]);
		expect(s.recoveries).toEqual([]);
	});

	it.each(["sequence-gap", "sequence-conflict", "epoch-mismatch"])(
		"fails closed and requests recovery once for %s",
		async reason => {
			const s = setup();
			const futurePause = control("pause", 2, 3_000);
			s.controller.installSnapshot(snapshot(load(), futurePause));
			await s.idle();
			const bad =
				reason === "sequence-gap"
					? control("play", 4, 4_000)
					: reason === "sequence-conflict"
						? { ...futurePause, type: "play" }
						: { ...futurePause, epoch: "foreign" };
			expect(s.controller.acceptEvent(bad)).toBe("rejected");
			expect(s.controller.acceptEvent(bad)).toBe("rejected");
			expect(s.recoveries).toMatchObject([{ reason, receivedSequence: 2 }]);
			expect(s.adapters[0].dispose).toHaveBeenCalledOnce();
			await s.advance();
			expect(s.adapters).toHaveLength(1);
			expect(s.controller.installSnapshot(snapshot(load(), futurePause))).toBe(true);
			await s.advance();
			expect(s.adapters).toHaveLength(2);
		},
	);

	it("ignores duplicate/stale events without creating new work or occurrences", async () => {
		const s = setup();
		const pause = control("pause", 2, 5_000);
		s.controller.installSnapshot(snapshot(load(), pause));
		await s.idle();
		expect(s.controller.acceptEvent(pause)).toBe("duplicate");
		expect(s.controller.acceptEvent(load())).toBe("stale");
		expect(s.adapters).toHaveLength(1);
		expect(s.recoveries).toEqual([]);
	});

	it("rejects same-epoch receipt rollback and equal-cursor conflicting snapshots", async () => {
		const s = setup();
		s.controller.installSnapshot(snapshot(load(), control("pause", 2, 2_000)));
		await s.idle();
		expect(s.controller.installSnapshot(snapshot(load()))).toBe(false);
		expect(s.recoveries[0].reason).toBe("snapshot-rollback");
		const t = setup();
		t.controller.installSnapshot(snapshot(load()));
		await t.idle();
		expect(t.controller.installSnapshot(snapshot(load({ positionSeconds: 99 })))).toBe(false);
		expect(t.recoveries[0].reason).toBe("snapshot-conflict");
	});

	it("allows delayed consistent snapshots and explicitly authorized epoch replacement", async () => {
		const s = setup();
		const original = snapshot(load());
		s.setServer(2_000);
		s.controller.installSnapshot(original);
		await s.idle();
		// The server's snapshot horizon can lag the client's compacted horizon in transit.
		expect(s.controller.installSnapshot(compactPlaybackTimeline(original, 1_500))).toBe(true);
		await s.advance();
		expect(s.controller.installSnapshot(createPlaybackTimeline("new-epoch", 2_250))).toBe(true);
		expect(s.controller.getStatus().code).toBe("idle");
		expect(s.recoveries).toEqual([]);
	});

	it("rejects same-epoch occurrence and effective-time rollback even at a higher cursor", async () => {
		const ordinal = setup();
		ordinal.controller.installSnapshot(
			snapshot(load(), load({ sequence: 2, occurrenceId: 2 })),
		);
		await ordinal.idle();
		expect(
			ordinal.controller.installSnapshot(
				snapshot(load(), control("play"), control("pause", 3)),
			),
		).toBe(false);
		expect(ordinal.recoveries[0].reason).toBe("snapshot-rollback");
		const time = setup();
		time.controller.installSnapshot(snapshot(load(), control("pause", 2, 3_000)));
		await time.idle();
		expect(
			time.controller.installSnapshot(
				snapshot(load(), control("play"), control("pause", 3, 2_000)),
			),
		).toBe(false);
		expect(time.recoveries[0].reason).toBe("snapshot-rollback");
	});

	it.each([NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1])(
		"does not project an unusable ready clock reading %s",
		async timeMs => {
			const s = setup();
			s.setServer(timeMs);
			s.controller.installSnapshot(snapshot(load()));
			await s.idle();
			expect(s.adapters).toHaveLength(0);
			expect(s.controller.getStatus().code).toBe("waiting-clock");
		},
	);

	it.each([
		{ intervalMs: 0 },
		{ intervalMs: 49 },
		{ intervalMs: 2_147_483_648 },
		{ driftThresholdSeconds: NaN },
		{ controlToleranceSeconds: NaN },
		{ driftReleaseSeconds: 2 },
		{ seekCooldownMs: -1 },
	])("rejects invalid controller configuration %j", options => {
		expect(() => setup(options)).toThrow(RangeError);
	});

	it("rejects invalid snapshots/events and events without a trusted snapshot", () => {
		const s = setup();
		expect(s.controller.acceptEvent(load())).toBe("rejected");
		expect(s.recoveries[0].reason).toBe("missing-snapshot");
		expect(s.controller.installSnapshot({})).toBe(false);
		expect(s.controller.installSnapshot(snapshot())).toBe(true);
		expect(s.controller.acceptEvent({ ...load(), privateUrl: "secret" })).toBe("rejected");
		expect(s.recoveries[1].reason).toBe("invalid-event");
		const invalid = setup();
		expect(invalid.controller.installSnapshot({})).toBe(false);
		expect(invalid.recoveries[0].reason).toBe("invalid-snapshot");
	});

	it("clamps backward calibration to the baseline and floors fractional Unix milliseconds", async () => {
		const s = setup();
		s.setServer(2_500.99);
		s.controller.installSnapshot(snapshot(load(), control("pause", 2, 2_500)));
		await s.idle();
		expect(s.adapters[0].seek).toHaveBeenCalledWith(11.5, s.contexts[0].signal);
		s.setServer(1_000.1);
		await s.advance();
		expect(s.controller.getStatus().code).toBe("paused");
		expect(s.adapters[0].play).not.toHaveBeenCalled();
		const t = setup();
		t.setServer(1_999.999);
		t.controller.installSnapshot(snapshot(load(), control("pause", 2, 2_000)));
		await t.idle();
		expect(t.adapters[0].seek).toHaveBeenCalledWith(10.999, t.contexts[0].signal);
		expect(t.controller.getStatus().code).toBe("playing");
	});

	it("stops rendering on lost/reset calibration and reloads only after ready", async () => {
		const s = setup();
		s.controller.installSnapshot(snapshot(load()));
		await s.idle();
		s.setReady(false);
		s.controller.tick();
		expect(s.adapters[0].dispose).toHaveBeenCalledOnce();
		expect(s.controller.getStatus().code).toBe("waiting-clock");
		await s.advance(5_000);
		expect(s.adapters).toHaveLength(1);
		s.setReady(true);
		await s.advance();
		expect(s.adapters[1].seek).toHaveBeenCalledWith(15.25, s.contexts[1].signal);
	});

	it("works with explicit ticks and bounds scheduled storm work and timer ownership", async () => {
		const s = setup({ scheduler: undefined });
		s.controller.installSnapshot(snapshot(load()));
		await s.idle();
		for (let i = 0; i < 100; i++) {
			s.controller.tick();
		}
		await s.idle();
		expect(s.adapters[0].getPosition).toHaveBeenCalledOnce();
		expect(s.timers.size).toBe(0);
		await s.advance();
		expect(s.adapters[0].getPosition).toHaveBeenCalledTimes(2);
		const scheduled = setup();
		scheduled.controller.installSnapshot(snapshot(load()));
		await scheduled.idle();
		for (let i = 0; i < 100; i++) {
			scheduled.controller.tick();
		}
		expect(scheduled.timers.size).toBe(1);
		scheduled.controller.dispose();
		expect(scheduled.timers.size).toBe(0);
	});
});

describe("playback controller async ownership and local outcomes", () => {
	it("consumes lifecycle alignment before seek-induced buffering callbacks", async () => {
		const s = setup();
		s.controller.installSnapshot(snapshot(load({ isPlaying: false })));
		await s.idle();
		const a = s.adapters[0];
		a.setPosition(9.4);
		a.seek.mockImplementation(position => {
			a.setPosition(position);
			s.contexts[0].report({ type: "buffering" });
			s.contexts[0].report({ type: "resumed" });
		});
		s.controller.resume();
		await s.idle();
		await s.advance(2_000);
		expect(a.seek).toHaveBeenCalledTimes(2);
		expect(a.pause).toHaveBeenCalledOnce();
		expect(a.play).not.toHaveBeenCalled();
		expect(a.dispose).not.toHaveBeenCalled();
		s.controller.dispose();
	});
	it("bounds deferred automatic retry to one per generation despite repeated lifecycle signals", async () => {
		const a = fakeAdapter();
		a.play.mockRejectedValue(new PlaybackDeferredError("Deferred start"));
		const s = setup({ createAdapter: () => a });
		s.controller.installSnapshot(snapshot(load()));
		await s.idle();
		expect(s.controller.getStatus().code).toBe("buffering");
		await s.advance(1_000);
		expect(a.play).toHaveBeenCalledOnce();
		s.controller.resume();
		s.controller.resume();
		await s.idle();
		expect(a.play).toHaveBeenCalledTimes(2);
		for (let i = 0; i < 5; i++) {
			await s.advance(1_000);
			s.controller.resume();
			await s.idle();
		}
		expect(a.play).toHaveBeenCalledTimes(2);
		expect(a.dispose).not.toHaveBeenCalled();
		s.controller.acceptEvent(control("pause", 2, 7_000));
		await s.idle();
		expect(a.pause).toHaveBeenCalledOnce();
		expect(s.controller.getStatus().code).toBe("paused");
		s.controller.dispose();
	});
	it("retries once when focus arrived during the pending bounded play wait", async () => {
		const pending = deferred();
		const a = fakeAdapter();
		a.play.mockReturnValueOnce(pending.promise);
		const s = setup({ createAdapter: () => a });
		s.controller.installSnapshot(snapshot(load()));
		for (let i = 0; i < 20; i++) {
			await Promise.resolve();
		}
		expect(a.play).toHaveBeenCalledOnce();
		s.controller.resume();
		pending.reject(new PlaybackDeferredError("Deferred start"));
		await s.idle();
		expect(a.play).toHaveBeenCalledTimes(2);
		expect(s.controller.getStatus().code).toBe("playing");
		s.controller.dispose();
	});
	it("does not retry genuine policy denial on lifecycle resume", async () => {
		const a = fakeAdapter();
		a.play.mockRejectedValue(new DOMException("Policy", "NotAllowedError"));
		const s = setup({ createAdapter: () => a });
		s.controller.installSnapshot(snapshot(load()));
		await s.idle();
		for (let i = 0; i < 4; i++) {
			await s.advance(1_000);
			s.controller.resume();
			await s.idle();
		}
		expect(a.play).toHaveBeenCalledOnce();
		expect(a.seek).toHaveBeenCalledOnce();
		expect(s.controller.getStatus().code).toBe("autoplay-blocked");
		s.controller.dispose();
	});
	it("ignores stale deferred completion and telemetry after occurrence replacement", async () => {
		const pending = deferred();
		const s = setup();
		s.controller.installSnapshot(snapshot(load({ isPlaying: false })));
		await s.idle();
		s.adapters[0].play.mockReturnValueOnce(pending.promise);
		s.controller.acceptEvent(control("play"));
		for (let i = 0; i < 20; i++) {
			await Promise.resolve();
		}
		s.controller.acceptEvent(load({ sequence: 3, occurrenceId: 2, isPlaying: false }));
		pending.reject(new PlaybackDeferredError("Stale"));
		await s.idle();
		s.contexts[0].report({ type: "resumed" });
		s.contexts[0].report({ type: "playback-change", isPlaying: true });
		s.controller.resume();
		await s.idle();
		expect(s.adapters).toHaveLength(2);
		expect(s.adapters[0].dispose).toHaveBeenCalledOnce();
		expect(s.adapters[1].play).not.toHaveBeenCalled();
		expect(s.controller.getStatus()).toMatchObject({
			code: "paused",
			scope: { occurrenceId: 2 },
		});
		s.controller.dispose();
	});
	it.each(["setRate", "seek", "play"] as const)(
		"ignores late %s rejection after a new occurrence",
		async method => {
			const pending = deferred();
			const old = fakeAdapter();
			const fresh = fakeAdapter();
			old[method].mockReturnValueOnce(pending.promise);
			const factory = vi.fn().mockReturnValueOnce(old).mockReturnValue(fresh);
			const s = setup({ createAdapter: factory });
			s.controller.installSnapshot(snapshot(load()));
			for (let i = 0; i < 15; i++) {
				await Promise.resolve();
			}
			expect(old[method]).toHaveBeenCalledOnce();
			s.controller.acceptEvent(load({ sequence: 2, occurrenceId: 2 }));
			expect(old.dispose).toHaveBeenCalledOnce();
			expect(factory).toHaveBeenCalledOnce();
			pending.reject({ name: "NotAllowedError" });
			await s.idle();
			await s.advance();
			expect(fresh.play).toHaveBeenCalledOnce();
			expect(s.controller.getStatus()).toMatchObject({
				code: "playing",
				scope: { occurrenceId: 2 },
			});
			expect(
				s.statuses.some(
					status => status.code === "error" || status.code === "autoplay-blocked",
				),
			).toBe(false);
		},
	);

	it("aligns an authoritative seek arriving during an old position read", async () => {
		const pending = deferred<number>();
		const a = fakeAdapter();
		a.getPosition.mockReturnValueOnce(pending.promise);
		const s = setup({ createAdapter: () => a });
		s.controller.installSnapshot(snapshot(load()));
		for (let i = 0; i < 12; i++) {
			await Promise.resolve();
		}
		s.controller.acceptEvent({ ...control("play"), type: "seek", positionSeconds: 80 });
		pending.resolve(10);
		await s.idle();
		expect(a.seek).toHaveBeenCalledOnce();
		expect(a.seek).toHaveBeenCalledWith(80, expect.anything());
		expect(a.play).toHaveBeenCalledOnce();
		expect(a.load).toHaveBeenCalledOnce();
	});

	it("handles buffer resume before the load promise settles", async () => {
		const pending = deferred();
		const a = fakeAdapter();
		a.load.mockReturnValueOnce(pending.promise);
		const factory = vi.fn((_context: PlaybackAdapterContext) => a);
		const s = setup({ createAdapter: factory });
		s.controller.installSnapshot(snapshot(load()));
		for (let i = 0; i < 12; i++) {
			await Promise.resolve();
		}
		const context: PlaybackAdapterContext = factory.mock.calls[0][0];
		context.report({ type: "buffering" });
		context.report({ type: "resumed" });
		pending.resolve();
		await s.idle();
		expect(a.load).toHaveBeenCalledOnce();
		expect(a.play).toHaveBeenCalledOnce();
		expect(s.controller.getStatus().code).toBe("playing");
	});

	it("captures gesture unlock synchronously and honors a later authoritative pause", async () => {
		const a = { ...fakeAdapter(), activate: vi.fn() };
		a.play.mockRejectedValueOnce({ name: "NotAllowedError" });
		const s = setup({ createAdapter: () => a });
		s.controller.installSnapshot(snapshot(load()));
		await s.idle();
		s.controller.userActivated();
		expect(a.activate).toHaveBeenCalledOnce();
		s.controller.acceptEvent(control("pause"));
		await s.advance();
		expect(a.play).toHaveBeenCalledOnce();
		expect(a.pause).toHaveBeenCalledOnce();
		expect(s.controller.getStatus().code).toBe("paused");
	});

	it("realigns an explicit seek despite drift cooldown and reapplies local play changes", async () => {
		const s = setup();
		s.controller.installSnapshot(snapshot(load()));
		await s.idle();
		s.controller.acceptEvent({ ...control("play"), type: "seek", positionSeconds: 25 });
		await s.advance();
		expect(s.adapters[0].seek).toHaveBeenCalledTimes(2);
		s.contexts[0].report({ type: "playback-change", isPlaying: false });
		await s.advance();
		expect(s.adapters[0].play).toHaveBeenCalledTimes(2);
		expect(s.recoveries).toEqual([]);
	});

	it("keeps startup source work singular across authority changes during API readiness", async () => {
		const pending = deferred();
		const a = fakeAdapter();
		a.ready.mockReturnValueOnce(pending.promise);
		const resolver = vi.fn(() => media.id);
		const s = setup({ createAdapter: () => a, resolveSource: resolver });
		s.controller.installSnapshot(snapshot(load()));
		for (let i = 0; i < 8; i++) {
			await Promise.resolve();
		}
		s.controller.acceptEvent(control("pause"));
		pending.resolve();
		await s.idle();
		expect(resolver).toHaveBeenCalledOnce();
		expect(a.ready).toHaveBeenCalledOnce();
		expect(a.load).toHaveBeenCalledOnce();
		expect(a.pause).toHaveBeenCalledOnce();
		expect(a.play).not.toHaveBeenCalled();
	});

	it.each(["resolve", "ready", "load", "getPosition"] as const)(
		"ignores late %s completion across a replacement",
		async boundary => {
			const pending = deferred<string | number | void>();
			const old = fakeAdapter();
			const fresh = fakeAdapter();
			// eslint-disable-next-line vitest/no-conditional-in-test -- One matrix row per pending SDK boundary.
			if (boundary !== "resolve") {
				old[boundary].mockImplementationOnce(() => pending.promise as never);
			}
			const factory = vi.fn().mockReturnValueOnce(old).mockReturnValue(fresh);
			const resolver = vi.fn().mockReturnValue(media.id);
			// eslint-disable-next-line vitest/no-conditional-in-test -- Resolution is the non-SDK matrix boundary.
			if (boundary === "resolve") {
				resolver.mockReturnValueOnce(pending.promise);
			}
			const s = setup({ createAdapter: factory, resolveSource: resolver });
			s.controller.installSnapshot(snapshot(load()));
			// Let the serialized pipeline reach the injected pending boundary.
			for (let i = 0; i < 12; i++) {
				await Promise.resolve();
			}
			s.controller.acceptEvent(load({ sequence: 2, occurrenceId: 2, positionSeconds: 30 }));
			expect(old.dispose).toHaveBeenCalledOnce();
			expect(factory.mock.calls[0][0].signal.aborted).toBe(true);
			// The pending call is the only outstanding worker, even across tick storms.
			for (let i = 0; i < 100; i++) {
				s.controller.tick();
			}
			pending.resolve(boundary === "getPosition" ? 999 : media.id);
			await s.idle();
			await s.advance();
			expect(old.play).not.toHaveBeenCalled();
			expect(old.seek).not.toHaveBeenCalled();
			expect(fresh.seek).toHaveBeenCalledWith(30, factory.mock.calls[1][0].signal);
			expect(fresh.play).toHaveBeenCalledOnce();
			expect(s.recoveries).toEqual([]);
		},
	);

	it.each(["ready", "play"] as const)(
		"clears/disposes during %s rejection safely",
		async method => {
			const pending = deferred();
			const a = fakeAdapter();
			a[method].mockReturnValueOnce(pending.promise);
			const factory = vi.fn(() => a);
			const s = setup({ createAdapter: factory });
			s.controller.installSnapshot(snapshot(load()));
			for (let i = 0; i < 15; i++) {
				await Promise.resolve();
			}
			// eslint-disable-next-line vitest/no-conditional-in-test -- Cover both clear and terminal disposal.
			if (method === "ready") {
				s.controller.acceptEvent(control("clear"));
				expect(s.controller.getStatus().code).toBe("idle");
			} else {
				s.controller.dispose();
			}
			pending.reject({ name: "NotAllowedError" });
			await s.idle();
			expect(a.dispose).toHaveBeenCalledOnce();
			expect(
				s.statuses.some(
					status => status.code === "error" || status.code === "autoplay-blocked",
				),
			).toBe(false);
			expect(s.controller.getStatus().code).toBe(method === "ready" ? "idle" : "disposed");
			s.controller.dispose();
			expect(s.timers.size).toBe(0);
			expect(s.controller.acceptEvent(control("play", 3))).toBe("rejected");
			expect(s.controller.installSnapshot(snapshot(load()))).toBe(false);
		},
	);

	it("reprojects latest position after load, without replaying obsolete seek/play state", async () => {
		const pending = deferred();
		const a = fakeAdapter();
		a.load.mockReturnValueOnce(pending.promise);
		const s = setup({ createAdapter: () => a });
		s.controller.installSnapshot(snapshot(load()));
		for (let i = 0; i < 10; i++) {
			await Promise.resolve();
		}
		s.setServer(3_000);
		s.controller.acceptEvent(control("pause", 2, 2_000));
		pending.resolve();
		await s.idle();
		await s.advance();
		expect(a.load).toHaveBeenCalledOnce();
		expect(a.seek).toHaveBeenCalledWith(11, expect.anything());
		expect(a.play).not.toHaveBeenCalled();
		expect(a.pause).toHaveBeenCalledOnce();
	});

	it("reports autoplay denial locally and retries once after activation using latest time", async () => {
		const a = fakeAdapter();
		a.play.mockRejectedValueOnce({ name: "NotAllowedError" });
		const s = setup({ createAdapter: () => a });
		s.controller.installSnapshot(snapshot(load()));
		await s.idle();
		expect(s.controller.getStatus().code).toBe("autoplay-blocked");
		for (let i = 0; i < 20; i++) {
			await s.advance();
		}
		expect(a.play).toHaveBeenCalledOnce();
		expect(a.seek).toHaveBeenCalledOnce();
		s.controller.userActivated();
		await s.advance();
		expect(a.play).toHaveBeenCalledTimes(2);
		expect(a.seek).toHaveBeenLastCalledWith(15.25, expect.anything());
		expect(s.controller.getStatus().code).toBe("playing");
		expect(s.recoveries).toEqual([]);
	});

	it("corrects actual drift after buffer resume; stale notifications do nothing", async () => {
		const s = setup();
		s.controller.installSnapshot(snapshot(load()));
		await s.idle();
		s.contexts[0].report({ type: "buffering" });
		await s.advance(3_000);
		expect(s.adapters[0].getPosition).toHaveBeenCalledOnce();
		expect(s.controller.getStatus().code).toBe("buffering");
		s.contexts[0].report({ type: "resumed" });
		await s.advance();
		expect(s.adapters[0].seek).toHaveBeenCalledOnce();
		await s.advance();
		expect(s.adapters[0].seek).toHaveBeenLastCalledWith(13.5, s.contexts[0].signal);
		expect(s.adapters[0].play).toHaveBeenCalledOnce();
		expect(s.adapters[0].setRate).toHaveBeenCalledOnce();
		s.controller.acceptEvent(load({ sequence: 2, occurrenceId: 2, effectiveAtMs: 4_500 }));
		await s.advance();
		s.contexts[0].report({ type: "error", error: "stale failure" });
		s.contexts[0].report({ type: "buffering" });
		expect(s.controller.getStatus().code).toBe("playing");
		expect(s.controller.getStatus().scope?.occurrenceId).toBe(2);
	});

	it("does not turn seek-induced buffering into an endless correction loop", async () => {
		const s = setup({
			createAdapter: context => {
				const adapter = fakeAdapter();
				s.adapters.push(adapter);
				adapter.seek.mockImplementation(position => {
					adapter.setPosition(position);
					context.report({ type: "buffering" });
					queueMicrotask(() => {
						context.report({ type: "resumed" });
						context.report({ type: "playback-change", isPlaying: true });
					});
				});
				return adapter;
			},
		});
		s.controller.installSnapshot(snapshot(load()));
		await s.idle();
		for (let step = 1; step <= 24; step++) {
			s.adapters[0].setPosition(10 + step * 0.25);
			await s.advance();
		}
		expect(s.adapters[0].seek).toHaveBeenCalledOnce();
		expect(s.adapters[0].setRate).toHaveBeenCalledOnce();
		expect(s.adapters[0].pause).not.toHaveBeenCalled();
		expect(s.controller.getStatus().code).toBe("playing");
	});

	it.each([true, false])(
		"applies playback intent after a seek stalls, playing=%s",
		async isPlaying => {
			const s = setup({
				createAdapter: context => {
					const adapter = fakeAdapter();
					s.adapters.push(adapter);
					adapter.seek.mockImplementation(position => {
						adapter.setPosition(position);
						context.report({ type: "buffering" });
						// A cued YouTube player can remain UNSTARTED after seeking.
						// It will not emit resumed until play is explicitly requested.
					});
					adapter.play.mockImplementation(() => context.report({ type: "resumed" }));
					return adapter;
				},
			});
			s.controller.installSnapshot(snapshot(load({ isPlaying })));
			await s.idle();
			expect(s.adapters[0][isPlaying ? "play" : "pause"]).toHaveBeenCalledOnce();
			s.adapters[0].setPosition(10.25);
			await s.advance();
			expect(s.adapters[0][isPlaying ? "play" : "pause"]).toHaveBeenCalledOnce();
			expect(s.adapters[0].seek).toHaveBeenCalledOnce();
			s.controller.acceptEvent(control("play"));
			await s.idle();
			expect(s.adapters[0].play).toHaveBeenCalledOnce();
			s.adapters[0].setPosition(isPlaying ? 10.5 : 10.25);
			await s.advance();
			expect(s.adapters[0].play).toHaveBeenCalledOnce();
			await s.advance();
			expect(s.controller.getStatus().code).toBe("playing");
			expect(s.adapters[0].seek).toHaveBeenCalledOnce();
		},
	);

	it("uses drift tolerance, hysteresis and cooldown instead of repeated seeks", async () => {
		const s = setup({
			driftThresholdSeconds: 1.5,
			driftReleaseSeconds: 0.5,
			seekCooldownMs: 2_000,
		});
		s.controller.installSnapshot(snapshot(load({ isPlaying: false })));
		await s.idle();
		s.adapters[0].setPosition(9);
		await s.advance(2_000);
		expect(s.adapters[0].seek).toHaveBeenCalledOnce();
		s.adapters[0].setPosition(7);
		await s.advance();
		expect(s.adapters[0].seek).toHaveBeenCalledOnce();
		await s.advance();
		expect(s.adapters[0].seek).toHaveBeenCalledTimes(2);
		s.adapters[0].setPosition(7);
		await s.advance(500);
		expect(s.adapters[0].seek).toHaveBeenCalledTimes(2);
		// Once detected, drift in the middle band stays latched until corrected/released.
		s.adapters[0].setPosition(9);
		await s.advance(1_500);
		expect(s.adapters[0].seek).toHaveBeenCalledTimes(3);
	});
	it("corrects native rate changes without manufacturing buffering or seeking", async () => {
		const s = setup();
		s.controller.installSnapshot(snapshot(load()));
		await s.idle();
		s.contexts[0].report({ type: "rate-change", rate: 2 });
		await s.advance();
		expect(s.adapters[0].setRate).toHaveBeenCalledTimes(2);
		expect(s.adapters[0].setRate).toHaveBeenLastCalledWith(1, s.contexts[0].signal);
		expect(s.adapters[0].seek).toHaveBeenCalledOnce();
		expect(s.adapters[0].play).toHaveBeenCalledOnce();
		s.contexts[0].report({ type: "rate-change", rate: 1 });
		await s.advance();
		expect(s.adapters[0].setRate).toHaveBeenCalledTimes(2);
	});
	it("applies a pause received while buffering without waiting for the provider", async () => {
		const s = setup();
		s.controller.installSnapshot(snapshot(load()));
		await s.idle();
		s.contexts[0].report({ type: "buffering" });
		s.controller.acceptEvent(control("pause"));
		await s.advance();
		expect(s.adapters[0].pause).toHaveBeenCalledOnce();
		s.contexts[0].report({ type: "resumed" });
		s.contexts[0].report({ type: "playback-change", isPlaying: false });
		await s.advance();
		expect(s.adapters[0].pause).toHaveBeenCalledOnce();
		expect(s.controller.getStatus().code).toBe("paused");
	});

	it("holds unsupported rates locally without faking progress with seeks", async () => {
		const s = setup();
		s.controller.installSnapshot(snapshot(load({ rate: 1.5 })));
		await s.idle();
		for (let i = 0; i < 15; i++) {
			await s.advance();
		}
		const a = s.adapters[0];
		expect(s.controller.getStatus()).toMatchObject({ code: "unsupported-rate", rate: 1.5 });
		expect(a.pause).toHaveBeenCalledOnce();
		expect(a.seek).not.toHaveBeenCalled();
		expect(a.setRate).not.toHaveBeenCalled();
		expect(a.play).not.toHaveBeenCalled();
		s.controller.acceptEvent({ ...control("play", 2, 4_750), type: "rate", rate: 2 });
		await s.advance();
		expect(a.setRate).toHaveBeenCalledWith(2, s.contexts[0].signal);
		expect(a.play).toHaveBeenCalledOnce();
	});

	it("reports current adapter failure once and only retries explicitly", async () => {
		const a = fakeAdapter();
		a.ready.mockRejectedValueOnce(new Error("provider unavailable"));
		const factory = vi.fn().mockReturnValueOnce(a).mockImplementation(fakeAdapter);
		const s = setup({ createAdapter: factory });
		s.controller.installSnapshot(snapshot(load()));
		await s.idle();
		expect(s.controller.getStatus()).toMatchObject({
			code: "error",
			scope: { occurrenceId: 1, epoch: "room-epoch" },
		});
		for (let i = 0; i < 20; i++) {
			await s.advance();
		}
		expect(factory).toHaveBeenCalledOnce();
		expect(a.dispose).toHaveBeenCalledOnce();
		s.controller.retry();
		await s.advance();
		expect(factory).toHaveBeenCalledTimes(2);
		expect(s.controller.getStatus().code).toBe("playing");
	});

	it("scopes resolver failures and ignores failures after replacement", async () => {
		const pending = deferred<string>();
		const s = setup({
			resolveSource: vi.fn().mockReturnValueOnce(pending.promise).mockReturnValue(media.id),
		});
		s.controller.installSnapshot(snapshot(load()));
		await Promise.resolve();
		s.controller.acceptEvent(load({ sequence: 2, occurrenceId: 2 }));
		pending.reject(new Error("old metadata failure"));
		await s.idle();
		await s.advance();
		expect(s.controller.getStatus().code).toBe("playing");
		expect(s.statuses.filter(status => status.code === "error")).toEqual([]);
	});
});
