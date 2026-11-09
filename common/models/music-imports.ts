/** Playlist references and metadata only: no media acquisition or queue commands. */
export type MusicImportStatus =
	| "queued"
	| "running"
	| "succeeded"
	| "partial"
	| "failed"
	| "cancelled";
export type MusicImportError = "provider" | "storage" | "unavailable" | "page-limit" | null;
export type CreateMusicImportSource = (
	| { url: string; reference?: never }
	| { reference: { service: "youtube"; id: string }; url?: never }
) & { daily?: boolean };
export interface MusicImportJob {
	id: string;
	sourceId: string;
	status: MusicImportStatus;
	pages: number;
	processed: number;
	added: number;
	existing: number;
	unavailable: number;
	failures: number;
	retryCount: number;
	error: MusicImportError;
	createdAt: number;
	completedAt: number | null;
	nextAttemptAt: number;
}
/** Deliberately omits provider IDs, cursors, lease tokens and raw provider messages. */
export interface MusicImportSource {
	id: string;
	service: "youtube";
	daily: boolean;
	removed: boolean;
	nextRunAt: number | null;
	lastSuccessAt: number | null;
	lastCompletionAt: number | null;
	lastJob: MusicImportJob | null;
}
