import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sequelize } from "sequelize";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCatalogueFixture } from "./music-test-helpers.js";
import {
	MusicImports,
	IMPORT_DAY,
	IMPORT_LEASE,
	type ImportPageProvider,
} from "../../music/imports.js";
import { musicImportModels } from "../../models/music-imports.js";
import { createMusicModels } from "../../models/music.js";
import { MusicCatalogue, subscribeCatalogueChanges } from "../../music/catalogue.js";
import type { CollectionPage } from "../../serviceadapter.js";
import { DEFAULT_MOODS, type CatalogueChange } from "ott-common/models/music.js";
import { createImportWorker } from "../../music/import-worker.js";
import { RoomMusic } from "../../music/room-music.js";
import { SqlMusicRoomStore } from "../../music/room-music-storage.js";

vi.mock("../../infoextractor.js", () => ({ default: {} }));
const PRIVATE_REPORT_FIELDS = /private URL|providerId|cursor|leaseToken|key/;
const migration = createRequire(import.meta.url)(
	"../../migrations/20261109220000-create-music-imports.js",
);
const page = (
	ids: string[],
	nextCursor: string | null = null,
	unavailable = 0,
): CollectionPage => ({
	entries: ids.map(id => ({
		reference: { service: "youtube", id },
		video: {
			service: "direct",
			id: "https://temporary.example/?private=secret",
			title: "Same title",
			length: 180,
		},
	})),
	nextCursor,
	unavailable,
});

