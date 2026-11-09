import type { Mood, Track } from "./music.js";

/** Anonymous discovery metadata. Never contains source identities or resource URLs. */
export interface MusicRecommendation {
	id: string;
	track: Pick<Track, "id" | "title" | "artists" | "styles" | "duration">;
	moods: Mood[];
}
export interface RecommendationPage {
	items: MusicRecommendation[];
	next: string | null;
}
export interface MusicPublication {
	eligible: boolean;
	moods: Mood[];
}
export interface PublishMusicRequest {
	moodIds: string[];
}
export interface AdoptMusicRequest {
	/** Explicit selection from the currently offered published moods; may be empty. */
	moodIds: string[];
}
export interface MusicAdoption {
	trackId: string;
	inLibrary: boolean;
	moodIds: string[];
}
