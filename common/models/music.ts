import type { QueueItem, VideoService } from "./video.js";

export type TrackId = string;
export type TrackSourceId = string;
export type MoodId = string;

export interface Track {
	id: TrackId;
	title: string;
	artists: string[];
	styles: string[];
	/** Reference duration in seconds; unknown for unresolved/live sources. */
	duration: number | null;
	artworkUrl: string | null;
}

export interface TrackSourceCapabilities {
	seek: boolean;
	/** Unknown is deliberate: embedded providers do not guarantee background playback. */
	backgroundPlayback: "supported" | "unknown";
}

export interface TrackSource {
	id: TrackSourceId;
	trackId: TrackId;
	service: VideoService;
	/** Internal provider reference. Resolve only in an authorized playback context. */
	providerId: string;
	capabilities: TrackSourceCapabilities;
	availability: "available" | "unavailable" | "unknown";
}

/** Personal REST responses omit internal provider/storage references. */
export type TrackSourceSummary = Omit<TrackSource, "providerId">;

export const MOOD_ICON_KEYS = [
	"heart",
	"headphones",
	"bolt",
	"sun",
	"cloud-rain",
	"moon",
	"sparkles",
	"coffee",
	"flame",
] as const;
export type MoodIconKey = (typeof MOOD_ICON_KEYS)[number];

export interface Mood {
	id: MoodId;
	name: string;
	normalizedName: string;
	iconKey: MoodIconKey;
}

/** Fixed IDs are shared by migrations, frontend shortcuts and future room state. */
export const DEFAULT_MOODS: readonly Mood[] = [
	{
		id: "00000000-0000-4000-8000-000000000001",
		name: "like",
		normalizedName: "like",
		iconKey: "heart",
	},
	{
		id: "00000000-0000-4000-8000-000000000002",
		name: "focus",
		normalizedName: "focus",
		iconKey: "headphones",
	},
	{
		id: "00000000-0000-4000-8000-000000000003",
		name: "energetic",
		normalizedName: "energetic",
		iconKey: "bolt",
	},
	{
		id: "00000000-0000-4000-8000-000000000004",
		name: "happy",
		normalizedName: "happy",
		iconKey: "sun",
	},
	{
		id: "00000000-0000-4000-8000-000000000005",
		name: "sad",
		normalizedName: "sad",
		iconKey: "cloud-rain",
	},
];

export interface UserTrackMood {
	userId: number;
	trackId: TrackId;
	moodId: MoodId;
}

export interface UserFavoriteMood {
	userId: number;
	moodId: MoodId;
}

export interface UserLibraryTrack {
	userId: number;
	trackId: TrackId;
	/** Initial provenance: a single provider reference, never an entire cache import. */
	importKind: "reference" | "catalogue" | "local";
}

export interface LibraryTrack {
	track: Track;
	sources: TrackSourceSummary[];
	addedAt: string;
	importKind: UserLibraryTrack["importKind"];
}

export interface MusicPage<T> {
	items: T[];
	limit: number;
	offset: number;
	total: number;
}

export type AddLibraryTrackRequest =
	| { reference: { service: VideoService; id: string } }
	| { url: string }
	| { trackId: TrackId };

export interface CreateMoodRequest {
	name: string;
	iconKey: MoodIconKey;
}

/** Additive view: legacy readers still consume service/id and all segment/subtitle fields. */
export interface MusicQueueItem extends QueueItem {
	trackId: TrackId;
	sourceId: TrackSourceId;
}

export type CatalogueChange =
	| { kind: "metadata"; userId: number; trackId: TrackId; action: "updated" }
	| { kind: "library"; userId: number; trackId: TrackId; action: "added" | "removed" }
	| {
			kind: "annotation";
			userId: number;
			trackId: TrackId;
			moodId: MoodId;
			action: "added" | "removed";
	  };
