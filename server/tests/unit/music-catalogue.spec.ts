import { randomUUID } from "node:crypto";
import { mkdtemp, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sequelize, DataTypes } from "sequelize";
import { DEFAULT_MOODS, MOOD_ICON_KEYS } from "ott-common/models/music.js";
import {
	AddLibraryTrackSchema,
	MusicCatalogue,
	MusicReferenceSchema,
	subscribeCatalogueChanges,
} from "../../music/catalogue.js";
import InfoExtract from "../../infoextractor.js";
import { createMusicModels } from "../../models/music.js";
import { createCatalogueFixture, migration } from "./music-test-helpers.js";

vi.mock("../../infoextractor.js", () => ({
	default: {
		getVideoInfo: vi.fn(),
		getServiceAdapterForURL: vi.fn(),
	},
}));

describe("Persistent music catalogue", () => {
	let fixture: Awaited<ReturnType<typeof createCatalogueFixture>>;
	const reference = { reference: { service: "youtube" as const, id: "recording-a" } };
	beforeEach(async () => {
		fixture = await createCatalogueFixture();
	});

	it("retains metadata, library, tags and favorites after reopening SQLite", async () => {
		const directory = await mkdtemp(join(tmpdir(), "undertone-catalogue-"));
		const storage = join(directory, "catalogue.sqlite");
		const persistent = await createCatalogueFixture(storage);
		let reopened: Sequelize | undefined;
		let originalClosed = false;
		try {
			const track = await persistent.catalogue.addLibraryTrack(1, reference);
			await persistent.models.Track.update(
				{ artists: ["Artist A", "Artist B"], styles: ["ambient"] },
				{ where: { id: track.id } },
			);
			await persistent.catalogue.setTrackMood(1, track.id, DEFAULT_MOODS[0].id, true);
			await persistent.catalogue.setFavorite(1, DEFAULT_MOODS[1].id, true);
			await persistent.connection.close();
			originalClosed = true;
			reopened = new Sequelize({ dialect: "sqlite", storage, logging: false });
			const models = createMusicModels(reopened);
			const catalogue = new MusicCatalogue(
				() => reopened!,
				() => models,
				persistent.resolver,
			);
			expect((await catalogue.listLibrary(1)).items[0].track).toMatchObject({
				id: track.id,
				artists: ["Artist A", "Artist B"],
				styles: ["ambient"],
				duration: 180,
			});
			expect((await catalogue.listTrackMoods(1, track.id)).items[0].id).toBe(
				DEFAULT_MOODS[0].id,
			);
			expect((await catalogue.listFavorites(1)).items[0].id).toBe(DEFAULT_MOODS[1].id);
		} finally {
			if (!originalClosed) {
				await persistent.connection.close();
			}
			await reopened?.close();
			await unlink(storage);
			await rmdir(directory);
		}
	});
	afterEach(async () => {
		await fixture.connection.close();
	});

	it("migrates seeded defaults and rolls back without changing legacy data", async () => {
		const { models, connection, User } = fixture;
		const CachedVideo = connection.define("CachedVideo", { title: DataTypes.STRING });
		await CachedVideo.sync();
		await CachedVideo.create({ title: "Cached only" });
		expect((await fixture.catalogue.listLibrary(1)).total).toBe(0);
		const moods = await models.Mood.findAll({ order: [["id", "ASC"]] });
		expect(
			moods.map(row => {
				const { id, name, normalizedName, iconKey } = row.get();
				return { id, name, normalizedName, iconKey };
			}),
		).toEqual(DEFAULT_MOODS);
		expect(moods.every(row => MOOD_ICON_KEYS.includes(row.get().iconKey))).toBe(true);
		await migration.down(connection.getQueryInterface());
		expect(await User.count()).toBe(2);
		expect(await CachedVideo.count()).toBe(1);
		await migration.up(connection.getQueryInterface(), Sequelize);
		expect(await models.Mood.count()).toBe(5);
		expect(await models.UserLibraryTrack.count()).toBe(0);
	});

	it("keeps adapter identity when providers resolve to changing direct-stream aliases", async () => {
		const { connection, models } = fixture;
		const catalogue = new MusicCatalogue(
			() => connection,
			() => models,
		);
		vi.mocked(InfoExtract.getServiceAdapterForURL).mockReturnValue({
			serviceId: "invidious",
			isCollectionURL: () => false,
			getVideoId: () => "music.example:recording-a",
		} as unknown as ReturnType<typeof InfoExtract.getServiceAdapterForURL>);
		vi.mocked(InfoExtract.getVideoInfo)
			.mockResolvedValueOnce({ service: "direct", id: "https://stream.example/a?token=one" })
			.mockResolvedValueOnce({ service: "direct", id: "https://stream.example/a?token=two" })
			.mockResolvedValueOnce({
				service: "direct",
				id: "https://stream.example/a?token=three",
			});
		const a = await catalogue.resolveTrack({
			url: "https://music.example/watch?v=recording-a",
		});
		const b = await catalogue.resolveTrack({
			service: "invidious",
			id: "music.example:recording-a",
		});
		expect(a.track.id).toBe(b.track.id);
		expect(a.source).toMatchObject({
			service: "invidious",
			providerId: "music.example:recording-a",
		});
		expect(a.track.title).toBe("Untitled track");
		const playable = await catalogue.toQueueItem(a.track.id, a.source.id);
		expect(playable.id).toBe("https://stream.example/a?token=three");
		expect(InfoExtract.getVideoInfo).toHaveBeenLastCalledWith(
			"invidious",
			"music.example:recording-a",
		);
		expect(await models.Track.count()).toBe(1);
	});

	it("rolls back a partial source import and a partial migration", async () => {
		const { catalogue, models, connection, User } = fixture;
		const failedImport = vi
			.spyOn(models.TrackSource, "findOrCreate")
			.mockRejectedValueOnce(new Error("Injected write failure"));
		await expect(catalogue.resolveTrack(reference.reference)).rejects.toThrow("Injected");
		failedImport.mockRestore();
		expect(await models.Track.count()).toBe(0);
		await migration.down(connection.getQueryInterface());
		const queryInterface = connection.getQueryInterface();
		const failedMigration = vi
			.spyOn(queryInterface, "addIndex")
			.mockRejectedValueOnce(new Error("Injected migration failure"));
		await expect(migration.up(queryInterface, Sequelize)).rejects.toThrow("Injected");
		failedMigration.mockRestore();
		expect(await queryInterface.showAllTables()).toEqual(["Users"]);
		expect(await User.count()).toBe(2);
	});

	it("deduplicates concurrent imports, URLs and users by canonical source, never title", async () => {
		const { catalogue, models } = fixture;
		const [a, b, c] = await Promise.all([
			catalogue.addLibraryTrack(1, reference),
			catalogue.addLibraryTrack(1, reference),
			catalogue.addLibraryTrack(2, { url: "https://youtube.com/watch?v=recording-a" }),
		]);
		expect(a.id).toBe(b.id);
		expect(a.id).toBe(c.id);
		expect(await models.Track.count()).toBe(1);
		expect(await models.TrackSource.count()).toBe(1);
		expect(await models.UserLibraryTrack.count()).toBe(2);
		const other = await catalogue.addLibraryTrack(1, {
			reference: { service: "youtube", id: "live-version" },
		});
		expect(other.title).toBe(a.title);
		expect(other.id).not.toBe(a.id);
		expect(await models.UserTrackMood.count()).toBe(0);
	});

	it("keeps libraries, tags and favorites independent and scoped to each user", async () => {
		const { catalogue, models } = fixture;
		const track = await catalogue.addLibraryTrack(1, reference);
		const [focus, happy] = [DEFAULT_MOODS[1].id, DEFAULT_MOODS[3].id];
		await catalogue.setFavorite(1, focus, true);
		await catalogue.setFavorite(1, focus, true);
		expect((await catalogue.listTrackMoods(1, track.id)).total).toBe(0);
		await catalogue.setTrackMood(1, track.id, focus, true);
		await catalogue.setTrackMood(1, track.id, focus, true);
		await catalogue.setTrackMood(2, track.id, happy, true);
		expect((await catalogue.listLibrary(2)).total).toBe(0);
		expect((await catalogue.listFavorites(2)).total).toBe(0);
		await catalogue.setFavorite(1, focus, false);
		await catalogue.removeLibraryTrack(1, track.id);
		await catalogue.setTrackMood(2, track.id, focus, false);
		expect((await catalogue.listTrackMoods(1, track.id)).items.map(m => m.id)).toEqual([focus]);
		expect((await catalogue.listTrackMoods(2, track.id)).items.map(m => m.id)).toEqual([happy]);
		expect(await models.Track.count()).toBe(1);
		expect(await models.UserTrackMood.count()).toBe(2);
	});

	it("normalizes shared names and retains the existing identity and icon", async () => {
		const { catalogue } = fixture;
		const [a, b] = await Promise.all([
			catalogue.createMood(1, { name: "  ＤＲＥＡＭＹ　 night  ", iconKey: "moon" }),
			catalogue.createMood(2, { name: "dreamy   NIGHT", iconKey: "sun" }),
		]);
		expect(a.id).toBe(b.id);
		expect(a.normalizedName).toBe("dreamy night");
		expect(b.iconKey).toBe("moon");
		const focus = await catalogue.createMood(2, { name: "FOCUS", iconKey: "moon" });
		expect(focus.id).toBe(DEFAULT_MOODS[1].id);
		expect(focus.iconKey).toBe("headphones");
		await expect(
			catalogue.createMood(1, { name: "bad", iconKey: "../../disk.svg" }),
		).rejects.toThrow();
		await expect(catalogue.createMood(1, { name: "  ", iconKey: "moon" })).rejects.toThrow();
	});

	it("notifies actual mutations after commit, without favorite or no-op invalidations", async () => {
		const { catalogue, models } = fixture;
		const received: string[] = [];
		const unsubscribe = subscribeCatalogueChanges(async event => {
			if (event.kind === "library" && event.action === "added") {
				expect(await models.UserLibraryTrack.count()).toBe(1);
			}
			received.push(`${event.kind}:${event.action}`);
		});
		try {
			const track = await catalogue.addLibraryTrack(1, reference);
			await catalogue.addLibraryTrack(1, reference);
			await catalogue.setTrackMood(1, track.id, DEFAULT_MOODS[0].id, true);
			await catalogue.setTrackMood(1, track.id, DEFAULT_MOODS[0].id, true);
			await catalogue.setFavorite(1, DEFAULT_MOODS[0].id, true);
			await expect(catalogue.setTrackMood(1, track.id, randomUUID(), true)).rejects.toThrow(
				"Mood not found",
			);
			await catalogue.setTrackMood(1, track.id, DEFAULT_MOODS[0].id, false);
			await catalogue.removeLibraryTrack(1, track.id);
			await catalogue.removeLibraryTrack(1, track.id);
			expect(received).toEqual([
				"library:added",
				"annotation:added",
				"annotation:removed",
				"library:removed",
			]);
		} finally {
			unsubscribe();
		}
	});

	it("preserves track annotations across equivalent sources and all legacy playback options", async () => {
		const { catalogue, models } = fixture;
		const { track, source } = await catalogue.resolveTrack(reference.reference);
		await catalogue.setTrackMood(1, track.id, DEFAULT_MOODS[0].id, true);
		const alternateId = randomUUID();
		// Explicit equivalence is a trusted server decision, not title matching or a REST mutation.
		await models.TrackSource.create({
			...source,
			id: alternateId,
			service: "direct",
			providerId: "https://media.example/music.mp3",
		});
		const options = {
			startAt: 10,
			endAt: 35,
			subtitleUrl: "https://media.example/selected.vtt",
		};
		const a = await catalogue.toQueueItem(track.id, source.id, options);
		const b = await catalogue.toQueueItem(track.id, alternateId, options);
		expect(a).toMatchObject({
			...options,
			trackId: track.id,
			sourceId: source.id,
			id: reference.reference.id,
		});
		expect(b).toMatchObject({
			...options,
			trackId: track.id,
			sourceId: alternateId,
			service: "direct",
			src_url: "https://media.example/stream",
		});
		expect((await catalogue.listTrackMoods(1, b.trackId)).items[0].id).toBe(
			DEFAULT_MOODS[0].id,
		);
		await expect(catalogue.toQueueItem(randomUUID(), source.id)).rejects.toThrow();
		await models.TrackSource.update(
			{ availability: "unavailable" },
			{ where: { id: source.id } },
		);
		await expect(catalogue.toQueueItem(track.id, source.id)).rejects.toThrow();
	});

	it("enforces DB uniqueness and foreign keys even outside the service", async () => {
		const { catalogue, models, User } = fixture;
		const { track, source } = await catalogue.resolveTrack(reference.reference);
		await expect(models.TrackSource.create({ ...source, id: randomUUID() })).rejects.toThrow();
		await expect(
			models.UserTrackMood.create({
				userId: 999,
				trackId: track.id,
				moodId: DEFAULT_MOODS[0].id,
			}),
		).rejects.toThrow();
		await catalogue.setTrackMood(1, track.id, DEFAULT_MOODS[0].id, true);
		await catalogue.setFavorite(1, DEFAULT_MOODS[0].id, true);
		await User.destroy({ where: { id: 1 } });
		expect(await models.UserTrackMood.count()).toBe(0);
		expect(await models.UserFavoriteMood.count()).toBe(0);
		expect(await models.Track.count()).toBe(1);
	});

	it("rejects disk references and bounds paging while omitting provider references", async () => {
		for (const input of [
			{ url: "file:///C:/private.mp3" },
			{ reference: { service: "direct", id: "C:\\private.mp3" } },
			{ reference: { service: "direct", id: "file:///tmp/private.mp3" } },
		]) {
			expect(AddLibraryTrackSchema.safeParse(input).success).toBe(false);
		}
		for (const reference of [
			{ service: "pluto", id: "movies/movie-id" },
			{ service: "reddit", id: "abc123" },
			{ service: "odysee", id: "lbry://@channel#abc/song#123" },
		]) {
			expect(MusicReferenceSchema.safeParse(reference).success).toBe(true);
		}
		const { catalogue } = fixture;
		await catalogue.addLibraryTrack(1, reference);
		const page = await catalogue.listLibrary(1, { limit: 1 });
		expect(page.total).toBe(1);
		expect(page.items[0].sources[0]).not.toHaveProperty("providerId");
		await expect(catalogue.listLibrary(1, { limit: 101 })).rejects.toThrow();
		await expect(catalogue.listMoods({ offset: -1 })).rejects.toThrow();
	});
});
