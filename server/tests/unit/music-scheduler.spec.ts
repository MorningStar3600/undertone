import { describe, expect, it } from "vitest";
import {
	createMusicScheduler,
	musicQueueTarget,
	projectMusicPlan,
	restoreMusicScheduler,
	serializeMusicScheduler,
	transitionMusicScheduler,
} from "../../music/music-scheduler.js";
import type { MusicSchedulerCommand } from "../../music/music-scheduler.js";
import { contributionScore, recordPlaybackStarted } from "../../music/playback-history.js";
import type {
	MusicCandidate,
	MusicSchedulerState,
	RoomMoodPreference,
} from "ott-common/music/types.js";

const person = (
	participantId: string,
	includeMoodIds: string[] = [],
	excludeMoodIds: string[] = [],
): RoomMoodPreference => ({ participantId, includeMoodIds, excludeMoodIds });
const candidate = (
	contributorId: string,
	trackId: string,
	tags: string[] = [],
): MusicCandidate => ({
	trackId,
	sourceId: `source-${trackId}`,
	contributorId,
	artistIds: [`artist-${trackId}`],
	styleIds: ["rock"],
	tagsByUser: { [contributorId]: tags },
	sourceUsable: true,
	mediaRef: { service: "direct", id: trackId, startAt: 3 },
});
const library = (owner: string, size = 20): MusicCandidate[] =>
	Array.from({ length: size }, (_, i) => candidate(owner, `${owner}-${i}`));
const apply = (state: MusicSchedulerState, command: MusicSchedulerCommand): MusicSchedulerState => {
	const result = transitionMusicScheduler(state, command, { expectedRevision: state.revision });
	expect(["applied", "confirmation-required", "source-unavailable"]).toContain(result.status);
	return result.state;
};
const setup = (ids = ["X", "Y"], settings = {}): MusicSchedulerState =>
	apply(createMusicScheduler("r", "s", settings), {
		type: "context",
		participants: ids.map(id => person(id)),
		candidates: ids.flatMap(id => library(id)),
		now: 1,
	});
const add = (
	state: MusicSchedulerState,
	requestId: string,
	owner = "X",
	intent: "mix" | "next" = "mix",
	item = candidate(owner, requestId),
) => apply(state, { type: "request", requestId, candidate: item, intent, now: 2 });
const loadAndStart = (state: MusicSchedulerState, playbackId: string): MusicSchedulerState => {
	state = apply(state, { type: "load-next", playbackId, now: 10 });
	return apply(state, { type: "started", playbackId, now: 11 });
};

