import type { ALL_VIDEO_SERVICES } from "../constants.js";

export type VideoService = (typeof ALL_VIDEO_SERVICES)[number];

export interface VideoId {
	service: VideoService;
	id: string;
}

export interface VideoMetadata {
	title: string;
	description: string;
	length: number;
	thumbnail: string;
	mime: string;
	highlight?: true;
	hls_url?: string;
	dash_url?: string;
	src_url?: string;
	subtitleUrl?: string;
}

export type Video = VideoId &
	Partial<VideoMetadata> & {
		/** Provider identity before resolving a playable alias. Never an admission grant. */
		originalReference?: VideoId;
	};
export interface QueueItemExtras {
	startAt?: number;
	endAt?: number;
	subtitleUrl?: string;
}

export type VideoAdd = VideoId & QueueItemExtras;
export interface QueueItem extends Video, QueueItemExtras {
	/** Present only for music occurrences; legacy service/id queues remain valid. */
	trackId?: string;
	sourceId?: string;
	entryId?: string;
	contributorId?: string;
	origin?: "automatic" | "manual" | "recommendation";
}
