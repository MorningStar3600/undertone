/* eslint vitest/expect-expect: ["warn", { "assertFunctionNames": ["expect", "expectCode"] }] */
import { describe, expect, it } from "vitest";
import {
	MAX_PLAYBACK_EVENTS,
	MAX_POSITION_SECONDS,
	PlaybackEventSchema,
	PlaybackTimelineException,
	PlaybackTimelineSchema,
	acceptPlaybackEvent,
	compactPlaybackTimeline,
	createPlaybackTimeline,
	expectedPlaybackAt,
	parsePlaybackTimeline,
	type PlaybackEvent,
	type PlaybackTimeline,
	type PlaybackTimelineErrorCode,
} from "../../playback/index.js";

const epoch = "room-incarnation-a";
const media = { service: "youtube", id: "same-video" };
const load = (
	sequence = 1,
	effectiveAtMs = 1000,
	occurrenceId = 1,
	patch: Partial<Extract<PlaybackEvent, { type: "load" }>> = {},
): PlaybackEvent => ({
	epoch,
	sequence,
	effectiveAtMs,
	occurrenceId,
	type: "load",
	media,
	positionSeconds: 10,
	isPlaying: false,
	rate: 1,
	...patch,
});
const control = (
	type: "play" | "pause" | "clear",
	sequence: number,
	effectiveAtMs: number,
	occurrenceId = 1,
): PlaybackEvent => ({ type, epoch, sequence, effectiveAtMs, occurrenceId });
const replay = (...events: PlaybackEvent[]): PlaybackTimeline =>
	events.reduce(
		(timeline, event) => acceptPlaybackEvent(timeline, event).timeline,
		createPlaybackTimeline(epoch, 1000),
	);
const expectCode = (run: () => unknown, code: PlaybackTimelineErrorCode): void => {
	expect(run).toThrowError(PlaybackTimelineException);
	expect(run).toThrowError(expect.objectContaining({ code }));
};

const transitions: PlaybackEvent[] = [
	load(),
	control("play", 2, 2000),
	{ type: "rate", epoch, sequence: 3, effectiveAtMs: 4000, occurrenceId: 1, rate: 2 },
	{
		type: "seek",
		epoch,
		sequence: 4,
		effectiveAtMs: 5000,
		occurrenceId: 1,
		positionSeconds: 100,
	},
	control("pause", 5, 6000),
	control("play", 6, 8000),
	load(7, 9000, 2, { isPlaying: true, positionSeconds: 0 }),
	control("clear", 8, 12000, 2),
	load(9, 15000, 3),
];

