import {
	acceptPlaybackEvent,
	compactPlaybackTimeline,
	expectedPlaybackAt,
	parsePlaybackTimeline,
	PlaybackTimelineException,
	type PlaybackAcceptance,
	type PlaybackMedia,
	type PlaybackProjection,
	type PlaybackTimeline,
	type PlaybackTimelineErrorCode,
} from "ott-common/playback/index.js";
import type { ServerClock } from "./server-clock.js";

export type PlaybackResult<T> = T | Promise<T>;

export interface PlaybackScope {
	epoch: string;
	occurrenceId: number;
	generation: number;
	media: PlaybackMedia;
}

export type PlaybackAdapterEvent =
	| { type: "buffering" | "resumed" }
	| { type: "playback-change"; isPlaying: boolean }
	| { type: "rate-change"; rate: number }
	| { type: "error"; error: unknown };

export interface PlaybackAdapterContext extends PlaybackScope {
	signal: AbortSignal;
	/** Captured to this generation; late notifications are ignored. */
	report(event: PlaybackAdapterEvent): void;
}

/**
 * Own a single captured provider instance, never a mutable current-player facade.
 * dispose MUST synchronously detach/stop rendering and prevent outstanding work from
 * affecting any replacement. All pending methods/resolution must settle on abort/dispose.
 * AbortSignal alone cannot undo SDK effects; see docs/playback-controller.md.
 */
export interface PlaybackAdapter<Source> {
	/** API readiness before load; load itself resolves only when seek/play/pause are usable. */
	ready(signal: AbortSignal): PlaybackResult<void>;
	/** Cue without autoplay, including when the authoritative state is paused. */
	load(source: Source, signal: AbortSignal): PlaybackResult<void>;
	getPosition(signal: AbortSignal): PlaybackResult<number>;
	seek(positionSeconds: number, signal: AbortSignal): PlaybackResult<void>;
	supportsRate(rate: number): boolean;
	setRate(rate: number, signal: AbortSignal): PlaybackResult<void>;
	play(signal: AbortSignal): PlaybackResult<void>;
	pause(signal: AbortSignal): PlaybackResult<void>;
	/** Optional synchronous browser-gesture unlock; must not change authoritative intent. */
	activate?(): void;
	/** Synchronous, idempotent teardown, including while ready/load/play are pending. */
	dispose(): void;
}

export type PlaybackStatusCode =
	| "waiting-snapshot"
	| "waiting-clock"
	| "recovering"
	| "idle"
	| "loading"
	| "playing"
	| "paused"
	| "buffering"
	| "autoplay-blocked"
	| "unsupported-rate"
	| "error"
	| "disposed";

export interface PlaybackControllerStatus {
	code: PlaybackStatusCode;
	scope: PlaybackScope | null;
	error?: unknown;
	rate?: number;
}

export type PlaybackRecoveryReason =
	| PlaybackTimelineErrorCode
	| "missing-snapshot"
	| "invalid-snapshot"
	| "invalid-event"
	| "snapshot-rollback"
	| "snapshot-conflict";

export interface PlaybackRecovery {
	reason: PlaybackRecoveryReason;
	epoch: string | null;
	receivedSequence: number;
	error?: unknown;
}

