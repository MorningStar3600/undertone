import { OttException } from "ott-common/exceptions.js";
import type {
	MusicPlaybackEvent,
	MusicPlaybackHistory,
	MusicQueueEntry,
} from "ott-common/music/types.js";

export class MusicSchedulingException extends OttException {
	name = "MusicSchedulingException";
}

export const createPlaybackHistory = (roomId: string, sessionId: string): MusicPlaybackHistory => ({
	version: 1,
	roomId,
	sessionId,
	scores: [],
	events: [],
});

export const contributionScore = (history: MusicPlaybackHistory, contributorId: string): number => {
	const score = history.scores.find(s => s.contributorId === contributorId);
	return score ? score.base + score.plays : 0;
};

/** Returners keep their debt. A first arrival gets a separate normalization base. */
export const initializeContributor = (
	history: MusicPlaybackHistory,
	contributorId: string,
	presentIds: readonly string[],
): MusicPlaybackHistory => {
	if (history.scores.some(s => s.contributorId === contributorId)) {
		return history;
	}
	const scores = presentIds
		.filter(id => id !== contributorId)
		.map(id => contributionScore(history, id));
	return {
		...history,
		scores: [
			...history.scores,
			{ contributorId, base: scores.length ? Math.min(...scores) : 0, plays: 0 },
		],
	};
};

/** Only a server-authoritative real start calls this. Loading paused, seek,
 * resume, source fallback and reconnection must reuse the same playbackId. */
export const recordPlaybackStarted = (
	history: MusicPlaybackHistory,
	playbackId: string,
	entry: MusicQueueEntry,
	startedAt: number,
): MusicPlaybackHistory => {
	const existing = history.events.find(event => event.playbackId === playbackId);
	if (existing) {
		if (
			existing.entry.entryId !== entry.entryId ||
			existing.entry.trackId !== entry.trackId ||
			existing.entry.contributorId !== entry.contributorId
		) {
			throw new MusicSchedulingException("Playback identity reused for another occurrence");
		}
		return history;
	}
	const initialized = initializeContributor(history, entry.contributorId, []);
	return {
		...initialized,
		scores: initialized.scores.map(score =>
			score.contributorId === entry.contributorId
				? { ...score, plays: score.plays + 1 }
				: score,
		),
		events: [
			...initialized.events,
			{
				playbackId,
				roomId: history.roomId,
				sessionId: history.sessionId,
				entry: structuredClone(entry),
				startedAt,
				actualSourceId: entry.sourceId,
			},
		],
	};
};

export const recordPlaybackEnded = (
	history: MusicPlaybackHistory,
	playbackId: string,
	endedAt: number,
	endReason: NonNullable<MusicPlaybackEvent["endReason"]>,
): MusicPlaybackHistory => ({
	...history,
	events: history.events.map(event =>
		event.playbackId === playbackId && event.endedAt === undefined
			? { ...event, endedAt, endReason }
			: event,
	),
});

export const recordPlaybackSource = (
	history: MusicPlaybackHistory,
	playbackId: string,
	sourceId: string,
): MusicPlaybackHistory => ({
	...history,
	events: history.events.map(event =>
		event.playbackId === playbackId ? { ...event, actualSourceId: sourceId } : event,
	),
});

/** Track identity, not provider identity. Last real start has distance zero. */
export const trackRecencyDistance = (
	history: MusicPlaybackHistory,
	trackId: string,
): number | undefined => {
	const index = history.events.findLastIndex(event => event.entry.trackId === trackId);
	return index < 0 ? undefined : history.events.length - 1 - index;
};

/** Initial proposed constants: epsilon=.02 and tau=10 room starts. Always positive. */
export const musicRecencyWeight = (distance?: number, epsilon = 0.02, tau = 10): number => {
	if (
		!(epsilon > 0 && epsilon <= 1 && tau > 0 && Number.isFinite(tau)) ||
		Number.isNaN(distance)
	) {
		throw new MusicSchedulingException("Invalid recency parameters");
	}
	return distance === undefined
		? 1
		: epsilon + (1 - epsilon) * (1 - Math.exp(-Math.max(0, distance) / tau));
};