describe("playback timeline reconstruction", () => {
	it("joins playing media at the expected fractional position in seconds", () => {
		const timeline = replay(load(1, 1000, 1, { isPlaying: true }));
		expect(expectedPlaybackAt(timeline, 3750)).toEqual({
			epoch,
			serverTimeMs: 3750,
			receivedSequence: 1,
			appliedSequence: 1,
			state: { occurrenceId: 1, media, positionSeconds: 12.75, isPlaying: true, rate: 1 },
		});
	});

	it("joins paused media without advancing position", () => {
		const timeline = replay(load());
		expect(expectedPlaybackAt(timeline, 60000).state).toEqual({
			occurrenceId: 1,
			media,
			positionSeconds: 10,
			isPlaying: false,
			rate: 1,
		});
	});

	it("integrates play, rate, seek, pause and resume at each effective time", () => {
		const timeline = replay(...transitions);
		expect(expectedPlaybackAt(timeline, 1500).state?.positionSeconds).toBe(10);
		expect(expectedPlaybackAt(timeline, 3500).state?.positionSeconds).toBe(11.5);
		expect(expectedPlaybackAt(timeline, 4500).state?.positionSeconds).toBe(13);
		expect(expectedPlaybackAt(timeline, 5500).state?.positionSeconds).toBe(101);
		expect(expectedPlaybackAt(timeline, 7500).state?.positionSeconds).toBe(102);
		expect(expectedPlaybackAt(timeline, 8500).state?.positionSeconds).toBe(103);
		expect(expectedPlaybackAt(timeline, 10000).state?.positionSeconds).toBe(1);
		expect(expectedPlaybackAt(timeline, 12500).state).toBeNull();
		expect(expectedPlaybackAt(timeline, 16000).state?.occurrenceId).toBe(3);
	});

	it("keeps receipt sequence ahead of effective sequence for future events", () => {
		const timeline = replay(load(), control("play", 2, 5000), control("pause", 3, 10000));
		expect(expectedPlaybackAt(timeline, 4000)).toMatchObject({
			receivedSequence: 3,
			appliedSequence: 1,
			state: { positionSeconds: 10, isPlaying: false },
		});
		expect(expectedPlaybackAt(timeline, 5000)).toMatchObject({
			appliedSequence: 2,
			state: { positionSeconds: 10, isPlaying: true },
		});
		expect(expectedPlaybackAt(timeline, 11000)).toMatchObject({
			appliedSequence: 3,
			state: { positionSeconds: 15, isPlaying: false },
		});
	});

	it("orders equal effective times by sequence, including at the exact boundary", () => {
		const seek: PlaybackEvent = {
			type: "seek",
			epoch,
			sequence: 3,
			effectiveAtMs: 2000,
			occurrenceId: 1,
			positionSeconds: 50,
		};
		const timeline = replay(load(), control("play", 2, 2000), seek, control("pause", 4, 2000));
		expect(expectedPlaybackAt(timeline, 1999).appliedSequence).toBe(1);
		expect(expectedPlaybackAt(timeline, 2000)).toMatchObject({
			appliedSequence: 4,
			state: { positionSeconds: 50, isPlaying: false },
		});
	});

	it("seeks and changes rate while paused without starting playback", () => {
		const timeline = replay(
			load(),
			{
				type: "seek",
				epoch,
				sequence: 2,
				effectiveAtMs: 2000,
				occurrenceId: 1,
				positionSeconds: 30,
			},
			{ type: "rate", epoch, sequence: 3, effectiveAtMs: 3000, occurrenceId: 1, rate: 0.5 },
			control("play", 4, 5000),
		);
		expect(expectedPlaybackAt(timeline, 4000).state).toMatchObject({
			positionSeconds: 30,
			isPlaying: false,
			rate: 0.5,
		});
		expect(expectedPlaybackAt(timeline, 6000).state?.positionSeconds).toBe(30.5);
	});

	it("does not restart media on repeated play or pause events", () => {
		const timeline = replay(
			load(1, 1000, 1, { isPlaying: true }),
			control("play", 2, 2000),
			control("pause", 3, 3000),
			control("pause", 4, 4000),
		);
		expect(expectedPlaybackAt(timeline, 5000).state?.positionSeconds).toBe(12);
	});

	it("distinguishes repeated sources and rejects controls for the old occurrence", () => {
		const timeline = replay(load(), load(2, 2000, 2));
		expect(expectedPlaybackAt(timeline, 1500).state?.occurrenceId).toBe(1);
		expect(expectedPlaybackAt(timeline, 2500).state?.occurrenceId).toBe(2);
		expectCode(
			() => acceptPlaybackEvent(timeline, control("pause", 3, 3000, 1)),
			"stale-occurrence",
		);
		expectCode(() => acceptPlaybackEvent(timeline, load(3, 3000, 2)), "stale-occurrence");
	});

	it("replaces source without changing occurrence or replaying a start", () => {
		const replacement = { service: "local", id: "public-source-2" };
		const timeline = replay(load(1, 1000, 1, { isPlaying: true, rate: 2 }), {
			type: "source",
			epoch,
			sequence: 2,
			effectiveAtMs: 3000,
			occurrenceId: 1,
			media: replacement,
		});
		expect(expectedPlaybackAt(timeline, 2999).state?.media).toEqual(media);
		expect(expectedPlaybackAt(timeline, 4000).state).toEqual({
			occurrenceId: 1,
			media: replacement,
			positionSeconds: 16,
			isPlaying: true,
			rate: 2,
		});
	});

	it("clears rendering and requires a fresh load occurrence afterwards", () => {
		const timeline = compactPlaybackTimeline(replay(load(), control("clear", 2, 2000)), 3000);
		expect(expectedPlaybackAt(timeline, 4000).state).toBeNull();
		expect(timeline.baseline.lastOccurrenceId).toBe(1);
		expectCode(() => acceptPlaybackEvent(timeline, load(3, 4000, 1)), "stale-occurrence");
		expectCode(
			() => acceptPlaybackEvent(timeline, control("play", 3, 4000)),
			"stale-occurrence",
		);
		const loaded = acceptPlaybackEvent(
			timeline,
			load(3, 4000, 2, { isPlaying: true }),
		).timeline;
		expect(expectedPlaybackAt(loaded, 5000).state).toMatchObject({
			occurrenceId: 2,
			isPlaying: true,
		});
	});

	it("retains a future source replacement through a snapshot and later resume", () => {
		const replacement = { service: "local", id: "public-fallback" };
		const prefix = replay(load(), {
			type: "source",
			epoch,
			sequence: 2,
			effectiveAtMs: 5000,
			occurrenceId: 1,
			media: replacement,
		});
		const play = control("play", 3, 6000);
		const full = acceptPlaybackEvent(prefix, play).timeline;
		const restored = acceptPlaybackEvent(compactPlaybackTimeline(prefix, 2000), play).timeline;
		for (const time of [4500, 5000, 7000]) {
			expect(expectedPlaybackAt(restored, time)).toEqual(expectedPlaybackAt(full, time));
		}
		expect(expectedPlaybackAt(restored, 4500).state?.media).toEqual(media);
		expect(expectedPlaybackAt(restored, 5000).state).toMatchObject({
			occurrenceId: 1,
			media: replacement,
			isPlaying: false,
			positionSeconds: 10,
		});
		expect(expectedPlaybackAt(restored, 7000).state?.positionSeconds).toBe(11);
	});

	it("bounds extrapolated positions at extreme valid times", () => {
		const timeline = replay(load(1, 1000, 1, { isPlaying: true, rate: 16 }));
		expect(expectedPlaybackAt(timeline, Number.MAX_SAFE_INTEGER).state?.positionSeconds).toBe(
			MAX_POSITION_SECONDS,
		);
	});
});

