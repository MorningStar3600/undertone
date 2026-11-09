import { describe, expect, it } from "vitest";
import {
	getRoomExclusionConflicts,
	getUnacceptedManualConflicts,
	isAutomaticMusicCandidate,
	setRoomMoodChoice,
	satisfiesRoomInclusions,
} from "../../music/room-mood-policy.js";
import type { MusicCandidate, RoomMoodPreference } from "../../music/types.js";

const candidate: MusicCandidate = {
	trackId: "t",
	sourceId: "s",
	contributorId: "Y",
	artistIds: [],
	styleIds: [],
	tagsByUser: { X: ["epic", "dreamy"], Y: ["energetic", "like"] },
	sourceUsable: true,
	mediaRef: { service: "legacy", id: "opaque" },
};
const person = (
	participantId: string,
	includeMoodIds: string[] = [],
	excludeMoodIds: string[] = [],
): RoomMoodPreference => ({ participantId, includeMoodIds, excludeMoodIds });

describe("collective room mood policy", () => {
	it("uses OR within a person and AND between people, only on contributor tags", () => {
		expect(
			satisfiesRoomInclusions(candidate, [
				person("X", ["sad", "like"]),
				person("Y", ["energetic"]),
			]),
		).toBe(true);
		expect(
			satisfiesRoomInclusions(candidate, [person("X", ["dreamy"]), person("Y", ["like"])]),
		).toBe(false);
	});
	it("treats empty inclusions as neutral and keeps exclusions active", () => {
		expect(isAutomaticMusicCandidate(candidate, [person("X"), person("Y")])).toBe(true);
		expect(isAutomaticMusicCandidate(candidate, [person("X", [], ["epic"]), person("Y")])).toBe(
			false,
		);
	});
	it("reports excluder identity even when another present person tagged the mood", () => {
		expect(
			getRoomExclusionConflicts(candidate, [person("X"), person("Y", [], ["epic", "epic"])]),
		).toEqual([{ participantId: "Y", moodId: "epic" }]);
	});
	it("ignores absent people's tags and preferences", () => {
		expect(isAutomaticMusicCandidate(candidate, [person("Y", [], ["epic"])])).toBe(true);
	});
	it("groups all conflicts and reconfirms only new (excluder,mood) pairs", () => {
		const participants = [person("X", [], ["epic", "like"]), person("Y", [], ["epic"])];
		expect(
			getUnacceptedManualConflicts(candidate, participants, [
				{ participantId: "X", moodId: "epic" },
			]),
		).toEqual([
			{ participantId: "X", moodId: "like" },
			{ participantId: "Y", moodId: "epic" },
		]);
	});
	it("never admits an unusable source automatically", () => {
		expect(isAutomaticMusicCandidate({ ...candidate, sourceUsable: false }, [])).toBe(false);
	});
	it("the latest mood choice replaces the opposite one without mutating input", () => {
		const original = person("X", ["epic"], []);
		const excluded = setRoomMoodChoice(original, "epic", "exclude");
		expect(excluded).toEqual(person("X", [], ["epic"]));
		expect(setRoomMoodChoice(excluded, "epic", "neutral")).toEqual(person("X"));
		expect(original.includeMoodIds).toEqual(["epic"]);
	});
});
