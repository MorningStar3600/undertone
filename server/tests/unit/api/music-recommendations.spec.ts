import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MOODS } from "ott-common/models/music.js";
import { buildMusicRecommendationsRouter } from "../../../api/music-recommendations.js";
import { createRecommendationFixture } from "../music-recommendations-fixture.js";
import type { User } from "../../../models/user.js";
vi.mock("../../../infoextractor.js", () => ({ default: {} }));
vi.mock("../../../rate-limit.js", () => ({ consumeRateLimitPoints: vi.fn(async () => true) }));
const LIKE = DEFAULT_MOODS[0].id;
describe("authenticated recommendation API", () => {
	let f: Awaited<ReturnType<typeof createRecommendationFixture>>;
	let app: express.Express;
	beforeEach(async () => {
		f = await createRecommendationFixture();
		app = express();
		app.use(express.json());
		app.use((req, _res, next) => {
			if (req.get("test-account")) {
				req.user = { id: Number(req.get("test-account")) } as User;
			}
			next();
		});
		app.use("/api/music/recommendations", buildMusicRecommendationsRouter(f.service));
	});
	afterEach(async () => {
		await f.connection.close();
	});
	const base = "/api/music/recommendations";
	it("denies guests/API-key-only access and enforces strict bounded requests", async () => {
		await request(app).get(base).expect(401);
		await request(app).get(base).set("apikey", "fixture-only").expect(401);
		for (const query of [
			"userId=2",
			"limit=51",
			"offset=0",
			"moods=nope",
			"moods=" + Array(21).fill(LIKE).join(","),
			"after=nope",
			"limit=1&limit=2",
		]) {
			await request(app).get(`${base}?${query}`).set("test-account", "1").expect(400);
		}
		for (const body of [
			{ moodIds: [LIKE], userId: 1 },
			{ moodIds: [LIKE], reference: { service: "youtube", id: "abcdefghijk" } },
			{ moodIds: [LIKE, LIKE] },
		]) {
			await request(app)
				.put(`${base}/publications/${randomUUID()}`)
				.set("test-account", "1")
				.send(body)
				.expect(400);
		}
		await request(app)
			.post(`${base}/${randomUUID()}/adopt?userId=1`)
			.set("test-account", "2")
			.send({ moodIds: [] })
			.expect(400);
		expect(await f.recommendations.Adoption.count()).toBe(0);
	});
	it("uses req.user exclusively and projects only consented metadata; unknown and revoked references match", async () => {
		const t = await f.catalogue.addLibraryTrack(1, {
			reference: { service: "youtube", id: "abcdefghijk" },
		});
		await f.catalogue.setTrackMood(1, t.id, LIKE, true);
		const path = `${base}/publications/${t.id}`;
		const initial = await request(app).get(base).set("test-account", "3").expect(200);
		expect(initial.body).toEqual({ success: true, items: [], next: null });
		await request(app)
			.put(path)
			.set("test-account", "2")
			.send({ moodIds: [LIKE] })
			.expect(404);
		await request(app)
			.put(path)
			.set("test-account", "1")
			.send({ moodIds: [LIKE] })
			.expect(200);
		const response = await request(app).get(base).set("test-account", "3").expect(200);
		expect(response.headers["cache-control"]).toBe("private, no-store");
		expect(response.body.items).toHaveLength(1);
		expect(JSON.stringify(response.body)).not.toMatch(
			/userId|providerId|artwork|email|abcdefghijk|https:/
		);
		expect(response.body.total).toBeUndefined();
		const id = response.body.items[0].id;
		await request(app)
			.post(`${base}/${id}/adopt`)
			.set("test-account", "3")
			.send({ moodIds: [LIKE], userId: 2 })
			.expect(400);
		const added = await request(app)
			.post(`${base}/${id}/adopt`)
			.set("test-account", "3")
			.send({ moodIds: [LIKE] })
			.expect(200);
		expect(added.body.adoption).toEqual({ trackId: t.id, inLibrary: true, moodIds: [LIKE] });
		expect((await f.catalogue.listLibrary(2)).items).toEqual([]);
		await request(app).delete(path).set("test-account", "1").send({}).expect(200);
		const revoked = await request(app)
			.post(`${base}/${id}/adopt`)
			.set("test-account", "2")
			.send({ moodIds: [] })
			.expect(404);
		const missing = await request(app)
			.post(`${base}/${randomUUID()}/adopt`)
			.set("test-account", "2")
			.send({ moodIds: [] })
			.expect(404);
		expect(revoked.body).toEqual(missing.body);
		const privateState = await request(app).get(path).set("test-account", "2").expect(200);
		expect(privateState.body.publication).toEqual({ eligible: false, moods: [] });
	});
});