export interface PlaybackScheduler {
	/** Must enqueue asynchronously, never invoke callback inline. */
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface PlaybackControllerOptions<Source> {
	clock: Pick<ServerClock, "getEstimate">;
	/** Local monotonic milliseconds, only for scheduling/cooldown, never media projection. */
	now(): number;
	/** Omit for explicit tick ownership. No global timers are used. */
	scheduler?: PlaybackScheduler;
	/** Resolve separately authorized metadata; no transport envelope/endpoints are assumed. */
	resolveSource(media: PlaybackMedia, context: PlaybackAdapterContext): PlaybackResult<Source>;
	/** Synchronous allocation of an isolated instance, initially silent. */
	createAdapter(context: PlaybackAdapterContext): PlaybackAdapter<Source>;
	onRecovery(recovery: PlaybackRecovery): void;
	onStatus?(status: PlaybackControllerStatus): void;
	/** At least 50 ms; also bounds automatic reconciliation and future-event timer frequency. */
	intervalMs?: number;
	driftThresholdSeconds?: number;
	driftReleaseSeconds?: number;
	seekCooldownMs?: number;
}

export interface PlaybackController {
	/** Transport authenticates room/request identity and authorizes epoch replacement first. */
	installSnapshot(input: unknown): boolean;
	acceptEvent(input: unknown): PlaybackAcceptance["status"] | "rejected";
	/** Call after clock calibration/reset as well as periodically without a scheduler. */
	tick(): void;
	/** Local retry after browser activation; never changes authoritative play intent. */
	userActivated(): void;
	/** Explicit retry of a failed adapter/resolver. There are no automatic failure retries. */
	retry(): void;
	getStatus(): PlaybackControllerStatus;
	/** Observes the current worker only; does not advance timers or await future events. */
	whenIdle(): Promise<void>;
	dispose(): void;
}

interface Generation<Source> {
	context: PlaybackAdapterContext;
	abort: AbortController;
	adapter: PlaybackAdapter<Source> | null;
	loaded: boolean;
	failed: boolean;
	buffering: boolean;
	blocked: boolean;
	playing: boolean | null;
	rate: number | null;
	aligned: number;
	lastSeekMs: number;
	drifting: boolean;
}

const cursor = (timeline: PlaybackTimeline): number =>
	timeline.events.at(-1)?.sequence ?? timeline.baseline.sequence;

const positive = (value: number, name: string): number => {
	if (!Number.isFinite(value) || value <= 0) {
		throw new RangeError(`Invalid playback controller option: ${name}`);
	}
	return value;
};

const autoplayBlocked = (error: unknown): boolean =>
	typeof error === "object" &&
	error !== null &&
	"name" in error &&
	error.name === "NotAllowedError";

export function createPlaybackController<Source>(
	options: PlaybackControllerOptions<Source>,
): PlaybackController {
	const intervalMs = positive(options.intervalMs ?? 250, "intervalMs");
	if (intervalMs < 50 || intervalMs > 2_147_483_647) {
		throw new RangeError("intervalMs must be between 50 and 2147483647");
	}
	const driftThreshold = positive(options.driftThresholdSeconds ?? 1.5, "driftThresholdSeconds");
	const driftRelease = positive(options.driftReleaseSeconds ?? 0.5, "driftReleaseSeconds");
	const cooldownMs = positive(options.seekCooldownMs ?? 2_000, "seekCooldownMs");
	if (driftRelease >= driftThreshold) {
		throw new RangeError("driftReleaseSeconds must be below driftThresholdSeconds");
	}
	let timeline: PlaybackTimeline | null = null;
	let projection: PlaybackProjection | null = null;
	let active: Generation<Source> | null = null;
	let generation = 0;
	let revision = 0;
	let alignment = 0;
	let appliedSequence = 0;
	let recovering = false;
	let disposed = false;
	let dirty = false;
	let worker: Promise<void> | null = null;
	let lastStartedMs = Number.NEGATIVE_INFINITY;
	let timer: { handle: unknown } | null = null;
	let status: PlaybackControllerStatus = { code: "waiting-snapshot", scope: null };

	const publish = (
		code: PlaybackStatusCode,
		g: Generation<Source> | null = active,
		detail: Pick<PlaybackControllerStatus, "error" | "rate"> = {},
	): void => {
		const scope: PlaybackScope | null = g
			? {
					epoch: g.context.epoch,
					occurrenceId: g.context.occurrenceId,
					generation: g.context.generation,
					media: { ...g.context.media },
				}
			: null;
		if (
			status.code === code &&
			status.scope?.generation === scope?.generation &&
			status.rate === detail.rate &&
			status.error === detail.error
		) {
			return;
		}
		status = { code, scope, ...detail };
		options.onStatus?.(status);
	};

	const teardown = (g: Generation<Source>): void => {
		g.abort.abort();
		const adapter = g.adapter;
		g.adapter = null;
		try {
			adapter?.dispose();
		} catch (error) {
			// Teardown errors are local and must not escape an async worker or affect a successor.
			if (active === g && !disposed) {
				publish("error", g, { error });
			}
		}
	};

	const retire = (): void => {
		const previous = active;
		active = null;
		if (previous) {
			teardown(previous);
		}
	};

	const recover = (reason: PlaybackRecoveryReason, error?: unknown): void => {
		if (recovering || disposed) {
			return;
		}
		recovering = true;
		revision += 1;
		projection = null;
		retire();
		publish("recovering");
		options.onRecovery({
			reason,
			epoch: timeline?.epoch ?? null,
			receivedSequence: timeline ? cursor(timeline) : 0,
			error,
		});
	};

	/** Refresh before AND after async boundaries, using the latest clock and authority. */
	const refresh = (): void => {
		if (disposed || recovering || !timeline) {
			projection = null;
			return;
		}
		const estimate = options.clock.getEstimate();
		const timeMs = estimate.ready ? Math.floor(estimate.serverNowMs) : NaN;
		if (!Number.isSafeInteger(timeMs) || timeMs < 0) {
			projection = null;
			retire();
			publish("waiting-clock");
			return;
		}
		// Backward calibration cannot undo already-rendered events. Compaction preserves
		// all future events; its horizon is a documented projection floor until time catches up.
		const queryMs = Math.max(timeMs, timeline.baseline.serverTimeMs);
		const next = expectedPlaybackAt(timeline, queryMs);
		if (next.appliedSequence !== appliedSequence) {
			const newlyEffective = timeline.events.filter(
				event => event.sequence > appliedSequence && event.sequence <= next.appliedSequence,
			);
			if (newlyEffective.some(event => event.type === "load" || event.type === "source")) {
				retire();
			}
			if (newlyEffective.some(event => event.type === "seek")) {
				alignment += 1;
			}
			appliedSequence = next.appliedSequence;
			revision += 1;
			dirty = true;
		}
		projection = next;
		timeline = compactPlaybackTimeline(timeline, queryMs);
		if (!next.state) {
			retire();
			publish("idle");
		}
	};

	const live = (g: Generation<Source>): boolean => {
		refresh();
		return (
			!disposed &&
			!recovering &&
			active === g &&
			!g.abort.signal.aborted &&
			!g.failed &&
			projection !== null &&
			projection.state !== null
		);
	};

	const current = (g: Generation<Source>, version: number): boolean =>
		live(g) && revision === version;

	const fail = (g: Generation<Source>, error: unknown): void => {
		if (active !== g || g.abort.signal.aborted || disposed) {
			return;
		}
		g.failed = true;
		teardown(g);
		publish("error", g, { error });
	};

	const createGeneration = (): Generation<Source> => {
		const state = projection!.state!;
		const abort = new AbortController();
		const g: Generation<Source> = {
			context: {
				epoch: projection!.epoch,
				occurrenceId: state.occurrenceId,
				media: { ...state.media },
				generation: ++generation,
				signal: abort.signal,
				report: event => {
					if (active !== g || abort.signal.aborted || disposed) {
						return;
					}
					if (event.type === "error") {
						fail(g, event.error);
					} else if (event.type === "buffering") {
						if (!g.buffering) {
							g.buffering = true;
							revision += 1;
							publish("buffering", g);
						}
					} else if (event.type === "resumed") {
						if (g.buffering) {
							g.buffering = false;
							// A seek can itself cause buffering. Measure drift after recovery
							// instead of forcing another seek and starting that cycle again.
							revision += 1;
						}
					} else if (event.type === "rate-change") {
						g.rate = event.rate;
					} else if (
						event.type === "playback-change" &&
						g.loaded &&
						g.playing !== event.isPlaying
					) {
						g.playing = event.isPlaying;
					}
					tick();
				},
			},
			abort,
			adapter: null,
			loaded: false,
			failed: false,
			buffering: false,
			blocked: false,
			playing: null,
			rate: null,
			aligned: -1,
			lastSeekMs: Number.NEGATIVE_INFINITY,
			drifting: false,
		};
		active = g;
		return g;
	};

	const reconcile = async (): Promise<void> => {
		refresh();
		if (!projection?.state) {
			return;
		}
		const g = active ?? createGeneration();
		let version = revision;
		const signal = g.abort.signal;
		if (!current(g, version)) {
			return;
		}
		try {
			if (!g.adapter) {
				publish("loading", g);
				const adapter = options.createAdapter(g.context);
				// A factory may synchronously trigger replacement through its host.
				if (!live(g)) {
					adapter.dispose();
					return;
				}
				g.adapter = adapter;
			}
			const adapter = g.adapter;
			if (!g.loaded) {
				const source = await options.resolveSource({ ...g.context.media }, g.context);
				if (!live(g)) {
					return;
				}
				await adapter.ready(signal);
				if (!live(g)) {
					return;
				}
				await adapter.load(source, signal);
				if (!live(g)) {
					return;
				}
				g.loaded = true;
			}
			// Position/play controls can change during startup without restarting source work.
			version = revision;
			let state = projection.state;
			if (!adapter.supportsRate(state.rate)) {
				if (g.playing !== false) {
					g.playing = false;
					await adapter.pause(signal);
					if (!current(g, version)) {
						return;
					}
				}
				publish("unsupported-rate", g, { rate: state.rate });
				return;
			}
			if (g.blocked && state.isPlaying) {
				publish("autoplay-blocked", g);
				return;
			}
			// Buffering suspends position corrections, not authoritative play/pause.
			// Some providers cannot finish a seek from a cued state until play is sent.
			if (!g.buffering) {
				if (g.rate !== state.rate) {
					await adapter.setRate(state.rate, signal);
					if (!current(g, version)) {
						return;
					}
					g.rate = state.rate;
				}
				const position = await adapter.getPosition(signal);
				if (!current(g, version)) {
					return;
				}
				if (!Number.isFinite(position) || position < 0) {
					throw new RangeError("Invalid adapter media position");
				}
				state = projection.state!;
				const drift = Math.abs(position - state.positionSeconds);
				if (drift <= driftRelease) {
					g.drifting = false;
				} else if (drift >= driftThreshold) {
					g.drifting = true;
				}
				const localNow = options.now();
				if (
					g.aligned !== alignment ||
					(g.drifting && localNow - g.lastSeekMs >= cooldownMs)
				) {
					// Reserve the correction before the SDK can synchronously report buffering.
					// A failed seek tears down this generation; explicit later seeks advance alignment.
					g.aligned = alignment;
					g.lastSeekMs = localNow;
					g.drifting = false;
					await adapter.seek(state.positionSeconds, signal);
					if (!current(g, version)) {
						return;
					}
				}
			}
			state = projection.state!;
			if (g.playing !== state.isPlaying) {
				g.playing = state.isPlaying;
				try {
					if (state.isPlaying) {
						await adapter.play(signal);
					} else {
						await adapter.pause(signal);
					}
				} catch (error) {
					refresh();
					if (active !== g || signal.aborted) {
						return;
					}
					g.playing = null;
					if (state.isPlaying && autoplayBlocked(error)) {
						g.blocked = true;
						publish("autoplay-blocked", g);
						return;
					}
					throw error;
				}
				if (!current(g, version)) {
					return;
				}
			}
			g.blocked = false;
			publish(state.isPlaying ? (g.buffering ? "buffering" : "playing") : "paused", g);
		} catch (error) {
			// Stale async failures have no bearing on the replacement occurrence.
			refresh();
			fail(g, error);
		}
	};

	const pump = (): void => {
		if (disposed || worker || !dirty || !projection?.state || active?.failed) {
			return;
		}
		const now = options.now();
		if (!Number.isFinite(now) || now - lastStartedMs < intervalMs) {
			return;
		}
		lastStartedMs = now;
		dirty = false;
		worker = Promise.resolve()
			.then(reconcile)
			.finally(() => {
				worker = null;
				pump();
			});
	};

	function tick(): void {
		if (disposed) {
			return;
		}
		refresh();
		dirty = true;
		pump();
		if (options.scheduler && timeline && !timer) {
			timer = {
				handle: options.scheduler.setTimeout(() => {
					timer = null;
					tick();
				}, intervalMs),
			};
		}
	}

	return {
		installSnapshot: input => {
			if (disposed) {
				return false;
			}
			let candidate: PlaybackTimeline;
			try {
				candidate = parsePlaybackTimeline(input);
			} catch (error) {
				recover("invalid-snapshot", error);
				return false;
			}
			if (timeline?.epoch === candidate.epoch) {
				const previousTail = timeline.events.at(-1);
				const candidateTail = candidate.events.at(-1);
				if (
					cursor(candidate) < cursor(timeline) ||
					(candidateTail?.occurrenceId ?? candidate.baseline.lastOccurrenceId) <
						(previousTail?.occurrenceId ?? timeline.baseline.lastOccurrenceId) ||
					(candidateTail?.effectiveAtMs ?? candidate.baseline.lastEffectiveAtMs) <
						(previousTail?.effectiveAtMs ?? timeline.baseline.lastEffectiveAtMs)
				) {
					recover("snapshot-rollback");
					return false;
				}
				const conflict = timeline.events.some(event => {
					const other = candidate.events.find(next => next.sequence === event.sequence);
					return other && JSON.stringify(event) !== JSON.stringify(other);
				});
				const horizon = Math.max(
					candidate.baseline.serverTimeMs,
					timeline.baseline.serverTimeMs,
				);
				if (
					conflict ||
					(cursor(candidate) === cursor(timeline) &&
						JSON.stringify(compactPlaybackTimeline(timeline, horizon)) !==
							JSON.stringify(compactPlaybackTimeline(candidate, horizon)))
				) {
					recover("snapshot-conflict");
					return false;
				}
				candidate = compactPlaybackTimeline(candidate, horizon);
			}
			retire();
			timeline = candidate;
			projection = null;
			appliedSequence = candidate.baseline.sequence;
			recovering = false;
			revision += 1;
			alignment += 1;
			tick();
			return true;
		},
		acceptEvent: input => {
			if (disposed || recovering) {
				return "rejected";
			}
			if (!timeline) {
				recover("missing-snapshot");
				return "rejected";
			}
			try {
				const result = acceptPlaybackEvent(timeline, input);
				timeline = result.timeline;
				if (result.status === "accepted") {
					tick();
				}
				return result.status;
			} catch (error) {
				recover(
					error instanceof PlaybackTimelineException ? error.code : "invalid-event",
					error,
				);
				return "rejected";
			}
		},
		tick,
		userActivated: () => {
			if (active?.blocked && !disposed) {
				const g = active;
				try {
					g.adapter?.activate?.();
				} catch (error) {
					fail(g, error);
					return;
				}
				if (active !== g || g.abort.signal.aborted) {
					return;
				}
				active.blocked = false;
				active.playing = null;
				alignment += 1;
				revision += 1;
				tick();
			}
		},
		retry: () => {
			if (active?.failed && !disposed) {
				retire();
				revision += 1;
				tick();
			}
		},
		getStatus: () => ({
			...status,
			scope: status.scope ? { ...status.scope, media: { ...status.scope.media } } : null,
		}),
		whenIdle: () => worker ?? Promise.resolve(),
		dispose: () => {
			if (disposed) {
				return;
			}
			disposed = true;
			if (timer) {
				options.scheduler?.clearTimeout(timer.handle);
				timer = null;
			}
			retire();
			timeline = null;
			projection = null;
			dirty = false;
			publish("disposed");
		},
	};
}
