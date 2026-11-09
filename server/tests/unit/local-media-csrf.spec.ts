import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authTokenMiddleware } from "../../auth/index.js";
import tokens from "../../auth/tokens.js";
import { buildLocalMediaRouter } from "../../api/local-media.js";
import type { LocalMediaLibrary } from "../../music/local-media.js";

vi.mock("../../usermanager.js", () => ({ default: { getUser: async () => ({ id: 1 }) } }));
vi.mock("../../roommanager.js", () => ({ rooms: [] }));
vi.mock("../../infoextractor.js", () => ({ default: {} }));
vi.mock("../../rate-limit.js", () => ({ consumeRateLimitPoints: async () => true }));
vi.mock("../../auth/tokens.js", () => ({ default: { getSessionInfo: vi.fn() } }));

describe("local scan CSRF boundary with cookie authentication", () => {
	const scan = vi.fn(async () => undefined);
	const library = {
		scan,
		status: async () => ({ enabled: true, roots: [] }),
	} as unknown as LocalMediaLibrary;
	const app = express()
		.set("trust proxy", "loopback")
		.use(cookieParser())
		.use(express.json())
		.use(authTokenMiddleware)
		.use(buildLocalMediaRouter(library));
	beforeEach(() => {
		scan.mockClear();
		vi.mocked(tokens.getSessionInfo).mockResolvedValue({ isLoggedIn: true, user_id: 1 });
	});
	const post = () =>
		request(app)
			.post("/roots/fixture/scan")
			.set("Host", "music.example.test")
			.set("Cookie", "token=synthetic-owner-session");
	it.each(["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"])(
		"rejects simple %s form requests before scanning",
		async contentType => {
			await post()
				.set("Origin", "http://untrusted.example.test")
				.set("Sec-Fetch-Site", "same-site")
				.set("Content-Type", contentType)
				.send("")
				.expect(403);
			expect(scan).not.toHaveBeenCalled();
		},
	);
	it("requires the custom header even with JSON and no browser metadata", async () => {
		await post().send({}).expect(403);
		expect(scan).not.toHaveBeenCalled();
	});
	it.each([
		"http://untrusted.example.test",
		"http://music.example.test:444",
		"https://music.example.test",
		"null",
	])("rejects mismatched origin %s even with the custom header", async origin => {
		await post().set("Origin", origin).set("X-Local-Media-Scan", "1").send({}).expect(403);
		expect(scan).not.toHaveBeenCalled();
	});
	it.each(["same-site", "cross-site", "none"])("rejects fetch metadata %s", async site => {
		await post()
			.set("Sec-Fetch-Site", site)
			.set("X-Local-Media-Scan", "1")
			.send({})
			.expect(403);
		expect(scan).not.toHaveBeenCalled();
	});
	it("accepts same-origin JSON and explicit non-browser requests", async () => {
		await post()
			.set("Origin", "http://music.example.test")
			.set("Sec-Fetch-Site", "same-origin")
			.set("X-Local-Media-Scan", "1")
			.send({})
			.expect(200);
		await post().set("X-Local-Media-Scan", "1").send({}).expect(200);
		expect(scan).toHaveBeenCalledTimes(2);
		expect(scan).toHaveBeenLastCalledWith(1, "fixture");
	});
	it("honors the configured proxy protocol and preserved public host", async () => {
		await post()
			.set("X-Forwarded-Proto", "https")
			.set("Origin", "https://music.example.test")
			.set("X-Local-Media-Scan", "1")
			.send({})
			.expect(200);
		expect(scan).toHaveBeenCalledOnce();
	});
	it("keeps authenticated ownership and strict payload validation", async () => {
		await post().set("X-Local-Media-Scan", "1").send({ ownerId: 2 }).expect(400);
		vi.mocked(tokens.getSessionInfo).mockResolvedValue({
			isLoggedIn: false,
			username: "Guest",
		});
		await post().set("X-Local-Media-Scan", "1").send({}).expect(401);
		expect(scan).not.toHaveBeenCalled();
	});
});
