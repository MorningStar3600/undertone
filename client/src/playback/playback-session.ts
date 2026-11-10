import type { PermissionName } from "ott-common/permissions";
import { z } from "zod";
import { ALL_VIDEO_SERVICES } from "ott-common";
import {
	acceptPlaybackEvent,
	compactPlaybackTimeline,
	expectedPlaybackAt,
	parsePlaybackTimeline,
	PlaybackEventSchema,
	PlaybackMediaSchema,
	type PlaybackTimeline,
	type PlaybackState,
} from "ott-common/playback/index.js";
import { PlaybackCommandSchema, type PlaybackAttachment } from "ott-common/playback/transport.js";
import type { QueueItem } from "ott-common/models/video";
import type { ServerMessage, ServerMessageActionType } from "ott-common/models/messages";
import type { LegacyPlaybackSync, OttRoomConnection } from "@/plugins/connection";
import { createServerClock } from "./server-clock";
import {
	createPlaybackController,
	type PlaybackAdapter,
	type PlaybackAdapterContext,
	type PlaybackControllerStatus,
} from "./playback-controller";

export type PlaybackIntention =
	| { command: "play" | "pause" | "next" | "previous" }
	| { command: "seek"; positionSeconds: number }
	| { command: "rate"; rate: number };

export interface PlaybackSessionOptions {
	connection: OttRoomConnection;
	now(): number;
	createAdapter(context: PlaybackAdapterContext): PlaybackAdapter<QueueItem>;
	/** Authority includes negotiation/recovery, even before a timeline has been established. */
	onState(state: PlaybackState | null, item: QueueItem | null, ownsPlayback: boolean): void;
	onLegacyState?(sync: LegacyPlaybackSync): void;
	onStatus?(status: PlaybackControllerStatus): void;
	allowed(grant: PermissionName): boolean;
}

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// QueueItem remains adapter metadata. No resolver URLs, credentials or provider lookups are added.
const itemSchema = z
	.object({
		service: z
			.string()
			.refine(service => (ALL_VIDEO_SERVICES as readonly string[]).includes(service)),
		id: z.string().min(1).max(8192),
		length: z.number().finite().nonnegative().optional(),
		title: z.string().optional(),
		description: z.string().optional(),
		thumbnail: z.string().optional(),
		mime: z.string().optional(),
		// eslint-disable-next-line camelcase
		hls_url: z.string().optional(),
		// eslint-disable-next-line camelcase
		dash_url: z.string().optional(),
		// eslint-disable-next-line camelcase
		src_url: z.string().optional(),
		subtitleUrl: z.string().optional(),
		startAt: z.number().finite().nonnegative().optional(),
		endAt: z.number().finite().nonnegative().optional(),
		trackId: z.string().optional(),
		sourceId: z.string().optional(),
		entryId: z.string().optional(),
		contributorId: z.string().optional(),
		origin: z.enum(["automatic", "manual", "recommendation"]).optional(),
		originalReference: z.object({ service: z.string(), id: z.string() }).optional(),
		highlight: z.literal(true).optional(),
	})
	.strict();
const attachmentSchema = z
	.object({
		epoch: z.string(),
		sequence: counter.min(1),
		occurrenceId: counter.min(1),
		media: PlaybackMediaSchema.refine(media => media.service === "adapter"),
		item: itemSchema,
		playbackId: z.string().optional(),
	})
	.strict();
const snapshotSchema = z
	.object({
		action: z.literal("playback-snapshot"),
		nonce: z.string(),
		timeline: z.unknown(),
		attachment: attachmentSchema.nullable(),
	})
	.strict();
const eventSchema = z
	.object({
		action: z.literal("playback-event"),
		event: PlaybackEventSchema,
		attachment: attachmentSchema.optional(),
	})
	.strict()
	.superRefine((message, context) => {
		const { event, attachment } = message;
		if (event.type === "source" || event.type === "load") {
			if (
				!attachment ||
				attachment.epoch !== event.epoch ||
				attachment.sequence !== event.sequence ||
				attachment.occurrenceId !== event.occurrenceId ||
				attachment.media.service !== event.media.service ||
				attachment.media.id !== event.media.id
			) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Missing or mismatched event attachment",
				});
			}
		} else if (attachment) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Unexpected event attachment",
			});
		}
	});
const clockReplySchema = z
	.object({
		action: z.literal("clock-reply"),
		generation: counter,
		nonce: z.string().min(1).max(128),
		serverReceiveMs: counter,
		serverSendMs: counter,
	})
	.strict();