describe("playback snapshots and compaction", () => {
	it("matches full replay at every tested cutoff, including accepted future events", () => {
		const full = replay(...transitions);
		for (const cutoff of [1000, 1500, 2000, 4500, 6000, 8500, 12000, 16000]) {
			const snapshot = parsePlaybackTimeline(
				JSON.parse(JSON.stringify(compactPlaybackTimeline(full, cutoff))),
			);
			for (const time of [cutoff, cutoff + 1, cutoff + 500, 20000]) {
				expect(expectedPlaybackAt(snapshot, time)).toEqual(expectedPlaybackAt(full, time));
			}
		}
	});

	it("matches full replay when following events are appended to a snapshot with pending events", () => {
		const prefix = replay(...transitions.slice(0, 5));
		const snapshot = compactPlaybackTimeline(prefix, 4500);
		expect(snapshot.baseline.sequence).toBe(3);
		expect(snapshot.events.map(event => event.sequence)).toEqual([4, 5]);
		const restored = transitions
			.slice(5)
			.reduce(
				(timeline, event) => acceptPlaybackEvent(timeline, event).timeline,
				parsePlaybackTimeline(JSON.parse(JSON.stringify(snapshot))),
			);
		const full = replay(...transitions);
		for (const time of [4500, 5000, 5500, 6000, 8500, 9000, 13000, 20000]) {
			expect(expectedPlaybackAt(restored, time)).toEqual(expectedPlaybackAt(full, time));
		}
	});

	it("retains the exact anchor across repeated compaction to avoid rounding drift", () => {
		const full = replay(
			load(1, 1000, 1, { isPlaying: true, positionSeconds: 1 / 3, rate: 1.1 }),
		);
		let snapshot = full;
		for (let time = 1001; time <= 1100; time++) {
			snapshot = compactPlaybackTimeline(snapshot, time);
		}
		expect(snapshot.baseline.lastEffectiveAtMs).toBe(1000);
		expect(snapshot.baseline.state?.positionSeconds).toBe(1 / 3);
		expect(expectedPlaybackAt(snapshot, 12345)).toEqual(expectedPlaybackAt(full, 12345));
	});

	it("accepts a late post-commit event before snapshot time using the retained anchor", () => {
		const prefix = replay(load(1, 1000, 1, { isPlaying: true }));
		const snapshot = compactPlaybackTimeline(prefix, 5000);
		const latePause = control("pause", 2, 3000);
		const restored = acceptPlaybackEvent(snapshot, latePause).timeline;
		const full = replay(load(1, 1000, 1, { isPlaying: true }), latePause);
		expect(expectedPlaybackAt(restored, 6000)).toEqual(expectedPlaybackAt(full, 6000));
		expect(expectedPlaybackAt(restored, 6000).state?.positionSeconds).toBe(12);
		expect(parsePlaybackTimeline(restored)).toEqual(restored);
	});

	it("folds same-time events but preserves later events and the receipt cursor", () => {
		const timeline = replay(
			load(),
			control("play", 2, 2000),
			control("pause", 3, 2000),
			load(4, 5000, 2),
		);
		const snapshot = compactPlaybackTimeline(timeline, 2000);
		expect(snapshot.baseline.sequence).toBe(3);
		expect(snapshot.events.map(event => event.sequence)).toEqual([4]);
		expect(expectedPlaybackAt(snapshot, 2000)).toMatchObject({
			appliedSequence: 3,
			receivedSequence: 4,
		});
	});

	it("rejects queries and compaction before the supported baseline", () => {
		const timeline = compactPlaybackTimeline(replay(load()), 4000);
		expectCode(() => expectedPlaybackAt(timeline, 3999), "before-baseline");
		expectCode(() => compactPlaybackTimeline(timeline, 3000), "before-baseline");
	});

	it("bounds retained events, frees applied history and never drops future work", () => {
		const timeline: PlaybackTimeline = {
			...createPlaybackTimeline(epoch, 1000),
			events: [
				load(),
				...Array.from({ length: MAX_PLAYBACK_EVENTS - 1 }, (_, index) =>
					control("play", index + 2, 5000),
				),
			],
		};
		const next = control("pause", MAX_PLAYBACK_EVENTS + 1, 5001);
		expectCode(() => acceptPlaybackEvent(timeline, next), "capacity");
		const snapshot = compactPlaybackTimeline(timeline, 2000);
		expect(snapshot.events).toHaveLength(MAX_PLAYBACK_EVENTS - 1);
		const accepted = acceptPlaybackEvent(snapshot, next).timeline;
		expect(accepted.events).toHaveLength(MAX_PLAYBACK_EVENTS);
		expect(compactPlaybackTimeline(accepted, 6000).events).toHaveLength(0);
		expect(expectedPlaybackAt(accepted, 6000).state?.isPlaying).toBe(false);
	});

	it("does not mutate caller-owned inputs or retain their nested media objects", () => {
		const initial = createPlaybackTimeline(epoch, 1000);
		const event = load();
		const accepted = acceptPlaybackEvent(initial, event).timeline;
		const snapshot = compactPlaybackTimeline(accepted, 2000);
		const projection = expectedPlaybackAt(snapshot, 3000);
		expect(initial.events).toEqual([]);
		expect(accepted.events).toEqual([event]);
		expect(snapshot.events).toEqual([]);
		expect(projection.state?.media).not.toBe(media);
		expect(snapshot.baseline.state?.media).not.toBe(media);
	});
});