describe("durable playlist reference imports", () => {
	let f: Awaited<ReturnType<typeof createCatalogueFixture>>;
	let imports: MusicImports;
	let now: number;
	let fetchPage: ReturnType<
		typeof vi.fn<Parameters<ImportPageProvider>, ReturnType<ImportPageProvider>>
	>;
	beforeEach(async () => {
		f = await createCatalogueFixture();
		await migration.up(f.connection.getQueryInterface(), Sequelize);
		now = 1000000;
		fetchPage = vi.fn<Parameters<ImportPageProvider>, ReturnType<ImportPageProvider>>(
			async () => page(["recording-a"]),
		);
		imports = new MusicImports(
			() => f.connection,
			f.catalogue,
			fetchPage,
			() => now,
		);
	});
	afterEach(async () => {
		await f.connection.close();
		vi.restoreAllMocks();
	});
	const register = () => ({ reference: { service: "youtube", id: "PLexample" } });
	it.each(["metadata", "availability"])(
		"refreshes every owner's room after shared %s changes",
		async change => {
			vi.spyOn(Date, "now").mockImplementation(() => now);
			const track = await f.catalogue.addLibraryTrack(2, {
				reference: { service: "youtube", id: "recording-a" },
			});
			await f.models.TrackSource.update(
				{ availability: change === "availability" ? "unavailable" : "available" },
				{ where: { trackId: track.id } },
			);
			const room = new RoomMusic(
				"other-owner",
				() => ["account:2"],
				async () => undefined,
				f.catalogue,
				new SqlMusicRoomStore(() => f.connection),
			);
			await room.refresh(true);
			const before = await f.catalogue.roomVersions([2]);
			const updated = page(["recording-a"]);
			updated.entries[0].video.title = change === "metadata" ? "Updated title" : "Same title";
			updated.entries[0].video.thumbnail = "https://media.example/cover.jpg";
			fetchPage.mockResolvedValue(updated);
			const source = await imports.create(1, register());
			await imports.run(1, source.id);
			const notices: CatalogueChange[] = [];
			const stop = subscribeCatalogueChanges(event => {
				notices.push(event);
			});
			try {
				await imports.step();
				expect(await f.catalogue.roomVersions([2])).not.toBe(before);
				expect(notices).toContainEqual({
					kind: "metadata",
					userId: 2,
					trackId: track.id,
					action: "updated",
				});
				expect(notices).toContainEqual({
					kind: "library",
					userId: 1,
					trackId: track.id,
					action: "added",
				});
				expect(notices).toHaveLength(2);
				// No local notification subscription: another monolith observes the durable version.
				now += 6000;
				await room.refresh();
				expect(room.state!.candidates).toHaveLength(1);
				expect(room.state!.candidates[0].mediaRef).toMatchObject({
					title: updated.entries[0].video.title,
				});
				const versions = await f.catalogue.roomVersions([1, 2]);
				notices.length = 0;
				await imports.run(1, source.id);
				await imports.step();
				expect(await f.catalogue.roomVersions([1, 2])).toBe(versions);
				expect(notices).toHaveLength(0);
			} finally {
				stop();
			}
		},
	);
	it("rolls back shared metadata and all owner versions before notifying a committed retry", async () => {
		const track = await f.catalogue.addLibraryTrack(2, {
			reference: { service: "youtube", id: "recording-a" },
		});
		const before = await f.catalogue.roomVersions([1, 2]);
		const updated = page(["recording-a"]);
		updated.entries[0].video.title = "Updated title";
		fetchPage.mockResolvedValue(updated);
		const source = await imports.create(1, register());
		await imports.run(1, source.id);
		vi.spyOn(musicImportModels(f.connection).Provenance, "upsert").mockRejectedValueOnce(
			new Error("rollback page"),
		);
		const notices: CatalogueChange[] = [];
		const stop = subscribeCatalogueChanges(event => {
			notices.push(event);
		});
		try {
			await imports.step();
			expect(await f.catalogue.roomVersions([1, 2])).toBe(before);
			expect((await f.catalogue.getTrack(track.id)).title).toBe("Same title");
			expect(notices).toHaveLength(0);
			now += IMPORT_LEASE;
			await imports.step();
			expect(await f.catalogue.roomVersions([1, 2])).not.toBe(before);
			expect((await f.catalogue.getTrack(track.id)).title).toBe("Updated title");
			expect(notices.map(event => event.userId).sort()).toEqual([1, 2]);
		} finally {
			stop();
		}
	});
	it("starts idle, paginates beyond fifty, deduplicates reruns and retains disappeared tracks and annotations", async () => {
		expect(await imports.step()).toBe(false);
		expect(fetchPage).not.toHaveBeenCalled();
		const source = await imports.create(1, register());
		expect(
			(await imports.create(1, { url: "https://www.youtube.com/playlist?list=PLexample" }))
				.id,
		).toBe(source.id);
		fetchPage
			.mockResolvedValueOnce(
				page(
					Array.from({ length: 50 }, (_, i) => `video-${i}`),
					"second",
				),
			)
			.mockResolvedValueOnce(page(["last", "last"]));
		const job = await imports.run(1, source.id);
		expect((await imports.run(1, source.id)).id).toBe(job.id);
		await imports.step();
		now += 5000;
		await imports.step();
		expect(fetchPage.mock.calls[1][1]).toBe("second");
		expect((await imports.getSource(1, source.id)).lastJob).toMatchObject({
			status: "succeeded",
			added: 51,
			existing: 1,
			processed: 52,
			pages: 2,
		});
		const track = (await f.catalogue.listLibrary(1)).items[0].track;
		await f.catalogue.setTrackMood(1, track.id, DEFAULT_MOODS[0].id, true);
		await f.catalogue.setFavorite(1, DEFAULT_MOODS[1].id, true);
		fetchPage.mockResolvedValue(page(["last", "new"]));
		await imports.run(1, source.id);
		await imports.step();
		expect((await imports.getSource(1, source.id)).lastJob).toMatchObject({
			added: 1,
			existing: 1,
		});
		expect(await f.models.UserLibraryTrack.count()).toBe(52);
		expect(await f.models.UserTrackMood.count()).toBe(1);
		expect(await f.models.UserFavoriteMood.count()).toBe(1);
		expect(await musicImportModels(f.connection).Provenance.count()).toBe(52);
		expect((await f.models.TrackSource.findOne())?.get().providerId).not.toContain("temporary");
		expect((await imports.sources(2, {})).total).toBe(0);
	});
	it("commits cursor, provenance, catalogue version and library together, with postcommit notification", async () => {
		const source = await imports.create(1, register());
		await imports.run(1, source.id);
		const models = musicImportModels(f.connection);
		vi.spyOn(models.Provenance, "upsert").mockRejectedValueOnce(new Error("SQL failure"));
		await imports.step();
		expect(await f.models.Track.count()).toBe(0);
		expect((await imports.getSource(1, source.id)).lastJob).toMatchObject({
			processed: 0,
			pages: 0,
			error: "storage",
			failures: 1,
		});
		expect(await f.catalogue.roomVersions([1])).toBe("1:0");
		const seen: string[] = [];
		const stop = subscribeCatalogueChanges(async event => {
			if (event.kind === "library") {
				expect(await models.Provenance.count()).toBe(1);
				seen.push(event.trackId);
			}
		});
		try {
			now += IMPORT_LEASE;
			await imports.step();
		} finally {
			stop();
		}
		expect(seen).toHaveLength(1);
		expect(await f.catalogue.roomVersions([1])).toBe("1:1");
	});
	it("persists partial availability and sanitized transient failures without claiming full sync", async () => {
		const source = await imports.create(1, register());
		await imports.run(1, source.id);
		fetchPage
			.mockResolvedValueOnce(page(["first"], "continue", 2))
			.mockRejectedValueOnce(new Error("private URL and key provider body"));
		await imports.step();
		now += 5000;
		await imports.step();
		const waiting = await imports.getSource(1, source.id);
		expect(waiting.lastJob).toMatchObject({
			status: "queued",
			pages: 1,
			failures: 1,
			retryCount: 1,
			error: "provider",
			added: 1,
			unavailable: 2,
		});
		expect(JSON.stringify(waiting)).not.toMatch(PRIVATE_REPORT_FIELDS);
		expect(await imports.step()).toBe(false);
		now += 30000;
		fetchPage.mockResolvedValueOnce(page(["second"]));
		await imports.step();
		expect(fetchPage.mock.calls.at(-1)?.[1]).toBe("continue");
		expect(await imports.getSource(1, source.id)).toMatchObject({
			lastSuccessAt: null,
			lastCompletionAt: now,
			lastJob: { status: "partial", processed: 4, added: 2, unavailable: 2, failures: 1 },
		});
	});
	it("bounds retry/backoff, resumes manual retry and schedules sequentially from success", async () => {
		const source = await imports.create(1, register());
		await imports.run(1, source.id);
		fetchPage.mockRejectedValue(new Error("unavailable"));
		for (let i = 0; i < 5; i++) {
			await imports.step();
			now += 3600000;
		}
		expect((await imports.getSource(1, source.id)).lastJob).toMatchObject({
			status: "failed",
			failures: 5,
		});
		expect(await imports.step()).toBe(false);
		fetchPage.mockResolvedValue(page(["recovered"]));
		await imports.run(1, source.id);
		await imports.schedule(1, source.id, true);
		await imports.step();
		expect(await imports.getSource(1, source.id)).toMatchObject({
			lastSuccessAt: now,
			nextRunAt: now + IMPORT_DAY,
		});
		now += IMPORT_DAY - 1;
		expect(await imports.step()).toBe(false);
		now++;
		await imports.step();
		expect((await imports.jobs(1, source.id, {})).total).toBe(2);
		await imports.schedule(1, source.id, false);
		now += IMPORT_DAY;
		expect(await imports.step()).toBe(false);
	});
	it("cancels in-flight results and soft-removes a source without removing library data", async () => {
		const source = await imports.create(1, register());
		await imports.run(1, source.id);
		await imports.step();
		await imports.run(1, source.id);
		let release!: (page: CollectionPage) => void;
		let started!: () => void;
		const ready = new Promise<void>(resolve => {
			started = resolve;
		});
		fetchPage.mockImplementationOnce(() => {
			started();
			return new Promise<CollectionPage>(resolve => {
				release = resolve;
			});
		});
		const work = imports.step();
		await ready;
		await imports.cancel(1, source.id, true);
		release(page(["must-not-commit"]));
		await work;
		expect(await f.models.Track.count()).toBe(1);
		expect(await imports.getSource(1, source.id)).toMatchObject({
			removed: true,
			daily: false,
			lastJob: { status: "cancelled" },
		});
		await expect(imports.run(1, source.id)).rejects.toThrow();
		expect((await imports.create(1, register())).removed).toBe(false);
	});
	it("migrates and reopens real SQLite; distinct connections fence expired workers and replay durable cursor", async () => {
		const directory = await mkdtemp(join(tmpdir(), "undertone-imports-"));
		const storage = join(directory, "test.sqlite");
		const persistent = await createCatalogueFixture(storage);
		let reopened: Sequelize | undefined;
		try {
			await migration.up(persistent.connection.getQueryInterface(), Sequelize);
			const first = new MusicImports(
				() => persistent.connection,
				persistent.catalogue,
				async () => page(["one"], "saved"),
				() => now,
			);
			const source = await first.create(1, register());
			await first.run(1, source.id);
			await first.step();
			await persistent.connection.close();
			reopened = new Sequelize({ dialect: "sqlite", storage, logging: false });
			const connection = reopened;
			const catalogue = new MusicCatalogue(
				() => connection,
				() => createMusicModelsOnce,
			);
			const createMusicModelsOnce = createMusicModels(connection);
			const secondConnection = new Sequelize({ dialect: "sqlite", storage, logging: false });
			try {
				const secondModels = createMusicModels(secondConnection);
				const otherCatalogue = new MusicCatalogue(
					() => secondConnection,
					() => secondModels,
				);
				let release!: (page: CollectionPage) => void;
				let started!: () => void;
				const ready = new Promise<void>(resolve => {
					started = resolve;
				});
				const stale = new MusicImports(
					() => connection,
					catalogue,
					async (_id, cursor) => {
						expect(cursor).toBe("saved");
						started();
						return new Promise(resolve => {
							release = resolve;
						});
					},
					() => now,
				);
				const freshProvider = vi.fn(async (_id, cursor) => {
					expect(cursor).toBe("saved");
					return page(["two"]);
				});
				const fresh = new MusicImports(
					() => secondConnection,
					otherCatalogue,
					freshProvider,
					() => now,
				);
				now += 5000;
				const oldWork = stale.step();
				await ready;
				expect(await fresh.step()).toBe(false);
				now += IMPORT_LEASE;
				await fresh.step();
				release(page(["stale"]));
				await oldWork;
				expect((await fresh.getSource(1, source.id)).lastJob).toMatchObject({
					pages: 2,
					added: 2,
					status: "succeeded",
				});
				expect(await secondModels.Track.count()).toBe(2);
				await fresh.run(1, source.id);
				freshProvider.mockImplementation(async () => page(["two"]));
				const contender = new MusicImports(
					() => connection,
					catalogue,
					freshProvider,
					() => now,
				);
				await Promise.all([fresh.step(), contender.step()]);
				expect((await fresh.getSource(1, source.id)).lastJob?.pages).toBe(1);
			} finally {
				await secondConnection.close();
			}
			await migration.down(connection.getQueryInterface());
			expect(await createMusicModelsOnce.Track.count()).toBe(2);
		} finally {
			await reopened?.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("stops and aborts the sequential worker without creating an unhandled loop", async () => {
		const source = await imports.create(1, register());
		await imports.run(1, source.id);
		let started!: () => void;
		const ready = new Promise<void>(resolve => {
			started = resolve;
		});
		fetchPage.mockImplementationOnce(
			(_id, _cursor, signal: AbortSignal) =>
				new Promise((_resolve, reject) => {
					started();
					signal.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		);
		const worker = createImportWorker(imports);
		worker.start();
		await ready;
		await worker.stop();
		expect(fetchPage).toHaveBeenCalledTimes(1);
		expect((await imports.getSource(1, source.id)).lastJob?.processed).toBe(0);
	});
});
