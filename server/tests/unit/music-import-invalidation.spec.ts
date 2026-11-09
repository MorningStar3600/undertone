/* eslint-disable vitest/no-conditional-in-test -- Parameterized metadata and occurrence scenarios share setup and assertions. */
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Sequelize } from "sequelize";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCatalogueFixture } from "./music-test-helpers.js";
import { MusicImports } from "../../music/imports.js";
import { musicImportModels } from "../../models/music-imports.js";
import { MusicCatalogue, subscribeCatalogueChanges } from "../../music/catalogue.js";
import { createMusicModels } from "../../models/music.js";
import { musicRoomModels } from "../../models/music-room.js";
import { RoomMusic } from "../../music/room-music.js";
import { SqlMusicRoomStore } from "../../music/room-music-storage.js";
import type { CatalogueChange } from "ott-common/models/music.js";
import { DEFAULT_MOODS } from "ott-common/models/music.js";
import type { CollectionPage } from "../../serviceadapter.js";

vi.mock("../../infoextractor.js", () => ({ default: {} }));
const migration = createRequire(import.meta.url)(
	"../../migrations/20261109220000-create-music-imports.js",
);
describe("shared import metadata serialization and durable occurrence invalidation", () => {
	let f: Awaited<ReturnType<typeof createCatalogueFixture>>;
	let now: number;
	const reference = (id: string) => ({ service: "youtube" as const, id });
	const entry = (id: string, title = "Same title") => ({
		reference: reference(id),
		video: {
			...reference(id),
			title,
			length: 180,
			thumbnail: "https://media.example/cover.jpg",
		},
	});
	const page = (...entries: CollectionPage["entries"]): CollectionPage => ({
		entries,
		unavailable: 0,
		nextCursor: null,
	});
	const revisions = async (ids = [1, 2, 3, 4]) =>
		new Map(
			(await f.catalogue.roomVersions(ids))
				.split(",")
				.map(x => x.split(":").map(Number) as [number, number]),
		);
	const importer = (result: CollectionPage) =>
		new MusicImports(
			() => f.connection,
			f.catalogue,
			async () => result,
			() => now,
		);
	async function run(imports: MusicImports, userId = 1, id = "PLcorrection") {
		const source = await imports.create(userId, { reference: reference(id) });
		await imports.run(userId, source.id);
		await imports.step();
		return source;
	}
	beforeEach(async () => {
		f = await createCatalogueFixture();
		await f.User.bulkCreate([{ id: 3 }, { id: 4 }]);
		await migration.up(f.connection.getQueryInterface(), Sequelize);
		now = 1000000;
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await f.connection.close();
	});

	it("deduplicates all actual owner-track changes and advances only each affected user once", async () => {
		const x = await f.catalogue.addLibraryTrack(1, { reference: reference("x") });
		await f.catalogue.addLibraryTrack(2, { trackId: x.id });
		await f.catalogue.addLibraryTrack(3, { trackId: x.id });
		const y = await f.catalogue.addLibraryTrack(2, { reference: reference("y") });
		await f.catalogue.addLibraryTrack(3, { trackId: y.id });
		await f.catalogue.addLibraryTrack(4, { reference: reference("unrelated") });
		const before = await revisions();
		const notices: CatalogueChange[] = [];
		const stop = subscribeCatalogueChanges(change => {
			notices.push(change);
		});
		try {
			await run(
				importer(
					page(
						entry("x", "Changed x"),
						entry("x", "Changed x"),
						entry("y", "Changed y"),
						entry("new"),
					),
				),
			);
			const after = await revisions();
			for (const id of [1, 2, 3]) {
				expect(after.get(id)).toBe(before.get(id)! + 1);
			}
			expect(after.get(4)).toBe(before.get(4));
			expect(notices).toHaveLength(7);
			expect(
				notices.filter(x => x.kind === "library").map(x => [x.userId, x.trackId]),
			).toEqual(expect.arrayContaining([[1, y.id]]));
			expect(notices.filter(x => x.kind === "library")).toHaveLength(2);
			expect(
				notices
					.filter(x => x.kind === "metadata")
					.map(x => `${x.userId}:${x.trackId}`)
					.sort(),
			).toEqual([`1:${x.id}`, `2:${x.id}`, `3:${x.id}`, `2:${y.id}`, `3:${y.id}`].sort());
			expect(
				notices.every(x => Object.keys(x).sort().join() === "action,kind,trackId,userId"),
			).toBe(true);
		} finally {
			stop();
		}
	});

	it.each(["title", "thumbnail", "length"] as const)(
		"detects %s changes with existing importer membership and suppresses exact repeats",
		async field => {
			const track = await f.catalogue.addLibraryTrack(1, { reference: reference("shared") });
			await f.catalogue.addLibraryTrack(2, { trackId: track.id });
			const changed = entry("shared");
			if (field === "title") {
				changed.video.title = "Changed";
			}
			if (field === "thumbnail") {
				changed.video.thumbnail = "https://media.example/new.jpg";
			}
			if (field === "length") {
				changed.video.length = 181;
			}
			const before = await revisions();
			const notices: CatalogueChange[] = [];
			const stop = subscribeCatalogueChanges(change => {
				notices.push(change);
			});
			try {
				const imports = importer(page(changed));
				const source = await run(imports);
				expect(notices.map(x => [x.kind, x.userId]).sort()).toEqual([
					["metadata", 1],
					["metadata", 2],
				]);
				const after = await revisions();
				for (const id of [1, 2]) {
					expect(after.get(id)).toBe(before.get(id)! + 1);
				}
				notices.length = 0;
				await imports.run(1, source.id);
				await imports.step();
				expect(await revisions()).toEqual(after);
				expect(notices).toHaveLength(0);
			} finally {
				stop();
			}
		},
	);

	it("compares sanitized values and preserves known duration on an invalid refresh", async () => {
		const first = entry("sanitize", "https://media.invalid/?signature=synthetic-one");
		first.video.thumbnail = "invalid-artwork-one";
		await run(importer(page(first)));
		const before = await revisions();
		const second = entry("sanitize", "https://media.invalid/?signature=synthetic-two");
		second.video.thumbnail = "invalid-artwork-two";
		second.video.length = NaN;
		const notices: CatalogueChange[] = [];
		const stop = subscribeCatalogueChanges(change => {
			notices.push(change);
		});
		try {
			await run(importer(page(second)), 1, "PLsanitize");
			expect(await revisions()).toEqual(before);
			expect(notices).toHaveLength(0);
			expect((await f.catalogue.listLibrary(1)).items[0].track).toMatchObject({
				title: "Untitled track",
				duration: 180,
				artworkUrl: null,
			});
		} finally {
			stop();
		}
	});

	it("recomputes recipients after an actual SQL rollback and invokes listeners after full commit outside the lock", async () => {
		const track = await f.catalogue.addLibraryTrack(2, { reference: reference("retry") });
		const before = await revisions();
		const imports = importer(page(entry("retry", "Changed on retry")));
		const source = await imports.create(1, { reference: reference("PLretry") });
		await imports.run(1, source.id);
		await f.connection.query(
			"CREATE TRIGGER reject_review_page BEFORE INSERT ON \"MusicImportProvenance\" BEGIN SELECT RAISE(ABORT, 'review page rollback'); END",
		);
		const notices: CatalogueChange[] = [];
		const committed: unknown[] = [];
		const stop = subscribeCatalogueChanges(async change => {
			notices.push(change);
			const snapshot = await f.catalogue.roomSnapshot([1, 3]);
			committed.push({
				titles: snapshot.tracks.map(t => t.title),
				source: (await imports.getSource(1, source.id)).lastJob,
				provenance: await musicImportModels(f.connection).Provenance.count(),
			});
		});
		try {
			await imports.step();
			expect(await revisions()).toEqual(before);
			expect(notices).toHaveLength(0);
			expect((await f.catalogue.getTrack(track.id)).title).toBe("Same title");
			expect((await imports.getSource(1, source.id)).lastJob).toMatchObject({
				pages: 0,
				processed: 0,
				added: 0,
			});
			await f.connection.query("DROP TRIGGER reject_review_page");
			// Use real membership changes between the rolled-back attempt and retry.
			await f.catalogue.removeLibraryTrack(2, track.id);
			await f.catalogue.addLibraryTrack(3, { trackId: track.id });
			notices.length = 0;
			committed.length = 0;
			now += 30001;
			await imports.step();
			expect(notices.map(x => [x.kind, x.userId]).sort()).toEqual([
				["library", 1],
				["metadata", 3],
			]);
			expect(committed).toHaveLength(2);
			for (const observed of committed) {
				expect(observed).toMatchObject({
					titles: ["Changed on retry"],
					source: { status: "succeeded", pages: 1, processed: 1, added: 1 },
					provenance: 1,
				});
			}
		} finally {
			stop();
		}
	});

	it("serializes reversed multi-entry SQLite imports, including a new shared identity, with atomic owner versions", async () => {
		const directory = await mkdtemp("../node_modules/.cache/import-concurrent-");
		const a = await createCatalogueFixture(join(directory, "review.sqlite"));
		let b: Sequelize | undefined;
		try {
			await migration.up(a.connection.getQueryInterface(), Sequelize);
			const track = await a.catalogue.addLibraryTrack(1, {
				reference: reference("concurrent"),
			});
			await a.catalogue.addLibraryTrack(2, { trackId: track.id });
			const second = await a.catalogue.addLibraryTrack(1, {
				reference: reference("concurrent-second"),
			});
			await a.catalogue.addLibraryTrack(2, { trackId: second.id });
			b = new Sequelize({
				dialect: "sqlite",
				storage: join(directory, "review.sqlite"),
				logging: false,
			});
			const bConnection = b;
			const bModels = createMusicModels(b);
			const bCatalogue = new MusicCatalogue(
				() => bConnection,
				() => bModels,
			);
			let fetched = 0;
			let release!: () => void;
			const gate = new Promise<void>(resolve => {
				release = resolve;
			});
			const fetch =
				(title: string, reverse = false) =>
				async () => {
					if (++fetched === 2) {
						release();
					}
					await gate;
					const entries = [
						entry("concurrent", title),
						entry("new-race", title),
						entry("concurrent-second", title),
					];
					return page(...(reverse ? entries.reverse() : entries));
				};
			const i1 = new MusicImports(
				() => a.connection,
				a.catalogue,
				fetch("Concurrent A"),
				() => now,
			);
			const i2 = new MusicImports(
				() => bConnection,
				bCatalogue,
				fetch("Concurrent B", true),
				() => now,
			);
			const s1 = await i1.create(1, { reference: reference("PLconcurrentA") });
			const s2 = await i2.create(2, { reference: reference("PLconcurrentB") });
			await i1.run(1, s1.id);
			await i2.run(2, s2.id);
			await Promise.all([i1.step(), i2.step()]);
			expect(await a.catalogue.roomVersions([1, 2])).toBe("1:4,2:4");
			expect(await a.models.Track.count()).toBe(3);
			expect(await a.models.TrackSource.count()).toBe(3);
			expect(await a.models.UserLibraryTrack.count()).toBe(6);
			expect(new Set((await a.models.Track.findAll()).map(row => row.get().title)).size).toBe(
				1,
			);
			expect((await i1.getSource(1, s1.id)).lastJob?.status).toBe("succeeded");
			expect((await i2.getSource(2, s2.id)).lastJob?.status).toBe("succeeded");
		} finally {
			await b?.close();
			await a.connection.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each(["account:2", "guest:manual-guest"])(
		"restores an unavailable retained manual request for %s without library membership",
		async identity => {
			vi.spyOn(Date, "now").mockImplementation(() => now);
			const { track } = await f.catalogue.resolveTrack(reference("manual-only"));
			await f.models.TrackSource.update(
				{ availability: "unavailable" },
				{ where: { trackId: track.id } },
			);
			const room = new RoomMusic(
				"manual-import-recheck",
				() => [identity],
				async () => undefined,
				f.catalogue,
				new SqlMusicRoomStore(() => f.connection),
			);
			await room.refresh(true);
			await room.execute(
				{
					action: "request",
					expectedRevision: room.state!.revision,
					requestId: "manual-review",
					correlationId: "manual-review",
					reference: reference("manual-only"),
					intent: "mix",
				},
				identity,
			);
			const request = () => room.state!.requests.find(r => r.requestId === "manual-review")!;
			now += 6000;
			await room.refresh();
			expect(request().status).toBe("pending");
			expect(request().candidate.sourceUsable).toBe(false);
			expect(await f.models.UserLibraryTrack.count({ where: { userId: 2 } })).toBe(0);
			const before = await f.catalogue.roomVersions([2]);
			const fingerprint = await f.catalogue.roomTrackVersions([track.id]);
			const snapshot = vi.spyOn(f.catalogue, "roomSnapshot");
			await run(importer(page(entry("unrelated"))), 1, "PLunrelated");
			now += 6000;
			await room.refresh();
			expect(snapshot).not.toHaveBeenCalled();
			expect(await f.catalogue.roomTrackVersions([track.id])).toBe(fingerprint);
			const notices: CatalogueChange[] = [];
			const stop = subscribeCatalogueChanges(change => {
				notices.push(change);
				room.invalidate(change.userId);
			});
			try {
				await run(importer(page(entry("manual-only"))));
			} finally {
				stop();
			}
			expect(notices.map(x => [x.kind, x.userId])).toEqual([["library", 1]]);
			expect(await f.catalogue.roomVersions([2])).toBe(before);
			expect(await f.catalogue.roomTrackVersions([track.id])).not.toBe(fingerprint);
			expect(
				(await f.models.TrackSource.findOne({ where: { trackId: track.id } }))!.get()
					.availability,
			).toBe("available");
			now += 6000;
			await room.refresh();
			const afterPolling = request().status;
			// The durable track fingerprint converges without a forced context or owner notification.
			expect(request().status).toBe("admitted");
			expect(
				afterPolling,
				`contributor version before=${before}, after=${await f.catalogue.roomVersions([2])}`,
			).toBe("admitted");
		},
	);

	// PostgreSQL lock protocol exercised against an adapter, with real SQLite changes injected
	// at the row-lock wait. This deliberately is NOT a live PostgreSQL concurrency test.
	it.each(["metadata", "availability"])(
		"rereads shared %s after a simulated PostgreSQL row-lock wait",
		async change => {
			const track = await f.catalogue.addLibraryTrack(1, {
				reference: reference("lock-shared"),
			});
			await f.catalogue.addLibraryTrack(2, { trackId: track.id });
			const pg = new Sequelize({ dialect: "postgres", logging: false });
			const queries = vi.spyOn(pg, "query").mockResolvedValue([] as never);
			const version = musicRoomModels(f.connection).Version;
			vi.spyOn(musicRoomModels(pg).Version, "findOrCreate").mockImplementation(
				version.findOrCreate.bind(version),
			);
			vi.spyOn(musicRoomModels(pg).Version, "increment").mockImplementation(
				version.increment.bind(version),
			);
			const catalogue = new MusicCatalogue(
				() => pg,
				() => f.models,
				f.resolver,
			);
			const find = f.models.Track.findByPk.bind(f.models.Track);
			let waited = false;
			vi.spyOn(f.models.Track, "findByPk").mockImplementation(async (id, options) => {
				if (options?.lock && !waited) {
					waited = true;
					// Another transaction has committed since storeResolved's initial M0 reads.
					if (change === "metadata") {
						await f.models.Track.update(
							{ title: "M1" },
							{ where: { id: String(id) }, transaction: options.transaction },
						);
					} else {
						await f.models.TrackSource.update(
							{ availability: "unavailable" },
							{ where: { trackId: String(id) }, transaction: options.transaction },
						);
					}
					await version.increment("revision", {
						where: { userId: [1, 2] },
						transaction: options.transaction,
					});
				}
				return find(id, options);
			});
			try {
				const result = await f.connection.transaction(transaction =>
					catalogue.importReferences(1, [entry("lock-shared")], transaction),
				);
				expect(waited).toBe(true);
				expect((await f.catalogue.getTrack(track.id)).title).toBe("Same title");
				expect(
					(await f.models.TrackSource.findOne({ where: { trackId: track.id } }))!.get()
						.availability,
				).toBe("available");
				expect(await f.catalogue.roomVersions([1, 2])).toBe("1:3,2:3");
				expect(result.changes.map(change => [change.kind, change.userId])).toEqual([
					["metadata", 1],
					["metadata", 2],
				]);
				expect(queries.mock.calls[0][0]).toBe(
					"SELECT pg_advisory_xact_lock(:namespace, :identity)",
				);
			} finally {
				await pg.close();
			}
		},
	);

	it("locks absent identities and aliased multi-track pages in the same order, without noop writes", async () => {
		const x = await f.catalogue.addLibraryTrack(1, { reference: reference("order-x") });
		const y = await f.catalogue.addLibraryTrack(1, { reference: reference("order-y") });
		const original = (await f.models.TrackSource.findOne({ where: { trackId: x.id } }))!.get();
		await f.models.TrackSource.create({
			...original,
			id: "00000000-0000-4000-8000-000000000099",
			providerId: "order-alias",
		});
		const pg = new Sequelize({ dialect: "postgres", logging: false });
		const query = vi.spyOn(pg, "query").mockResolvedValue([] as never);
		const version = musicRoomModels(f.connection).Version;
		vi.spyOn(musicRoomModels(pg).Version, "findOrCreate").mockImplementation(
			version.findOrCreate.bind(version),
		);
		vi.spyOn(musicRoomModels(pg).Version, "increment").mockImplementation(
			version.increment.bind(version),
		);
		const catalogue = new MusicCatalogue(
			() => pg,
			() => f.models,
			f.resolver,
		);
		const trackRead = vi.spyOn(f.models.Track, "findByPk");
		const sourceRead = vi.spyOn(f.models.TrackSource, "findByPk");
		const identityRead = vi.spyOn(f.models.TrackSource, "findOne");
		const updateTrack = vi.spyOn(f.models.Track, "update");
		const updateSource = vi.spyOn(f.models.TrackSource, "update");
		const entries = [
			entry("order-x"),
			entry("order-y"),
			entry("order-new"),
			entry("order-alias"),
			entry("order-x"),
		];
		try {
			const result = await f.connection.transaction(transaction =>
				catalogue.importReferences(1, entries, transaction),
			);
			const identities = query.mock.calls.map(call => call[1]!.replacements);
			expect(identities).toHaveLength(4);
			expect(Math.max(...query.mock.invocationCallOrder)).toBeLessThan(
				Math.min(...identityRead.mock.invocationCallOrder),
			);
			const lockedTracks = trackRead.mock.calls
				.filter(call => call[1]?.lock)
				.map(call => String(call[0]));
			const lockedSources = sourceRead.mock.calls
				.filter(call => call[1]?.lock)
				.map(call => String(call[0]));
			expect(lockedTracks).toEqual([...new Set(result.trackIds)].sort());
			expect(lockedTracks).toContain(x.id);
			expect(lockedTracks).toContain(y.id);
			expect(lockedSources).toEqual([...new Set(lockedSources)].sort());
			expect(lockedSources).toHaveLength(4);
			expect(
				trackRead.mock.calls
					.filter(call => call[1]?.lock)
					.every(call => call[1]!.lock === "NO KEY UPDATE"),
			).toBe(true);
			expect(updateTrack).not.toHaveBeenCalled();
			expect(updateSource).not.toHaveBeenCalled();
			query.mockClear();
			trackRead.mockClear();
			sourceRead.mockClear();
			const before = await f.catalogue.roomVersions([1]);
			const replay = await f.connection.transaction(transaction =>
				catalogue.importReferences(1, [...entries].reverse(), transaction),
			);
			expect(query.mock.calls.map(call => call[1]!.replacements)).toEqual(identities);
			expect(
				trackRead.mock.calls.filter(call => call[1]?.lock).map(call => String(call[0])),
			).toEqual(lockedTracks);
			expect(replay.changes).toHaveLength(0);
			expect(await f.catalogue.roomVersions([1])).toBe(before);
			expect(updateTrack).not.toHaveBeenCalled();
			expect(updateSource).not.toHaveBeenCalled();
		} finally {
			await pg.close();
		}
	});

	it("reopens a guest's retained request and polls another connection without hooks or memberships", async () => {
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const directory = await mkdtemp("../node_modules/.cache/import-room-restart-");
		const storage = join(directory, "test.sqlite");
		const a = await createCatalogueFixture(storage);
		let b: Sequelize | undefined;
		try {
			await migration.up(a.connection.getQueryInterface(), Sequelize);
			const { track } = await a.catalogue.resolveTrack(reference("restart-manual"));
			await a.models.TrackSource.update(
				{ availability: "unavailable" },
				{ where: { trackId: track.id } },
			);
			const room = new RoomMusic(
				"restart-import",
				() => ["guest:retained"],
				async () => undefined,
				a.catalogue,
				new SqlMusicRoomStore(() => a.connection),
			);
			await room.refresh();
			await room.execute(
				{
					action: "request",
					expectedRevision: room.state!.revision,
					requestId: "restart-request",
					correlationId: "restart-request",
					reference: reference("restart-manual"),
					intent: "mix",
				},
				"guest:retained",
			);
			await a.connection.close();
			b = new Sequelize({ dialect: "sqlite", storage, logging: false });
			const connection = b;
			const models = createMusicModels(connection);
			const catalogue = new MusicCatalogue(
				() => connection,
				() => models,
				a.resolver,
			);
			const restored = new RoomMusic(
				"restart-import",
				() => ["guest:retained"],
				async () => undefined,
				catalogue,
				new SqlMusicRoomStore(() => connection),
			);
			await restored.refresh();
			expect(restored.state!.requests[0].status).toBe("pending");
			const remote = new Sequelize({ dialect: "sqlite", storage, logging: false });
			try {
				const remoteModels = createMusicModels(remote);
				const remoteCatalogue = new MusicCatalogue(
					() => remote,
					() => remoteModels,
					a.resolver,
				);
				await run(
					new MusicImports(
						() => remote,
						remoteCatalogue,
						async () => page(entry("restart-manual")),
						() => now,
					),
				);
				now += 6000;
				await restored.refresh();
				expect(restored.state!.requests[0]).toMatchObject({
					status: "admitted",
					candidate: { sourceUsable: true, contributorId: "guest:retained" },
				});
				expect(restored.state!.candidates).toHaveLength(0);
				expect(restored.state!.queue.some(entry => entry.trackId === track.id)).toBe(true);
				expect(await catalogue.roomVersions([2])).toBe("2:0");
			} finally {
				await remote.close();
			}
		} finally {
			await b?.close();
			await a.connection.close().catch(() => undefined);
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each(["queued", "current", "departed"])(
		"polls shared metadata for a nonlibrary guest's %s occurrence",
		async position => {
			vi.spyOn(Date, "now").mockImplementation(() => now);
			let people = ["guest:occurrence", "account:2"];
			const room = new RoomMusic(
				"occurrence-versions",
				() => people,
				async () => undefined,
				f.catalogue,
				new SqlMusicRoomStore(() => f.connection),
			);
			await room.refresh();
			await room.execute(
				{
					action: "settings",
					expectedRevision: room.state!.revision,
					correlationId: "settings",
					settings: { removeDepartedEntries: false },
				},
				"guest:occurrence",
			);
			await room.execute(
				{
					action: "request",
					expectedRevision: room.state!.revision,
					requestId: "occurrence",
					correlationId: "occurrence",
					reference: reference("occurrence"),
					intent: "mix",
					extras: { startAt: 12, endAt: 60 },
				},
				"guest:occurrence",
			);
			const trackId = room.state!.requests[0].candidate.trackId;
			if (position === "current") {
				await room.advance();
			}
			if (position === "departed") {
				people = ["account:2"];
			}
			room.invalidate(2);
			await room.refresh();
			const before = room.state!;
			const snapshot = vi.spyOn(f.catalogue, "roomSnapshot");
			await run(importer(page(entry("occurrence", "Fresh shared title"))));
			now += 6000;
			await room.refresh();
			expect(snapshot.mock.calls.some(call => call[1]?.includes(trackId))).toBe(true);
			expect(room.state!.candidates).toHaveLength(0);
			expect(await f.models.UserLibraryTrack.count({ where: { userId: 2 } })).toBe(0);
			if (position === "current") {
				expect(room.state!.current!.playbackId).toBe(before.current!.playbackId);
			} else {
				expect(room.state!.queue[0].mediaRef).toMatchObject({
					title: "Fresh shared title",
					startAt: 12,
					endAt: 60,
				});
				expect(room.state!.queue[0].entryId).toBe(before.queue[0].entryId);
			}
			expect(room.state!.history).toEqual(before.history);
		},
	);

	it("fingerprints only durable public metadata, independent of ID order and personal data", async () => {
		const x = await f.catalogue.addLibraryTrack(1, { reference: reference("fingerprint-x") });
		const y = await f.catalogue.addLibraryTrack(1, { reference: reference("fingerprint-y") });
		const before = await f.catalogue.roomTrackVersions([x.id, y.id]);
		expect(await f.catalogue.roomTrackVersions([y.id, x.id, x.id])).toBe(before);
		await f.catalogue.addLibraryTrack(2, { trackId: x.id });
		await f.catalogue.setTrackMood(1, x.id, DEFAULT_MOODS[0].id, true);
		await f.catalogue.setFavorite(1, DEFAULT_MOODS[1].id, true);
		await f.models.Track.update({ title: x.title }, { where: { id: x.id } });
		expect(await f.catalogue.roomTrackVersions([x.id, y.id])).toBe(before);
		await f.models.TrackSource.update(
			{ capabilities: { seek: false, backgroundPlayback: "unknown" } },
			{ where: { trackId: x.id } },
		);
		expect(await f.catalogue.roomTrackVersions([x.id, y.id])).not.toBe(before);
		const snapshot = await f.catalogue.roomSnapshot([1], [x.id, y.id]);
		expect(snapshot.trackVersions).toBe(await f.catalogue.roomTrackVersions([x.id, y.id]));
	});
});
