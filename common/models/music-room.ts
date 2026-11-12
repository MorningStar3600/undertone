import type { Mood } from "./music.js";
import { z } from "zod";
import type { QueueItem } from "./video.js";
import type {
	MoodExclusionConflict,
	MusicSchedulerSettings,
	RoomMoodPreference,
} from "../music/types.js";

const id = z.string().min(1).max(256);
const revision = z.number().int().nonnegative();
const moodIds = z.array(z.string().uuid()).max(100);
const conflict = z.object({ participantId: id, moodId: z.string().uuid() }).strict();
const base = { expectedRevision: revision, correlationId: id };
export const MusicRoomActionSchema = z.discriminatedUnion("action", [
	z
		.object({
			...base,
			action: z.literal("preferences"),
			includeMoodIds: moodIds,
			excludeMoodIds: moodIds,
			content: z.enum(["keep", "renew"]).default("keep"),
		})
		.strict(),
	z
		.object({
			...base,
			action: z.literal("settings"),
			settings: z
				.object({
					fairShare: z.boolean().optional(),
					autoAdmitOnJoin: z.boolean().optional(),
					removeDepartedEntries: z.boolean().optional(),
				})
				.strict(),
		})
		.strict(),
	z.object({ ...base, action: z.literal("replan"), content: z.enum(["keep", "renew"]) }).strict(),
	z
		.object({
			...base,
			action: z.literal("request"),
			requestId: z.string().min(1).max(128),
			reference: z.object({ service: z.string(), id: z.string().min(1).max(2048) }).strict(),
			extras: z
				.object({
					startAt: z.number().finite().nonnegative().optional(),
					endAt: z.number().finite().positive().optional(),
					subtitleUrl: z
						.string()
						.url()
						.max(2048)
						.refine(value => {
							const url = new URL(value);
							return (
								["https:", "http:"].includes(url.protocol) &&
								!url.username &&
								!url.password
							);
						})
						.optional(),
				})
				.strict()
				.optional(),
			intent: z.enum(["mix", "next"]),
		})
		.strict(),
	z
		.object({
			...base,
			action: z.literal("confirm"),
			requestId: id,
			trackId: z.string().uuid(),
			conflicts: z.array(conflict).max(1000),
		})
		.strict(),
	z.object({ ...base, action: z.literal("cancel"), requestId: id }).strict(),
	z.object({ ...base, action: z.literal("remove"), entryId: id }).strict(),
	z
		.object({
			...base,
			action: z.literal("requests"),
			filter: z.enum(["all", "pending"]).default("all"),
			offset: z.number().int().nonnegative().default(0),
			limit: z.number().int().min(1).max(100).default(25),
		})
		.strict(),
	z
		.object({
			...base,
			action: z.literal("queue"),
			offset: z.number().int().nonnegative().default(0),
			limit: z.number().int().min(1).max(100).default(25),
		})
		.strict(),
]);
export type MusicRoomAction = z.infer<typeof MusicRoomActionSchema>;
export type MusicRoomActionInput = z.input<typeof MusicRoomActionSchema>;
export interface MusicRoomEntry {
	entryId: string;
	trackId: string;
	sourceId: string;
	contributorId: string;
	artists: string[];
	origin: "automatic" | "manual" | "recommendation";
	requestId?: string;
	title?: string;
	/** Public cover art, when the source has one (YouTube thumbnails only). */
	artworkUrl?: string;
}
export interface MusicRoomPublic {
	revision: number;
	planRevision: number;
	queue: MusicRoomEntry[];
	queueTotal: number;
	/** Recently played tracks, oldest first; the last one is right before the current track.
	 * Each can be returned to with a `previous` playback command of `played.length - index` steps. */
	played?: MusicRoomEntry[];
	current:
		| (MusicRoomEntry & {
				playbackId: string;
				started: boolean;
				contributorMoodIds: string[];
				contributorMoods: Mood[];
		  })
		| null;
	participants: (RoomMoodPreference & { name?: string; clientIds?: string[] })[];
	/** Shared vocabulary only for active room rule IDs. No per-track annotations. */
	ruleMoods?: Mood[];
	settings: MusicSchedulerSettings;
}
export interface MusicRoomRequestSummary {
	requestId: string;
	entryId: string;
	trackId: string;
	intent: "mix" | "next";
	status: "pending" | "admitted" | "consumed" | "cancelled";
	conflicts: MoodExclusionConflict[];
	title?: string;
	/** Metadata for exactly the offered pairs, from the authorized server reply. */
	conflictMetadata?: (MoodExclusionConflict & { mood?: Mood; participantName?: string })[];
}
export interface MusicRoomResult {
	correlationId: string;
	revision: number;
	status: string;
	request?: MusicRoomRequestSummary;
	/** Caller-only count, independent of the requested history/pending page. */
	pendingCount?: number;
	page?: {
		items: MusicRoomRequestSummary[] | MusicRoomEntry[];
		total: number;
		offset: number;
		limit: number;
	};
}
/** Private Redis/SQL data; never part of ServerMessageSync. */
export interface MusicRoomPlayback {
	currentSource: QueueItem | null;
	isPlaying: boolean;
	playbackPosition: number;
	playbackSpeed: number;
	playbackStart: string | null;
}
