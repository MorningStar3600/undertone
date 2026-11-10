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

/** A bounded SDK wait elapsed without a provider failure or browser policy rejection. */
export class PlaybackDeferredError extends Error {}

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
	/** Per-command signal: abort must cancel pending playback and settle promptly. */
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
	/** At least 50 ms; bounds periodic drift work, not newly effective authority. */
	intervalMs?: number;
	driftThresholdSeconds?: number;
	driftReleaseSeconds?: number;
	seekCooldownMs?: number;
	/** Pause/resume alignment ignores smaller SDK sampling differences. */
	controlToleranceSeconds?: number;
}

export interface PlaybackController {
	/** Transport authenticates room/request identity and authorizes epoch replacement first. */
	installSnapshot(input: unknown): boolean;
	acceptEvent(input: unknown): PlaybackAcceptance["status"] | "rejected";
	/** Call after clock calibration/reset as well as periodically without a scheduler. */
	tick(): void;
	/** Measure promptly after lifecycle resume; at most one deferred retry per generation. */
	resume(): void;
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
	deferred: boolean;
	resumeRetryUsed: boolean;
	resumeCheck: boolean;
	playing: boolean | null;
	rate: number | null;
	aligned: number;
	lastSeekMs: number;
	drifting: boolean;
	driftDirection: number;
	driftSinceMs: number | null;
	controlAligned: number;
	playAbort: AbortController | null;
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
	const driftThreshold = positive(options.driftThresholdSeconds ?? 0.3, "driftThresholdSeconds");
	const driftRelease = positive(options.driftReleaseSeconds ?? 0.1, "driftReleaseSeconds");
	const cooldownMs = positive(options.seekCooldownMs ?? 1_000, "seekCooldownMs");
	const controlTolerance = positive(
		options.controlToleranceSeconds ?? 0.1,
		"controlToleranceSeconds",
	);
	if (driftRelease >= driftThreshold) {
		throw new RangeError("driftReleaseSeconds must be below driftThresholdSeconds");
	}
	let timeline: PlaybackTimeline | null = null;
	let projection: PlaybackProjection | null = null;
	let active: Generation<Source> | null = null;
	let generation = 0;
	let revision = 0;
	let alignment = 0;
	let controlAlignment = 0;
	let appliedSequence = 0;
	let recovering = false;
	let disposed = false;
	let dirty = false;
	let urgent = false;
	let worker: Promise<void> | null = null;
	let lastStartedMs = Number.NEGATIVE_INFINITY;
	let lastResumeMs = Number.NEGATIVE_INFINITY;
	let timer: { handle: unknown; dueMs: number } | null = null;
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
		g.playAbort?.abort();
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
			if (next.state?.isPlaying !== projection?.state?.isPlaying) {
				controlAlignment += 1;
				if (active?.loaded) {
					active.deferred = false;
				}
			}
			appliedSequence = next.appliedSequence;
			revision += 1;
			dirty = true;
			urgent = true;
		}
		projection = next;
		timeline = compactPlaybackTimeline(timeline, queryMs);
		if (
			next.state &&
			active?.playAbort &&
			(!next.state.isPlaying || !active.adapter?.supportsRate(next.state.rate))
		) {
			active.playAbort.abort();
		}
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
							// Continue a startup/control pass interrupted by a seek's buffering callback.
							if (g.loaded && g.playing !== projection?.state?.isPlaying) {
								urgent = true;
							}
							publish("buffering", g);
						}
					} else if (event.type === "resumed") {
						// Late readiness can finish the original captured surface after its bounded wait.
						if (g.deferred && !g.loaded) {
							g.deferred = false;
							urgent = true;
						}
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
						if (event.isPlaying && g.deferred) {
							g.deferred = false;
							g.resumeCheck = true;
							urgent = true;
						}
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
			deferred: false,
			resumeRetryUsed: false,
			resumeCheck: false,
			playing: null,
			rate: null,
			aligned: -1,
			lastSeekMs: Number.NEGATIVE_INFINITY,
			drifting: false,
			driftDirection: 0,
			driftSinceMs: null,
			controlAligned: -1,
			playAbort: null,
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
		if (g.deferred) {
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
			// One measured catch-up per slow seek/play; never recurse after the catch-up seek.
			const catchUp = async (startedMs: number): Promise<boolean> => {
				if (!current(g, version)) {
					return false;
				}
				const latest = projection!.state!;
				if (
					g.buffering ||
					!latest.isPlaying ||
					(options.now() - startedMs) * latest.rate < controlTolerance * 1_000
				) {
					return true;
				}
				const position = await adapter.getPosition(signal);
				if (!current(g, version)) {
					return false;
				}
				if (!Number.isFinite(position) || position < 0) {
					throw new RangeError("Invalid adapter media position");
				}
				if (Math.abs(position - projection!.state!.positionSeconds) > controlTolerance) {
					g.lastSeekMs = options.now();
					await adapter.seek(projection!.state!.positionSeconds, signal);
				}
				return current(g, version);
			};
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
			// Stop promptly, before an asynchronous position sample or alignment seek.
			if (!state.isPlaying && g.playing !== false) {
				g.playing = false;
				await adapter.pause(signal);
				if (!current(g, version)) {
					return;
				}
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
				const sampledAtMs = options.now();
				const position = await adapter.getPosition(signal);
				if (!current(g, version)) {
					return;
				}
				if (!Number.isFinite(position) || position < 0) {
					throw new RangeError("Invalid adapter media position");
				}
				state = projection.state!;
				const drift = Math.abs(position - state.positionSeconds);
				const direction = Math.sign(position - state.positionSeconds);
				const localNow = options.now();
				// Seeking small residuals is audible and provider seeks need not land exactly.
				// Lifecycle checks use the normal drift threshold, plus measurement uncertainty.
				const uncertaintyMs = options.clock.getEstimate().uncertaintyMs;
				const resumeTolerance =
					Math.max(
						driftThreshold,
						((uncertaintyMs ?? Number.POSITIVE_INFINITY) / 1_000) * state.rate,
					) + (state.isPlaying ? ((localNow - sampledAtMs) / 1_000) * state.rate : 0);
				// Lifecycle resume is evidence to sample now, not evidence that a seek is needed.
				const resumeDrift = g.resumeCheck && drift > resumeTolerance;
				g.resumeCheck = false;
				if (drift <= driftRelease) {
					g.drifting = false;
					g.driftSinceMs = null;
				} else if (drift >= driftThreshold) {
					if (!g.drifting || g.driftDirection !== direction) {
						g.driftSinceMs = localNow;
					}
					g.drifting = true;
					g.driftDirection = direction;
				} else if (g.driftDirection !== direction) {
					g.drifting = false;
					g.driftSinceMs = null;
				}
				const controlDrift =
					g.controlAligned !== controlAlignment &&
					(state.isPlaying || drift > controlTolerance);
				g.controlAligned = controlAlignment;
				if (
					g.aligned !== alignment ||
					controlDrift ||
					resumeDrift ||
					(g.drifting &&
						g.driftSinceMs !== null &&
						localNow - g.driftSinceMs >= intervalMs &&
						localNow - g.lastSeekMs >= cooldownMs)
				) {
					// Reserve the correction before the SDK can synchronously report buffering.
					// A failed seek tears down this generation; explicit later seeks advance alignment.
					g.aligned = alignment;
					g.lastSeekMs = localNow;
					g.drifting = false;
					g.driftSinceMs = null;
					await adapter.seek(state.positionSeconds, signal);
					if (!(await catchUp(localNow))) {
						return;
					}
				}
			}
			state = projection.state!;
			if (g.playing !== state.isPlaying) {
				g.playing = state.isPlaying;
				if (state.isPlaying && g.buffering) {
					// Do not turn recovery from a cued/buffering play into a second forced seek.
					g.controlAligned = controlAlignment;
				}
				const startedMs = options.now();
				try {
					if (state.isPlaying) {
						const command = new AbortController();
						g.playAbort = command;
						try {
							await adapter.play(command.signal);
							if (command.signal.aborted) {
								if (g.playing) {
									g.playing = null;
								}
								return;
							}
						} catch (error) {
							if (command.signal.aborted) {
								if (g.playing) {
									g.playing = null;
								}
								return;
							}
							throw error;
						} finally {
							g.playAbort = null;
						}
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
				if (state.isPlaying && !(await catchUp(startedMs))) {
					return;
				}
			}
			g.blocked = false;
			publish(state.isPlaying ? (g.buffering ? "buffering" : "playing") : "paused", g);
		} catch (error) {
			// Stale async failures have no bearing on the replacement occurrence.
			refresh();
			if (error instanceof PlaybackDeferredError && live(g)) {
				// Keep the captured surface for late readiness. Ordinary ticks never retry it.
				if (!g.loaded || projection.state.isPlaying) {
					g.deferred = true;
					publish("buffering", g);
					// A lifecycle signal may have arrived while this bounded SDK wait was pending.
					if (g.resumeCheck && !g.resumeRetryUsed) {
						g.resumeRetryUsed = true;
						g.deferred = false;
						dirty = true;
						urgent = true;
					}
				} else {
					dirty = true;
					urgent = true;
				}
				return;
			}
			fail(g, error);
		}
	};

	const pump = (): void => {
		if (disposed || worker || !dirty || !projection?.state || active?.failed) {
			return;
		}
		const now = options.now();
		if (!Number.isFinite(now) || (!urgent && now - lastStartedMs < intervalMs)) {
			return;
		}
		lastStartedMs = now;
		dirty = false;
		urgent = false;
		worker = Promise.resolve()
			.then(reconcile)
			.finally(() => {
				worker = null;
				pump();
			});
	};

	function schedule(): void {
		if (!options.scheduler || !timeline || disposed) {
			return;
		}
		const estimate = options.clock.getEstimate();
		const nextEvent = timeline.events[0];
		const delay =
			estimate.ready && nextEvent
				? Math.min(intervalMs, Math.max(1, nextEvent.effectiveAtMs - estimate.serverNowMs))
				: intervalMs;
		const dueMs = options.now() + delay;
		if (timer && timer.dueMs <= dueMs) {
			return;
		}
		if (timer) {
			options.scheduler.clearTimeout(timer.handle);
		}
		timer = {
			dueMs,
			handle: options.scheduler.setTimeout(() => {
				timer = null;
				tick();
			}, delay),
		};
	}

	function tick(): void {
		if (disposed) {
			return;
		}
		refresh();
		if (projection?.state && !active) {
			urgent = true;
		}
		dirty = true;
		pump();
		schedule();
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
		resume: () => {
			if (disposed) {
				return;
			}
			const now = options.now();
			if (now - lastResumeMs >= intervalMs) {
				lastResumeMs = now;
				if (active) {
					active.resumeCheck = true;
					if (active.deferred && !active.resumeRetryUsed) {
						active.resumeRetryUsed = true;
						active.deferred = false;
					}
				}
				urgent = true;
			}
			tick();
		},
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
				urgent = true;
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
