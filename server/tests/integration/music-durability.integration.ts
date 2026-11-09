import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryTypes, type Transaction } from "sequelize";
import { Room, RoomUser } from "../../room.js";
import { RoomMusic } from "../../music/room-music.js";
import { SqlMusicRoomStore } from "../../music/room-music-storage.js";
import { musicRoomModels } from "../../models/music-room.js";
import { MusicImports } from "../../music/imports.js";
import tokens from "../../auth/tokens.js";
import { QueueMode, Role } from "ott-common/models/types.js";
import { RoomRequestType } from "ott-common/models/messages.js";
import permissions from "ott-common/permissions.js";
import {
	captureError,
	createFixture,
	entry,
	page,
	reference,
	waitForLock,
} from "./music-fixture.js";

describe("real PostgreSQL Room persistence", () => {
	let f: Awaited<ReturnType<typeof createFixture>>;
	let store: SqlMusicRoomStore;
	beforeEach(async () => {
		f = await createFixture();
		store = new SqlMusicRoomStore(() => f.connection);
		for (const id of ["durable-a", "durable-b", "durable-c"]) {
			await f.catalogue.addLibraryTrack(1, { reference: reference(id) });
		}
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await f?.cleanup();
	});
	const engine = (name = "durable", connection = f.connection, catalogue = f.catalogue) =>
		new RoomMusic(
			name,
			() => ["account:1"],
			async () => undefined,
			catalogue,
			new SqlMusicRoomStore(() => connection),
		);
	const playing = async () => {
		const room = engine();
		await room.refresh(true);
		await room.advance();
		await room.setPlayback({ isPlaying: true });
		return room;
	};

	it("rejects one of two stale writers from independent connections", async () => {
		const room = await playing();
		const b = f.peer();
		const rival = new SqlMusicRoomStore(() => b.connection);
		const aValue = (await store.load("durable"))!,
			bValue = (await rival.load("durable"))!;
		expect(aValue).toEqual(bValue);
		const revision = room.state!.revision;
		aValue.state.revision++;
		bValue.state.revision++;
		const outcomes = await Promise.allSettled([
			store.save(aValue, revision),
			rival.save(bValue, revision),
		]);
		expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.filter(result => result.status === "rejected")).toMatchObject([
			{ reason: { message: expect.stringContaining("revision conflict") } },
		]);
		expect((await rival.load("durable"))!.state.history.events).toHaveLength(1);
		expect(await musicRoomModels(b.connection).Event.count()).toBe(1);
	});

	it("loads coherent finalized snapshot, normalized history and scores after a real lock wait", async () => {
		await playing();
		const b = f.peer(),
			observer = f.peer();
		const before = (await store.load("durable"))!;
		const value = structuredClone(before);
		value.state.revision++;
		const finalized = structuredClone(value);
		finalized.state.history.events[0].startedAt += 123;
		finalized.playback.playbackPosition = 23;
		let release!: () => void, staged!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		const entered = new Promise<void>(resolve => {
			staged = resolve;
		});
		let calls = 0;
		const saving = store.save(value, before.state.revision, {
			authorize: async () => {
				if (++calls === 2) {
					staged();
					await gate;
				}
			},
			finalize: () => finalized,
		});
		const saveOutcome = captureError(saving);
		let loading: ReturnType<SqlMusicRoomStore["load"]> | undefined;
		try {
			await Promise.race([entered, saving]);
			loading = new SqlMusicRoomStore(() => b.connection).load("durable");
			await waitForLock(observer.connection, f.schema);
		} finally {
			release();
		}
		expect(await saveOutcome).toBeUndefined();
		expect(await loading).toEqual(finalized);
		const rows = musicRoomModels(b.connection);
		expect((await rows.Event.findOne())!.get().event).toEqual(
			finalized.state.history.events[0],
		);
		expect((await rows.Score.findOne())!.get().plays).toBe(1);
		const restarted = engine("durable", b.connection, b.catalogue);
		await restarted.initialize();
		await restarted.setPlayback({ isPlaying: true });
		expect(restarted.state!.history.events).toHaveLength(1);
		expect(restarted.state!.history.scores).toEqual(before.state.history.scores);
		expect(restarted.state!.current!.playbackId).toBe(before.state.current!.playbackId);
	});

	it("enforces actual 5s lock/10s statement settings and rolls back a revoked save hook", async () => {
		await playing();
		const b = f.peer();
		const before = (await store.load("durable"))!;
		const value = structuredClone(before);
		value.state.revision++;
		const blocker = await b.connection.transaction();
		let rolledBack = false,
			allowed = true,
			calls = 0;
		const observed: unknown[] = [];
		let savingTransaction: Transaction | undefined;
		f.connection.addHook("afterQuery", "music-settings", options => {
			if (options.transaction) {
				savingTransaction = options.transaction;
			}
		});
		await musicRoomModels(b.connection).State.findByPk("durable", {
			transaction: blocker,
			lock: blocker.LOCK.UPDATE,
		});
		const saving = store.save(value, before.state.revision, {
			authorize: () => {
				calls++;
				if (!allowed) {
					throw new Error("synthetic revoked grant");
				}
			},
		});
		const outcome = captureError(saving);
		try {
			await waitForLock(b.connection, f.schema);
			const active = await b.connection.query<{ pid: number }>(
				"SELECT pid FROM pg_stat_activity WHERE application_name = :application AND wait_event_type = 'Lock'",
				{ replacements: { application: f.schema }, type: QueryTypes.SELECT },
			);
			expect(active).toHaveLength(1);
			allowed = false;
			await blocker.rollback();
			rolledBack = true;
			expect(await outcome).toMatchObject({ message: "synthetic revoked grant" });
			expect(calls).toBe(2);
			expect(await store.load("durable")).toEqual(before);
			// Read the settings on the exact connection currently in the store transaction.
			await store.save(value, before.state.revision, {
				authorize: async () => {
					observed.push(
						(
							await f.connection.query(
								"SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement",
								{ transaction: savingTransaction, type: QueryTypes.SELECT },
							)
						)[0],
					);
				},
			});
			expect(observed).toEqual([
				{ lock: "5s", statement: "10s" },
				{ lock: "5s", statement: "10s" },
			]);
		} finally {
			f.connection.removeHook("afterQuery", "music-settings");
			if (!rolledBack) {
				await blocker.rollback();
			}
			await outcome;
		}
	});

	it("rechecks Room grants after an actual CAS wait and publishes no revoked playback", async () => {
		const b = f.peer();
		vi.spyOn(tokens, "getSessionInfo").mockResolvedValue({ isLoggedIn: true, user_id: 1 });
		const room = new Room(
			{ name: "auth-wait", queueMode: QueueMode.Music },
			{ catalogue: f.catalogue, store },
		);
		room.throttledSync.cancel();
		room.throttledSync = vi.fn() as unknown as typeof room.throttledSync;
		vi.spyOn(room, "publish").mockResolvedValue(undefined);
		vi.spyOn(room, "command").mockResolvedValue(undefined);
		const user = new RoomUser("synthetic-tab", "synthetic-token");
		user.user_id = 1;
		room.realusers.push(user);
		room.grants.setRoleGrants(Role.RegisteredUser, permissions.parseIntoGrantMask(["*"]));
		await room.musicEngine.refresh(true);
		await room.dequeueNext();
		const before = (await store.load(room.name))!;
		const published = vi.mocked(room.publish).mock.calls.length;
		const blocker = await b.connection.transaction();
		await musicRoomModels(b.connection).State.findByPk(room.name, {
			transaction: blocker,
			lock: blocker.LOCK.UPDATE,
		});
		const action = room.processRequest(
			{ type: RoomRequestType.PlaybackRequest, state: true },
			{ clientId: user.id, role: Role.RegisteredUser, username: "synthetic" },
		);
		const outcome = captureError(action);
		try {
			await waitForLock(b.connection, f.schema);
			room.grants.setRoleGrants(Role.RegisteredUser, 0);
		} finally {
			await blocker.rollback();
		}
		expect(await outcome).toBeInstanceOf(Error);
		expect(await store.load(room.name)).toEqual(before);
		expect(room.isPlaying).toBe(false);
		expect(room.musicState!.history.events).toHaveLength(0);
		expect(vi.mocked(room.publish).mock.calls).toHaveLength(published);
		room.saveStateToRedisDebounced.cancel();
	});

	it("aborts a real blocked CAS at the store's five-second PostgreSQL lock timeout", async () => {
		await playing();
		const b = f.peer();
		const before = (await store.load("durable"))!;
		const draft = structuredClone(before);
		draft.state.revision++;
		const blocker = await b.connection.transaction();
		await musicRoomModels(b.connection).State.findByPk("durable", {
			transaction: blocker,
			lock: blocker.LOCK.UPDATE,
		});
		const started = performance.now();
		try {
			const outcome = captureError(store.save(draft, before.state.revision));
			await waitForLock(b.connection, f.schema);
			expect(await outcome).toMatchObject({ original: { code: "55P03" } });
			expect(performance.now() - started).toBeGreaterThanOrEqual(4500);
			expect(performance.now() - started).toBeLessThan(10000);
		} finally {
			await blocker.rollback();
		}
		expect(await store.load("durable")).toEqual(before);
	});

	it("rolls back failed normalized writes without publishing or spending a play, then retries once", async () => {
		const room = engine();
		await room.refresh(true);
		await room.advance();
		const before = (await store.load("durable"))!;
		await f.connection.query(
			"CREATE FUNCTION reject_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic event failure'; END $$",
		);
		await f.connection.query(
			'CREATE TRIGGER reject_event BEFORE INSERT ON "MusicRoomEvents" FOR EACH ROW EXECUTE FUNCTION reject_event()',
		);
		await expect(room.setPlayback({ isPlaying: true })).rejects.toThrow(
			"synthetic event failure",
		);
		expect(room.state).toEqual(before.state);
		expect(await store.load("durable")).toEqual(before);
		expect(await musicRoomModels(f.connection).Event.count()).toBe(0);
		await f.connection.query('DROP TRIGGER reject_event ON "MusicRoomEvents"');
		await f.connection.query("DROP FUNCTION reject_event()");
		await room.setPlayback({ isPlaying: true });
		await room.setPlayback({ isPlaying: true });
		expect(await musicRoomModels(f.connection).Event.count()).toBe(1);
		expect(room.state!.history.scores[0].plays).toBe(1);
	});

	it("refuses to reset normalized debt if its durable snapshot is missing", async () => {
		await playing();
		await musicRoomModels(f.connection).State.destroy({ where: { roomId: "durable" } });
		const b = f.peer();
		await expect(new SqlMusicRoomStore(() => b.connection).load("durable")).rejects.toThrow(
			"refusing to reset",
		);
		expect(await musicRoomModels(b.connection).Event.count()).toBe(1);
		expect((await musicRoomModels(b.connection).Score.findOne())!.get().plays).toBe(1);
	});

	it.each(["account:2", "guest:retained"])(
		"restores nonlibrary manual availability by durable fingerprints for %s",
		async identity => {
			const b = f.peer();
			let now = 1000000;
			vi.spyOn(Date, "now").mockImplementation(() => now);
			const { track } = await f.catalogue.resolveTrack(reference("manual-only"));
			await f.models.TrackSource.update(
				{ availability: "unavailable" },
				{ where: { trackId: track.id } },
			);
			const first = new RoomMusic(
				"manual-restart",
				() => [identity],
				async () => undefined,
				f.catalogue,
				store,
			);
			await first.refresh();
			await first.execute(
				{
					action: "request",
					expectedRevision: first.state!.revision,
					requestId: "manual",
					correlationId: "manual",
					reference: reference("manual-only"),
					intent: "mix",
				},
				identity,
			);
			expect(first.state!.requests[0].status).toBe("pending");
			const restarted = new RoomMusic(
				"manual-restart",
				() => [identity],
				async () => undefined,
				b.catalogue,
				new SqlMusicRoomStore(() => b.connection),
			);
			await restarted.refresh();
			const before = await b.catalogue.roomTrackVersions([track.id]);
			const imports = new MusicImports(
				() => f.connection,
				f.catalogue,
				async () => page(entry("manual-only")),
				() => now,
			);
			const source = await imports.create(1, { reference: reference("PLrestore") });
			await imports.run(1, source.id);
			await imports.step();
			expect(await b.catalogue.roomTrackVersions([track.id])).not.toBe(before);
			expect(await b.catalogue.roomVersions([2])).toBe("2:0");
			expect(await b.models.UserLibraryTrack.count({ where: { userId: 2 } })).toBe(0);
			now += 6000;
			await restarted.refresh();
			expect(restarted.state!.requests[0]).toMatchObject({
				status: "admitted",
				candidate: { sourceUsable: true },
			});
			expect(restarted.state!.candidates).toHaveLength(0);
		},
	);
});
