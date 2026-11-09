import { afterEach, describe, expect, it, vi } from "vitest";
import { createServerClock } from "../../src/playback/server-clock.js";
import type {
	ServerClock,
	ServerClockOptions,
	ServerClockProbe,
} from "../../src/playback/server-clock.js";

const setup = (options: Omit<ServerClockOptions, "now"> = {}) => {
	let timeMs = 1_000;
	const clock = createServerClock({ now: () => timeMs, maxDriftPpm: 0, ...options });
	return { clock, setTime: (value: number) => (timeMs = value) };
};

const probe = (clock: ServerClock): ServerClockProbe => {
	const result = clock.createProbe();
	if (!result) {
		throw new Error("Expected probe capacity");
	}
	return result;
};

const reply = (
	request: ServerClockProbe,
	serverReceiveMs: number,
	serverSendMs = serverReceiveMs,
) => ({
	generation: request.generation,
	nonce: request.nonce,
	serverReceiveMs,
	serverSendMs,
});

describe("server clock calibration", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("is explicitly unavailable until a solicited sample arrives", () => {
		const { clock } = setup();
		expect(clock.getEstimate()).toMatchObject({
			ready: false,
			serverNowMs: null,
			uncertaintyMs: null,
			sampleAgeMs: null,
			roundTripMs: null,
			sampleCount: 0,
		});
	});

	it.each([1_730_000_000_000, -50_000, 0])(
		"maps an arbitrary server offset of %s ms",
		offsetMs => {
			const { clock, setTime } = setup();
			const request = probe(clock);
			setTime(1_040);
			expect(clock.acceptReply(reply(request, 1_020 + offsetMs))).toBe(true);
			expect(clock.getEstimate()).toMatchObject({
				ready: true,
				serverNowMs: 1_040 + offsetMs,
				roundTripMs: 40,
				uncertaintyMs: 20,
				sampleAgeMs: 0,
			});
			setTime(2_290);
			expect(clock.getEstimate().serverNowMs).toBe(2_290 + offsetMs);
		},
	);

	it("excludes server processing from RTT without moving the midpoint estimate", () => {
		const { clock, setTime } = setup();
		const request = probe(clock);
		setTime(1_120);
		// 20 ms outbound, 80 ms server processing, 20 ms inbound; offset +9000 ms.
		expect(clock.acceptReply(reply(request, 10_020, 10_100))).toBe(true);
		expect(clock.getEstimate()).toMatchObject({
			serverNowMs: 10_120,
			roundTripMs: 40,
			uncertaintyMs: 20,
		});
	});

	it("reports the unavoidable uncertainty of asymmetric network delay", () => {
		const { clock, setTime } = setup();
		const request = probe(clock);
		setTime(1_100);
		// True offset +9000 ms, with 10 ms outbound and 90 ms inbound.
		clock.acceptReply(reply(request, 10_010));
		expect(clock.getEstimate()).toMatchObject({ serverNowMs: 10_060, uncertaintyMs: 50 });
	});

	it("supports fractional milliseconds and zero network RTT", () => {
		const { clock, setTime } = setup();
		const request = probe(clock);
		setTime(1_000.5);
		expect(clock.acceptReply(reply(request, 10_000.125, 10_000.625))).toBe(true);
		expect(clock.getEstimate()).toMatchObject({
			serverNowMs: 10_000.625,
			uncertaintyMs: 0,
			roundTripMs: 0,
		});
	});

	it("uses captured receipt time rather than time spent waiting in a callback queue", () => {
		const { clock, setTime } = setup();
		const request = probe(clock);
		setTime(1_100);
		expect(clock.acceptReply(reply(request, 10_020), 1_040)).toBe(true);
		expect(clock.getEstimate()).toMatchObject({
			serverNowMs: 10_100,
			roundTripMs: 40,
			sampleAgeMs: 60,
		});
	});

	it("prefers low RTT until it expires, then uses a fresher retained sample", () => {
		const { clock, setTime } = setup({ sampleMaxAgeMs: 500 });
		const fast = probe(clock);
		setTime(1_020);
		clock.acceptReply(reply(fast, 10_010));
		const slow = probe(clock);
		setTime(1_420);
		clock.acceptReply(reply(slow, 10_320));
		expect(clock.getEstimate()).toMatchObject({
			serverNowMs: 10_420,
			roundTripMs: 20,
			sampleCount: 2,
		});
		setTime(1_520);
		expect(clock.getEstimate()).toMatchObject({
			serverNowMs: 10_620,
			roundTripMs: 400,
			sampleCount: 1,
		});
	});

	it("uses the freshest sample to break equal RTT ties", () => {
		const { clock, setTime } = setup();
		const first = probe(clock);
		setTime(1_040);
		clock.acceptReply(reply(first, 10_020));
		const second = probe(clock);
		setTime(1_080);
		clock.acceptReply(reply(second, 11_060));
		expect(clock.getEstimate().serverNowMs).toBe(11_080);
	});

	it("allows backward calibration corrections and immediately resumes unit-rate progress", () => {
		const { clock, setTime } = setup();
		const inaccurate = probe(clock);
		setTime(1_100);
		clock.acceptReply(reply(inaccurate, 20_050));
		expect(clock.getEstimate().serverNowMs).toBe(20_100);
		const accurate = probe(clock);
		setTime(1_120);
		clock.acceptReply(reply(accurate, 10_110));
		expect(clock.getEstimate().serverNowMs).toBe(10_120);
		setTime(2_120);
		expect(clock.getEstimate().serverNowMs).toBe(11_120);
	});

	it("grows uncertainty by the configured drift allowance", () => {
		const { clock, setTime } = setup({ maxDriftPpm: 200 });
		const request = probe(clock);
		setTime(1_040);
		clock.acceptReply(reply(request, 10_020));
		expect(clock.getEstimate().uncertaintyMs).toBeCloseTo(20.004);
		setTime(11_040);
		expect(clock.getEstimate().uncertaintyMs).toBeCloseTo(22.004);
	});

	it("never consults the wall clock", () => {
		const wallNow = vi.spyOn(Date, "now").mockImplementation(() => {
			throw new Error("Wall clock must not be read");
		});
		const { clock, setTime } = setup();
		const request = probe(clock);
		setTime(1_020);
		clock.acceptReply(reply(request, 10_010));
		setTime(2_020);
		expect(clock.getEstimate().serverNowMs).toBe(11_020);
		expect(wallNow).not.toHaveBeenCalled();
	});
});