const resultSchema = z
	.object({
		requestId: z.string(),
		epoch: z.string(),
		sequence: counter,
		status: z.enum(["applied", "rejected"]),
		code: z
			.enum([
				"request-conflict",
				"capacity",
				"stale-epoch",
				"stale-occurrence",
				"unauthorized",
				"unavailable",
				"failed",
			])
			.optional(),
	})
	.strict();
const cursor = (timeline: PlaybackTimeline) =>
	timeline.events.at(-1)?.sequence ?? timeline.baseline.sequence;
const endTime = (timeline: PlaybackTimeline) =>
	timeline.events.at(-1)?.effectiveAtMs ?? timeline.baseline.serverTimeMs;
const identity = (epoch: string, occurrence: number, id: string) => `${epoch}/${occurrence}/${id}`;
const sessions = new WeakMap<OttRoomConnection, PlaybackSession>();
// Sync is authenticated room evidence; disconnect/open/outgoing auth alone start no deadline.
const CAPABILITY_WAIT_MS = 1_000;
const legacySchema = z.object({
	action: z.literal("sync"),
	currentSource: itemSchema.nullable().optional(),
	isPlaying: z.boolean().optional(),
	playbackPosition: z.number().finite().nonnegative().optional(),
	playbackSpeed: z.number().finite().positive().optional(),
});
export const getPlaybackSession = (connection: OttRoomConnection) => sessions.get(connection);
export type PlaybackSession = ReturnType<typeof createPlaybackSession>;

