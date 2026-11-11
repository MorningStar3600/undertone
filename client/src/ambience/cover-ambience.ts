import { reactive } from "vue";
import {
	AMBIENCE_SAMPLE_SIZE,
	DEFAULT_AMBIENCE,
	pickAmbienceFromPixels,
	type AmbienceId,
} from "ott-common/ambience";

const MAX_CACHED = 64;
const YOUTUBE_ID = /^[\w-]{6,20}$/;

/** Ambience per cover URL. Reactive, so every view showing a cover updates together. */
const results = reactive(new Map<string, AmbienceId>());
const pending = new Map<string, Promise<AmbienceId>>();

/**
 * The cover to show for a playing item. YouTube thumbnails are normalized to the 320×180
 * `mqdefault`, which exists for every video, has no letterbox bars and allows CORS reads.
 */
export function coverUrl(
	source: { service?: string; id?: string; thumbnail?: string } | null | undefined,
): string | null {
	if (!source) {
		return null;
	}
	if (source.service === "youtube" && source.id && YOUTUBE_ID.test(source.id)) {
		return `https://i.ytimg.com/vi/${source.id}/mqdefault.jpg`;
	}
	return source.thumbnail || null;
}

/** Already known ambience for a cover, if it was sampled. */
export function knownAmbience(url: string | null | undefined): AmbienceId | undefined {
	return url ? results.get(url) : undefined;
}

function remember(url: string, ambience: AmbienceId) {
	results.set(url, ambience);
	while (results.size > MAX_CACHED) {
		const oldest = results.keys().next().value as string;
		results.delete(oldest);
		pending.delete(oldest);
	}
}

/** Reads a downscaled copy of the image. Returns null when the browser forbids it (CORS). */
function samplePixels(image: HTMLImageElement): Uint8ClampedArray | null {
	const size = AMBIENCE_SAMPLE_SIZE;
	const canvas = document.createElement("canvas");
	canvas.width = size;
	canvas.height = size;
	const context = canvas.getContext("2d", { willReadFrequently: true });
	if (!context) {
		return null;
	}
	const width = image.naturalWidth;
	const height = image.naturalHeight;
	if (!width || !height) {
		return null;
	}
	// Covers taller than 16:9 (e.g. 4:3 video thumbnails) carry letterbox bars: keep the
	// central 16:9 band, like the desktop app does.
	const band = Math.min(height, Math.round((width * 9) / 16));
	context.drawImage(image, 0, Math.round((height - band) / 2), width, band, 0, 0, size, size);
	try {
		return context.getImageData(0, 0, size, size).data;
	} catch {
		return null;
	}
}

/**
 * Resolves the ambience of a cover. Covers are fetched once, reduced to 32×32 and matched
 * with the shared rule. Anything that fails (no cover, network, CORS) gets the default.
 */
export function ambienceForCover(url: string | null | undefined): Promise<AmbienceId> {
	if (!url) {
		return Promise.resolve(DEFAULT_AMBIENCE);
	}
	const known = results.get(url);
	if (known) {
		return Promise.resolve(known);
	}
	const inflight = pending.get(url);
	if (inflight) {
		return inflight;
	}
	const task = new Promise<AmbienceId>(resolve => {
		if (typeof Image === "undefined" || typeof document === "undefined") {
			resolve(DEFAULT_AMBIENCE);
			return;
		}
		const image = new Image();
		image.crossOrigin = "anonymous";
		image.decoding = "async";
		image.onload = () => {
			const pixels = samplePixels(image);
			resolve(pixels ? pickAmbienceFromPixels(pixels) : DEFAULT_AMBIENCE);
		};
		image.onerror = () => resolve(DEFAULT_AMBIENCE);
		image.src = url;
	}).then(ambience => {
		remember(url, ambience);
		pending.delete(url);
		return ambience;
	});
	pending.set(url, task);
	return task;
}

/** Test helper. */
export function resetCoverAmbiences() {
	results.clear();
	pending.clear();
}
