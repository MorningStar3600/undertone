/** Public local-library status contains no directory, filename or account assignment. */
export interface LocalMediaRootStatus {
	id: string;
	status: "idle" | "scanning" | "complete" | "partial" | "failed";
	processed: number;
	available: number;
	completedAt: number | null;
}
export interface LocalMediaStatus {
	enabled: boolean;
	reason: "balancer" | null;
	roots: LocalMediaRootStatus[];
}

/** A public identity marker, never a credential or filesystem reference. */
export const LOCAL_MEDIA_REFERENCE =
	/^local:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
