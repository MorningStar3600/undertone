import { describe, expect, it } from "vitest";
import {
	contributionScore,
	createPlaybackHistory,
	initializeContributor,
	musicRecencyWeight,
	recordPlaybackEnded,
	recordPlaybackSource,
	recordPlaybackStarted,
	trackRecencyDistance,
} from "../../music/playback-history.js";
import type { MusicQueueEntry } from "ott-common/music/types.js";

const entry: MusicQueueEntry = {
	entryId: "e",
	trackId: "t",
	sourceId: "youtube",
	contributorId: "X",
	origin: "manual",
	admittedAt: 1,
	artistIds: [],
	styleIds: [],
	tagsByUser: {},
	sourceUsable: true,
	mediaRef: null,
};

describe("music playback history", () => {
	it("counts a real start once across repeat delivery, end, skip, error and fallback", () => {
		const empty = createPlaybackHistory("room", "session");
		const started = recordPlaybackStarted(empty, "p", entry, 10);
		const again = recordPlaybackStarted(started, "p", entry, 11);
		const fallback = recordPlaybackSource(again, "p", "local");
		const ended = recordPlaybackEnded(fallback, "p", 12, "skipped");
		const repeatedEnd = recordPlaybackEnded(ended, "p", 13, "error");
		expect(contributionScore(repeatedEnd, "X")).toBe(1);
		expect(repeatedEnd.events).toHaveLength(1);
		expect(repeatedEnd.events[0]).toMatchObject({
			actualSourceId: "local",
			endedAt: 12,
			endReason: "skipped",
		});
		expect(empty.events).toEqual([]);
	});
	it("rejects reuse of playback identity for another occurrence", () => {
		const started = recordPlaybackStarted(createPlaybackHistory("r", "s"), "p", entry, 1);
		expect(() =>
			recordPlaybackStarted(started, "p", { ...entry, entryId: "different" }, 2),
		).toThrow("identity reused");
	});
	it("does not rewrite the source of a finished passage", () => {
		const started = recordPlaybackStarted(createPlaybackHistory("r", "s"), "p", entry, 1);
		const ended = recordPlaybackEnded(started, "p", 2, "finished");
		expect(recordPlaybackSource(ended, "p", "late-source")).toEqual(ended);
	});
	it("requires a new occurrence identity for an explicit repeat", () => {
		const started = recordPlaybackStarted(createPlaybackHistory("r", "s"), "p", entry, 1);
		expect(() => recordPlaybackStarted(started, "p2", entry, 2)).toThrow(
			"Occurrence already started",
		);
		const repeated = recordPlaybackStarted(started, "p2", { ...entry, entryId: "repeat" }, 2);
		expect(contributionScore(repeated, "X")).toBe(2);
	});
	it("separates arrival base from real plays, and preserves returner debt", () => {
		let history = createPlaybackHistory("r", "s");
		for (let i = 0; i < 5; i++) {
			history = recordPlaybackStarted(history, `p${i}`, { ...entry, entryId: `e${i}` }, i);
		}
		history = initializeContributor(history, "Y", ["X"]);
		expect(history.scores.find(s => s.contributorId === "Y")).toEqual({
			contributorId: "Y",
			base: 5,
			plays: 0,
		});
		expect(history.events).toHaveLength(5);
		expect(initializeContributor(history, "X", ["Y"])).toBe(history);
	});
	it("uses track-level recency, regardless of source, and never permanently bans a track", () => {
		const first = recordPlaybackStarted(createPlaybackHistory("r", "s"), "p1", entry, 1);
		const second = recordPlaybackStarted(
			first,
			"p2",
			{ ...entry, entryId: "e2", trackId: "other" },
			2,
		);
		expect(trackRecencyDistance(first, "t")).toBe(0);
		expect(trackRecencyDistance(second, "t")).toBe(1);
		expect(trackRecencyDistance(second, "never")).toBeUndefined();
		const weights = [0, 1, 2, 10, 100].map(d => musicRecencyWeight(d));
		expect(weights[0]).toBe(0.02);
		expect(weights.every((w, i) => w > 0 && w <= 1 && (i === 0 || w > weights[i - 1]))).toBe(
			true,
		);
		expect(musicRecencyWeight()).toBe(1);
	});
});
