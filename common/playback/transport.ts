import { z } from "zod";
import { PlaybackEpochSchema, PlaybackRateSchema, PositionSecondsSchema } from "./schema.js";
import type { PlaybackEvent, PlaybackMedia, PlaybackTimeline } from "./schema.js";
import type { QueueItem } from "../models/video.js";

const nonce = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9._~-]+$/);
const counter = z.number().finite().int().min(0).max(Number.MAX_SAFE_INTEGER);
const commandBase = {
	requestId: nonce,
	epoch: PlaybackEpochSchema,
	occurrenceId: counter.min(1),
};
export const PlaybackCommandSchema = z.discriminatedUnion("command", [
	z.object({ ...commandBase, command: z.literal("play") }).strict(),
	z.object({ ...commandBase, command: z.literal("pause") }).strict(),
	z.object({ ...commandBase, command: z.literal("next") }).strict(),
	z
		.object({
			...commandBase,
			command: z.literal("seek"),
			positionSeconds: PositionSecondsSchema,
		})
		.strict(),
	z.object({ ...commandBase, command: z.literal("rate"), rate: PlaybackRateSchema }).strict(),
]);
export type PlaybackCommand = z.infer<typeof PlaybackCommandSchema>;
export const PlaybackSubscribeSchema = z
	.object({
		action: z.literal("playback-subscribe"),
		version: z.literal(1),
		nonce,
		resume: z.object({ epoch: PlaybackEpochSchema, lastSequence: counter }).strict().optional(),
	})
	.strict();
export const ClockProbeSchema = z
	.object({
		action: z.literal("clock-probe"),
		generation: counter,
		nonce,
	})
	.strict();

/** Adapter data belongs only to this cursor/occurrence, never to a historical resolver. */
export interface PlaybackAttachment {
	epoch: string;
	sequence: number;
	occurrenceId: number;
	media: PlaybackMedia;
	item: QueueItem;
	playbackId?: string;
}
export interface PlaybackCommandResult {
	requestId: string;
	epoch: string;
	sequence: number;
	status: "applied" | "rejected";
	code?:
		| "request-conflict"
		| "capacity"
		| "stale-epoch"
		| "stale-occurrence"
		| "unauthorized"
		| "failed";
}
export type PlaybackClientMessage =
	| { action: "playback-command"; command: PlaybackCommand }
	| z.infer<typeof PlaybackSubscribeSchema>
	| z.infer<typeof ClockProbeSchema>;
export type PlaybackServerMessage =
	| { action: "playback-capabilities"; version: 1; recovery: "snapshot" }
	| { action: "playback-event"; event: PlaybackEvent; attachment?: PlaybackAttachment }
	| {
			action: "playback-snapshot";
			nonce: string;
			timeline: PlaybackTimeline;
			attachment: PlaybackAttachment | null;
	  }
	| { action: "playback-result"; result: PlaybackCommandResult }
	| {
			action: "clock-reply";
			generation: number;
			nonce: string;
			serverReceiveMs: number;
			serverSendMs: number;
	  };
