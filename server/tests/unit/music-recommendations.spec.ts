import { randomUUID } from "node:crypto";
import { mkdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { DataTypes, Sequelize } from "sequelize";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MOODS, type CatalogueChange } from "ott-common/models/music.js";
import { MusicCatalogue, subscribeCatalogueChanges } from "../../music/catalogue.js";
import { MusicRecommendations } from "../../music/recommendations.js";
import { createMusicModels } from "../../models/music.js";
import { RoomMusic } from "../../music/room-music.js";
import { SqlMusicRoomStore } from "../../music/room-music-storage.js";
import { musicRoomModels } from "../../models/music-room.js";
import {
	createRecommendationFixture,
	recommendationMigration,
} from "./music-recommendations-fixture.js";

vi.mock("../../infoextractor.js", () => ({ default: {} }));
const [LIKE, FOCUS, ENERGY] = DEFAULT_MOODS.map(m => m.id);
describe("explicit anonymous music recommendations", () => {
	let f: Awaited<ReturnType<typeof createRecommendationFixture>>;
	beforeEach(async () => {
		f = await createRecommendationFixture();
	});
	afterEach(async () => {
		await f.connection.close();
	});
	async function track(id = "abcdefghijk", userId = 1, moods = [LIKE]) {
		const t = await f.catalogue.addLibraryTrack(userId, {
			reference: { service: "youtube", id },
		});
		for (const mood of moods) {
			await f.catalogue.setTrackMood(userId, t.id, mood, true);
		}
		return t;
	}
	async function publish(trackId: string, userId = 1, moodIds = [LIKE]) {
		await f.service.publish(userId, trackId, { moodIds });
		return (await f.service.discover(3)).items.find(item => item.track.id === trackId)!;
	}
	it("is private by default; publishes only selected own tags anonymously; withdrawal is immediate and idempotent", async () => {
		const t = await track("abcdefghijk", 1, [LIKE, ENERGY]);
		expect(await f.service.discover(3)).toEqual({ items: [], next: null });
		const p = await publish(t.id);
		expect(p.moods.map(m => m.id)).toEqual([LIKE]);
		expect(await f.service.publication(2, t.id)).toEqual({ eligible: false, moods: [] });
		expect(await f.service.discover(3, { moods: ENERGY })).toEqual({ items: [], next: null });
		await f.service.withdraw(1, t.id);
		await f.service.withdraw(1, t.id);
		expect((await f.service.discover(3)).items).toEqual([]);
		await expect(f.service.adopt(3, p.id, { moodIds: [LIKE] })).rejects.toMatchObject({
			status: 404,
		});
	});
	it("does not join two publishers' annotations; deduplicates tracks only after a whole author matches", async () => {
		const t = await track();
		await f.catalogue.addLibraryTrack(2, { trackId: t.id });
		await f.catalogue.setTrackMood(2, t.id, ENERGY, true);
		await publish(t.id);
		await publish(t.id, 2, [ENERGY]);
		expect((await f.service.discover(3, { moods: `${LIKE},${ENERGY}` })).items).toEqual([]);
		await f.catalogue.setTrackMood(2, t.id, LIKE, true);
		await publish(t.id, 2, [LIKE, ENERGY]);
		const result = await f.service.discover(3, { moods: `${LIKE},${ENERGY}` });
		expect(result.items).toHaveLength(1);
		expect(result.items[0].moods.map(m => m.id)).toEqual([LIKE, ENERGY]);
		expect((await f.service.discover(3)).items).toHaveLength(1);
	});
	it("removes publication consent with an annotation, without silently restoring it on reannotation", async () => {
		const t = await track();
		const p = await publish(t.id);
		await f.catalogue.setTrackMood(1, t.id, LIKE, false);
		expect(await f.recommendations.PublishedMood.count()).toBe(0);
		await f.catalogue.setTrackMood(1, t.id, LIKE, true);
		expect((await f.service.discover(3)).items).toEqual([]);
		await expect(f.service.adopt(3, p.id, { moodIds: [LIKE] })).rejects.toMatchObject({
			status: 404,
		});
	});
	it("rejects invented, foreign, stale and empty publication payloads and nonowner publication attempts", async () => {
		const t = await track();
		for (const payload of [
			{ moodIds: [ENERGY] },
			{ moodIds: [LIKE], userId: 1 },
			{ moodIds: [] },
			{ moodIds: [LIKE, LIKE] },
		]) {
			await expect(f.service.publish(1, t.id, payload)).rejects.toThrow();
		}
		await expect(f.service.publish(2, t.id, { moodIds: [LIKE] })).rejects.toMatchObject({
			status: 404,
		});
		await f.catalogue.addLibraryTrack(2, { trackId: t.id });
		await expect(f.service.publish(2, t.id, { moodIds: [LIKE] })).rejects.toMatchObject({
			status: 400,
		});
		await expect(f.service.adopt(3, randomUUID(), { moodIds: [] })).rejects.toMatchObject({
			status: 404,
		});
		expect(await f.recommendations.Publication.count()).toBe(0);
	});
	it("fails closed for direct/HLS/DASH/local/unknown sources, malformed YouTube identities and unavailable sources", async () => {
		const t = await track();
		for (const service of ["direct", "hls", "dash", "local", "vimeo", "future"]) {
			await f.models.TrackSource.update(
				{ service: service as "youtube" },
				{ where: { trackId: t.id } }
			);
			await expect(f.service.publish(1, t.id, { moodIds: [LIKE] })).rejects.toMatchObject({
				status: 404,
			});
		}
		await f.models.TrackSource.update(
			{ service: "youtube", providerId: "https://x/y" },
			{ where: { trackId: t.id } }
		);
		await expect(f.service.publish(1, t.id, { moodIds: [LIKE] })).rejects.toMatchObject({
			status: 404,
		});
		await f.models.TrackSource.update(
			{ providerId: "abcdefghijk" },
			{ where: { trackId: t.id } }
		);
		const p = await publish(t.id);
		await f.models.TrackSource.update(
			{ availability: "unavailable" },
			{ where: { trackId: t.id } }
		);
		expect((await f.service.discover(3)).items).toEqual([]);
		await expect(f.service.adopt(3, p.id, { moodIds: [] })).rejects.toMatchObject({
			status: 404,
		});
	});
	it("redacts URL metadata and never returns provider identities, artwork, account IDs or unrelated tags", async () => {
		const t = await track();
		await publish(t.id);
		await f.models.Track.update(
			{
				title: "https://private.example/file?signature=secret",
				artworkUrl: "https://private.example/image?signature=secret",
			},
			{ where: { id: t.id } }
		);
		const result = await f.service.discover(3);
		expect(result.items[0].track.title).toBe("Untitled track");
		expect(JSON.stringify(result)).not.toMatch(
			/https:|signature|providerId|userId|artwork|abcdefghijk/
		);
		expect(f.resolver.video).not.toHaveBeenCalled();
	});
	it("uses stable keyset pages without duplicates or skips after adoption and excludes all owned tracks in SQL", async () => {
		for (const id of ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc", "ddddddddddd"]) {
			const t = await track(id);
			await publish(t.id);
		}
		const all = (await f.service.discover(3)).items;
		await f.catalogue.addLibraryTrack(3, { trackId: all[1].track.id });
		const first = await f.service.discover(3, { limit: 1 });
		expect(first.items[0].track.id).toBe(all[0].track.id);
		await f.service.adopt(3, first.items[0].id, { moodIds: [] });
		const rest = await f.service.discover(3, { limit: 2, after: first.next! });
		expect(rest.items.map(p => p.track.id)).toEqual(all.slice(2).map(p => p.track.id));
		expect(rest.next).toBeNull();
		for (const input of [
			{ limit: 51 },
			{ offset: 10000 },
			{ moods: `${LIKE},${LIKE}` },
			{ moods: "bad" },
			{ after: "bad" },
			{ userId: 1 },
		]) {
			await expect(f.service.discover(3, input)).rejects.toThrow();
		}
	});
	it("adopts only explicitly confirmed moods atomically; invalidates durably and notifies after commit exactly once; favorites are independent", async () => {
		const t = await track("abcdefghijk", 1, [LIKE, ENERGY]);
		const p = await publish(t.id, 1, [LIKE, ENERGY]);
		await f.catalogue.setFavorite(3, FOCUS, true);
		const before = await f.catalogue.roomVersions([1, 3]);
		const notices: CatalogueChange[] = [];
		const observed: string[] = [];
		const stop = subscribeCatalogueChanges(async change => {
			notices.push(change);
			observed.push(await f.catalogue.roomVersions([1, 3]));
			expect((await f.catalogue.listLibrary(3)).items).toHaveLength(1);
		});
		try {
			const result = await f.service.adopt(3, p.id, { moodIds: [ENERGY] });
			expect(result).toEqual({ trackId: t.id, inLibrary: true, moodIds: [ENERGY] });
			expect(await f.catalogue.roomVersions([1, 3])).not.toBe(before);
			expect(notices.map(n => [n.kind, n.userId])).toEqual([
				["library", 3],
				["annotation", 3],
			]);
			expect(new Set(observed).size).toBe(1);
			expect(observed[0]).not.toBe(before);
			await f.service.adopt(3, p.id, { moodIds: [LIKE] });
			expect(notices).toHaveLength(2);
			expect((await f.catalogue.listFavorites(3)).items.map(m => m.id)).toEqual([FOCUS]);
			expect(f.resolver.video).not.toHaveBeenCalled();
			expect(await musicRoomModels(f.connection).State.count()).toBe(0);
		} finally {
			stop();
		}
	});
	it("excludes an owned track beyond the first hundred library memberships", async () => {
		const fillers = Array.from({ length: 101 }, () => ({
			id: randomUUID(),
			title: "Own track",
			artists: [],
			styles: [],
			duration: null,
			artworkUrl: null,
		}));
		await f.models.Track.bulkCreate(fillers);
		await f.models.UserLibraryTrack.bulkCreate(
			fillers.map(t => ({ userId: 3, trackId: t.id, importKind: "catalogue" as const }))
		);
		const t = await track();
		await publish(t.id);
		await f.catalogue.addLibraryTrack(3, { trackId: t.id });
		const first = await f.catalogue.listLibrary(3, { limit: 100 });
		expect(first.total).toBe(102);
		expect(first.items.some(row => row.track.id === t.id)).toBe(false);
		expect((await f.service.discover(3)).items).toEqual([]);
	});
	it("retries never undo subsequent user edits or resurrect removed membership", async () => {
		const t = await track();
		const p = await publish(t.id);
		await f.service.adopt(3, p.id, { moodIds: [LIKE] });
		await f.catalogue.setTrackMood(3, t.id, LIKE, false);
		await f.catalogue.setTrackMood(3, t.id, FOCUS, true);
		expect((await f.service.adopt(3, p.id, { moodIds: [LIKE] })).moodIds).toEqual([FOCUS]);
		await f.catalogue.removeLibraryTrack(3, t.id);
		expect((await f.service.adopt(3, p.id, { moodIds: [LIKE] })).inLibrary).toBe(false);
		expect((await f.service.discover(3)).items).toEqual([]);
	});
	it("does not mutate a Room or play on adoption; normal later Room refresh credits the adopter", async () => {
		const t = await track();
		const p = await publish(t.id);
		const room = new RoomMusic(
			"recommendation-contract",
			() => ["account:3"],
			async () => undefined,
			f.catalogue,
			new SqlMusicRoomStore(() => f.connection)
		);
		await room.refresh(true);
		const before = room.state!;
		expect(before.queue).toEqual([]);
		await f.service.adopt(3, p.id, { moodIds: [LIKE] });
		expect(room.state).toEqual(before);
		expect(f.resolver.video).not.toHaveBeenCalled();
		room.invalidate(3);
		await room.refresh(true);
		expect(room.state!.queue.length).toBeGreaterThan(0);
		expect(room.state!.queue.every(entry => entry.contributorId === "account:3")).toBe(true);
		expect(room.state!.current).toBeUndefined();
	});
	it("rejects unoffered adoption tags and stale publisher membership without any partial writes", async () => {
		const t = await track();
		const p = await publish(t.id);
		await expect(f.service.adopt(3, p.id, { moodIds: [ENERGY] })).rejects.toMatchObject({
			status: 400,
		});
		await f.catalogue.removeLibraryTrack(1, t.id);
		await expect(f.service.adopt(3, p.id, { moodIds: [LIKE] })).rejects.toMatchObject({
			status: 404,
		});
		expect((await f.catalogue.listLibrary(3)).items).toEqual([]);
	});
	it("rolls back membership, tags, receipt and durable invalidation when SQL fails late; retries apply once", async () => {
		const t = await track();
		const p = await publish(t.id);
		const before = await f.catalogue.roomVersions([3]);
		const notice = vi.fn();
		const stop = subscribeCatalogueChanges(notice);
		await f.connection.query(
			"CREATE TRIGGER reject_adoption BEFORE INSERT ON \"MusicRecommendationAdoptions\" BEGIN SELECT RAISE(ABORT, 'rollback adoption'); END"
		);
		try {
			await expect(f.service.adopt(3, p.id, { moodIds: [LIKE] })).rejects.toThrow();
			expect((await f.catalogue.listLibrary(3)).items).toEqual([]);
			expect((await f.catalogue.listTrackMoods(3, t.id)).items).toEqual([]);
			expect(await f.recommendations.Adoption.count()).toBe(0);
			expect(await f.catalogue.roomVersions([3])).toBe(before);
			expect(notice).not.toHaveBeenCalled();
			await f.connection.query("DROP TRIGGER reject_adoption");
			await Promise.all([
				f.service.adopt(3, p.id, { moodIds: [LIKE] }),
				f.service.adopt(3, p.id, { moodIds: [LIKE] }),
			]);
			expect(notice).toHaveBeenCalledTimes(2);
		} finally {
			stop();
		}
	});
	it("rolls back a completed invalidation when a failure occurs at the end of adoption", async () => {
		const t = await track();
		const p = await publish(t.id);
		const before = await f.catalogue.roomVersions([3]);
		const invalidate = f.catalogue.invalidateLibraryAdoption.bind(f.catalogue);
		const spy = vi
			.spyOn(f.catalogue, "invalidateLibraryAdoption")
			.mockImplementation(async (...args) => {
				await invalidate(...args);
				throw new Error("failure after durable revision write");
			});
		try {
			await expect(f.service.adopt(3, p.id, { moodIds: [LIKE] })).rejects.toThrow(
				"failure after"
			);
			expect(await f.catalogue.roomVersions([3])).toBe(before);
			expect((await f.catalogue.listLibrary(3)).items).toEqual([]);
			expect((await f.catalogue.listTrackMoods(3, t.id)).items).toEqual([]);
			expect(await f.recommendations.Adoption.count()).toBe(0);
		} finally {
			spy.mockRestore();
		}
	});
	it("migration down/up retains personal data; migration failure rolls back all new tables", async () => {
		const t = await track();
		await publish(t.id);
		await recommendationMigration.down(f.connection.getQueryInterface());
		expect((await f.catalogue.listLibrary(1)).items[0].track.id).toBe(t.id);
		const q = f.connection.getQueryInterface();
		const create = q.createTable.bind(q);
		const spy = vi.spyOn(q, "createTable").mockImplementation(async (...args) => {
			if (args[0] === "MusicRecommendationAdoptions") {
				throw new Error("injected migration failure");
			}
			return create(...args);
		});
		await expect(recommendationMigration.up(q, Sequelize)).rejects.toThrow("injected");
		spy.mockRestore();
		expect(await q.showAllTables()).not.toContain("MusicPublications");
		await recommendationMigration.up(q, Sequelize);
		expect((await f.service.discover(3)).items).toEqual([]);
	});
});

