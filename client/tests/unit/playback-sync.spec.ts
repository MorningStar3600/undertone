/* eslint vitest/no-conditional-in-test: "off" */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	acceptPlaybackEvent,
	createPlaybackTimeline,
	type PlaybackEvent,
} from "ott-common/playback/index.js";
import {
	createPlaybackController,
	type PlaybackAdapter,
	type PlaybackAdapterContext,
} from "../../src/playback/playback-controller";

const media = { service: "youtube", id: "public-video" };
const event = (type: "play" | "pause", sequence: number, effectiveAtMs: number): PlaybackEvent => ({
	epoch: "room",
	occurrenceId: 1,
	type,
	sequence,
	effectiveAtMs,
});
const snapshot = (isPlaying = false, rate = 1) =>
	acceptPlaybackEvent(createPlaybackTimeline("room", 1_000), {
		epoch: "room",
		sequence: 1,
		occurrenceId: 1,
		effectiveAtMs: 1_000,
		type: "load",
		media,
		positionSeconds: 10,
		isPlaying,
		rate,
	}).timeline;
const flush = async () => {
	for (let i = 0; i < 60; i++) {
		await Promise.resolve();
	}
};
const advance = async (ms: number) => {
	await flush();
	await vi.advanceTimersByTimeAsync(ms);
	await flush();
};
const controllers: ReturnType<typeof createPlaybackController>[] = [];

/** Two independent renderers/providers, one simulated server clock, delayed transport and SDK. */
function client(
	options: {
		loadMs?: number;
		seekMs?: number;
		playMs?: number;
		readMs?: number;
		offsetMs?: number;
		uncertaintyMs?: number;
	} = {},
) {
	const calls: { type: string; at: number; position?: number }[] = [];
	const contexts: PlaybackAdapterContext[] = [];
	let anchor = 0;
	let anchorAt = 0;
	let playing = false;
	let rate = 1;
	let noise = 0;
	let live = 0;
	let maxLive = 0;
	let seekDelay = options.seekMs ?? 0;
	const position = () => anchor + (playing ? ((Date.now() - anchorAt) * rate) / 1_000 : 0);
	const freeze = () => {
		anchor = position();
		anchorAt = Date.now();
	};
	const record = (type: string, target?: number) =>
		calls.push({ type, at: Date.now(), position: target });
	const wait = (ms: number, signal: AbortSignal) =>
		new Promise<void>((resolve, reject) => {
			if (signal.aborted) {
				reject(new DOMException("Cancelled", "AbortError"));
				return;
			}
			const cancel = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", cancel);
				freeze();
				playing = false;
				reject(new DOMException("Cancelled", "AbortError"));
			};
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", cancel);
				resolve();
			}, ms);
			signal.addEventListener("abort", cancel, { once: true });
		});
	const controller = createPlaybackController<string>({
		now: () => Date.now() + (options.offsetMs ?? 0),
		clock: {
			getEstimate: () => ({
				ready: true,
				serverNowMs: 1_000 + Date.now(),
				generation: 1,
				sampleCount: 1,
				pendingProbeCount: 0,
				uncertaintyMs: options.uncertaintyMs ?? 0,
				sampleAgeMs: 0,
				roundTripMs: 0,
			}),
		},
		scheduler: {
			setTimeout: (callback, delay) => setTimeout(callback, delay),
			clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
		},
		resolveSource: () => media.id,
		createAdapter: context => {
			contexts.push(context);
			maxLive = Math.max(maxLive, ++live);
			let dead = false;
			const adapter: PlaybackAdapter<string> = {
				ready: () => undefined,
				load: async (_source, signal) => {
					if (options.loadMs) {
						await wait(options.loadMs, signal);
					}
				},
				getPosition: async signal => {
					const sample = position() + noise;
					if (options.readMs) {
						await wait(options.readMs, signal);
					}
					return sample;
				},
				seek: async (target, signal) => {
					record("seek", target);
					if (seekDelay) {
						const delay = seekDelay;
						seekDelay = 0;
						await wait(delay, signal);
					}
					anchor = target;
					anchorAt = Date.now();
				},
				supportsRate: value => [1, 2].includes(value),
				setRate: value => {
					freeze();
					rate = value;
					record("rate");
				},
				play: async signal => {
					record("play");
					if (options.playMs) {
						await wait(options.playMs, signal);
					}
					freeze();
					playing = true;
				},
				pause: () => {
					record("pause");
					freeze();
					playing = false;
				},
				dispose: () => {
					if (!dead) {
						dead = true;
						live--;
						freeze();
						playing = false;
					}
				},
			};
			return adapter;
		},
		onRecovery: recovery => {
			throw new Error(recovery.reason);
		},
	});
	controllers.push(controller);
	return {
		controller,
		calls,
		contexts,
		position,
		get maxLive() {
			return maxLive;
		},
		get playing() {
			return playing;
		},
		jump: (seconds: number) => {
			freeze();
			anchor += seconds;
		},
		noise: (seconds: number) => {
			noise = seconds;
		},
		delayNextSeek: (ms: number) => {
			seekDelay = ms;
		},
		deliver: (value: PlaybackEvent, delay: number) =>
			setTimeout(() => controller.acceptEvent(value), delay),
	};
}