/** One subscription, clock and rendering pipeline per Room. All listeners precede subscribe. */
export function createPlaybackSession(options: PlaybackSessionOptions) {
	const { connection, now } = options;
	const clock = createServerClock({ now });
	const sessionId = crypto.randomUUID();
	let timeline: PlaybackTimeline | null = null;
	let established = false;
	let mode: "negotiating" | "legacy" | "modern" = "negotiating";
	let legacySync: LegacyPlaybackSync = { action: "sync" };
	let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
	let capable = false;
	let disposed = false;
	let generation = 0;
	let serial = 0;
	let nonce: string | null = null;
	let attempts = 0;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let lastProbe = -Infinity;
	let lastTick = now();
	let sentTimes: number[] = [];
	let buffer: unknown[] = [];
	const attachments = new Map<string, PlaybackAttachment>();
	const receipts = new Map<string, string>();
	const pending = new Map<
		string,
		{ epoch: string; occurrenceId: number; at: number; command: PlaybackIntention["command"] }
	>();
	const unsubs: (() => void)[] = [];

	function send(message: Parameters<OttRoomConnection["send"]>[0]) {
		const time = now();
		sentTimes = sentTimes.filter(at => time - at < 10_000);
		if (disposed || sentTimes.length >= 16) {
			return false;
		}
		try {
			connection.send(message);
			sentTimes.push(time);
			return true;
		} catch {
			return false;
		}
	}
	function probe() {
		if (
			!capable ||
			now() - lastProbe < 2_000 ||
			sentTimes.filter(at => now() - at < 10_000).length >= 16
		) {
			return;
		}
		lastProbe = now();
		const probe = clock.createProbe();
		if (
			probe &&
			!send({ action: "clock-probe", generation: probe.generation, nonce: probe.nonce })
		) {
			clock.reset();
		}
	}
	function requestSnapshot() {
		if (disposed || !capable) {
			return;
		}
		nonce = `${sessionId}-g${generation}-${++serial}`;
		// Buffer is already installed. Never queue timestamps or automatically retry commands.
		send({ action: "playback-subscribe", version: 1, nonce });
		clearTimeout(retryTimer);
		retryTimer = setTimeout(
			requestSnapshot,
			Math.min(8_000, 1_000 * 2 ** Math.min(attempts++, 3)),
		);
		probe();
	}
	function recover() {
		if (disposed) {
			return;
		}
		nonce = null;
		pending.clear();
		// Invalid input latches controller recovery and synchronously disposes its surface.
		if (controller.getStatus().code !== "recovering") {
			controller.acceptEvent(null);
		}
		if (!retryTimer) {
			retryTimer = setTimeout(
				requestSnapshot,
				Math.min(8_000, 500 * 2 ** Math.min(attempts++, 4)),
			);
		}
	}
	function makeController() {
		return createPlaybackController<QueueItem>({
			clock,
			now,
			createAdapter: options.createAdapter,
			resolveSource(media, context) {
				const attachment = attachments.get(
					identity(context.epoch, context.occurrenceId, media.id),
				);
				if (!attachment || media.service !== "adapter") {
					throw new Error("Missing playback attachment");
				}
				return structuredClone(attachment.item);
			},
			onRecovery: () => recover(),
			onStatus: options.onStatus,
		});
	}
	let controller = makeController();
	function validateAttachment(
		value: unknown,
		state: PlaybackState | null,
		epoch: string,
		sequence: number,
		exact: boolean,
	) {
		if (!state) {
			if (value != null) {
				throw new Error("Unexpected playback attachment");
			}
			return null;
		}
		const attachment = attachmentSchema.parse(value) as PlaybackAttachment;
		if (
			state.media.service !== "adapter" ||
			attachment.epoch !== epoch ||
			attachment.occurrenceId !== state.occurrenceId ||
			attachment.media.id !== state.media.id ||
			attachment.sequence > sequence ||
			(exact && attachment.sequence !== sequence)
		) {
			throw new Error("Mismatched playback attachment");
		}
		const previous = attachments.get(identity(epoch, state.occurrenceId, state.media.id));
		if (
			previous &&
			(previous.sequence > attachment.sequence ||
				JSON.stringify(previous.item) !== JSON.stringify(attachment.item) ||
				previous.playbackId !== attachment.playbackId)
		) {
			throw new Error("Conflicting playback attachment");
		}
		return attachment;
	}
	function installAttachment(attachment: PlaybackAttachment | null) {
		if (attachment) {
			attachments.set(
				identity(attachment.epoch, attachment.occurrenceId, attachment.media.id),
				attachment,
			);
		}
	}
	function publish() {
		if (!timeline || !established || controller.getStatus().code === "recovering") {
			return;
		}
		const estimate = clock.getEstimate();
		// No wall-clock fallback. Controls are held while clock authority is unavailable.
		if (!estimate.ready) {
			return;
		}
		const time = Math.max(timeline.baseline.serverTimeMs, Math.floor(estimate.serverNowMs));
		const { state } = expectedPlaybackAt(timeline, time);
		const item = state
			? attachments.get(identity(timeline.epoch, state.occurrenceId, state.media.id))?.item
			: null;
		if (state && !item) {
			recover();
			return;
		}
		options.onState(state, item ?? null, true);
		prunePending(state);
		timeline = compactPlaybackTimeline(timeline, time);
		const keep = new Set<string>();
		if (state) {
			keep.add(identity(timeline.epoch, state.occurrenceId, state.media.id));
		}
		for (const event of timeline.events) {
			if (event.type === "load" || event.type === "source") {
				keep.add(identity(event.epoch, event.occurrenceId, event.media.id));
			}
		}
		for (const key of attachments.keys()) {
			if (!keep.has(key)) {
				attachments.delete(key);
			}
		}
	}
	function prunePending(state: PlaybackState | null) {
		for (const [id, intention] of pending) {
			if (
				intention.epoch !== timeline?.epoch ||
				intention.occurrenceId !== (state?.occurrenceId ?? 0)
			) {
				pending.delete(id);
			}
		}
	}
	function accept(input: unknown) {
		if (!timeline) {
			throw new Error("Missing snapshot");
		}
		const message = eventSchema.parse(input);
		const { event } = message;
		const key = event.epoch + "/" + event.sequence;
		const fingerprint = JSON.stringify(message);
		const known = receipts.get(key);
		if (event.epoch !== timeline.epoch) {
			throw new Error("Event epoch mismatch");
		}
		if (known && known !== fingerprint) {
			throw new Error("Conflicting event receipt");
		}
		if (known) {
			return;
		}
		const accepted = acceptPlaybackEvent(timeline, event);
		if (accepted.status !== "accepted") {
			return;
		}
		const state = expectedPlaybackAt(
			accepted.timeline,
			Math.max(endTime(accepted.timeline), accepted.timeline.baseline.serverTimeMs),
		).state;
		if (event.type === "load" || event.type === "source") {
			installAttachment(
				validateAttachment(message.attachment, state, event.epoch, event.sequence, true),
			);
		} else if (message.attachment) {
			throw new Error("Unexpected event attachment");
		}
		if (attachments.size > 128) {
			throw new Error("Playback attachment capacity");
		}
		if (controller.acceptEvent(event) === "rejected") {
			return;
		}
		receipts.set(key, fingerprint);
		if (receipts.size > 128) {
			receipts.delete(receipts.keys().next().value);
		}
		timeline = accepted.timeline;
		publish();
	}
	function listen(action: ServerMessageActionType, handler: (message: ServerMessage) => void) {
		connection.addMessageHandler(action, handler);
		unsubs.push(() => connection.removeMessageHandler(action, handler));
	}
	function bufferLegacy(message: unknown) {
		if (disposed || mode !== "negotiating") {
			return;
		}
		const parsed = legacySchema.safeParse(message);
		if (!parsed.success) {
			return;
		}
		legacySync = { ...legacySync, ...parsed.data } as LegacyPlaybackSync;
		if (fallbackTimer) {
			return;
		}
		const currentGeneration = generation;
		fallbackTimer = setTimeout(() => {
			fallbackTimer = undefined;
			if (disposed || mode !== "negotiating" || generation !== currentGeneration) {
				return;
			}
			mode = "legacy";
			established = false;
			options.onState(null, null, false);
			options.onLegacyState?.(legacySync);
			legacySync = { action: "sync" };
		}, CAPABILITY_WAIT_MS);
	}
	function selectModern() {
		clearTimeout(fallbackTimer);
		fallbackTimer = undefined;
		legacySync = { action: "sync" };
		mode = "modern";
		capable = true;
		// Also detach a legacy surface after late capability, before awaiting its fresh snapshot.
		options.onState(null, null, true);
		requestSnapshot();
	}
	listen("sync", bufferLegacy);
	listen("playback-capabilities", message => {
		if (
			message.action !== "playback-capabilities" ||
			message.version !== 1 ||
			message.recovery !== "snapshot" ||
			Object.keys(message).length !== 3 ||
			capable
		) {
			return;
		}
		selectModern();
	});
	listen("playback-event", message => {
		if (!capable || disposed) {
			return;
		}
		if (nonce || controller.getStatus().code === "recovering") {
			if (buffer.length >= 128) {
				buffer = [];
				recover();
				return;
			}
			buffer.push(message);
			return;
		}
		try {
			accept(message);
		} catch {
			recover();
		}
	});
	listen("playback-snapshot", input => {
		if (!capable || input.action !== "playback-snapshot" || input.nonce !== nonce || disposed) {
			return;
		}
		try {
			const message = snapshotSchema.parse(input);
			const previousEpoch = timeline?.epoch;
			const candidate = parsePlaybackTimeline(message.timeline);
			if (timeline?.epoch === candidate.epoch && cursor(candidate) < cursor(timeline)) {
				throw new Error("Snapshot rollback");
			}
			const active = expectedPlaybackAt(candidate, candidate.baseline.serverTimeMs);
			const attachment = validateAttachment(
				message.attachment,
				active.state,
				candidate.epoch,
				active.appliedSequence,
				false,
			);
			// Current protocol supplies only the active attachment. Reject unresolved future sources.
			const states = candidate.events
				.filter(
					event =>
						event.effectiveAtMs > candidate.baseline.serverTimeMs &&
						(event.type === "load" || event.type === "source"),
				)
				.map(event => ({
					occurrenceId: event.occurrenceId,
					media: "media" in event ? event.media : null,
				}));
			for (const value of states) {
				if (
					value?.media &&
					(!attachment ||
						value.occurrenceId !== attachment.occurrenceId ||
						value.media.id !== attachment.media.id)
				) {
					throw new Error("Missing future attachment");
				}
			}
			installAttachment(attachment);
			if (!controller.installSnapshot(candidate)) {
				return;
			}
			timeline = candidate;
			established = true;
			nonce = null;
			attempts = 0;
			options.onState(null, null, true);
			clearTimeout(retryTimer);
			retryTimer = undefined;
			const arrivals = buffer;
			buffer = [];
			for (const arrival of arrivals) {
				const parsed = eventSchema.parse(arrival);
				if (parsed.event.epoch !== candidate.epoch && previousEpoch === candidate.epoch) {
					throw new Error("Buffered epoch conflict");
				}
				if (
					parsed.event.epoch === candidate.epoch &&
					parsed.event.sequence > candidate.baseline.sequence
				) {
					accept(parsed);
				}
			}
			publish();
			controller.tick();
		} catch {
			recover();
		}
	});
	listen("clock-reply", message => {
		if (capable && clockReplySchema.safeParse(message).success && clock.acceptReply(message)) {
			controller.tick();
			publish();
		}
	});
	listen("playback-result", message => {
		if (message.action !== "playback-result") {
			return;
		}
		const parsed = resultSchema.safeParse(message.result);
		if (!parsed.success) {
			return;
		}
		const result = parsed.data;
		const intention = pending.get(result.requestId);
		if (!intention || intention.epoch !== timeline?.epoch) {
			return;
		}
		pending.delete(result.requestId);
		if (
			result.code === "stale-epoch" ||
			result.code === "stale-occurrence" ||
			result.epoch !== intention.epoch
		) {
			recover();
		}
	});
	function reset() {
		++generation;
		established = false;
		mode = "negotiating";
		clearTimeout(fallbackTimer);
		fallbackTimer = undefined;
		legacySync = { action: "sync" };
		capable = false;
		nonce = null;
		timeline = null;
		buffer = [];
		attachments.clear();
		receipts.clear();
		pending.clear();
		sentTimes = [];
		lastProbe = -Infinity;
		lastTick = now();
		clearTimeout(retryTimer);
		retryTimer = undefined;
		attempts = 0;
		clock.reset();
		controller.dispose();
		controller = makeController();
		// Hold rendering and commands until this generation negotiates its own authority.
		options.onState(null, null, true);
	}
	const unsubLifecycle = connection.onLifecycle?.(reset);
	if (unsubLifecycle) {
		unsubs.push(unsubLifecycle);
	}
	const interval = setInterval(() => {
		const time = now();
		if (time < lastTick) {
			resume();
		} else if (time - lastTick > 5_000) {
			refreshClock();
		}
		lastTick = time;
		controller.tick();
		publish();
		if (time - lastProbe >= 5_000) {
			probe();
		}
		for (const [id, intention] of pending) {
			if (time - intention.at > 15_000) {
				pending.delete(id);
				recover();
			}
		}
	}, 250);
	function refreshClock() {
		if (disposed) {
			return;
		}
		// Visibility and timer throttling do not invalidate a still-fresh estimate.
		// The estimator itself rejects expired samples and discontinuous clock readings.
		controller.tick();
		probe();
	}
	function resume() {
		if (disposed) {
			return;
		}
		clock.reset();
		controller.tick();
		lastProbe = -Infinity;
		probe();
	}
	const session = {
		get established() {
			return established;
		},
		get ownsPlayback() {
			return mode !== "legacy";
		},
		get controller() {
			return controller;
		},
		resume,
		refreshClock,
		command(intention: PlaybackIntention) {
			if (mode === "legacy" && !disposed) {
				return false;
			}
			if (intention.command === "play") {
				controller.userActivated();
			}
			const estimate = clock.getEstimate();
			if (
				!timeline ||
				nonce ||
				!estimate.ready ||
				controller.getStatus().code === "recovering"
			) {
				return true;
			}
			const projection = expectedPlaybackAt(
				timeline,
				Math.max(timeline.baseline.serverTimeMs, Math.floor(estimate.serverNowMs)),
			);
			const state = projection.state;
			// A scheduled occurrence can become effective between projection ticks.
			prunePending(state);
			const grant =
				intention.command === "seek"
					? "playback.seek"
					: intention.command === "rate"
						? "playback.speed"
						: intention.command === "next" || intention.command === "previous"
							? "playback.skip"
							: "playback.play-pause";
			if (
				(!state && intention.command !== "previous") ||
				!options.allowed(grant) ||
				pending.size >= 64
			) {
				return true;
			}
			if (
				(intention.command === "next" || intention.command === "previous") &&
				[...pending.values()].some(
					value =>
						(value.command === "next" || value.command === "previous") &&
						value.epoch === timeline?.epoch &&
						value.occurrenceId === (state?.occurrenceId ?? 0),
				)
			) {
				return true;
			}
			const command = PlaybackCommandSchema.safeParse({
				...intention,
				requestId: `${sessionId}-g${generation}-c${++serial}`,
				epoch: timeline.epoch,
				occurrenceId: state?.occurrenceId ?? 0,
				...(intention.command === "previous"
					? { sequence: projection.appliedSequence }
					: {}),
			});
			if (command.success) {
				pending.set(command.data.requestId, {
					epoch: timeline.epoch,
					occurrenceId: state?.occurrenceId ?? 0,
					at: now(),
					command: intention.command,
				});
				if (!send({ action: "playback-command", command: command.data })) {
					pending.delete(command.data.requestId);
				}
			}
			return true;
		},
		dispose() {
			if (disposed) {
				return;
			}
			disposed = true;
			established = false;
			capable = false;
			nonce = null;
			timeline = null;
			clock.reset();
			clearInterval(interval);
			clearTimeout(retryTimer);
			clearTimeout(fallbackTimer);
			for (const unsub of unsubs) {
				unsub();
			}
			controller.dispose();
			attachments.clear();
			receipts.clear();
			pending.clear();
			buffer = [];
			legacySync = { action: "sync" };
			if (sessions.get(connection) === session) {
				sessions.delete(connection);
			}
			options.onState(null, null, false);
		},
	};
	sessions.set(connection, session);
	options.onState(null, null, true);
	if (connection.playbackCapability) {
		selectModern();
	} else if (connection.playbackSync) {
		bufferLegacy(connection.playbackSync);
	}
	return session;
}
