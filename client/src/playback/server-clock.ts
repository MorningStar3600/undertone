export interface ServerClockOptions {
	/** A monotonic millisecond clock, normally () => performance.now(). */
	now: () => number;
	probeTimeoutMs?: number;
	sampleMaxAgeMs?: number;
	maxClockGapMs?: number;
	maxPendingProbes?: number;
	maxSamples?: number;
	/** Assumed maximum relative clock drift; this is not a measured guarantee. */
	maxDriftPpm?: number;
}

export interface ServerClockProbe {
	readonly generation: number;
	readonly nonce: string;
	readonly sentAtMs: number;
}

export interface ServerClockReply {
	generation: number;
	nonce: string;
	serverReceiveMs: number;
	serverSendMs: number;
}

interface ClockState {
	generation: number;
	sampleCount: number;
	pendingProbeCount: number;
}

export type ServerClockEstimate = ClockState &
	(
		| {
				ready: true;
				serverNowMs: number;
				uncertaintyMs: number;
				sampleAgeMs: number;
				roundTripMs: number;
		  }
		| {
				ready: false;
				serverNowMs: null;
				uncertaintyMs: null;
				sampleAgeMs: null;
				roundTripMs: null;
		  }
	);

export interface ServerClock {
	/** Start a new connection/room or invalidate calibration after suspend/resume. */
	reset(): number;
	/** Record immediately before sending; null means the clock or capacity is unavailable. */
	createProbe(): ServerClockProbe | null;
	/** receivedAtMs, if supplied, must use the same monotonic origin as now(). */
	acceptReply(reply: unknown, receivedAtMs?: number): boolean;
	getEstimate(): ServerClockEstimate;
}

interface Sample {
	clientMidpointMs: number;
	serverMidpointMs: number;
	receivedAtMs: number;
	roundTripMs: number;
}

const positiveOption = (value: number, name: string, integer = false): number => {
	if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) {
		throw new RangeError(`Invalid server clock option: ${name}`);
	}
	return value;
};

