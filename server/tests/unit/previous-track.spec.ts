import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Room, RoomUser } from "../../room.js";
import tokens from "../../auth/tokens.js";
import usermanager from "../../usermanager.js";
import { QueueMode, Role } from "ott-common/models/types.js";
import permissions from "ott-common/permissions.js";
import { PlaybackCommandSchema } from "ott-common/playback/transport.js";
import { SqlMusicRoomStore } from "../../music/room-music-storage.js";
import { createCatalogueFixture } from "./music-test-helpers.js";
import type { User } from "../../models/user.js";
import { DEFAULT_MOODS } from "ott-common/models/music.js";

vi.mock("../../roommanager.js", () => ({ default: { publish: vi.fn() } }));
vi.mock("../../websockets.js", () => ({ wss: {} }));
vi.mock("../../balancer.js", () => ({ balancerManager: {}, buildGossipMessage: vi.fn() }));

const auth = { token: "session", clientId: "tab" };
const track = (id: string) => ({ service: "youtube" as const, id, length: 180 });
const prepare = (room: Room, registered = false) => {
	room.throttledSync.cancel();
	room.throttledSync = vi.fn() as unknown as typeof room.throttledSync;
	const user = new RoomUser("tab", "session");
	if (registered) {
		user.user_id = 1;
	}
	room.realusers.push(user);
	room.grants.setRoleGrants(Role.UnregisteredUser, 0);
	room.grants.setRoleGrants(
		registered ? Role.RegisteredUser : Role.UnregisteredUser,
		permissions.parseIntoGrantMask(["*"]),
	);
	vi.spyOn(room, "publish").mockResolvedValue(undefined);
	return room;
};
const command = (room: Room, requestId: string, kind = "previous") => ({
	command: kind,
	requestId,
	epoch: room.playbackSnapshot("test").timeline.epoch,
	occurrenceId: room.playbackSnapshot("test").timeline.baseline.state?.occurrenceId ?? 0,
	...(kind === "previous"
		? { sequence: room.playbackSnapshot("test").timeline.baseline.sequence }
		: {}),
});
const previous = (room: Room, id: string) => room.executePlaybackCommand(command(room, id), auth);

