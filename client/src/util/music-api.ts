import { API } from "@/common-http";
import type { AxiosRequestConfig } from "axios";
import type { AddLibraryTrackRequest, CreateMoodRequest } from "ott-common/models/music";
import type { CreateMusicImportSource } from "ott-common/models/music-imports";

export const MUSIC_PAGE_LIMIT = 20;
export const MUSIC_MAX_OFFSET = 10000;

export class MusicRequestError extends Error {
	constructor(public readonly kind: "request" | "auth" | "rate-limit" | "stale") {
		super(kind);
	}
}

/** Uses the application's axios instance and its existing token/cookie authentication. */
export async function musicRequest<T>(
	method: "GET" | "POST" | "PUT" | "DELETE",
	path: string,
	signal: AbortSignal,
	data?:
		| AddLibraryTrackRequest
		| CreateMoodRequest
		| CreateMusicImportSource
		| { daily: boolean }
		| Record<string, never>,
	params?: { limit: number; offset: number },
): Promise<T> {
	const config: AxiosRequestConfig = { method, url: `/music${path}`, signal, data, params };
	const response = await API.request<{ success: boolean } & T>(config);
	if (!response.data.success) {
		throw new MusicRequestError("request");
	}
	return response.data;
}