describe("music scheduler invariants", () => {
	it("makes recent tracks less likely, with positive return probability and no source reset", () => {
		const state = setup(["X"]);
		const old = { ...candidate("X", "old"), artistIds: [], styleIds: [] };
		const recent = { ...candidate("X", "recent"), artistIds: [], styleIds: [] };
		state.history = recordPlaybackStarted(
			state.history,
			"recent-play",
			{ ...recent, entryId: "past-recent", origin: "automatic", admittedAt: 0 },
			1,
		);
		state.history = recordPlaybackStarted(
			state.history,
			"other-play",
			{
				...candidate("X", "outside"),
				entryId: "past-other",
				origin: "automatic",
				admittedAt: 0,
			},
			2,
		);
		state.queue = [];
		state.candidates = [old, { ...recent, sourceId: "other-provider" }];
		let repeats = 0;
		for (let i = 0; i < 1000; i++) {
			if (projectMusicPlan(state, () => (i + 0.5) / 1000).entries[0].trackId === "recent") {
				repeats++;
			}
		}
		expect(repeats).toBeGreaterThan(0);
		expect(repeats).toBeLessThan(200);
	});
	it("failed paused loads never debit history and expose a revised plan before retry", () => {
		let state = apply(setup(), { type: "load-next", playbackId: "failed", now: 2 });
		state = apply(state, { type: "ended", playbackId: "failed", reason: "error", now: 3 });
		expect(state.current).toBeUndefined();
		expect(state.history.events).toEqual([]);
		expect(state.history.scores.every(s => s.plays === 0)).toBe(true);
		expect(state.planRevision).toBe(state.revision);
		state = restoreMusicScheduler(JSON.parse(JSON.stringify(state)));
		const repeat = transitionMusicScheduler(
			state,
			{ type: "load-next", playbackId: "failed", now: 4 },
			{ expectedRevision: state.revision },
		);
		expect(repeat.status).toBe("duplicate");
		expect(repeat.state).toBe(state);
	});
	it("favours artist/style diversity after selecting the contributor", () => {
		const state = setup(["X"]);
		const previous = {
			...candidate("X", "previous"),
			artistIds: ["shared", "secondary"],
			styleIds: ["rock"],
		};
		state.history = recordPlaybackStarted(
			state.history,
			"previous",
			{ ...previous, entryId: "played", origin: "automatic", admittedAt: 0 },
			1,
		);
		state.queue = [];
		state.candidates = [
			{ ...candidate("X", "repeat"), artistIds: ["secondary"], styleIds: ["rock"] },
			{ ...candidate("X", "variety"), artistIds: ["different"], styleIds: ["jazz"] },
		];
		let repeats = 0;
		for (let i = 0; i < 100; i++) {
			if (projectMusicPlan(state, () => (i + 0.5) / 100).entries[0].trackId === "repeat") {
				repeats++;
			}
		}
		expect(repeats).toBeGreaterThan(0);
		expect(repeats).toBeLessThan(20);
	});
	it("does not automatically admit newcomers when disabled, but permits manual contributions", () => {
		let state = setup(["X"], { autoAdmitOnJoin: false });
		expect(state.queue).toEqual([]);
		state = add(state, "manual");
		expect(state.queue).toHaveLength(1);
		expect(state.queue[0].origin).toBe("manual");
	});
	it("suspends automatic generation with nobody present", () => {
		let state = setup(["X"], { removeDepartedEntries: false });
		state = apply(state, {
			type: "context",
			participants: [],
			candidates: library("X"),
			now: 2,
		});
		const nextSequence = state.nextEntrySequence;
		state = loadAndStart(state, "p");
		state = apply(state, { type: "replan", now: 4 });
		expect(state.queue).toHaveLength(9);
		expect(state.nextEntrySequence).toBe(nextSequence);
	});
	it("implements the exact participant threshold, including zero", () => {
		expect(Array.from({ length: 13 }, (_, i) => musicQueueTarget(i))).toEqual([
			0, 10, 10, 9, 12, 10, 12, 14, 8, 9, 10, 10, 10,
		]);
		expect(() => musicQueueTarget(-1)).toThrow();
	});
	it("keeps 10 automatic + 4 manual, generates nothing on 14->10, then fills 9->10", () => {
		let state = setup();
		const originalAutos = state.queue.map(e => e.entryId);
		for (let i = 0; i < 4; i++) {
			state = add(state, `manual-${i}`);
		}
		expect(state.queue).toHaveLength(14);
		expect(state.queue.filter(e => originalAutos.includes(e.entryId))).toHaveLength(10);
		const sequence = state.nextEntrySequence;
		for (let i = 0; i < 4; i++) {
			state = loadAndStart(state, `p${i}`);
			state = apply(state, { type: "replan", now: 20 });
			expect(state.queue).toHaveLength(13 - i);
			expect(state.nextEntrySequence).toBe(sequence);
		}
		state = loadAndStart(state, "p4");
		expect(state.queue).toHaveLength(9);
		state = apply(state, { type: "replan", now: 21 });
		expect(state.queue).toHaveLength(10);
		expect(state.nextEntrySequence).toBe(sequence + 1);
	});
	it("dequeues the published head without random draw or hidden automatic generation", () => {
		const before = setup();
		const result = transitionMusicScheduler(
			before,
			{ type: "load-next", playbackId: "p", now: 4 },
			{
				expectedRevision: before.revision,
				random: () => {
					throw new Error("must not draw");
				},
			},
		);
		expect(result.state.current?.entry).toEqual(before.queue[0]);
		expect(result.state.queue).toEqual(before.queue.slice(1));
		expect(result.state.nextEntrySequence).toBe(before.nextEntrySequence);
		expect(result.state.history.events).toEqual([]);
		expect(result.state.planRevision).toBe(before.planRevision);
	});
	it("serves all 12 people over time with a horizon of 10", () => {
		let state = setup(Array.from({ length: 12 }, (_, i) => `u${i}`));
		expect(state.queue).toHaveLength(10);
		for (let i = 0; i < 36; i++) {
			state = loadAndStart(state, `p${i}`);
			state = apply(state, { type: "replan", now: i + 30 });
		}
		expect(state.history.scores.map(s => s.plays)).toEqual(Array(12).fill(3));
		expect(restoreMusicScheduler(JSON.parse(JSON.stringify(state)))).toEqual(state);
	});
	it("skips an owner with no admissible candidate without increasing their score", () => {
		let state = apply(createMusicScheduler("r", "s"), {
			type: "context",
			participants: [person("empty"), person("X")],
			candidates: library("X"),
			now: 1,
		});
		state = loadAndStart(state, "p");
		expect(contributionScore(state.history, "empty")).toBe(0);
		expect(state.current?.entry.contributorId).toBe("X");
	});
	it("uses minimum score among actual candidates and uniform injectable tie breaking", () => {
		const state = setup();
		state.queue = [];
		state.history.scores = [
			{ contributorId: "X", base: 0, plays: 8 },
			{ contributorId: "Y", base: 0, plays: 0 },
		];
		expect(projectMusicPlan(state, () => 0).entries[0].contributorId).toBe("Y");
		state.history.scores[0].plays = 0;
		let x = 0;
		for (let i = 0; i < 100; i++) {
			if (projectMusicPlan(state, () => (i + 0.5) / 100).entries[0].contributorId === "X") {
				x++;
			}
		}
		expect(x).toBe(50);
	});
	it("projects and reshuffles without debiting real counters, retaining existing content", () => {
		let state = setup();
		const snapshot = JSON.stringify(state);
		const projected = projectMusicPlan(state);
		expect(projectMusicPlan(state)).toEqual(projected);
		expect(JSON.stringify(state)).toBe(snapshot);
		const original = state.queue.map(e => e.entryId).sort();
		for (let i = 0; i < 10; i++) {
			state = apply(state, { type: "replan", content: "keep", now: i + 10 });
		}
		expect(state.queue.map(e => e.entryId).sort()).toEqual(original);
		expect(state.history.events).toEqual([]);
		expect(state.history.scores.every(score => score.plays === 0)).toBe(true);
	});
	it("gives ordinary manual requests FIFO priority at their owner's turn", () => {
		let state = setup();
		state = add(state, "first");
		state = add(state, "second");
		const owned = state.queue.filter(e => e.contributorId === "X");
		expect(owned.slice(0, 2).map(e => e.requestId)).toEqual(["first", "second"]);
		expect(owned[0].origin).toBe("manual");
	});
	it("has stable round robin beyond ten people; priority passes out of turn", () => {
		let state = setup(
			Array.from({ length: 12 }, (_, i) => `u${i}`),
			{ fairShare: false },
		);
		expect(state.queue.map(e => e.contributorId)).toEqual(
			Array.from({ length: 10 }, (_, i) => `u${i}`),
		);
		state = add(state, "priority", "u8", "next");
		expect(state.queue[0].requestId).toBe("priority");
		state = loadAndStart(state, "priority-play");
		expect(state.roundRobinCursor).toBe(0);
		state = apply(state, { type: "replan", now: 30 });
		expect(state.queue[0].contributorId).toBe("u0");
		for (let i = 0; i < 12; i++) {
			expect(state.queue[0].contributorId).toBe(`u${i}`);
			state = loadAndStart(state, `p${i}`);
			state = apply(state, { type: "replan", now: 40 + i });
		}
		expect(contributionScore(state.history, "u8")).toBe(2);
	});
	it("charges neither paused load nor duplicate start, fallback, resume/reconnect or end", () => {
		let state = setup();
		state = apply(state, { type: "load-next", playbackId: "p", now: 4 });
		expect(state.history.events).toHaveLength(0);
		state = restoreMusicScheduler(JSON.parse(JSON.stringify(state)));
		state = apply(state, { type: "started", playbackId: "p", now: 5 });
		const source = { ...state.current!.entry, sourceId: "fallback" };
		state = apply(state, {
			type: "update-source",
			entryId: source.entryId,
			candidate: source,
			now: 6,
		});
		const repeat = transitionMusicScheduler(
			state,
			{ type: "started", playbackId: "p", now: 7 },
			{ expectedRevision: state.revision },
		);
		expect(repeat.status).toBe("duplicate");
		expect(repeat.state).toBe(state);
		state = apply(state, { type: "ended", playbackId: "p", reason: "error", now: 8 });
		expect(state.history.events).toHaveLength(1);
		expect(state.history.events[0].actualSourceId).toBe("fallback");
		expect(state.history.scores.reduce((sum, s) => sum + s.plays, 0)).toBe(1);
	});
	it("keeps returner debt and normalizes first arrivals without fictitious starts", () => {
		let state = setup(["X"]);
		for (let i = 0; i < 3; i++) {
			state = loadAndStart(state, `p${i}`);
		}
		state = apply(state, {
			type: "context",
			participants: [person("X"), person("new")],
			candidates: library("X"),
			now: 20,
		});
		expect(state.history.scores.find(s => s.contributorId === "new")).toEqual({
			contributorId: "new",
			base: 3,
			plays: 0,
		});
		state = apply(state, {
			type: "context",
			participants: [person("new")],
			candidates: [],
			now: 21,
		});
		state = apply(state, {
			type: "context",
			participants: [person("new"), person("X")],
			candidates: library("X"),
			now: 22,
		});
		expect(contributionScore(state.history, "X")).toBe(3);
		expect(state.history.events).toHaveLength(3);
	});
	it.each([true, false])(
		"departure remove=%s preserves current; absent libraries cannot generate",
		removeDepartedEntries => {
			let state = setup(["X", "Y"], { removeDepartedEntries });
			state = add(state, "priority", "X", "next");
			state = loadAndStart(state, "p");
			const existing = state.queue.filter(e => e.contributorId === "X").map(e => e.entryId);
			state = apply(state, {
				type: "context",
				participants: [person("Y")],
				candidates: library("X"),
				now: 20,
			});
			expect(state.current?.entry.contributorId).toBe("X");
			expect(
				state.queue
					.filter(e => e.contributorId === "X")
					.map(e => e.entryId)
					.sort(),
			).toEqual(removeDepartedEntries ? [] : existing.sort());
		},
	);
	it("may keep a shorter horizon and repeat a tiny library after real starts", () => {
		let state = apply(createMusicScheduler("r", "s"), {
			type: "context",
			participants: [person("X")],
			candidates: library("X", 1),
			now: 1,
		});
		expect(state.queue).toHaveLength(1);
		for (let i = 0; i < 4; i++) {
			state = loadAndStart(state, `p${i}`);
			state = apply(state, { type: "replan", now: 20 + i });
			expect(state.queue).toHaveLength(1);
		}
	});
	it("cannot use diversity to bypass exclusions or contributor equity", () => {
		const state = setup();
		state.queue = [];
		state.history.scores[0].plays = 10;
		state.candidates = [
			candidate("X", "different-artist"),
			{ ...candidate("Y", "allowed"), artistIds: ["same"] },
			candidate("Y", "excluded", ["epic"]),
		];
		state.participants[0].excludeMoodIds = ["epic"];
		const plan = projectMusicPlan(state, () => 0.99);
		expect(plan.entries[0].trackId).toBe("allowed");
		expect(plan.entries.some(e => e.trackId === "excluded")).toBe(false);
	});
	it("suspends filling after the target drops, retaining compatible occurrences", () => {
		let state = setup(Array.from({ length: 7 }, (_, i) => `u${i}`));
		const ids = state.queue.map(e => e.entryId).sort();
		state = apply(state, {
			type: "context",
			participants: Array.from({ length: 8 }, (_, i) => person(`u${i}`)),
			candidates: Array.from({ length: 8 }, (_, i) => library(`u${i}`)).flat(),
			now: 3,
		});
		expect(state.queue).toHaveLength(14);
		expect(state.queue.map(e => e.entryId).sort()).toEqual(ids);
	});
});