describe("playback event acceptance", () => {
	it("ignores identical duplicates without applying them twice", () => {
		const event = load(1, 1000, 1, { isPlaying: true });
		const timeline = replay(event, control("pause", 2, 2000));
		const duplicate = acceptPlaybackEvent(timeline, { ...event });
		expect(duplicate.status).toBe("duplicate");
		expect(duplicate.timeline).toEqual(timeline);
		expect(expectedPlaybackAt(duplicate.timeline, 3000).state?.positionSeconds).toBe(11);
	});

	it("rejects different payloads at an already retained sequence", () => {
		const timeline = replay(load());
		expectCode(
			() => acceptPlaybackEvent(timeline, load(1, 1000, 1, { isPlaying: true })),
			"sequence-conflict",
		);
	});

	it("classifies compacted sequences as stale without trusting their old payload", () => {
		const timeline = compactPlaybackTimeline(replay(load(), control("play", 2, 2000)), 3000);
		const stale = acceptPlaybackEvent(timeline, load(1, 1500, 1, { positionSeconds: 99 }));
		expect(stale.status).toBe("stale");
		expect(stale.timeline).toEqual(timeline);
	});

	it("detects a missing sequence and accepts an out-of-order delivery only after replay", () => {
		const timeline = replay(load());
		expectCode(() => acceptPlaybackEvent(timeline, control("pause", 3, 3000)), "sequence-gap");
		const recovered = acceptPlaybackEvent(timeline, control("play", 2, 2000)).timeline;
		expect(acceptPlaybackEvent(recovered, control("pause", 3, 3000)).status).toBe("accepted");
	});

	it("requires monotonic effective times even for future events", () => {
		const timeline = replay(load(), control("play", 2, 10000));
		expectCode(
			() => acceptPlaybackEvent(timeline, control("pause", 3, 9000)),
			"effective-time-regression",
		);
		expectCode(
			() => acceptPlaybackEvent(replay(load()), control("play", 2, 999)),
			"effective-time-regression",
		);
	});

	it("rejects foreign epochs before checking even stale sequences", () => {
		const timeline = compactPlaybackTimeline(replay(load()), 2000);
		expectCode(
			() => acceptPlaybackEvent(timeline, load(1, 1000, 1, { epoch: "old-epoch" })),
			"epoch-mismatch",
		);
	});

	it("validates controls against the receipt tail even when its load is in the future", () => {
		const timeline = replay(load(), load(2, 10000, 2));
		expectCode(
			() => acceptPlaybackEvent(timeline, control("play", 3, 10000, 1)),
			"stale-occurrence",
		);
		const accepted = acceptPlaybackEvent(timeline, control("play", 3, 10000, 2)).timeline;
		expect(expectedPlaybackAt(accepted, 5000).state?.occurrenceId).toBe(1);
		expect(expectedPlaybackAt(accepted, 11000).state).toMatchObject({
			occurrenceId: 2,
			isPlaying: true,
		});
	});
});

