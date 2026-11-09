import { z } from "zod";
import { OttException } from "../exceptions.js";
import {
	MAX_PLAYBACK_EVENTS,
	MAX_POSITION_SECONDS,
	PlaybackEpochSchema,
	PlaybackEventSchema,
	PlaybackTimelineShapeSchema,
	ServerTimeMsSchema,
	type PlaybackBaseline,
	type PlaybackEvent,
	type PlaybackState,
	type PlaybackTimeline,
} from "./schema.js";

export type PlaybackTimelineErrorCode =
	| "epoch-mismatch"
	| "sequence-gap"
	| "sequence-conflict"
	| "effective-time-regression"
	| "stale-occurrence"
	| "capacity"
	| "before-baseline";

export class PlaybackTimelineException extends OttException {
	name = "PlaybackTimelineException";
	constructor(public readonly code: PlaybackTimelineErrorCode) {
		super(`Playback timeline: ${code}`);
	}
}

/** Receipt progress is distinct from the sequence effective at serverTimeMs. */
export interface PlaybackProjection {
	epoch: string;
	serverTimeMs: number;
	receivedSequence: number;
	appliedSequence: number;
	state: PlaybackState | null;
}

export interface PlaybackAcceptance {
	/** stale means the sequence was compacted: its old payload cannot be compared. */
	status: "accepted" | "duplicate" | "stale";
	timeline: PlaybackTimeline;
}

const positionAt = (anchor: PlaybackBaseline, timeMs: number): number => {
	const state = anchor.state;
	if (!state) {
		return 0;
	}
	const elapsedSeconds = state.isPlaying ? (timeMs - anchor.lastEffectiveAtMs) / 1000 : 0;
	return Math.min(MAX_POSITION_SECONDS, state.positionSeconds + elapsedSeconds * state.rate);
};

const applyEvent = (anchor: PlaybackBaseline, event: PlaybackEvent): PlaybackBaseline => {
	if (event.sequence !== anchor.sequence + 1) {
		throw new PlaybackTimelineException("sequence-gap");
	}
	if (event.effectiveAtMs < anchor.lastEffectiveAtMs) {
		throw new PlaybackTimelineException("effective-time-regression");
	}
	let state: PlaybackState | null;
	let lastOccurrenceId = anchor.lastOccurrenceId;
	if (event.type === "load") {
		if (event.occurrenceId !== lastOccurrenceId + 1) {
			throw new PlaybackTimelineException("stale-occurrence");
		}
		lastOccurrenceId = event.occurrenceId;
		state = {
			occurrenceId: event.occurrenceId,
			media: event.media,
			positionSeconds: event.positionSeconds,
			isPlaying: event.isPlaying,
			rate: event.rate,
		};
	} else {
		if (!anchor.state || event.occurrenceId !== anchor.state.occurrenceId) {
			throw new PlaybackTimelineException("stale-occurrence");
		}
		state = { ...anchor.state, positionSeconds: positionAt(anchor, event.effectiveAtMs) };
		switch (event.type) {
			case "play":
				state.isPlaying = true;
				break;
			case "pause":
				state.isPlaying = false;
				break;
			case "seek":
				state.positionSeconds = event.positionSeconds;
				break;
			case "rate":
				state.rate = event.rate;
				break;
			case "source":
				state.media = event.media;
				break;
			case "clear":
				state = null;
				break;
		}
	}
	return {
		serverTimeMs: event.effectiveAtMs,
		sequence: event.sequence,
		lastEffectiveAtMs: event.effectiveAtMs,
		lastOccurrenceId,
		state,
	};
};

const checkEpoch = (timeline: PlaybackTimeline, event: PlaybackEvent): void => {
	if (event.epoch !== timeline.epoch) {
		throw new PlaybackTimelineException("epoch-mismatch");
	}
};

/** Validate even future transitions; snapshots must be internally replayable. */
export const PlaybackTimelineSchema = PlaybackTimelineShapeSchema.superRefine((timeline, ctx) => {
	let anchor = timeline.baseline;
	for (const [index, event] of timeline.events.entries()) {
		try {
			checkEpoch(timeline, event);
			anchor = applyEvent(anchor, event);
		} catch (error) {
			if (!(error instanceof PlaybackTimelineException)) {
				throw error;
			}
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["events", index],
				message: error.message,
			});
			break;
		}
	}
});

