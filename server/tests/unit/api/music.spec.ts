import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "../../../models/user.js";
import { buildMusicRouter } from "../../../api/music.js";
import { DEFAULT_MOODS } from "ott-common/models/music.js";
import { randomUUID } from "node:crypto";
import { createCatalogueFixture } from "../music-test-helpers.js";

vi.mock("../../../infoextractor.js", () => ({ default: {} }));
vi.mock("../../../rate-limit.js", () => ({ consumeRateLimitPoints: vi.fn(async () => true) }));

describe("Authenticated personal music API", () => {
	let fixture: Awaited<ReturnType<typeof createCatalogueFixture>>;
	let app: express.Express;
	beforeEach(async () => {
		fixture = await createCatalogueFixture();
		app = express();
		app.use(express.json());
		// This harness supplies the account resolved by the existing authTokenMiddleware in production.
		app.use((req, _res, next) => {
			if (req.get("test-account")) {
				req.user = { id: Number(req.get("test-account")) } as User;
			}
			next();
		});
		app.use("/api/music", buildMusicRouter(fixture.catalogue));
	});
	afterEach(async () => {
		await fixture.connection.close();
	});

	it("requires an authenticated account on every route including the shared vocabulary", async () => {
		for (const path of [
			"library",
			"moods",
			"favorites",
			`tracks/${DEFAULT_MOODS[0].id}/moods`,
		]) {
			await request(app).get(`/api/music/${path}`).expect(401);
		}
		await request(app).post("/api/music/library").send({ userId: 1 }).expect(401);
		expect(await fixture.models.Track.count()).toBe(0);
	});

	it("rejects identity overrides, excessive pagination, unknown inputs and file URLs", async () => {
		for (const body of [
			{ userId: 2, reference: { service: "youtube", id: "a" } },
			{ url: "file:///secret.mp3" },
			{ reference: { service: "direct", id: "/srv/private/music.mp3" } },
		]) {
			await request(app)
				.post("/api/music/library")
				.set("test-account", "1")
				.send(body)
				.expect(400);
		}
		await request(app).get("/api/music/library?userId=2").set("test-account", "1").expect(400);
		await request(app).get("/api/music/moods?limit=101").set("test-account", "1").expect(400);
		await request(app)
			.post("/api/music/moods")
			.set("test-account", "1")
			.send({ name: "Epic", iconKey: "disk-path" })
			.expect(400);
		expect(await fixture.models.Track.count()).toBe(0);
	});

	it("serves private library and own tags/favorites, and isolates mutations from another account", async () => {
		const added = await request(app)
			.post("/api/music/library")
			.set("test-account", "1")
			.send({ reference: { service: "youtube", id: "a" } })
			.expect(200);
		const trackId = added.body.track.id;
		const moodId = DEFAULT_MOODS[1].id;
		const tagPath = `/api/music/tracks/${trackId}/moods/${moodId}`;
		await request(app).put(tagPath).set("test-account", "1").send({ userId: 2 }).expect(400);
		await request(app).put(tagPath).set("test-account", "1").expect(200);
		await request(app)
			.put(`/api/music/favorites/${moodId}`)
			.set("test-account", "1")
			.expect(200);
		await request(app).delete(tagPath).set("test-account", "2").expect(200);
		await request(app)
			.delete(`/api/music/library/${trackId}`)
			.set("test-account", "2")
			.expect(200);
		const own = await request(app)
			.get("/api/music/library")
			.set("test-account", "1")
			.expect(200);
		expect(own.body.total).toBe(1);
		expect(own.headers["cache-control"]).toContain("no-store");
		expect(own.body.items[0].sources[0]).not.toHaveProperty("providerId");
		const others = await request(app)
			.get("/api/music/library")
			.set("test-account", "2")
			.expect(200);
		expect(others.body.total).toBe(0);
		const tags = await request(app)
			.get(`/api/music/tracks/${trackId}/moods`)
			.set("test-account", "1")
			.expect(200);
		expect(tags.body.items.map(m => m.id)).toEqual([moodId]);
		const favorites = await request(app)
			.get("/api/music/favorites")
			.set("test-account", "2")
			.expect(200);
		expect(favorites.body.total).toBe(0);
	});

	it("creates a shared normalized mood and returns safe missing-resource errors", async () => {
		const a = await request(app)
			.post("/api/music/moods")
			.set("test-account", "1")
			.send({ name: " Epic ", iconKey: "flame" })
			.expect(200);
		const b = await request(app)
			.post("/api/music/moods")
			.set("test-account", "2")
			.send({ name: "epic", iconKey: "moon" })
			.expect(200);
		expect(a.body.mood.id).toBe(b.body.mood.id);
		expect(b.body.mood.iconKey).toBe("flame");
		await request(app)
			.put(`/api/music/favorites/${randomUUID()}`)
			.set("test-account", "1")
			.expect(404);
		await request(app)
			.get("/api/music/tracks/not-an-id/moods")
			.set("test-account", "1")
			.expect(400);
	});
});