describe("playback runtime validation", () => {
	it.each([
		{ effectiveAtMs: NaN },
		{ effectiveAtMs: Infinity },
		{ effectiveAtMs: -1 },
		{ effectiveAtMs: 1.5 },
		{ effectiveAtMs: Number.MAX_SAFE_INTEGER + 1 },
		{ sequence: 0 },
		{ sequence: 1.5 },
		{ sequence: Number.MAX_SAFE_INTEGER + 1 },
		{ occurrenceId: 0 },
		{ occurrenceId: 1.5 },
		{ occurrenceId: Infinity },
		{ positionSeconds: -1 },
		{ positionSeconds: NaN },
		{ positionSeconds: Infinity },
		{ positionSeconds: MAX_POSITION_SECONDS + 1 },
		{ rate: 0 },
		{ rate: -1 },
		{ rate: NaN },
		{ rate: Infinity },
		{ rate: 16.1 },
		{ epoch: "" },
		{ epoch: "x".repeat(129) },
		{ epoch: "has whitespace" },
		{ isPlaying: "true" },
		{ credentials: "private" },
		{ type: "next" },
		{ media: { ...media, accessToken: "private" } },
		{ media: { service: "youtube", id: "https://user:password@example.test/video" } },
		{ media: { service: "url", id: "https://example.test/video?token=private" } },
		{ media: { service: "youtube", id: "x".repeat(257) } },
		{ media: { service: "youtube", id: "" } },
	])("rejects invalid or nonpublic event fields: %j", patch => {
		expect(PlaybackEventSchema.safeParse({ ...load(), ...patch }).success).toBe(false);
	});

	it("does not coerce payload values and validates each public entry point", () => {
		expect(() => acceptPlaybackEvent(replay(), { ...load(), sequence: "1" })).toThrow();
		expect(() => createPlaybackTimeline(epoch, Infinity)).toThrow();
		expect(() => expectedPlaybackAt(replay(), 1.5)).toThrow();
		expect(() => compactPlaybackTimeline(replay(), -1)).toThrow();
		expect(() => parsePlaybackTimeline({ ...replay(), version: 2 })).toThrow();
	});

	it("validates serialized event sequences, epochs, occurrence transitions and times", () => {
		const initial = replay();
		for (const events of [
			[control("play", 1, 1000)],
			[load(2)],
			[load(), control("play", 3, 2000)],
			[load(), control("play", 2, 2000, 2)],
			[load(), control("play", 2, 999)],
			[load(1, 1000, 1, { epoch: "another-epoch" })],
			[load(), load(2, 2000, 1)],
			[load(1, 1000, 2)],
		]) {
			expect(PlaybackTimelineSchema.safeParse({ ...initial, events }).success).toBe(false);
		}
	});

	it("rejects contradictory baselines and unbounded event arrays", () => {
		const snapshot = compactPlaybackTimeline(replay(load()), 2000);
		for (const patch of [
			{ state: null },
			{ lastEffectiveAtMs: 2001 },
			{ lastOccurrenceId: 0 },
			{ lastOccurrenceId: 2 },
			{ sequence: 0 },
		]) {
			expect(
				PlaybackTimelineSchema.safeParse({
					...snapshot,
					baseline: { ...snapshot.baseline, ...patch },
				}).success,
			).toBe(false);
		}
		expect(
			PlaybackTimelineSchema.safeParse({
				...replay(),
				events: Array.from({ length: MAX_PLAYBACK_EVENTS + 1 }, () => load()),
			}).success,
		).toBe(false);
	});
});