describe("server-owned previous track", () => {
	beforeEach(() => {
		vi.spyOn(tokens, "getSessionInfo").mockResolvedValue({
			isLoggedIn: false,
			username: "guest",
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each([QueueMode.Manual, QueueMode.Vote, QueueMode.Loop])(
		"walks history in order and retains interrupted tracks for Next in %s",
		async queueMode => {
			const room = prepare(
				new Room({ name: "previous", currentSource: track("a"), queueMode }),
			);
			await room.queue.set([track("b"), track("c")]);
			await room.dequeueNext();
			await room.dequeueNext();
			expect(room.previousTracks.map(item => item.id)).toEqual(["a", "b"]);
			const input = command(room, "back-b");
			const first = room.executePlaybackCommand(input, auth);
			expect(room.executePlaybackCommand(input, auth)).toBe(first);
			expect((await first).status).toBe("applied");
			expect(room.currentSource?.id).toBe("b");
			expect(room.queue.items[0].id).toBe("c");
			expect(await room.executePlaybackCommand(input, auth)).toEqual(await first);
			expect((await previous(room, "back-a")).status).toBe("applied");
			expect(room.currentSource?.id).toBe("a");
			expect(room.previousAvailable).toBe(false);
			expect((await previous(room, "empty")).code).toBe("unavailable");
			expect(
				(await room.executePlaybackCommand(command(room, "next", "next"), auth)).status,
			).toBe("applied");
			expect(room.currentSource?.id).toBe("b");
		},
	);

	it("restores after natural exhaustion, persists bounded history privately, and keeps paused state", async () => {
		const room = prepare(new Room({ name: "empty", currentSource: track("last") }));
		await room.dequeueNext();
		expect(room.currentSource).toBeNull();
		expect(command(room, "after-end").occurrenceId).toBe(0);
		expect(room.syncableState()).not.toHaveProperty("previousTracks");
		const saved = JSON.parse(room.serializeState());
		const restored = prepare(new Room(saved));
		expect((await previous(restored, "after-restart")).status).toBe("applied");
		expect(restored.currentSource?.id).toBe("last");
		expect(restored.isPlaying).toBe(false);
		for (let i = 0; i < 105; i++) {
			await room.queue.set([track(String(i))]);
			await room.dequeueNext();
		}
		expect(room.previousTracks).toHaveLength(100);
	});

	it("rejects forged media, stale cursors, revocation, stale connections and vote-skip bypass", async () => {
		const room = prepare(new Room({ name: "guards", currentSource: track("a") }));
		await room.queue.set([track("b")]);
		await room.dequeueNext();
		const input = command(room, "stale");
		expect(() => PlaybackCommandSchema.parse({ ...input, media: track("forged") })).toThrow();
		room.enableVoteSkip = true;
		expect((await previous(room, "vote")).code).toBe("unauthorized");
		expect(room.previousTracks).toHaveLength(1);
		room.enableVoteSkip = false;
		room.grants.setRoleGrants(Role.UnregisteredUser, 0);
		expect((await previous(room, "denied")).code).toBe("unauthorized");
		room.grants.setRoleGrants(
			Role.UnregisteredUser,
			permissions.parseIntoGrantMask(["playback.skip"]),
		);
		expect(
			(
				await room.executePlaybackCommand(command(room, "connection"), {
					...auth,
					assertCurrent: () => {
						throw Error("reauth");
					},
				})
			).code,
		).toBe("unauthorized");
		await previous(room, "valid");
		expect((await room.executePlaybackCommand(input, auth)).code).toBe("stale-occurrence");
		expect(room.currentSource?.id).toBe("a");
	});

	it("supports DJ history while preserving DJ's repeat-current Next semantics", async () => {
		const room = prepare(
			new Room({ name: "dj", currentSource: track("a"), queueMode: QueueMode.Dj }),
		);
		await room.dequeueNext();
		expect((await previous(room, "dj-back")).status).toBe("applied");
		expect(room.currentSource?.id).toBe("a");
		expect(room.queue.items).toEqual([]);
	});

	it("rejects an old empty-timeline cursor after another track has loaded and ended", async () => {
		const room = prepare(new Room({ name: "empty-cursor" }));
		const old = command(room, "old-empty");
		await room.queue.set([track("a")]);
		await room.dequeueNext();
		await room.dequeueNext();
		expect((await room.executePlaybackCommand(old, auth)).code).toBe("stale-occurrence");
		expect(room.currentSource).toBeNull();
		expect((await previous(room, "current-empty")).status).toBe("applied");
	});

	async function musicFixture() {
		const fixture = await createCatalogueFixture();
		vi.mocked(tokens.getSessionInfo).mockResolvedValue({ isLoggedIn: true, user_id: 1 });
		vi.spyOn(usermanager, "getUser").mockResolvedValue({ id: 1, username: "one" } as User);
		for (const id of ["a", "b", "c"]) {
			await fixture.catalogue.addLibraryTrack(1, { reference: { service: "youtube", id } });
		}
		const store = new SqlMusicRoomStore(() => fixture.connection);
		const create = () =>
			prepare(
				new Room(
					{ name: "music-previous", queueMode: QueueMode.Music },
					{ catalogue: fixture.catalogue, store },
				),
				true,
			);
		const room = create();
		await room.musicEngine.refresh(true);
		await room.dequeueNext();
		await room.play();
		return { ...fixture, store, room, create };
	}

	it("navigates Music past/future durably without double starts, preserves end causes and published head", async () => {
		const fixture = await musicFixture();
		try {
			const { room, store, create } = fixture;
			const a = room.music!.current!;
			await room.dequeueNext();
			const b = room.music!.current!;
			await room.executePlaybackCommand(command(room, "skip-c", "next"), auth);
			const c = room.music!.current!;
			const original = room.musicState!;
			expect(original.history.events.map(event => event.endReason)).toEqual([
				"finished",
				"skipped",
				undefined,
			]);
			expect((await previous(room, "music-b")).status).toBe("applied");
			expect(room.music!.current!.playbackId).toBe(b.playbackId);
			expect(room.music!.queue[0].entryId).toBe(c.entryId);
			expect((await previous(room, "music-a")).status).toBe("applied");
			expect(room.music!.current!.playbackId).toBe(a.playbackId);
			expect(room.musicState!.history.scores).toEqual(original.history.scores);
			expect(room.musicState!.history.events).toHaveLength(3);
			expect(room.musicState!.history.events.map(event => event.endReason)).toEqual([
				"finished",
				"skipped",
				"interrupted",
			]);
			const restart = create();
			await restart.initializeMusic();
			expect(restart.musicState).toEqual((await store.load(room.name))!.state);
			await restart.dequeueNext();
			expect(restart.music!.current!.playbackId).toBe(b.playbackId);
			await restart.dequeueNext();
			expect(restart.music!.current!.playbackId).toBe(c.playbackId);
			expect(restart.musicState!.queue).toEqual(original.queue);
			expect(restart.musicState!.history.scores).toEqual(original.history.scores);
		} finally {
			await fixture.connection.close();
		}
	});

	it("rolls Music navigation back after staged SQL authorization failure", async () => {
		const fixture = await musicFixture();
		try {
			const { room, store } = fixture;
			await room.dequeueNext();
			const before = (await store.load(room.name))!;
			const journal = room.playbackSnapshot("before").timeline;
			const save = store.save.bind(store);
			vi.spyOn(store, "save").mockImplementation(async (value, revision, hooks) => {
				let checks = 0;
				await save(value, revision, {
					...hooks,
					authorize: async () => {
						if (value.state.navigation?.future.length && ++checks === 2) {
							room.grants.setRoleGrants(Role.RegisteredUser, 0);
						}
						await hooks?.authorize?.();
					},
				});
			});
			expect((await previous(room, "rollback")).code).toBe("unauthorized");
			expect(await store.load(room.name)).toEqual(before);
			expect(room.musicState).toEqual(before.state);
			expect(room.playbackSnapshot("after").timeline).toEqual(journal);
		} finally {
			await fixture.connection.close();
		}
	});

	it("retains unstarted Music forward loads and charges them only when actually started", async () => {
		const fixture = await musicFixture();
		try {
			const { room } = fixture;
			await room.pause();
			await room.dequeueNext();
			const unstarted = room.music!.current!;
			expect(unstarted.started).toBe(false);
			await previous(room, "paused-back");
			await room.play();
			expect(room.musicState!.history.events).toHaveLength(1);
			await room.dequeueNext();
			expect(room.music!.current!.playbackId).toBe(unstarted.playbackId);
			expect(room.musicState!.history.events).toHaveLength(2);
		} finally {
			await fixture.connection.close();
		}
	});

	it("rechecks historical Music mood exclusions and unavailable sources without consuming history", async () => {
		const fixture = await musicFixture();
		try {
			const { room, catalogue, models } = fixture;
			const a = room.music!.current!;
			await room.dequeueNext();
			const currentId = room.music!.current!.playbackId;
			await catalogue.setTrackMood(1, a.trackId, DEFAULT_MOODS[0].id, true);
			await room.musicEngine.execute(
				{
					action: "preferences",
					correlationId: "moods",
					content: "keep",
					expectedRevision: room.music!.revision,
					includeMoodIds: [],
					excludeMoodIds: [DEFAULT_MOODS[0].id],
				},
				"account:1",
			);
			expect((await previous(room, "excluded")).code).toBe("failed");
			expect(room.music!.current!.playbackId).toBe(currentId);
			expect(room.musicState!.navigation!.past.at(-1)!.playbackId).toBe(a.playbackId);
			await room.musicEngine.execute(
				{
					action: "preferences",
					correlationId: "clear-moods",
					content: "keep",
					expectedRevision: room.music!.revision,
					includeMoodIds: [],
					excludeMoodIds: [],
				},
				"account:1",
			);
			await models.TrackSource.update(
				{ availability: "unavailable" },
				{ where: { id: a.sourceId } },
			);
			expect((await previous(room, "unavailable")).code).toBe("failed");
			expect(room.music!.current!.playbackId).toBe(currentId);
			expect(room.musicState!.history.events).toHaveLength(2);
		} finally {
			await fixture.connection.close();
		}
	});

	it("includes Music's return path in queue pagination and permits authorized removal without rewriting history", async () => {
		const fixture = await musicFixture();
		try {
			const { room } = fixture;
			await room.dequeueNext();
			const b = room.music!.current!;
			await previous(room, "back");
			const page = await room.musicEngine.execute(
				{
					action: "queue",
					correlationId: "page",
					offset: 0,
					limit: 10,
					expectedRevision: room.music!.revision,
				},
				"account:1",
			);
			expect(page.page!.items[0].entryId).toBe(b.entryId);
			expect(page.page!.total).toBe(room.music!.queueTotal);
			const history = room.musicState!.history;
			await room.musicEngine.execute(
				{
					action: "remove",
					correlationId: "remove",
					expectedRevision: room.music!.revision,
					entryId: b.entryId,
				},
				"account:1",
			);
			expect(room.musicState!.navigation!.future).toEqual([]);
			expect(room.musicState!.history).toEqual(history);
		} finally {
			await fixture.connection.close();
		}
	});
});