describe("cross-connection withdrawal ordering", () => {
	it("committed withdrawal wins against waiting adoption; a new connection retains publication and receipt state", async () => {
		await mkdir(resolve("../node_modules/.cache"), { recursive: true });
		const storage = resolve(`../node_modules/.cache/recommendations-${randomUUID()}.sqlite`);
		const a = await createRecommendationFixture(storage);
		const connection = new Sequelize({ dialect: "sqlite", storage, logging: false });
		connection.define("User", { id: { type: DataTypes.INTEGER, primaryKey: true } });
		const models = createMusicModels(connection);
		const catalogue = new MusicCatalogue(
			() => connection,
			() => models,
			a.resolver
		);
		const b = new MusicRecommendations(
			() => connection,
			catalogue,
			() => models
		);
		try {
			const t = await a.catalogue.addLibraryTrack(1, {
				reference: { service: "youtube", id: "abcdefghijk" },
			});
			await a.catalogue.setTrackMood(1, t.id, LIKE, true);
			await a.service.publish(1, t.id, { moodIds: [LIKE] });
			const p = (await b.discover(3)).items[0];
			let release!: () => void;
			let entered!: () => void;
			const hold = new Promise<void>(resolve => {
				release = resolve;
			});
			const ready = new Promise<void>(resolve => {
				entered = resolve;
			});
			const update = a.recommendations.Publication.update.bind(a.recommendations.Publication);
			// Hold a real IMMEDIATE SQL writer across a withdrawal, then start the other writer.
			const { musicTransaction } = await import("../../music/room-music-db.js");
			const withdrawal = musicTransaction(a.connection, async transaction => {
				await update({ active: false }, { where: { id: p.id }, transaction });
				entered();
				await hold;
			});
			await ready;
			const adoption = b.adopt(3, p.id, { moodIds: [LIKE] });
			const outcome = expect(adoption).rejects.toMatchObject({ status: 404 });
			release();
			await withdrawal;
			await outcome;
			expect((await b.discover(3)).items).toEqual([]);
			expect((await catalogue.listLibrary(3)).items).toEqual([]);
			// Republish, then concurrently adopt through independent connections. The durable
			// receipt and publication lock arbitrate repeats beyond one process-local mutex.
			await a.service.publish(1, t.id, { moodIds: [LIKE] });
			const notices: CatalogueChange[] = [];
			const stop = subscribeCatalogueChanges(change => {
				notices.push(change);
			});
			try {
				await Promise.all([
					a.service.adopt(3, p.id, { moodIds: [LIKE] }),
					b.adopt(3, p.id, { moodIds: [LIKE] }),
				]);
				expect(notices.map(n => n.kind)).toEqual(["library", "annotation"]);
				expect(await a.recommendations.Adoption.count()).toBe(1);
				await catalogue.setTrackMood(3, t.id, LIKE, false);
				expect((await a.service.adopt(3, p.id, { moodIds: [LIKE] })).moodIds).toEqual([]);
			} finally {
				stop();
			}
		} finally {
			await connection.close();
			await a.connection.close();
			await unlink(storage);
		}
	});
});
