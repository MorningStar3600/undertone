import type { MoodExclusionConflict, MusicCandidate, RoomMoodPreference } from "./types.js";

const userTags = (candidate: MusicCandidate, id: string): string[] =>
	Object.hasOwn(candidate.tagsByUser, id) ? candidate.tagsByUser[id] : [];

export const sameMoodConflict = (a: MoodExclusionConflict, b: MoodExclusionConflict): boolean =>
	a.participantId === b.participantId && a.moodId === b.moodId;

/** OR within a person's inclusions, AND across people, contributor tags only. */
export const satisfiesRoomInclusions = (
	candidate: MusicCandidate,
	participants: readonly RoomMoodPreference[],
): boolean => {
	const tags = new Set(userTags(candidate, candidate.contributorId));
	return participants.every(
		person =>
			person.includeMoodIds.length === 0 || person.includeMoodIds.some(id => tags.has(id)),
	);
};

/** Union of present people's exclusions against union of present people's tags.
 * Resolve participant and mood display names in the caller; IDs survive renames. */
export const getRoomExclusionConflicts = (
	candidate: MusicCandidate,
	participants: readonly RoomMoodPreference[],
): MoodExclusionConflict[] => {
	const tags = new Set(participants.flatMap(p => userTags(candidate, p.participantId)));
	return participants.flatMap(person =>
		[...new Set(person.excludeMoodIds)]
			.filter(id => tags.has(id))
			.map(moodId => ({ participantId: person.participantId, moodId })),
	);
};

export const isAutomaticMusicCandidate = (
	candidate: MusicCandidate,
	participants: readonly RoomMoodPreference[],
): boolean =>
	candidate.sourceUsable &&
	satisfiesRoomInclusions(candidate, participants) &&
	getRoomExclusionConflicts(candidate, participants).length === 0;

/** Call with confirmations from this request's server-side ledger only. */
export const getUnacceptedManualConflicts = (
	candidate: MusicCandidate,
	participants: readonly RoomMoodPreference[],
	acceptedConflicts: readonly MoodExclusionConflict[],
): MoodExclusionConflict[] =>
	getRoomExclusionConflicts(candidate, participants).filter(
		conflict => !acceptedConflicts.some(accepted => sameMoodConflict(conflict, accepted)),
	);

/** A last choice replaces the opposite choice; favourites are not policy input. */
export const setRoomMoodChoice = (
	preference: RoomMoodPreference,
	moodId: string,
	choice: "include" | "exclude" | "neutral",
): RoomMoodPreference => ({
	participantId: preference.participantId,
	includeMoodIds: [
		...preference.includeMoodIds.filter(id => id !== moodId),
		...(choice === "include" ? [moodId] : []),
	],
	excludeMoodIds: [
		...preference.excludeMoodIds.filter(id => id !== moodId),
		...(choice === "exclude" ? [moodId] : []),
	],
});