/** No transport, timers, wall clock, or browser globals are accessed by this module. */
export function createServerClock(options: ServerClockOptions): ServerClock {
	const probeTimeoutMs = positiveOption(options.probeTimeoutMs ?? 5_000, "probeTimeoutMs");
	const sampleMaxAgeMs = positiveOption(options.sampleMaxAgeMs ?? 30_000, "sampleMaxAgeMs");
	const maxClockGapMs = positiveOption(options.maxClockGapMs ?? 30_000, "maxClockGapMs");
	const maxPendingProbes = positiveOption(
		options.maxPendingProbes ?? 8,
		"maxPendingProbes",
		true,
	);
	const maxSamples = positiveOption(options.maxSamples ?? 8, "maxSamples", true);
	const maxDriftPpm = options.maxDriftPpm ?? 100;
	if (!Number.isFinite(maxDriftPpm) || maxDriftPpm < 0 || maxDriftPpm > 1_000_000) {
		throw new RangeError("Invalid server clock option: maxDriftPpm");
	}

	const pending = new Map<string, number>();
	let samples: Sample[] = [];
	let generation = 0;
	let nextNonce = 0;
	let lastNowMs: number | null = null;

	const reset = (): number => {
		if (generation === Number.MAX_SAFE_INTEGER) {
			throw new RangeError("Server clock generation exhausted");
		}
		generation += 1;
		nextNonce = 0;
		pending.clear();
		samples = [];
		lastNowMs = null;
		return generation;
	};

	const readNow = (): number | null => {
		const nowMs = options.now();
		if (!Number.isFinite(nowMs)) {
			reset();
			return null;
		}
		if (lastNowMs !== null && (nowMs < lastNowMs || nowMs - lastNowMs > maxClockGapMs)) {
			reset();
		}
		lastNowMs = nowMs;
		for (const [nonce, sentAtMs] of pending) {
			if (nowMs - sentAtMs >= probeTimeoutMs) {
				pending.delete(nonce);
			}
		}
		samples = samples.filter(sample => {
			const elapsedMs = nowMs - sample.clientMidpointMs;
			return (
				nowMs - sample.receivedAtMs < sampleMaxAgeMs &&
				Number.isFinite(sample.serverMidpointMs + elapsedMs) &&
				Number.isFinite(sample.roundTripMs / 2 + elapsedMs * (maxDriftPpm / 1_000_000))
			);
		});
		return nowMs;
	};

	reset();

	return {
		reset,
		createProbe: () => {
			const sentAtMs = readNow();
			if (
				sentAtMs === null ||
				pending.size >= maxPendingProbes ||
				nextNonce === Number.MAX_SAFE_INTEGER
			) {
				return null;
			}
			// Unique within a generation, including after eviction, timeout, or rejection.
			const nonce = String(++nextNonce);
			pending.set(nonce, sentAtMs);
			return { generation, nonce, sentAtMs };
		},
		acceptReply: (reply, receivedAtMs) => {
			const nowMs = readNow();
			if (
				nowMs === null ||
				typeof reply !== "object" ||
				reply === null ||
				Array.isArray(reply)
			) {
				return false;
			}
			const data = reply as Partial<ServerClockReply>;
			if (data.generation !== generation || typeof data.nonce !== "string") {
				return false;
			}
			const sentAtMs = pending.get(data.nonce);
			if (sentAtMs === undefined) {
				return false;
			}
			// A matching reply consumes its probe even when the timestamps are invalid.
			pending.delete(data.nonce);
			const receivedMs = receivedAtMs === undefined ? nowMs : receivedAtMs;
			if (
				!Number.isFinite(receivedMs) ||
				receivedMs < sentAtMs ||
				receivedMs > nowMs ||
				nowMs - receivedMs >= sampleMaxAgeMs ||
				typeof data.serverReceiveMs !== "number" ||
				typeof data.serverSendMs !== "number" ||
				!Number.isFinite(data.serverReceiveMs) ||
				!Number.isFinite(data.serverSendMs)
			) {
				return false;
			}
			const elapsedMs = receivedMs - sentAtMs;
			const processingMs = data.serverSendMs - data.serverReceiveMs;
			const roundTripMs = elapsedMs - processingMs;
			const clientMidpointMs = sentAtMs + elapsedMs / 2;
			const serverMidpointMs = data.serverReceiveMs + processingMs / 2;
			if (
				processingMs < 0 ||
				roundTripMs < 0 ||
				!Number.isFinite(roundTripMs) ||
				!Number.isFinite(serverMidpointMs + (nowMs - clientMidpointMs))
			) {
				return false;
			}
			samples.push({
				clientMidpointMs,
				serverMidpointMs,
				receivedAtMs: receivedMs,
				roundTripMs,
			});
			// Retain the newest receipts, even if buffered callbacks are delivered out of order.
			samples.sort((a, b) => b.receivedAtMs - a.receivedAtMs);
			samples.length = Math.min(samples.length, maxSamples);
			return true;
		},
		getEstimate: () => {
			const nowMs = readNow();
			const state: ClockState = {
				generation,
				sampleCount: samples.length,
				pendingProbeCount: pending.size,
			};
			const best = samples.reduce<Sample | null>(
				(selected, sample) =>
					selected === null || sample.roundTripMs < selected.roundTripMs
						? sample
						: selected,
				null,
			);
			if (nowMs === null || best === null) {
				return {
					...state,
					ready: false,
					serverNowMs: null,
					uncertaintyMs: null,
					sampleAgeMs: null,
					roundTripMs: null,
				};
			}
			const elapsedMs = nowMs - best.clientMidpointMs;
			return {
				...state,
				ready: true,
				serverNowMs: best.serverMidpointMs + elapsedMs,
				uncertaintyMs: best.roundTripMs / 2 + elapsedMs * (maxDriftPpm / 1_000_000),
				sampleAgeMs: nowMs - best.receivedAtMs,
				roundTripMs: best.roundTripMs,
			};
		},
	};
}