export const parsePlaybackTimeline = (input: unknown): PlaybackTimeline =>
	PlaybackTimelineSchema.parse(input);

/** The authority injects the epoch and initialization time; no clock or RNG is read here. */
export const createPlaybackTimeline = (epoch: string, serverTimeMs: number): PlaybackTimeline => ({
	version: 1,
	epoch: PlaybackEpochSchema.parse(epoch),
	baseline: {
		serverTimeMs: ServerTimeMsSchema.parse(serverTimeMs),
		sequence: 0,
		lastEffectiveAtMs: serverTimeMs,
		lastOccurrenceId: 0,
		state: null,
	},
	events: [],
});

const receivedSequence = (timeline: PlaybackTimeline): number =>
	timeline.events.at(-1)?.sequence ?? timeline.baseline.sequence;

/** Accept in authoritative sequence order, never in delivery-time or effective-time order. */
export const acceptPlaybackEvent = (
	input: PlaybackTimeline,
	eventInput: unknown,
): PlaybackAcceptance => {
	const timeline = parsePlaybackTimeline(input);
	const event = PlaybackEventSchema.parse(eventInput);
	checkEpoch(timeline, event);
	if (event.sequence <= timeline.baseline.sequence) {
		return { status: "stale", timeline };
	}
	const previous = timeline.events[event.sequence - timeline.baseline.sequence - 1];
	if (previous) {
		// Both objects have been parsed into the same schema-defined key order.
		if (JSON.stringify(previous) !== JSON.stringify(event)) {
			throw new PlaybackTimelineException("sequence-conflict");
		}
		return { status: "duplicate", timeline };
	}
	if (event.sequence !== receivedSequence(timeline) + 1) {
		throw new PlaybackTimelineException("sequence-gap");
	}
	if (timeline.events.length >= MAX_PLAYBACK_EVENTS) {
		throw new PlaybackTimelineException("capacity");
	}
	let anchor = timeline.baseline;
	for (const accepted of timeline.events) {
		anchor = applyEvent(anchor, accepted);
	}
	applyEvent(anchor, event);
	return { status: "accepted", timeline: { ...timeline, events: [...timeline.events, event] } };
};

const anchorAt = (timeline: PlaybackTimeline, timeMs: number): PlaybackBaseline => {
	if (timeMs < timeline.baseline.serverTimeMs) {
		throw new PlaybackTimelineException("before-baseline");
	}
	let anchor = timeline.baseline;
	for (const event of timeline.events) {
		if (event.effectiveAtMs > timeMs) {
			break;
		}
		anchor = applyEvent(anchor, event);
	}
	return anchor;
};

/** Includes events effective exactly at timeMs, breaking ties by sequence. */
export const expectedPlaybackAt = (input: PlaybackTimeline, timeMs: number): PlaybackProjection => {
	const timeline = parsePlaybackTimeline(input);
	ServerTimeMsSchema.parse(timeMs);
	const anchor = anchorAt(timeline, timeMs);
	return {
		epoch: timeline.epoch,
		serverTimeMs: timeMs,
		receivedSequence: receivedSequence(timeline),
		appliedSequence: anchor.sequence,
		state: anchor.state
			? { ...anchor.state, positionSeconds: positionAt(anchor, timeMs) }
			: null,
	};
};

/** Fold only effective events; preserve the exact last-event anchor and every future event. */
export const compactPlaybackTimeline = (
	input: PlaybackTimeline,
	timeMs: number,
): PlaybackTimeline => {
	const timeline = parsePlaybackTimeline(input);
	ServerTimeMsSchema.parse(timeMs);
	const anchor = anchorAt(timeline, timeMs);
	return {
		...timeline,
		baseline: { ...anchor, serverTimeMs: timeMs },
		events: timeline.events.filter(event => event.sequence > anchor.sequence),
	};
};
