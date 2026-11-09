import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Room, RoomUser, type RoomStateFromRedis } from "../../room.js";
import { redisStateToState } from "../../roommanager.js";
import { conf } from "../../ott-config.js";
import { buildClients, createSubscriber, redisClient } from "../../redisclient.js";
import { SqlMusicRoomStore } from "../../music/room-music-storage.js";
import { musicRoomModels } from "../../models/music-room.js";
import { projectMusicPlan } from "../../music/music-scheduler.js";
import { expectedPlaybackAt } from "ott-common/playback/index.js";
import { QueueMode } from "ott-common/models/types.js";
import { createFixture, reference, targets, settle, waitForLock } from "./music-fixture.js";

const FINALIZER_FAILURE = /synthetic final/;

describe("bounded integrated timeline probes over real PostgreSQL/Redis", () => {
	let f: Awaited<ReturnType<typeof createFixture>>;
	let store: SqlMusicRoomStore;
	let reader: Awaited<ReturnType<typeof createSubscriber>>;
	const rooms: Room[] = [];
	const keys: string[] = [];
	beforeAll(async () => {
		conf.set("redis.url", targets().redis);
		conf.set("redis.db", 15);
		await buildClients();
		reader = await createSubscriber();
	});
	afterAll(async () => {
		if (reader?.isOpen) {
			await reader.quit();
		}
		if (redisClient?.isOpen) {
			await redisClient.quit();
		}
	});
	beforeEach(async () => {
		f = await createFixture();
		store = new SqlMusicRoomStore(() => f.connection);
		for (const userId of [1, 2]) {
			for (const id of ["a", "b"]) {
				await f.catalogue.addLibraryTrack(userId, {
					reference: reference(`probe-${userId}-${id}`),
				});
			}
		}
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		for (const room of rooms.splice(0)) {
			room.throttledSync.cancel();
			room.saveStateToRedisDebounced.cancel();
		}
		for (const key of keys.splice(0)) {
			await redisClient.del(key);
		}
		await f?.cleanup();
	});
	function makeRoom(name: string, options = {}, peer?: ReturnType<typeof f.peer>) {
		const room = new Room(
			{ name, queueMode: QueueMode.Music, ...options },
			{
				catalogue: peer?.catalogue ?? f.catalogue,
				store: peer ? new SqlMusicRoomStore(() => peer.connection) : store,
			},
		);
		room.throttledSync.cancel();
		room.throttledSync = Object.assign(() => undefined, {
			cancel: () => undefined,
		}) as typeof room.throttledSync;
		vi.spyOn(room, "publish").mockResolvedValue(undefined);
		for (const id of [1, 2]) {
			const user = new RoomUser(`probe-tab-${id}`, `probe-token-${id}`);
			user.user_id = id;
			room.realusers.push(user);
		}
		rooms.push(room);
		return room;
	}
	function playbackEvents(room: Room) {
		return vi
			.mocked(room.publish)
			.mock.calls.map(([message]) => message)
			.filter(message => message.action === "playback-event");
	}

	it.each(["throw-finalizer", "reject-final-sql"])(
		"rolls back SQL and staged public timeline for %s; retry has no sequence/debt gap",
		async failure => {
			const room = makeRoom("timeline-failure");
			await room.musicEngine.refresh(true);
			await room.dequeueNext();
			const before = (await store.load(room.name))!;
			const timeline = room.playbackSnapshot("before").timeline;
			const published = vi.mocked(room.publish).mock.calls.length;
			let finalized = 0;
			const save = store.save.bind(store);
			const interception = vi
				.spyOn(store, "save")
				.mockImplementation((value, revision, hooks) =>
					save(value, revision, {
						...hooks,
						finalize: () => {
							const result = hooks!.finalize!();
							finalized++;
							if (failure === "throw-finalizer") {
								throw new Error("synthetic finalizer failure");
							}
							return result;
						},
					}),
				);
			if (failure === "reject-final-sql") {
				await f.connection.query(
					"CREATE FUNCTION reject_final() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic finalized SQL failure'; END $$",
				);
				await f.connection.query(
					'CREATE TRIGGER reject_final BEFORE UPDATE ON "MusicRoomStates" FOR EACH ROW WHEN (NEW.revision = OLD.revision) EXECUTE FUNCTION reject_final()',
				);
			}
			await expect(
				room.musicEngine.setPlayback({ isPlaying: true, playbackPosition: 40 }),
			).rejects.toThrow(FINALIZER_FAILURE);
			expect(finalized).toBe(1);
			expect(await store.load(room.name)).toEqual(before);
			expect(room.musicState).toEqual(before.state);
			expect(room.playbackSnapshot("rollback").timeline).toEqual(timeline);
			expect(vi.mocked(room.publish).mock.calls).toHaveLength(published);
			const models = musicRoomModels(f.connection);
			expect(await models.Event.count()).toBe(0);
			expect(
				(await models.Score.findAll()).reduce((sum, score) => sum + score.get().plays, 0),
			).toBe(0);
			interception.mockRestore();
			if (failure === "reject-final-sql") {
				await f.connection.query('DROP TRIGGER reject_final ON "MusicRoomStates"');
				await f.connection.query("DROP FUNCTION reject_final()");
			}
			await room.musicEngine.setPlayback({ isPlaying: true, playbackPosition: 40 });
			const events = playbackEvents(room);
			expect(events.map(message => message.event.sequence)).toEqual([1, 2, 3]);
			expect(
				expectedPlaybackAt(room.playbackSnapshot("committed").timeline, Date.now()).state,
			).toMatchObject({ isPlaying: true });
			expect(await models.Event.count()).toBe(1);
			expect(
				(await models.Score.findAll()).reduce((sum, score) => sum + score.get().plays, 0),
			).toBe(1);
			expect(room.musicState!.current!.playbackId).toBe(before.state.current!.playbackId);
			console.log(
				"Rollback evidence:",
				failure,
				"finalizer calls",
				finalized,
				"committed public sequences",
				events.map(message => message.event.sequence),
			);
		},
	);

	it("retimes the public play event, SQL playback anchor and normalized start after an observed CAS lock wait", async () => {
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const room = makeRoom("timeline-lock");
		await room.musicEngine.refresh(true);
		await room.dequeueNext();
		const peer = f.peer();
		await peer.connection.authenticate();
		const tx = await peer.connection.transaction();
		await musicRoomModels(peer.connection).State.findByPk(room.name, {
			transaction: tx,
			lock: tx.LOCK.UPDATE,
		});
		const before = room.playbackSnapshot("before").timeline;
		const starting = settle(room.play());
		try {
			await waitForLock(peer.connection, f.schema);
			expect(room.playbackSnapshot("waiting").timeline).toEqual(before);
			now += 2700;
		} finally {
			await tx.rollback();
		}
		expect(await starting).not.toHaveProperty("error");
		const durable = (await store.load(room.name))!;
		expect(durable.playback.playbackStart).toBe(new Date(now).toISOString());
		expect(durable.state.history.events[0].startedAt).toBe(now);
		expect(playbackEvents(room).at(-1)!.event).toMatchObject({
			type: "play",
			effectiveAtMs: now,
		});
		expect(
			(await musicRoomModels(peer.connection).Event.findOne())!.get().event.startedAt,
		).toBe(now);
		console.log(
			"CAS retiming evidence: SQL anchor, normalized start and public event all",
			now,
		);
	});

	it("restores from real Redis and SQL-only with fresh public epochs while preserving playback identity, fairness debt and deterministic future plan", async () => {
		const name = `timeline-restore-${targets().runId}`;
		const key = `room:${name}`;
		expect(await redisClient.set(key, "synthetic-claim", { NX: true, EX: 300 })).toBe("OK");
		keys.push(key);
		const room = makeRoom(name);
		await room.musicEngine.refresh(true);
		await room.dequeueNext();
		await room.play();
		const before = room.musicState!;
		const sourceEpoch = room.playbackSnapshot("before").timeline.epoch;
		const plan = projectMusicPlan(before);
		expect(before.history.scores.reduce((sum, score) => sum + score.plays, 0)).toBe(1);
		expect(new Set(before.history.scores.map(score => score.contributorId)).size).toBe(2);
		room.saveStateToRedisDebounced();
		await room.saveStateToRedisDebounced.flush();
		expect(await reader.ttl(key)).toBeGreaterThan(0);
		const raw = JSON.parse((await reader.get(key))!) as RoomStateFromRedis;
		const peer = f.peer();
		const restored = makeRoom(name, redisStateToState(raw), peer);
		await restored.initializeMusic();
		expect(restored.playbackSnapshot("redis").timeline.epoch).not.toBe(sourceEpoch);
		expect(restored.playbackSnapshot("redis").attachment!.playbackId).toBe(
			before.current!.playbackId,
		);
		expect(restored.musicState).toEqual(before);
		expect(projectMusicPlan(restored.musicState!)).toEqual(plan);
		await redisClient.del(key);
		expect(await reader.get(key)).toBeNull();
		const fallback = makeRoom(name, {}, peer);
		await fallback.initializeMusic();
		expect(
			new Set([
				sourceEpoch,
				restored.playbackSnapshot("redis").timeline.epoch,
				fallback.playbackSnapshot("sql").timeline.epoch,
			]).size,
		).toBe(3);
		expect(fallback.playbackSnapshot("sql").attachment!.playbackId).toBe(
			before.current!.playbackId,
		);
		expect(fallback.musicState).toEqual(before);
		expect(projectMusicPlan(fallback.musicState!)).toEqual(plan);
		await fallback.play();
		expect(fallback.musicState!.sessionId).toBe(before.sessionId);
		expect(fallback.musicState!.history).toEqual(before.history);
		expect(await musicRoomModels(peer.connection).Event.count()).toBe(1);
		expect(
			(await musicRoomModels(peer.connection).Score.findAll()).reduce(
				(sum, score) => sum + score.get().plays,
				0,
			),
		).toBe(1);
		console.log(
			"Restore evidence: 3 distinct public epochs; domain playbackId/session preserved; two contributors, one total play; future plan identical.",
		);
	});
});
