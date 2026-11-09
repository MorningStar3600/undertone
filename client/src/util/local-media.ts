import type { Video } from "ott-common/models/video";
import { LOCAL_MEDIA_REFERENCE } from "ott-common/models/local-media";

/** Public identity only. The existing HttpOnly OTT cookie supplies live authorization. */
export function directPlaybackUrl(
	source: Video | null | undefined,
	roomName: string,
	baseUrl = "",
): string {
	const localId = source?.service === "direct" && LOCAL_MEDIA_REFERENCE.exec(source.id)?.[1];
	return localId
		? `${baseUrl}/api/local-media/${localId}${roomName ? `?room=${encodeURIComponent(roomName)}` : ""}`
		: (source?.src_url ?? source?.id ?? "");
}