describe("manual request ledger and next slot", () => {
	const excluded = (): MusicSchedulerState =>
		apply(createMusicScheduler("r", "s"), {
			type: "context",
			participants: [person("X", ["focus"]), person("Y", [], ["epic"])],
			candidates: [],
			now: 1,
		});
	const epic = () => ({ ...candidate("X", "epic-track"), tagsByUser: { X: ["epic"] } });
	it("pending intentions cannot steal a valid reserved slot when conflicts disappear", () => {
		let state = add(excluded(), "older-pending", "X", "next", epic());
		state = add(state, "reserved", "Y", "next");
		state = apply(state, {
			type: "context",
			participants: [person("X"), person("Y")],
			candidates: [],
			now: 3,
		});
		expect(state.queue.filter(e => e.requestId === "reserved")).toHaveLength(1);
		expect(state.queue[0].requestId).toBe("reserved");
		expect(state.requests.find(r => r.requestId === "older-pending")?.status).toBe("pending");
		const confirmation = transitionMusicScheduler(
			state,
			{
				type: "confirm",
				requestId: "older-pending",
				trackId: "epic-track",
				conflicts: [],
				now: 4,
			},
			{ expectedRevision: state.revision },
		);
		expect(confirmation.status).toBe("slot-conflict");
	});
	it("refreshes manual-only metadata without silently turning it into a library candidate", () => {
		let state = add(excluded(), "outside", "X", "mix", candidate("X", "outside"));
		const refreshed = { ...candidate("X", "outside"), tagsByUser: { X: ["epic"] } };
		state = apply(state, {
			type: "context",
			participants: [person("X"), person("Y", [], ["epic"])],
			candidates: [],
			occurrenceCandidates: [refreshed],
			now: 3,
		});
		expect(state.queue).toEqual([]);
		expect(state.requests[0].status).toBe("pending");
		expect(state.candidates).toEqual([]);
		state = apply(state, {
			type: "context",
			participants: [person("X"), person("Y")],
			candidates: [],
			occurrenceCandidates: [refreshed],
			now: 4,
		});
		expect(state.queue).toHaveLength(1);
		expect(state.queue[0].origin).toBe("manual");
	});
	it("keeps new conflicts pending until specifically confirmed, retaining old acceptance", () => {
		let state = add(excluded(), "confirmed", "X", "mix", epic());
		state = apply(state, {
			type: "confirm",
			requestId: "confirmed",
			trackId: "epic-track",
			conflicts: state.requests[0].offeredConflicts,
			now: 3,
		});
		state = apply(state, {
			type: "context",
			participants: [person("X", [], ["epic"]), person("Y", [], ["epic"])],
			candidates: [],
			now: 4,
		});
		state = apply(state, {
			type: "confirm",
			requestId: "confirmed",
			trackId: "epic-track",
			conflicts: [{ participantId: "Y", moodId: "epic" }],
			now: 5,
		});
		expect(state.queue).toEqual([]);
		state = apply(state, {
			type: "confirm",
			requestId: "confirmed",
			trackId: "epic-track",
			conflicts: [{ participantId: "X", moodId: "epic" }],
			now: 6,
		});
		expect(state.queue).toHaveLength(1);
		expect(state.requests[0].acceptedConflicts).toHaveLength(2);
	});
	it("ignores inclusions and admits an untagged manual request", () => {
		const state = add(excluded(), "untagged");
		expect(state.queue[0].requestId).toBe("untagged");
	});
	it("pending and cancelled confirmations create no active occurrence, slot or debt", () => {
		let state = add(excluded(), "pending", "X", "next", epic());
		expect(state.queue).toEqual([]);
		expect(state.requests[0].offeredConflicts).toEqual([
			{ participantId: "Y", moodId: "epic" },
		]);
		state = add(state, "other-priority", "Y", "next");
		expect(state.queue[0].requestId).toBe("other-priority");
		state = apply(state, { type: "cancel", requestId: "pending", now: 3 });
		expect(state.history.events).toEqual([]);
		expect(state.requests.find(r => r.requestId === "pending")?.status).toBe("cancelled");
	});
	it("confirmation is specific to request/track/conflicts and retransmission is idempotent", () => {
		let state = add(excluded(), "confirmed", "X", "mix", epic());
		const confirm: MusicSchedulerCommand = {
			type: "confirm",
			requestId: "confirmed",
			trackId: "epic-track",
			conflicts: [{ participantId: "Y", moodId: "epic" }],
			now: 3,
		};
		const wrong = transitionMusicScheduler(
			state,
			{ ...confirm, trackId: "wrong" },
			{ expectedRevision: state.revision },
		);
		expect(wrong.status).toBe("not-found");
		const forged = transitionMusicScheduler(
			state,
			{ ...confirm, conflicts: [{ participantId: "Y", moodId: "unoffered" }] },
			{ expectedRevision: state.revision },
		);
		expect(forged.status).toBe("invalid-confirmation");
		state = apply(state, confirm);
		state = restoreMusicScheduler(JSON.parse(JSON.stringify(serializeMusicScheduler(state))));
		state = apply(state, { type: "replan", now: 4 });
		expect(state.queue).toHaveLength(1);
		expect(
			transitionMusicScheduler(state, confirm, { expectedRevision: state.revision }).status,
		).toBe("duplicate");
		const repeat = transitionMusicScheduler(
			state,
			{ type: "request", requestId: "confirmed", candidate: epic(), intent: "mix", now: 5 },
			{ expectedRevision: state.revision },
		);
		expect(repeat.status).toBe("duplicate");
		expect(repeat.state.queue).toHaveLength(1);
		state = add(state, "independent", "X", "mix", epic());
		expect(state.requests[1].status).toBe("pending");
	});
	it("requests only new conflicts after admission and readmits when they disappear", () => {
		let state = add(excluded(), "confirmed", "X", "mix", epic());
		state = apply(state, {
			type: "confirm",
			requestId: "confirmed",
			trackId: "epic-track",
			conflicts: state.requests[0].offeredConflicts,
			now: 3,
		});
		const entryId = state.queue[0].entryId;
		state = apply(state, {
			type: "context",
			participants: [person("X", ["sad"], ["epic"]), person("Y", [], ["epic"])],
			candidates: [],
			now: 4,
		});
		expect(state.queue).toEqual([]);
		expect(state.requests[0].offeredConflicts).toEqual([
			{ participantId: "X", moodId: "epic" },
		]);
		expect(state.requests[0].acceptedConflicts).toEqual([
			{ participantId: "Y", moodId: "epic" },
		]);
		state = apply(state, {
			type: "context",
			participants: [person("X", ["sad"]), person("Y", [], ["epic"])],
			candidates: [],
			now: 5,
		});
		expect(state.queue[0].entryId).toBe(entryId);
		expect(state.requests[0].status).toBe("admitted");
	});
	it("first next-slot claim wins under serialized revision checks", () => {
		const before = setup();
		const command = (requestId: string): MusicSchedulerCommand => ({
			type: "request",
			requestId,
			candidate: candidate("X", requestId),
			intent: "next",
			now: 2,
		});
		const first = transitionMusicScheduler(before, command("first"), {
			expectedRevision: before.revision,
		});
		const stale = transitionMusicScheduler(first.state, command("second"), {
			expectedRevision: before.revision,
		});
		expect(stale.status).toBe("revision-conflict");
		const retry = transitionMusicScheduler(first.state, command("second"), {
			expectedRevision: first.state.revision,
		});
		expect(retry.status).toBe("slot-conflict");
		expect(first.state.queue[0].requestId).toBe("first");
		expect(first.state.current).toBe(before.current);
		expect(before.requests).toEqual([]);
	});
	it("explicit renew replaces automatic content and preserves confirmed manual occurrences", () => {
		let state = add(setup(), "manual");
		const manualId = state.requests[0].entryId;
		const oldAuto = state.queue.filter(e => e.origin === "automatic").map(e => e.entryId);
		state = apply(state, { type: "replan", content: "renew", now: 4 });
		expect(state.queue.some(e => e.entryId === manualId)).toBe(true);
		expect(state.queue.some(e => oldAuto.includes(e.entryId))).toBe(false);
		expect(state.history.events).toEqual([]);
	});
	it("restores the same published plan and deterministic future draws; rejects bad versions", () => {
		const original = setup();
		const restored = restoreMusicScheduler(JSON.parse(JSON.stringify(original)));
		expect(projectMusicPlan(original)).toEqual(projectMusicPlan(restored));
		expect(restored).toEqual(original);
		expect(() => restoreMusicScheduler({ ...original, version: 2 })).toThrow();
		expect(() => restoreMusicScheduler({ ...original, nextEntrySequence: 0 })).toThrow();
		const brokenCounters = structuredClone(original);
		brokenCounters.history.scores[0].plays = 99;
		expect(() => restoreMusicScheduler(brokenCounters)).toThrow();
		expect(() =>
			restoreMusicScheduler({ ...original, queue: [original.queue[0], original.queue[0]] }),
		).toThrow();
	});
});