describe("two-client authoritative timing simulation", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
	});
	afterEach(async () => {
		for (const controller of controllers.splice(0)) {
			controller.dispose();
		}
		await flush();
		vi.useRealTimers();
	});

	it.each([1, 2])(
		"compensates server ms 1 -> receipt ms 15 at rate %s, without moving paused anchors",
		async rate => {
			const a = client({ offsetMs: 20_000 });
			const b = client({ offsetMs: 90_000 });
			a.controller.installSnapshot(snapshot(false, rate));
			b.controller.installSnapshot(snapshot(false, rate));
			await flush();
			await advance(1);
			const play = event("play", 2, 1_001);
			a.controller.acceptEvent(play);
			b.deliver(play, 14);
			await advance(14);
			expect(a.calls.find(call => call.type === "play")?.at).toBe(1);
			expect(b.calls.find(call => call.type === "play")?.at).toBe(15);
			// At rate 1 the receiver seeks to 10.014, not 10 or a local wall-clock anchor.
			expect(b.position()).toBeCloseTo(10 + 0.014 * rate, 9);
			expect(b.position()).toBeCloseTo(a.position(), 9);
			await advance(86);
			const pause = event("pause", 3, 1_101);
			a.controller.acceptEvent(pause);
			b.deliver(pause, 140);
			await advance(140);
			expect(b.calls.findLast(call => call.type === "pause")?.at).toBe(241);
			expect(b.position()).toBeCloseTo(10 + 0.1 * rate, 9);
			expect(b.position()).toBeCloseTo(a.position(), 9);
			await advance(2_000);
			expect(b.position()).toBeCloseTo(10 + 0.1 * rate, 9);
			const resume = event("play", 4, 3_241);
			a.controller.acceptEvent(resume);
			b.deliver(resume, 150);
			await advance(150);
			expect(b.position()).toBeCloseTo(a.position(), 9);
			expect(b.calls.findLast(call => call.type === "play")?.at).toBe(2_391);
		},
	);

	it("projects after delayed startup and catches up once after a slow seek or play", async () => {
		const a = client();
		const b = client({ loadMs: 80, seekMs: 400, playMs: 150 });
		a.controller.installSnapshot(snapshot(true));
		b.controller.installSnapshot(snapshot(true));
		await advance(80);
		expect(b.calls.find(call => call.type === "seek")).toMatchObject({
			at: 80,
			position: 10.08,
		});
		await advance(400);
		expect(b.calls.filter(call => call.type === "seek")).toHaveLength(2);
		expect(b.calls.findLast(call => call.type === "seek")?.position).toBeCloseTo(10.48, 9);
		await advance(150);
		// One bounded check for each slow operation, with no recursive seek completion checks.
		expect(b.position()).toBeCloseTo(a.position(), 9);
		expect(b.calls.filter(call => call.type === "seek")).toHaveLength(3);
		expect(b.maxLive).toBe(1);
	});

	it("measures play-start latency without waiting for the ordinary drift threshold", async () => {
		const a = client();
		const b = client({ playMs: 180 });
		a.controller.installSnapshot(snapshot(true));
		b.controller.installSnapshot(snapshot(true));
		await advance(180);
		expect(b.calls.filter(call => call.type === "seek")).toHaveLength(2);
		expect(b.position()).toBeCloseTo(a.position(), 9);
		await advance(2_000);
		expect(b.calls.filter(call => call.type === "play")).toHaveLength(1);
		expect(b.calls.filter(call => call.type === "seek")).toHaveLength(2);
	});

	it("reprojects after asynchronous position samples and delayed explicit seek completion", async () => {
		const a = client();
		const b = client({ readMs: 40 });
		a.controller.installSnapshot(snapshot(true));
		b.controller.installSnapshot(snapshot(true));
		await advance(40);
		expect(b.calls.find(call => call.type === "seek")).toMatchObject({
			at: 40,
			position: 10.04,
		});
		expect(b.position()).toBeCloseTo(a.position(), 9);
		b.delayNextSeek(300);
		const seek: PlaybackEvent = {
			...event("play", 2, 1_040),
			type: "seek",
			positionSeconds: 60,
		};
		a.controller.acceptEvent(seek);
		b.deliver(seek, 14);
		await advance(14 + 40);
		expect(b.calls.findLast(call => call.type === "seek")).toMatchObject({
			at: 94,
			position: 60.054,
		});
		await advance(340);
		expect(b.calls.findLast(call => call.type === "seek")?.position).toBeCloseTo(60.394, 9);
		expect(b.position()).toBeCloseTo(a.position(), 9);
		expect(b.calls.filter(call => call.type === "play")).toHaveLength(1);
	});

	it("uses an event deadline between periodic ticks and never applies future controls early", async () => {
		const a = client();
		const b = client();
		a.controller.installSnapshot(snapshot(true));
		b.controller.installSnapshot(snapshot(true));
		await flush();
		a.deliver(event("pause", 2, 1_123), 10);
		b.deliver(event("pause", 2, 1_123), 40);
		await advance(122);
		expect(a.calls.filter(call => call.type === "pause")).toHaveLength(0);
		expect(b.calls.filter(call => call.type === "pause")).toHaveLength(0);
		await advance(1);
		expect(a.calls.find(call => call.type === "pause")?.at).toBe(123);
		expect(b.calls.find(call => call.type === "pause")?.at).toBe(123);
		expect(a.position()).toBeCloseTo(b.position(), 9);
	});

	it("corrects sustained drift on two samples but ignores sampling noise and bounds seeks", async () => {
		const a = client();
		const b = client();
		a.controller.installSnapshot(snapshot(true));
		b.controller.installSnapshot(snapshot(true));
		await advance(1_000);
		b.jump(-0.6);
		await advance(250);
		expect(b.calls.filter(call => call.type === "seek")).toHaveLength(1);
		await advance(250);
		expect(b.position()).toBeCloseTo(a.position(), 9);
		expect(b.calls.filter(call => call.type === "seek")).toHaveLength(2);
		for (let i = 0; i < 12; i++) {
			b.noise(i % 2 === 0 ? 0.45 : 0.02);
			await advance(250);
		}
		expect(b.calls.filter(call => call.type === "seek")).toHaveLength(2);
		for (let i = 0; i < 12; i++) {
			b.noise(i % 2 === 0 ? 0.45 : -0.45);
			await advance(250);
		}
		expect(b.calls.filter(call => call.type === "seek")).toHaveLength(2);
		b.noise(0);
		for (let i = 0; i < 12; i++) {
			b.jump(-0.4);
			await advance(250);
		}
		// Routine corrections cannot exceed one per second, even under continuous provider drift.
		const corrections = b.calls.filter(call => call.type === "seek").slice(2);
		for (let i = 1; i < corrections.length; i++) {
			expect(corrections[i].at - corrections[i - 1].at).toBeGreaterThanOrEqual(1_000);
		}
		expect(b.calls.filter(call => call.type === "play")).toHaveLength(1);
		expect(b.calls.filter(call => call.type === "rate")).toHaveLength(1);
	});

	it("preempts a delayed play with newer pause without stale playback or a second generation", async () => {
		const a = client({ playMs: 4_000 });
		const b = client({ playMs: 4_000 });
		a.controller.installSnapshot(snapshot(true));
		b.controller.installSnapshot(snapshot(true));
		await advance(10);
		const pause = event("pause", 2, 1_010);
		a.controller.acceptEvent(pause);
		b.deliver(pause, 14);
		await advance(14);
		expect(a.calls.find(call => call.type === "pause")?.at).toBe(10);
		expect(b.calls.find(call => call.type === "pause")?.at).toBe(24);
		expect(a.controller.getStatus().code).toBe("paused");
		expect(b.controller.getStatus().code).toBe("paused");
		await advance(5_000);
		expect(a.playing).toBe(false);
		expect(b.playing).toBe(false);
		expect(a.maxLive).toBe(1);
		expect(b.maxLive).toBe(1);
	});

	it.each([true, false])(
		"settles rapid control bursts to the final playing=%s intent",
		async finalPlaying => {
			const a = client({ playMs: 180 });
			const b = client({ playMs: 450, offsetMs: 90_000 });
			a.controller.installSnapshot(snapshot(false));
			b.controller.installSnapshot(snapshot(false));
			await flush();
			for (let i = 0; i < (finalPlaying ? 41 : 40); i++) {
				await advance(30);
				const control = event(i % 2 === 0 ? "play" : "pause", i + 2, 1_000 + Date.now());
				a.controller.acceptEvent(control);
				b.deliver(control, 14);
			}
			await advance(5_000);
			expect(a.playing).toBe(finalPlaying);
			expect(b.playing).toBe(finalPlaying);
			// Paused anchors below the correction tolerance can differ by delivery latency.
			expect(Math.abs(b.position() - a.position())).toBeLessThan(0.05);
			expect(a.controller.getStatus().code).toBe(finalPlaying ? "playing" : "paused");
			expect(b.controller.getStatus().code).toBe(finalPlaying ? "playing" : "paused");
			expect(a.maxLive).toBe(1);
			expect(b.maxLive).toBe(1);
			const resume = event("play", finalPlaying ? 43 : 42, 1_000 + Date.now());
			a.controller.acceptEvent(resume);
			b.deliver(resume, 14);
			await advance(1_000);
			expect(b.position()).toBeCloseTo(a.position(), 9);
		},
	);

	it.each([true, false])(
		"corrects a persistent 80ms residual on the five-second check (playing=%s)",
		async playing => {
			const a = client();
			const b = client();
			a.controller.installSnapshot(snapshot(playing));
			b.controller.installSnapshot(snapshot(playing));
			await advance(1_000);
			b.jump(-0.08);
			await advance(3_999);
			expect(a.position() - b.position()).toBeCloseTo(0.08, 9);
			await advance(1);
			expect(b.position()).toBeCloseTo(a.position(), 9);
			expect(b.calls.filter(call => call.type === "seek")).toHaveLength(2);
			await advance(10_000);
			expect(b.calls.filter(call => call.type === "seek")).toHaveLength(2);
		},
	);

	it("bounds repeated fine corrections and ignores alternating sampling noise", async () => {
		const b = client();
		b.controller.installSnapshot(snapshot(true));
		await flush();
		for (let i = 0; i < 48; i++) {
			b.noise(i % 2 === 0 ? 0.08 : -0.08);
			await advance(250);
		}
		expect(b.calls.filter(call => call.type === "seek")).toHaveLength(1);
		b.noise(0);
		for (let i = 0; i < 48; i++) {
			b.jump(-0.06);
			await advance(250);
			// Keep a small residual instead of accumulating into the fast drift policy.
			b.jump(10 + Date.now() / 1_000 - b.position());
		}
		const seeks = b.calls.filter(call => call.type === "seek").slice(1);
		expect(seeks.length).toBeGreaterThanOrEqual(2);
		for (let i = 1; i < seeks.length; i++) {
			expect(seeks[i].at - seeks[i - 1].at).toBeGreaterThanOrEqual(5_000);
		}
	});

	it("does not treat clock uncertainty or slow position sampling as fine drift", async () => {
		const uncertain = client({ uncertaintyMs: 120 });
		const slow = client({ readMs: 80 });
		uncertain.controller.installSnapshot(snapshot(true));
		slow.controller.installSnapshot(snapshot(true));
		await advance(1_000);
		uncertain.jump(-0.08);
		await advance(15_000);
		expect(uncertain.calls.filter(call => call.type === "seek")).toHaveLength(1);
		expect(slow.calls.filter(call => call.type === "seek")).toHaveLength(1);
	});

	it("cancels pending play before a replacement surface becomes audible", async () => {
		const a = client({ playMs: 4_000 });
		const b = client({ playMs: 4_000 });
		a.controller.installSnapshot(snapshot(true));
		b.controller.installSnapshot(snapshot(true));
		await advance(10);
		const replacement: PlaybackEvent = {
			epoch: "room",
			sequence: 2,
			occurrenceId: 2,
			effectiveAtMs: 1_010,
			type: "load",
			media,
			positionSeconds: 30,
			isPlaying: false,
			rate: 1,
		};
		a.controller.acceptEvent(replacement);
		b.deliver(replacement, 14);
		await advance(14);
		expect(a.contexts[0].signal.aborted).toBe(true);
		expect(b.contexts[0].signal.aborted).toBe(true);
		expect(a.controller.getStatus()).toMatchObject({
			code: "paused",
			scope: { occurrenceId: 2 },
		});
		expect(b.controller.getStatus()).toMatchObject({
			code: "paused",
			scope: { occurrenceId: 2 },
		});
		await advance(4_000);
		expect(a.position()).toBe(30);
		expect(b.position()).toBe(30);
		expect(a.maxLive).toBe(1);
		expect(b.maxLive).toBe(1);
	});
});
