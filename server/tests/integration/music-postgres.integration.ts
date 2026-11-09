import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QueryTypes, Sequelize } from "sequelize";
import { MusicImports } from "../../music/imports.js";
import { musicImportModels } from "../../models/music-imports.js";
import { musicRoomModels } from "../../models/music-room.js";
import {
	createFixture,
	entry,
	migration,
	page,
	reference,
	settle,
	waitForLock,
} from "./music-fixture.js";

const ANNOTATIONS_QUERY = /FROM (?:"[^"]+"\.)?"UserTrackMoods"/;

describe("real PostgreSQL migrations and catalogue imports", () => {
	let f: Awaited<ReturnType<typeof createFixture>>;
	beforeEach(async () => {
		f = await createFixture();
	});
	afterEach(async () => {
		await f?.cleanup();
	});

	it("applies every discovered migration in filename order; failed DDL rolls back and music tables reapply", async () => {
		expect(f.migrations.length).toBeGreaterThanOrEqual(22);
		expect(f.migrations).toEqual([...f.migrations].sort());
		const tables = async () =>
			(
				await f.connection.query<{ table_name: string }>(
					"SELECT t.table_name FROM information_schema.tables AS t WHERE table_schema = :schema ORDER BY table_name",
					{ replacements: { schema: f.schema }, type: QueryTypes.SELECT },
				)
			).map(row => row.table_name);
		expect(await tables()).toEqual(
			expect.arrayContaining([
				"Rooms",
				"Users",
				"Tracks",
				"MusicRoomStates",
				"MusicImportProvenance",
			]),
		);
		const imports = migration("20261109220000-create-music-imports.js");
		await imports.down(f.connection.getQueryInterface());
		await f.connection.query('CREATE TABLE "MusicImportJobs" (sentinel integer)');
		await expect(imports.up(f.connection.getQueryInterface(), Sequelize)).rejects.toThrow();
		expect(await tables()).not.toContain("MusicImportSources");
		expect(await tables()).not.toContain("MusicImportProvenance");
		await f.connection.query('DROP TABLE "MusicImportJobs"');
		await imports.up(f.connection.getQueryInterface(), Sequelize);
		const rooms = migration("20261109200000-create-music-rooms.js");
		await rooms.down(f.connection.getQueryInterface());
		await rooms.up(f.connection.getQueryInterface(), Sequelize);
		const { track } = await f.catalogue.resolveTrack(reference("constraints"));
		await expect(
			f.models.UserLibraryTrack.create({
				userId: 999,
				trackId: track.id,
				importKind: "reference",
			}),
		).rejects.toThrow();
		await f.catalogue.addLibraryTrack(1, { trackId: track.id });
		await expect(
			f.models.UserLibraryTrack.create({
				userId: 1,
				trackId: track.id,
				importKind: "reference",
			}),
		).rejects.toThrow();
		expect(await f.models.UserLibraryTrack.count()).toBe(1);
	});

	it("serializes absent provider identities across independent pools and reversed pages", async () => {
		const b = f.peer();
		await b.connection.authenticate();
		const t = await f.connection.transaction();
		let committed = false;
		const entries = [entry("race-new-a"), entry("race-new-b"), entry("race-new-a")];
		let pending: Promise<unknown> | undefined;
		try {
			await f.catalogue.importReferences(1, entries, t);
			pending = b.connection.transaction(tx =>
				b.catalogue.importReferences(2, [...entries].reverse(), tx),
			);
			// Attach rejection immediately, including timeout/deadlock failures.
			const outcome = settle(pending);
			await waitForLock(f.connection, f.schema);
			await t.commit();
			committed = true;
			expect(await outcome).not.toHaveProperty("error");
			expect(await f.models.Track.count()).toBe(2);
			expect(await f.models.TrackSource.count()).toBe(2);
			expect(await f.models.UserLibraryTrack.count()).toBe(4);
			expect(await b.catalogue.roomVersions([1, 2])).toBe("1:1,2:1");
		} finally {
			if (!committed) {
				await t.rollback();
			}
			await pending?.catch(() => undefined);
		}
	});

	it("locks shared tracks reached by different aliases in cross order without deadlock or noop writes", async () => {
		const b = f.peer();
		const x = await f.catalogue.addLibraryTrack(1, { reference: reference("alias-x") });
		const y = await f.catalogue.addLibraryTrack(1, { reference: reference("alias-y") });
		for (const [id, track] of [
			["other-x", x],
			["other-y", y],
		] as const) {
			const original = (await f.models.TrackSource.findOne({
				where: { trackId: track.id },
			}))!.get();
			await f.models.TrackSource.create({
				...original,
				id: crypto.randomUUID(),
				providerId: id,
			});
		}
		await f.catalogue.addLibraryTrack(2, { trackId: x.id });
		await f.catalogue.addLibraryTrack(2, { trackId: y.id });
		const before = await f.models.Track.findAll({ order: [["id", "ASC"]], raw: true });
		const versions = await f.catalogue.roomVersions([1, 2]);
		const results = await Promise.all([
			f.connection.transaction(t =>
				f.catalogue.importReferences(1, [entry("alias-x"), entry("other-y")], t),
			),
			b.connection.transaction(t =>
				b.catalogue.importReferences(2, [entry("alias-y"), entry("other-x")], t),
			),
		]);
		expect(results.flatMap(result => result.changes)).toEqual([]);
		expect(await f.catalogue.roomVersions([1, 2])).toBe(versions);
		expect(await f.models.Track.findAll({ order: [["id", "ASC"]], raw: true })).toEqual(before);
	});

	it.each(["metadata", "availability"])(
		"rechecks stale M0 after an actual row-lock wait for %s and bumps both owners",
		async change => {
			const b = f.peer();
			const track = await f.catalogue.addLibraryTrack(1, { reference: reference("shared") });
			await f.catalogue.addLibraryTrack(2, { trackId: track.id });
			const t = await b.connection.transaction();
			let committed = false;
			let pending: Promise<unknown> | undefined;
			try {
				await b.models.Track.findByPk(track.id, {
					transaction: t,
					lock: t.LOCK.NO_KEY_UPDATE,
				});
				if (change === "metadata") {
					await b.models.Track.update(
						{ title: "M1" },
						{ where: { id: track.id }, transaction: t },
					);
				} else {
					await b.models.TrackSource.update(
						{ availability: "unavailable" },
						{ where: { trackId: track.id }, transaction: t },
					);
				}
				await musicRoomModels(b.connection).Version.increment("revision", {
					where: { userId: [1, 2] },
					transaction: t,
				});
				pending = f.connection.transaction(tx =>
					f.catalogue.importReferences(1, [entry("shared")], tx),
				);
				const outcome = settle(pending);
				await waitForLock(b.connection, f.schema);
				await t.commit();
				committed = true;
				expect(await outcome).toMatchObject({
					value: {
						changes: expect.arrayContaining([
							expect.objectContaining({ kind: "metadata", userId: 1 }),
							expect.objectContaining({ kind: "metadata", userId: 2 }),
						]),
					},
				});
				expect((await f.catalogue.getTrack(track.id)).title).toBe("Same title");
				expect(
					(await f.models.TrackSource.findOne({ where: { trackId: track.id } }))!.get()
						.availability,
				).toBe("available");
				expect(await f.catalogue.roomVersions([1, 2])).toBe("1:3,2:3");
				const replay = await f.connection.transaction(tx =>
					f.catalogue.importReferences(1, [entry("shared")], tx),
				);
				expect(replay.changes).toEqual([]);
				expect(await b.catalogue.roomVersions([1, 2])).toBe("1:3,2:3");
			} finally {
				if (!committed) {
					await t.rollback();
				}
				await pending?.catch(() => undefined);
			}
		},
	);

	it("rolls back page metadata, membership, provenance, cursor and versions together, then retries", async () => {
		const b = f.peer();
		const track = await f.catalogue.addLibraryTrack(2, { reference: reference("rollback") });
		const before = await f.catalogue.roomVersions([1, 2]);
		let now = 1000000;
		const imports = new MusicImports(
			() => f.connection,
			f.catalogue,
			async () => ({ ...page(entry("rollback", "Changed")), nextCursor: "page-two" }),
			() => now,
		);
		const source = await imports.create(1, { reference: reference("PLrollback") });
		await imports.run(1, source.id);
		await f.connection.query(
			`CREATE FUNCTION reject_page() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic provenance failure'; END $$`,
		);
		await f.connection.query(
			'CREATE TRIGGER reject_page BEFORE INSERT ON "MusicImportProvenance" FOR EACH ROW EXECUTE FUNCTION reject_page()',
		);
		await imports.step();
		expect(await b.catalogue.roomVersions([1, 2])).toBe(before);
		expect((await b.catalogue.getTrack(track.id)).title).toBe("Same title");
		expect(await b.models.UserLibraryTrack.count({ where: { userId: 1 } })).toBe(0);
		expect(await musicImportModels(b.connection).Provenance.count()).toBe(0);
		expect((await musicImportModels(b.connection).Job.findOne())!.get()).toMatchObject({
			cursor: null,
			pages: 0,
			processed: 0,
			added: 0,
			error: "storage",
		});
		await f.connection.query('DROP TRIGGER reject_page ON "MusicImportProvenance"');
		await f.connection.query("DROP FUNCTION reject_page()");
		now += 30001;
		await imports.step();
		expect(await b.catalogue.roomVersions([1, 2])).toBe("1:1,2:2");
		expect((await b.catalogue.getTrack(track.id)).title).toBe("Changed");
		expect(await musicImportModels(b.connection).Provenance.count()).toBe(1);
		expect((await musicImportModels(b.connection).Job.findOne())!.get()).toMatchObject({
			cursor: "page-two",
			pages: 1,
			processed: 1,
			added: 1,
			error: null,
		});
	});

	it("reads annotations and their version from the same repeatable-read snapshot across a remote commit", async () => {
		const b = f.peer();
		const track = await f.catalogue.addLibraryTrack(1, { reference: reference("consistent") });
		const mood = (await f.models.Mood.findOne())!.get();
		let entered!: () => void,
			release!: () => void,
			paused = false;
		const staged = new Promise<void>(resolve => {
			entered = resolve;
		});
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		f.connection.addHook("afterQuery", "snapshot-barrier", async (_options, query) => {
			if (
				!paused &&
				ANNOTATIONS_QUERY.test((query as unknown as { sql?: string }).sql ?? "")
			) {
				paused = true;
				entered();
				await gate;
			}
		});
		const reading = f.catalogue.roomSnapshot([1]);
		const outcome = settle(reading);
		try {
			await Promise.race([staged, reading]);
			expect(paused).toBe(true);
			await b.catalogue.setTrackMood(1, track.id, mood.id, true);
		} finally {
			release();
			f.connection.removeHook("afterQuery", "snapshot-barrier");
		}
		expect(await outcome).toMatchObject({ value: { tags: [], versions: "1:1" } });
		const next = await f.catalogue.roomSnapshot([1]);
		expect(next.versions).toBe("1:2");
		expect(next.tags).toMatchObject([{ userId: 1, trackId: track.id, moodId: mood.id }]);
	});
});
