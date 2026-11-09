import { createRequire } from "node:module";
import { mkdir, mkdtemp, writeFile, unlink, rename, symlink, rm, utimes } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Sequelize } from "sequelize";
import express from "express";
import request from "supertest";
import { get } from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MOODS } from "ott-common/models/music.js";
import { LocalMediaLibrary, isLocalSource } from "../../music/local-media.js";
import { localMediaModels } from "../../models/local-media.js";
import { LocalMediaRootsSchema } from "../../music/local-media-config.js";
import { openLocalFile, probeLocalAudio, safeRelative } from "../../music/local-media-files.js";
import { buildLocalMediaRouter, mediaRange } from "../../api/local-media.js";
import { subscribeCatalogueChanges } from "../../music/catalogue.js";
import { createCatalogueFixture } from "./music-test-helpers.js";
import { RoomMusic } from "../../music/room-music.js";
import { SqlMusicRoomStore } from "../../music/room-music-storage.js";

vi.mock("../../infoextractor.js", () => ({ default: {} }));
vi.mock("../../rate-limit.js", () => ({ consumeRateLimitPoints: vi.fn(async () => true) }));
const migration = createRequire(import.meta.url)(
	"../../migrations/20261110010000-create-local-media.js",
);
const PRIVATE_FIELDS = /relativePath|providerId|inode|private-first|private-second/;
describe("operator local audio", () => {
	let f: Awaited<ReturnType<typeof createCatalogueFixture>>,
		directory: string,
		library: LocalMediaLibrary;
	const metadata = { title: "Recording", artists: ["Artist"], duration: 180 };
	let cluster = false;
	beforeEach(async () => {
		f = await createCatalogueFixture();
		await migration.up(f.connection.getQueryInterface(), Sequelize);
		const scratch = resolve("../node_modules/.cache/local-media-tests");
		await mkdir(scratch, { recursive: true });
		directory = await mkdtemp(join(scratch, "library-"));
		cluster = false;
		library = new LocalMediaLibrary(
			() => f.connection,
			() => f.models,
			() => [{ id: "fixture", directory, ownerId: 1 }],
			() => cluster,
			async () => metadata,
			(ids, transaction) => f.catalogue.invalidateTracks(ids, transaction),
		);
		vi.spyOn(f.catalogue, "localSourceOwners").mockImplementation(sources =>
			library.sourceOwners(sources),
		);
		vi.spyOn(f.catalogue, "localSourceAllowed").mockImplementation((source, identity) =>
			library.sourceAllowed(source, identity),
		);
		vi.mocked(f.resolver.video).mockImplementation(source =>
			isLocalSource(source)
				? library.video(source)
				: Promise.resolve({
						service: source.service,
						id: source.providerId,
						title: "Remote",
						length: 180,
					}),
		);
	});
	afterEach(async () => {
		await f.connection.close();
		await rm(directory, { recursive: true, force: true });
	});
	const file = () => localMediaModels(f.connection).File.findOne({ rejectOnEmpty: true });
	it("validates operator config and rejects input path/owner assignment and encoded traversal", async () => {
		expect(
			LocalMediaRootsSchema.safeParse([{ id: "fixture", directory: "relative", ownerId: 1 }])
				.success,
		).toBe(false);
		expect(
			LocalMediaRootsSchema.safeParse([{ id: "fixture", directory, ownerId: -1 }]).success,
		).toBe(false);
		for (const value of [
			"../outside.mp3",
			"%2e%2e/audio.mp3",
			"%252e%252e.mp3",
			"C:\\audio.mp3",
			"folder/../audio.mp3",
			"a\0.mp3",
		]) {
			expect(safeRelative(value)).toBe(false);
		}
		await expect(library.scan(2, "fixture")).rejects.toThrow("not available");
		const app = express()
			.use(express.json())
			.use((req, _res, next) => {
				req.user = { id: 1 } as never;
				next();
			})
			.use(buildLocalMediaRouter(library, async () => true));
		await request(app)
			.post("/roots/fixture/scan")
			.set("X-Local-Media-Scan", "1")
			.send({ directory, ownerId: 2 })
			.expect(400);
		expect(await localMediaModels(f.connection).File.count()).toBe(0);
	});
	it("indexes idempotently without title merging, redacts paths, and invalidates only actual changes", async () => {
		await writeFile(join(directory, "private-first.mp3"), "0123456789");
		await writeFile(join(directory, "private-second.mp3"), "abcdefghij");
		const changes: unknown[] = [],
			stop = subscribeCatalogueChanges(change => {
				changes.push(change);
			});
		try {
			await library.scan(1, "fixture");
			const first = await f.catalogue.listLibrary(1);
			expect(first.total).toBe(2);
			expect(new Set(first.items.map(entry => entry.track.id)).size).toBe(2);
			const versions = await f.catalogue.roomVersions([1]);
			expect(changes).toHaveLength(2);
			await library.scan(1, "fixture");
			expect(await f.catalogue.roomVersions([1])).toBe(versions);
			expect(changes).toHaveLength(2);
			expect(await f.models.Track.count()).toBe(2);
			const dto = JSON.stringify([await library.status(1), await f.catalogue.listLibrary(1)]);
			expect(dto).not.toMatch(PRIVATE_FIELDS);
			expect(dto).not.toContain(directory);
			expect((await library.status(2)).roots).toEqual([]);
		} finally {
			stop();
		}
	});
	it("marks missing sources unavailable, preserves tags/links, and never sweeps on failed scans", async () => {
		await writeFile(join(directory, "audio.mp3"), "0123456789");
		await library.scan(1, "fixture");
		const stored = (await file()).get();
		await f.catalogue.setTrackMood(1, stored.trackId, DEFAULT_MOODS[0].id, true);
		await rename(directory, `${directory}-away`);
		try {
			await library.scan(1, "fixture");
			expect((await library.status(1)).roots[0].status).toBe("failed");
			expect((await f.models.TrackSource.findByPk(stored.id))!.get().availability).toBe(
				"available",
			);
		} finally {
			await rename(`${directory}-away`, directory);
		}
		await unlink(join(directory, "audio.mp3"));
		await library.scan(1, "fixture");
		expect((await f.models.TrackSource.findByPk(stored.id))!.get().availability).toBe(
			"unavailable",
		);
		expect((await f.catalogue.listLibrary(1)).total).toBe(1);
		expect((await f.catalogue.listTrackMoods(1, stored.trackId)).items[0].id).toBe(
			DEFAULT_MOODS[0].id,
		);
	});
	it("invalidates every current library owner and track fingerprints only for effective metadata changes", async () => {
		await writeFile(join(directory, "audio.mp3"), "0123456789");
		await library.scan(1, "fixture");
		const stored = (await file()).get();
		await f.catalogue.addLibraryTrack(2, { trackId: stored.trackId });
		const before = await f.catalogue.roomVersions([1, 2]),
			fingerprint = await f.catalogue.roomTrackVersions([stored.trackId]);
		const events: { userId: number }[] = [],
			stop = subscribeCatalogueChanges(change => {
				events.push(change);
			});
		try {
			const updated = new LocalMediaLibrary(
				() => f.connection,
				() => f.models,
				() => [{ id: "fixture", directory, ownerId: 1 }],
				() => false,
				async () => ({ ...metadata, title: "Updated title" }),
				(ids, transaction) => f.catalogue.invalidateTracks(ids, transaction),
			);
			await updated.scan(1, "fixture");
			expect(events.map(event => event.userId).sort()).toEqual([1, 2]);
			expect(await f.catalogue.roomVersions([1, 2])).not.toBe(before);
			expect(await f.catalogue.roomTrackVersions([stored.trackId])).not.toBe(fingerprint);
			const versions = await f.catalogue.roomVersions([1, 2]);
			await updated.scan(1, "fixture");
			await f.catalogue.setFavorite(1, DEFAULT_MOODS[0].id, true);
			expect(events).toHaveLength(2);
			expect(await f.catalogue.roomVersions([1, 2])).toBe(versions);
		} finally {
			stop();
		}
	});
	it("rejects overlapping scans and reports scanning state without exposing the lease", async () => {
		await writeFile(join(directory, "audio.mp3"), "0123456789");
		let entered!: () => void, release!: () => void;
		const started = new Promise<void>(resolve => {
				entered = resolve;
			}),
			blocked = new Promise<void>(resolve => {
				release = resolve;
			});
		const scanning = new LocalMediaLibrary(
			() => f.connection,
			() => f.models,
			() => [{ id: "fixture", directory, ownerId: 1 }],
			() => false,
			async () => {
				entered();
				await blocked;
				return metadata;
			},
			(ids, transaction) => f.catalogue.invalidateTracks(ids, transaction),
		);
		const work = scanning.scan(1, "fixture");
		await started;
		try {
			const status = await scanning.status(1);
			expect(status.roots[0].status).toBe("scanning");
			expect(JSON.stringify(status)).not.toContain("scanToken");
			await expect(library.scan(1, "fixture")).rejects.toMatchObject({ status: 409 });
		} finally {
			release();
			await work;
		}
		expect(await f.models.Track.count()).toBe(1);
	});
	it("rolls back catalogue, provenance and invalidation together on write failure", async () => {
		await writeFile(join(directory, "audio.mp3"), "0123456789");
		const failing = new LocalMediaLibrary(
			() => f.connection,
			() => f.models,
			() => [{ id: "fixture", directory, ownerId: 1 }],
			() => false,
			async () => metadata,
			async () => {
				throw new Error("private/path");
			},
		);
		await expect(failing.scan(1, "fixture")).rejects.toThrow("not available");
		expect(await f.models.Track.count()).toBe(0);
		expect(await localMediaModels(f.connection).File.count()).toBe(0);
		expect((await library.status(1)).roots[0].status).toBe("failed");
	});
	it("denies replaced files and junction/symlink escapes, without modifying library files", async () => {
		await writeFile(join(directory, "audio.mp3"), "0123456789");
		await library.scan(1, "fixture");
		const stored = (await file()).get();
		await rename(join(directory, "audio.mp3"), join(directory, "old.mp3"));
		await writeFile(join(directory, "audio.mp3"), "SECRET_OUTSIDE");
		await expect(library.open(stored.id)).rejects.toThrow();
		const outside = `${directory}-outside`;
		await mkdir(outside);
		await writeFile(join(outside, "escape.mp3"), "SECRET_OUTSIDE");
		try {
			await symlink(
				outside,
				join(directory, "escape"),
				process.platform === "win32" ? "junction" : "dir",
			);
			await expect(openLocalFile(directory, join("escape", "escape.mp3"))).rejects.toThrow();
			await library.scan(1, "fixture");
			expect((await library.status(1)).roots[0].status).toBe("partial");
			expect(await localMediaModels(f.connection).File.count()).toBe(2);
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});
	it("serves real bytes/ranges/HEAD with no path or auth secret, and denies unauthenticated reads", async () => {
		await writeFile(join(directory, "audio.mp3"), "0123456789");
		await library.scan(1, "fixture");
		const id = (await file()).get().id;
		let allowed = true;
		const app = express().use(buildLocalMediaRouter(library, async () => allowed));
		const full = await request(app).get(`/${id}`).expect(200);
		expect(full.body.toString()).toBe("0123456789");
		expect(full.headers["content-type"]).toBe("audio/mpeg");
		expect(full.headers["cache-control"]).toContain("no-store");
		expect(full.headers["x-content-type-options"]).toBe("nosniff");
		for (const [range, result] of [
			["bytes=2-4", "234"],
			["bytes=8-", "89"],
			["bytes=-3", "789"],
			["bytes=-100", "0123456789"],
		]) {
			const response = await request(app).get(`/${id}`).set("Range", range).expect(206);
			expect(response.body.toString()).toBe(result);
		}
		const head = await request(app).head(`/${id}`).set("Range", "bytes=2-4").expect(206);
		expect(head.headers["content-length"]).toBe("3");
		expect(head.text).toBeUndefined();
		for (const range of [
			"bytes=20-",
			"bytes=1-2,4-5",
			"bytes=-0",
			"bytes=99999999999999999999-",
			"bytes=-",
			"bytes=2-1",
		]) {
			const response = await request(app).get(`/${id}`).set("Range", range).expect(416);
			expect(response.headers["content-range"]).toBe("bytes */10");
		}
		allowed = false;
		await request(app).get(`/${id}`).expect(404);
		await request(app).head(`/${id}`).expect(404);
		cluster = true;
		allowed = true;
		await request(app).get(`/${id}`).expect(404);
		expect(await library.status(1)).toEqual({ enabled: false, reason: "balancer", roots: [] });
	});
	it.each(["GET", "HEAD", "range"])(
		"rejects a file overwritten during authorization for %s",
		async method => {
			const path = join(directory, "audio.mp3");
			await writeFile(path, "0123456789");
			await library.scan(1, "fixture");
			const id = (await file()).get().id;
			const open = library.open.bind(library);
			let closed = false;
			vi.spyOn(library, "open").mockImplementation(async sourceId => {
				const opened = await open(sourceId),
					close = opened.handle.close.bind(opened.handle);
				vi.spyOn(opened.handle, "close").mockImplementation(async () => {
					await close();
					closed = true;
				});
				return opened;
			});
			const app = express().use(
				buildLocalMediaRouter(library, async () => {
					// Same-sized replacement: mtime, rather than Content-Length, must invalidate it.
					await writeFile(path, "abcdefghij");
					await utimes(path, new Date(0), new Date(0));
					return true;
				}),
			);
			const pending =
				method === "HEAD" ? request(app).head(`/${id}`) : request(app).get(`/${id}`);
			// eslint-disable-next-line vitest/no-conditional-in-test -- Parameterized request setup; assertions are unconditional.
			if (method === "range") {
				pending.set("Range", "bytes=2-4");
			}
			const response = await pending.expect(404);
			expect(response.headers["content-range"]).toBeUndefined();
			expect(response.headers["content-length"]).not.toBe(method === "range" ? "3" : "10");
			expect(response.text ?? "").toBe("");
			await vi.waitFor(() => expect(closed).toBe(true));
		},
	);
	it("finishes the indexed descriptor across atomic replacement and requires rescan for new opens", async () => {
		const path = join(directory, "audio.mp3"),
			replacement = join(directory, "replacement.tmp");
		await writeFile(path, "0123456789");
		await library.scan(1, "fixture");
		const id = (await file()).get().id;
		let replace = true;
		let replacementBlocked = false;
		const app = express().use(
			buildLocalMediaRouter(library, async () => {
				if (replace) {
					replace = false;
					await writeFile(replacement, "new recording");
					try {
						await rename(replacement, path);
					} catch (error) {
						if (
							process.platform !== "win32" ||
							(error as NodeJS.ErrnoException).code !== "EPERM"
						) {
							throw error;
						}
						// Windows can deny replacing an open file: ingestion must wait, never overwrite it.
						replacementBlocked = true;
					}
				}
				return true;
			}),
		);
		expect((await request(app).get(`/${id}`).expect(200)).body.toString()).toBe("0123456789");
		// eslint-disable-next-line vitest/no-conditional-in-test -- Windows may require ingestion to wait for the descriptor to close.
		if (replacementBlocked) {
			await vi.waitFor(async () => rename(replacement, path));
		}
		await request(app).get(`/${id}`).expect(404);
		await library.scan(1, "fixture");
		expect((await request(app).get(`/${id}`).expect(200)).body.toString()).toBe(
			"new recording",
		);
	});
	it("uses safe unknown probe metadata and keeps descriptor usable", async () => {
		await writeFile(join(directory, "audio.mp3"), "not audio");
		const { handle } = await openLocalFile(directory, "audio.mp3");
		try {
			expect(await probeLocalAudio(handle)).toEqual({
				title: "Untitled track",
				artists: [],
				duration: null,
			});
			expect((await handle.stat()).size).toBe(9);
		} finally {
			await handle.close();
		}
	});
	it("closes the opened media descriptor when the reader aborts a real stream", async () => {
		await writeFile(join(directory, "audio.mp3"), Buffer.alloc(16 * 1024 * 1024));
		await library.scan(1, "fixture");
		const id = (await file()).get().id;
		const open = library.open.bind(library);
		let closed = false;
		vi.spyOn(library, "open").mockImplementation(async sourceId => {
			const opened = await open(sourceId),
				close = opened.handle.close.bind(opened.handle);
			vi.spyOn(opened.handle, "close").mockImplementation(async () => {
				await close();
				closed = true;
			});
			return opened;
		});
		const server = express()
			.use(buildLocalMediaRouter(library, async () => true))
			.listen(0, "127.0.0.1");
		try {
			await new Promise<void>(resolve => server.once("listening", resolve));
			const address = server.address();
			if (!address || typeof address === "string") {
				throw new Error("No fixture address");
			}
			await new Promise<void>((resolve, reject) => {
				const client = get(
					{ host: "127.0.0.1", port: address.port, path: `/${id}` },
					response => {
						response.once("data", () => {
							response.destroy();
							client.destroy();
							resolve();
						});
						response.once("error", () => resolve());
					},
				);
				client.once("error", reject);
			});
			await vi.waitFor(() => expect(closed).toBe(true));
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
	it("filters catalogue adoption by contributor and plays local identity through the existing Music engine", async () => {
		await writeFile(join(directory, "audio.mp3"), "0123456789");
		await library.scan(1, "fixture");
		const stored = (await file()).get();
		await f.catalogue.addLibraryTrack(2, { trackId: stored.trackId });
		await expect(
			f.catalogue.resolveTrack({ service: "direct", id: `local:${stored.id}` }, "account:2"),
		).rejects.toThrow();
		const room = new RoomMusic(
			"local-room",
			() => ["account:1", "account:2"],
			async () => {
				/* capture durable state below instead of publishing */
			},
			f.catalogue,
			new SqlMusicRoomStore(() => f.connection),
		);
		await room.refresh();
		expect(room.state!.queue).toHaveLength(1);
		expect(room.state!.queue.every(entry => entry.contributorId === "account:1")).toBe(true);
		await room.advance();
		expect(room.state!.current!.entry.trackId).toBe(stored.trackId);
		const saved = await new SqlMusicRoomStore(() => f.connection).load("local-room");
		expect(saved!.playback.currentSource?.id).toBe(`local:${stored.id}`);
		expect(JSON.stringify(saved)).not.toContain(directory);
		cluster = true;
		expect(
			await library.sourceAllowed(
				(await f.models.TrackSource.findByPk(stored.id))!.get(),
				"account:1",
			),
		).toBe(false);
	});
	it("supports transactional up/down and range bounds", async () => {
		expect(mediaRange(undefined, 0)).toBeNull();
		expect(() => mediaRange("bytes=0-", 0)).toThrow();
		await migration.down(f.connection.getQueryInterface());
		expect(await f.connection.getQueryInterface().showAllTables()).not.toContain(
			"LocalMediaFiles",
		);
		await migration.up(f.connection.getQueryInterface(), Sequelize);
	});
	it("plays a mixed local/YouTube queue while retaining contributor, track, tags and history", async () => {
		await writeFile(join(directory, "audio.mp3"), "0123456789");
		await library.scan(1, "fixture");
		const local = (await file()).get();
		const remote = await f.catalogue.addLibraryTrack(2, {
			reference: { service: "youtube", id: "remote-recording" },
		});
		await f.catalogue.setTrackMood(1, local.trackId, DEFAULT_MOODS[0].id, true);
		const room = new RoomMusic(
			"mixed",
			() => ["account:1", "account:2"],
			async () => {
				/* no publication needed */
			},
			f.catalogue,
			new SqlMusicRoomStore(() => f.connection),
		);
		await room.refresh();
		await room.advance();
		await room.setPlayback({ isPlaying: true });
		const first = room.state!.current!.entry;
		await room.advance();
		const state = room.state!;
		expect(new Set(state.history.events.map(event => event.entry.trackId))).toEqual(
			new Set([local.trackId, remote.id]),
		);
		expect(state.history.events).toHaveLength(2);
		const localEvent = state.history.events.find(
			event => event.entry.trackId === local.trackId,
		)!;
		expect(localEvent.entry.contributorId).toBe("account:1");
		expect(localEvent.entry.tagsByUser["account:1"]).toEqual([DEFAULT_MOODS[0].id]);
		expect(state.history.events[0].entry.entryId).toBe(first.entryId);
	});
	it("equivalent source fallback retains occurrence identity and credits one playback", async () => {
		await writeFile(join(directory, "audio.mp3"), "0123456789");
		await library.scan(1, "fixture");
		const local = (await file()).get();
		const room = new RoomMusic(
			"fallback",
			() => ["account:1"],
			async () => {
				/* no publication needed */
			},
			f.catalogue,
			new SqlMusicRoomStore(() => f.connection),
		);
		await room.refresh();
		await room.advance();
		const before = room.state!.current!;
		// Equivalent-source linking is intentionally explicit in this fixture, never title-based.
		const equivalent = randomUUID();
		await f.models.TrackSource.create({
			id: equivalent,
			trackId: local.trackId,
			service: "youtube",
			providerId: "equivalent-recording",
			availability: "available",
			capabilities: { seek: true, backgroundPlayback: "unknown" },
		});
		await unlink(join(directory, "audio.mp3"));
		await room.setPlayback({ isPlaying: true });
		const after = room.state!;
		expect(after.current?.entry.entryId).toBe(before.entry.entryId);
		expect(after.current?.entry.contributorId).toBe(before.entry.contributorId);
		expect(after.current?.playbackId).toBe(before.playbackId);
		expect(after.current?.entry.sourceId).toBe(equivalent);
		expect(after.history.events).toHaveLength(1);
		expect(after.history.events[0].actualSourceId).toBe(equivalent);
		await room.setPlayback({ isPlaying: false });
		await room.setPlayback({ isPlaying: true });
		expect(room.state!.history.events).toHaveLength(1);
	});
	it("rolls back a failed migration without leaving partially created local tables", async () => {
		const q = f.connection.getQueryInterface();
		await migration.down(q);
		const fail = vi.spyOn(q, "addIndex").mockRejectedValue(new Error("fixture failure"));
		try {
			await expect(migration.up(q, Sequelize)).rejects.toThrow("fixture failure");
		} finally {
			fail.mockRestore();
		}
		const tables = await q.showAllTables();
		expect(tables).not.toContain("LocalMediaRoots");
		expect(tables).not.toContain("LocalMediaFiles");
	});
});

describe("local migration PostgreSQL SQL generation (no PostgreSQL runtime)", () => {
	it("generates private provenance FKs and per-root path uniqueness transactionally", async () => {
		const connection = new Sequelize({ dialect: "postgres", logging: false });
		const query = vi.spyOn(connection, "query").mockResolvedValue([] as never);
		const q = connection.getQueryInterface();
		const mock = {
			sequelize: {
				transaction: async (action: (transaction: undefined) => Promise<void>) =>
					action(undefined),
			},
			createTable: q.createTable.bind(q),
			dropTable: q.dropTable.bind(q),
			addIndex: q.addIndex.bind(q),
		};
		try {
			await migration.up(mock, Sequelize);
			const sql = query.mock.calls.map(call => String(call[0])).join("\n");
			expect(sql).toContain('REFERENCES "Users" ("id") ON DELETE CASCADE');
			expect(sql).toContain('REFERENCES "TrackSources" ("id") ON DELETE CASCADE');
			expect(sql).toContain('"modified" DOUBLE PRECISION NOT NULL');
			expect(sql).toContain('ON "LocalMediaFiles" ("rootId", "pathKey")');
			await migration.down(mock);
		} finally {
			query.mockRestore();
			await connection.close();
		}
	});
});
