/** Scheduling-only DTOs. Adapt catalogue IDs to strings and resolve source usability
 * before calling the engine. mediaRef is opaque JSON (including legacy playback
 * options); the engine never resolves providers, paths, permissions or URLs. */
export type MusicJson =
	| null
	| boolean
	| number
	| string
	| MusicJson[]
	| { [key: string]: MusicJson };

export interface RoomMoodPreference {
	participantId: string;
	includeMoodIds: string[];
	excludeMoodIds: string[];
}

export interface MoodExclusionConflict {
	/** Identity of the person excluding the mood, not the person tagging it. */
	participantId: string;
	moodId: string;
}

export interface MusicCandidate {
	trackId: string;
	sourceId: string;
	contributorId: string;
	artistIds: string[];
	styleIds: string[];
	tagsByUser: Record<string, string[]>;
	sourceUsable: boolean;
	mediaRef: MusicJson;
}

export type MusicEntryOrigin = "automatic" | "manual" | "recommendation";
export type ManualMusicIntent = "mix" | "next";

export interface MusicQueueEntry extends MusicCandidate {
	entryId: string;
	origin: MusicEntryOrigin;
	admittedAt: number;
	requestId?: string;
}

export interface ManualMusicRequest {
	requestId: string;
	candidate: MusicCandidate;
	intent: ManualMusicIntent;
	origin: "manual" | "recommendation";
	requestedAt: number;
	order: number;
	entryId: string;
	status: "pending" | "admitted" | "consumed" | "cancelled";
	acceptedConflicts: MoodExclusionConflict[];
	/** Only these server-issued conflicts can be confirmed. No bypass flag. */
	offeredConflicts: MoodExclusionConflict[];
	confirmedAt?: number;
}

export interface ContributionScore {
	contributorId: string;
	/** Arrival normalization, never represented as fictitious history events. */
	base: number;
	plays: number;
}

export interface MusicPlaybackEvent {
	playbackId: string;
	roomId: string;
	sessionId: string;
	entry: MusicQueueEntry;
	startedAt: number;
	endedAt?: number;
	endReason?: "finished" | "skipped" | "interrupted" | "error";
	/** A fallback changes the actual source without creating a second play. */
	actualSourceId: string;
}

export interface MusicPlaybackHistory {
	version: 1;
	roomId: string;
	sessionId: string;
	scores: ContributionScore[];
	events: MusicPlaybackEvent[];
}

export interface MusicSchedulerSettings {
	fairShare: boolean;
	removeDepartedEntries: boolean;
	/** False excludes library generation, while manual admissions remain possible. */
	autoAdmitOnJoin: boolean;
	recencyEpsilon: number;
	recencyTau: number;
	artistRepeatWeight: number;
	styleRepeatWeight: number;
}

export interface MusicSchedulerState {
	version: 1;
	roomId: string;
	sessionId: string;
	/** Compare-and-swap revision of the entire business transition. */
	revision: number;
	/** Revision at which the published order was last calculated. */
	planRevision: number;
	updatedAt: number;
	settings: MusicSchedulerSettings;
	/** Already deduplicated by durable identity by the Room adapter. */
	participants: RoomMoodPreference[];
	participantOrder: string[];
	autoContributorIds: string[];
	roundRobinCursor: number;
	candidates: MusicCandidate[];
	queue: MusicQueueEntry[];
	current?: { entry: MusicQueueEntry; playbackId: string; started: boolean };
	/** Includes failed/unstarted loads, without inventing real playback events. */
	loadedPlaybackIds: string[];
	requests: ManualMusicRequest[];
	nextEntrySequence: number;
	nextRequestSequence: number;
	rngState: number;
	history: MusicPlaybackHistory;
}

export type MusicRandom = () => number;

export interface MusicPlan {
	entries: MusicQueueEntry[];
	rngState: number;
	nextEntrySequence: number;
}