describe("server clock validation and bounded lifecycle", () => {
	it.each([
		null,
		undefined,
		[],
		"reply",
		{},
		{ generation: 1, nonce: 1, serverReceiveMs: 1_000, serverSendMs: 1_000 },
		{ generation: 1, nonce: "unsolicited", serverReceiveMs: 1_000, serverSendMs: 1_000 },
	])("rejects malformed or unsolicited input %j", input => {
		const { clock } = setup();
		probe(clock);
		expect(clock.acceptReply(input)).toBe(false);
		expect(clock.getEstimate()).toMatchObject({ ready: false, pendingProbeCount: 1 });
	});

	it.each([
		{ serverReceiveMs: NaN, serverSendMs: 10_020 },
		{ serverReceiveMs: 10_020, serverSendMs: Infinity },
		{ serverReceiveMs: "10020", serverSendMs: 10_020 },
		{ serverReceiveMs: 10_020 },
		{ serverReceiveMs: 10_020, serverSendMs: 10_019 },
		{ serverReceiveMs: 10_020, serverSendMs: 10_061 },
		{ serverReceiveMs: -Number.MAX_VALUE, serverSendMs: Number.MAX_VALUE },
	])("rejects invalid server timestamps %j and consumes the matching nonce", timestamps => {
		const { clock, setTime } = setup();
		const request = probe(clock);
		setTime(1_040);
		expect(
			clock.acceptReply({
				generation: request.generation,
				nonce: request.nonce,
				...timestamps,
			}),
		).toBe(false);
		expect(clock.acceptReply(reply(request, 10_020))).toBe(false);
		expect(clock.getEstimate()).toMatchObject({ ready: false, pendingProbeCount: 0 });
	});

	it.each([999, 1_041, NaN, Infinity])(
		"rejects impossible local receipt time %s",
		receivedAtMs => {
			const { clock, setTime } = setup();
			const request = probe(clock);
			setTime(1_040);
			expect(clock.acceptReply(reply(request, 10_020), receivedAtMs)).toBe(false);
			expect(clock.getEstimate().ready).toBe(false);
		},
	);

	it("accepts reordered replies once without allowing replay to change calibration", () => {
		const { clock, setTime } = setup();
		const first = probe(clock);
		setTime(1_010);
		const second = probe(clock);
		setTime(1_030);
		expect(clock.acceptReply(reply(second, 10_020))).toBe(true);
		setTime(1_100);
		expect(clock.acceptReply(reply(first, 10_050))).toBe(true);
		expect(clock.acceptReply(reply(second, 99_020))).toBe(false);
		expect(clock.getEstimate()).toMatchObject({
			serverNowMs: 10_100,
			roundTripMs: 20,
			pendingProbeCount: 0,
		});
	});

	it("rejects stale generations even when a new probe uses the same nonce", () => {
		const { clock, setTime } = setup();
		const old = probe(clock);
		expect(clock.reset()).toBe(old.generation + 1);
		const current = probe(clock);
		expect(current.nonce).toBe(old.nonce);
		setTime(1_020);
		expect(clock.acceptReply(reply(old, 99_010))).toBe(false);
		expect(clock.getEstimate().pendingProbeCount).toBe(1);
		expect(clock.acceptReply(reply(current, 10_010))).toBe(true);
		expect(clock.getEstimate().serverNowMs).toBe(10_020);
	});

	it("bounds in-flight probes, expires them at the timeout, and never reuses their IDs", () => {
		const { clock, setTime } = setup({ maxPendingProbes: 2, probeTimeoutMs: 100 });
		const first = probe(clock);
		const second = probe(clock);
		expect(clock.createProbe()).toBeNull();
		expect(clock.getEstimate().pendingProbeCount).toBe(2);
		setTime(1_100);
		expect(clock.acceptReply(reply(first, 10_050))).toBe(false);
		const third = probe(clock);
		expect([first.nonce, second.nonce]).not.toContain(third.nonce);
		expect(clock.getEstimate().pendingProbeCount).toBe(1);
	});

	it("bounds retained samples by newest receipt rather than lowest RTT forever", () => {
		const { clock, setTime } = setup({ maxSamples: 2 });
		const first = probe(clock);
		setTime(1_010);
		clock.acceptReply(reply(first, 10_005));
		const second = probe(clock);
		setTime(1_050);
		clock.acceptReply(reply(second, 11_030));
		const third = probe(clock);
		setTime(1_110);
		clock.acceptReply(reply(third, 12_080));
		expect(clock.getEstimate()).toMatchObject({
			sampleCount: 2,
			roundTripMs: 40,
			serverNowMs: 11_110,
		});
	});

	it("retains newest receipts and chooses freshest RTT ties with buffered callbacks", () => {
		const { clock, setTime } = setup({ maxSamples: 1 });
		const first = probe(clock);
		const second = probe(clock);
		setTime(1_100);
		clock.acceptReply(reply(second, 10_040), 1_080);
		clock.acceptReply(reply(first, 99_010), 1_020);
		expect(clock.getEstimate()).toMatchObject({ serverNowMs: 10_100, sampleCount: 1 });
	});

	it("expires calibration even if reads continue, then recovers with a new sample", () => {
		const { clock, setTime } = setup({ sampleMaxAgeMs: 100 });
		const first = probe(clock);
		setTime(1_020);
		clock.acceptReply(reply(first, 10_010));
		setTime(1_119);
		expect(clock.getEstimate().ready).toBe(true);
		setTime(1_120);
		expect(clock.getEstimate()).toMatchObject({
			ready: false,
			serverNowMs: null,
			sampleCount: 0,
		});
		const fresh = probe(clock);
		setTime(1_140);
		expect(clock.acceptReply(reply(fresh, 10_130))).toBe(true);
		expect(clock.getEstimate().serverNowMs).toBe(10_140);
	});

	it("rejects a buffered receipt that has already aged out", () => {
		const { clock, setTime } = setup({ sampleMaxAgeMs: 100 });
		const request = probe(clock);
		setTime(1_200);
		expect(clock.acceptReply(reply(request, 10_020), 1_040)).toBe(false);
	});

	it("resets calibration and pending work explicitly after suspend/resume", () => {
		const { clock, setTime } = setup();
		const first = probe(clock);
		setTime(1_020);
		clock.acceptReply(reply(first, 10_010));
		const pending = probe(clock);
		clock.reset();
		expect(clock.getEstimate()).toMatchObject({
			ready: false,
			sampleCount: 0,
			pendingProbeCount: 0,
		});
		expect(clock.acceptReply(reply(pending, 10_020))).toBe(false);
		const fresh = probe(clock);
		setTime(1_040);
		clock.acceptReply(reply(fresh, 10_030));
		expect(clock.getEstimate().serverNowMs).toBe(10_040);
	});

	it.each([500, 1_121, NaN, Infinity])(
		"invalidates calibration on clock discontinuity %s",
		jumpMs => {
			const { clock, setTime } = setup({ maxClockGapMs: 100 });
			const first = probe(clock);
			setTime(1_020);
			clock.acceptReply(reply(first, 10_010));
			const old = probe(clock);
			setTime(jumpMs);
			expect(clock.getEstimate()).toMatchObject({ ready: false, pendingProbeCount: 0 });
			setTime(2_000);
			const fresh = probe(clock);
			expect(fresh.generation).toBeGreaterThan(old.generation);
			setTime(2_020);
			expect(clock.acceptReply(reply(old, 99_010))).toBe(false);
			expect(clock.acceptReply(reply(fresh, 11_010))).toBe(true);
			expect(clock.getEstimate().serverNowMs).toBe(11_020);
		},
	);

	it("does not let a reply arriving after a long clock gap recalibrate the clock", () => {
		const { clock, setTime } = setup({ maxClockGapMs: 100 });
		const old = probe(clock);
		setTime(1_101);
		expect(clock.acceptReply(reply(old, 10_050))).toBe(false);
		expect(clock.getEstimate().ready).toBe(false);
	});

	it("does not create probes from invalid local time", () => {
		const { clock, setTime } = setup();
		setTime(NaN);
		expect(clock.createProbe()).toBeNull();
	});

	it("never reports a nonfinite projection as ready even with extreme configured ranges", () => {
		const { clock, setTime } = setup({
			sampleMaxAgeMs: Number.MAX_VALUE,
			maxClockGapMs: Number.MAX_VALUE,
		});
		const request = probe(clock);
		expect(clock.acceptReply(reply(request, Number.MAX_VALUE))).toBe(true);
		setTime(1e308);
		expect(clock.getEstimate()).toMatchObject({
			ready: false,
			serverNowMs: null,
			sampleCount: 0,
		});
	});

	it.each([
		{ probeTimeoutMs: 0 },
		{ sampleMaxAgeMs: -1 },
		{ maxClockGapMs: Infinity },
		{ maxPendingProbes: 1.5 },
		{ maxSamples: 0 },
		{ maxDriftPpm: NaN },
		{ maxDriftPpm: -1 },
		{ maxDriftPpm: 1_000_001 },
	])("rejects invalid configuration %j", options => {
		expect(() => setup(options)).toThrow(RangeError);
	});
});
