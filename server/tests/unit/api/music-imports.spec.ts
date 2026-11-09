import { createRequire } from "node:module";
import express from "express";
import request from "supertest";
import { Sequelize } from "sequelize";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMusicImportsRouter } from "../../../api/music-imports.js";
import { MusicImports } from "../../../music/imports.js";
import { createCatalogueFixture } from "../music-test-helpers.js";
import type { User } from "../../../models/user.js";

vi.mock("../../../infoextractor.js", () => ({ default: {} }));
const PRIVATE_REPORT_FIELDS = /PLprivateReference|providerId|cursor|leaseToken|userId/;
vi.mock("../../../rate-limit.js", () => ({ consumeRateLimitPoints: vi.fn(async () => true) }));
describe("private music import API", () => {
	let f: Awaited<ReturnType<typeof createCatalogueFixture>>;
	let app: express.Express;
	beforeEach(async () => {
		f = await createCatalogueFixture();
		await createRequire(import.meta.url)(
			"../../../migrations/20261109220000-create-music-imports.js",
		).up(f.connection.getQueryInterface(), Sequelize);
		const imports = new MusicImports(
			() => f.connection,
			f.catalogue,
			vi.fn(async () => {
				throw new Error("No network");
			}),
		);
		app = express();
		app.use(express.json());
		app.use((req, _res, next) => {
			if (req.get("test-account")) {
				req.user = { id: Number(req.get("test-account")) } as User;
			}
			next();
		});
		app.use("/api/music/imports", buildMusicImportsRouter(imports));
	});
	afterEach(async () => {
		await f.connection.close();
	});
	it("rejects anonymous and API-key-only requests, payload user IDs, invalid references and unbounded pages", async () => {
		await request(app).get("/api/music/imports/sources").expect(401);
		await request(app)
			.post("/api/music/imports/sources")
			.set("apikey", "test-only")
			.send({ reference: { service: "youtube", id: "PLvalid" } })
			.expect(401);
		for (const body of [
			{ userId: 2, reference: { service: "youtube", id: "PLvalid" } },
			{ reference: { service: "vimeo", id: "PLvalid" } },
			{ reference: { service: "youtube", id: "WL" } },
			{ url: "file:///private" },
			{ url: "https://youtube.com.evil/playlist?list=PLvalid" },
			{ url: "https://secret@youtube.com/playlist?list=PLvalid" },
			{ url: "https://youtube.com/channel/PLvalid" },
		]) {
			await request(app)
				.post("/api/music/imports/sources")
				.set("test-account", "1")
				.send(body)
				.expect(400);
		}
		await request(app)
			.get("/api/music/imports/sources?limit=101")
			.set("test-account", "1")
			.expect(400);
		await request(app)
			.get("/api/music/imports/sources?userId=2")
			.set("test-account", "1")
			.expect(400);
		expect(await f.models.UserLibraryTrack.count()).toBe(0);
	});
	it("isolates source IDs and job reports; exposes safe counters and accepts typed run/schedule/cancel/stop", async () => {
		const added = await request(app)
			.post("/api/music/imports/sources")
			.set("test-account", "1")
			.send({ reference: { service: "youtube", id: "PLprivateReference" } })
			.expect(200);
		const id = added.body.source.id;
		const base = `/api/music/imports/sources/${id}`;
		for (const [method, suffix, body] of [
			["get", "/jobs", undefined],
			["post", "/run", {}],
			["post", "/cancel", {}],
			["put", "/schedule", { daily: true }],
			["delete", "", {}],
		] as const) {
			const response = request(app)[method](`${base}${suffix}`);
			await response.set("test-account", "2").send(body).expect(404);
		}
		const run = await request(app)
			.post(`${base}/run`)
			.set("test-account", "1")
			.send({})
			.expect(200);
		const duplicate = await request(app)
			.post(`${base}/run`)
			.set("test-account", "1")
			.send({})
			.expect(200);
		expect(run.body.job.id).toBe(duplicate.body.job.id);
		await request(app)
			.post(`${base}/run`)
			.set("test-account", "1")
			.send({ userId: 2 })
			.expect(400);
		await request(app)
			.put(`${base}/schedule`)
			.set("test-account", "1")
			.send({ daily: true })
			.expect(200);
		await request(app)
			.put(`${base}/schedule`)
			.set("test-account", "1")
			.send({ daily: false })
			.expect(200);
		const report = await request(app)
			.get(`${base}/jobs?limit=1&offset=0`)
			.set("test-account", "1")
			.expect(200);
		expect(report.body.total).toBe(1);
		expect(report.headers["cache-control"]).toContain("no-store");
		expect(JSON.stringify(report.body)).not.toMatch(PRIVATE_REPORT_FIELDS);
		await request(app).post(`${base}/cancel`).set("test-account", "1").send({}).expect(200);
		await request(app).delete(base).set("test-account", "1").send({}).expect(200);
		await request(app).post(`${base}/run`).set("test-account", "1").send({}).expect(409);
	});
});
