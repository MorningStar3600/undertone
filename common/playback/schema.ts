import { z } from "zod";

export const MAX_PLAYBACK_EVENTS = 1024;
export const MAX_POSITION_SECONDS = 1_000_000_000;
export const MIN_PLAYBACK_RATE = 0.1;
export const MAX_PLAYBACK_RATE = 16;

const counter = z.number().finite().int().min(0).max(Number.MAX_SAFE_INTEGER);
const occurrenceId = counter.min(1);
export const PlaybackEpochSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9._~-]+$/);
export const ServerTimeMsSchema = counter;
export const PositionSecondsSchema = z.number().finite().min(0).max(MAX_POSITION_SECONDS);
export const PlaybackRateSchema = z.number().finite().min(MIN_PLAYBACK_RATE).max(MAX_PLAYBACK_RATE);

/** Public, opaque identifiers only. Resolve URLs and credentials outside this contract. */
export const PlaybackMediaSchema = z
	.object({
		service: z
			.string()
			.min(1)
			.max(64)
			.regex(/^[a-z][a-z0-9-]*$/),
		id: z
			.string()
			.min(1)
			.max(256)
			.regex(/^[A-Za-z0-9._~-]+$/),
	})
	.strict();

const eventBase = {
	epoch: PlaybackEpochSchema,
	sequence: counter.min(1),
	effectiveAtMs: ServerTimeMsSchema,
	occurrenceId,
};

export const PlaybackEventSchema = z.discriminatedUnion("type", [
	z
		.object({
			...eventBase,
			type: z.literal("load"),
			media: PlaybackMediaSchema,
			positionSeconds: PositionSecondsSchema,
			isPlaying: z.boolean(),
			rate: PlaybackRateSchema,
		})
		.strict(),
	z.object({ ...eventBase, type: z.literal("play") }).strict(),
	z.object({ ...eventBase, type: z.literal("pause") }).strict(),
	z
		.object({
			...eventBase,
			type: z.literal("seek"),
			positionSeconds: PositionSecondsSchema,
		})
		.strict(),
	z.object({ ...eventBase, type: z.literal("rate"), rate: PlaybackRateSchema }).strict(),
	z.object({ ...eventBase, type: z.literal("source"), media: PlaybackMediaSchema }).strict(),
	z.object({ ...eventBase, type: z.literal("clear") }).strict(),
]);

export const PlaybackStateSchema = z
	.object({
		occurrenceId,
		media: PlaybackMediaSchema,
		positionSeconds: PositionSecondsSchema,
		isPlaying: z.boolean(),
		rate: PlaybackRateSchema,
	})
	.strict();

export const PlaybackBaselineSchema = z
	.object({
		/** Earliest query time supported after compaction. */
		serverTimeMs: ServerTimeMsSchema,
		sequence: counter,
		/** State is anchored here, NOT at serverTimeMs. */
		lastEffectiveAtMs: ServerTimeMsSchema,
		/** Retained even when state is cleared, preventing occurrence ID reuse. */
		lastOccurrenceId: counter,
		state: PlaybackStateSchema.nullable(),
	})
	.strict()
	.superRefine((baseline, ctx) => {
		if (
			baseline.lastEffectiveAtMs > baseline.serverTimeMs ||
			baseline.lastOccurrenceId > baseline.sequence ||
			(baseline.sequence === 0 && baseline.state !== null) ||
			(baseline.sequence > 0 && baseline.lastOccurrenceId === 0) ||
			(baseline.sequence > 0 &&
				baseline.state === null &&
				baseline.sequence === baseline.lastOccurrenceId) ||
			(baseline.state !== null && baseline.state.occurrenceId !== baseline.lastOccurrenceId)
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Inconsistent playback baseline",
			});
		}
	});

/** Structural schema; use PlaybackTimelineSchema for ordered transition validation too. */
export const PlaybackTimelineShapeSchema = z
	.object({
		version: z.literal(1),
		epoch: PlaybackEpochSchema,
		baseline: PlaybackBaselineSchema,
		events: z.array(PlaybackEventSchema).max(MAX_PLAYBACK_EVENTS),
	})
	.strict();

export type PlaybackMedia = z.infer<typeof PlaybackMediaSchema>;
export type PlaybackEvent = z.infer<typeof PlaybackEventSchema>;
export type PlaybackState = z.infer<typeof PlaybackStateSchema>;
export type PlaybackBaseline = z.infer<typeof PlaybackBaselineSchema>;
/** A portable snapshot includes the folded baseline AND all accepted following events. */
export type PlaybackTimeline = z.infer<typeof PlaybackTimelineShapeSchema>;
