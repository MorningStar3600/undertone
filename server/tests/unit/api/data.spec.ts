import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { main } from "../../../app.js";
import InfoExtract, { AddPreview } from "../../../infoextractor.js";
import tokens from "../../../auth/tokens.js";
import { OttException } from "ott-common/exceptions.js";
import { consumeRateLimitPoints } from "../../../rate-limit.js";

vi.mock("../../../rate-limit.js", async importOriginal => ({
	...(await importOriginal<typeof import("../../../rate-limit.js")>()),
	consumeRateLimitPoints: vi.fn(async () => true),
}));

const JSON_CONTENT_TYPE_REGEX = /json/;

describe("Data API", () => {
	let app;
	let getSessionInfoSpy;
	let validateSpy;

	beforeAll(async () => {
		getSessionInfoSpy = vi.spyOn(tokens, "getSessionInfo").mockResolvedValue({
			isLoggedIn: false,
			username: "test",
		});
		validateSpy = vi.spyOn(tokens, "validate").mockResolvedValue(true);
		app = (await main()).app;
	});

	afterAll(() => {
		getSessionInfoSpy.mockRestore();
		validateSpy.mockRestore();
	});

	it("charges the provider's search cost only when a search misses the cache", async () => {
		const resolveQuerySpy = vi
			.spyOn(InfoExtract, "resolveVideoQuery")
			.mockResolvedValue(new AddPreview([], 0));
		const cachedSpy = vi.spyOn(InfoExtract, "isSearchCached");
		const consume = vi.mocked(consumeRateLimitPoints);
		const preview = (input: string) =>
			request(app)
				.get("/api/data/previewAdd")
				.set({ Authorization: "Bearer foobar" })
				.query({ input })
				.expect(200);

		consume.mockClear();
		cachedSpy.mockResolvedValueOnce(false);
		await preview("  fresh search  ");
		expect(cachedSpy).toHaveBeenLastCalledWith("youtube", "fresh search");
		expect(consume).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 75);

		cachedSpy.mockResolvedValueOnce(true);
		await preview("fresh search");
		expect(consume).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 5);

		cachedSpy.mockClear();
		await preview("https://youtube.com/watch?v=dQw4w9WgXcQ");
		expect(cachedSpy).not.toHaveBeenCalled();
		expect(consume).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 5);

		resolveQuerySpy.mockRestore();
		cachedSpy.mockRestore();
	});

	it("GET /data/previewAdd", async () => {
		let resolveQuerySpy = vi
			.spyOn(InfoExtract, "resolveVideoQuery")
			.mockResolvedValue(new AddPreview([], 0));

		await request(app)
			.get("/api/data/previewAdd")
			.set({ Authorization: "Bearer foobar" })
			.query({ input: "test search query" })
			.expect(200)
			.expect("Content-Type", JSON_CONTENT_TYPE_REGEX)
			.then(resp => {
				expect(resp.body.success).toBe(true);
				expect(resp.body.result).toHaveLength(0);
				expect(resolveQuerySpy).toBeCalled();
			});

		resolveQuerySpy.mockRestore();
		resolveQuerySpy = vi
			.spyOn(InfoExtract, "resolveVideoQuery")
			.mockRejectedValue({ name: "UnsupportedServiceException", message: "error message" });

		await request(app)
			.get("/api/data/previewAdd")
			.set({ Authorization: "Bearer foobar" })
			.query({ input: "test search query" })
			.expect(400)
			.expect("Content-Type", JSON_CONTENT_TYPE_REGEX)
			.then(resp => {
				expect(resp.body.success).toBe(false);
				expect(resp.body.error).toBeDefined();
				expect(resolveQuerySpy).toBeCalled();
			});

		resolveQuerySpy.mockRestore();
		resolveQuerySpy = vi.spyOn(InfoExtract, "resolveVideoQuery").mockRejectedValue({
			name: "InvalidAddPreviewInputException",
			message: "error message",
		});

		await request(app)
			.get("/api/data/previewAdd")
			.set({ Authorization: "Bearer foobar" })
			.query({ input: "test search query" })
			.expect(400)
			.expect("Content-Type", JSON_CONTENT_TYPE_REGEX)
			.then(resp => {
				expect(resp.body.success).toBe(false);
				expect(resp.body.error).toBeDefined();
				expect(resolveQuerySpy).toBeCalled();
			});

		resolveQuerySpy.mockRestore();
		resolveQuerySpy = vi
			.spyOn(InfoExtract, "resolveVideoQuery")
			.mockRejectedValue({ name: "OutOfQuotaException", message: "error message" });

		await request(app)
			.get("/api/data/previewAdd")
			.set({ Authorization: "Bearer foobar" })
			.query({ input: "test search query" })
			.expect(400)
			.expect("Content-Type", JSON_CONTENT_TYPE_REGEX)
			.then(resp => {
				expect(resp.body.success).toBe(false);
				expect(resp.body.error).toBeDefined();
				expect(resolveQuerySpy).toBeCalled();
			});

		resolveQuerySpy.mockRestore();
	});

	it("GET /data/previewAdd with adapter parameter", async () => {
		const resolveQuerySpy = vi
			.spyOn(InfoExtract, "resolveVideoQuery")
			.mockResolvedValue(new AddPreview([], 0));

		await request(app)
			.get("/api/data/previewAdd")
			.set({ Authorization: "Bearer foobar" })
			.query({ input: "https://example.com/video", adapter: "direct" })
			.expect(200)
			.expect("Content-Type", JSON_CONTENT_TYPE_REGEX)
			.then(resp => {
				expect(resp.body.success).toBe(true);
				expect(resolveQuerySpy).toHaveBeenCalledWith(
					"https://example.com/video",
					expect.any(String),
					"direct",
				);
			});

		resolveQuerySpy.mockRestore();
	});

	it.each([0, 1])(
		"handles bulk previews with %i of 2 videos available and allows retry",
		async available => {
			const videos = ["https://example.com/one.mp4", "https://example.com/two.mp4"].map(
				id => ({
					service: "direct" as const,
					id,
					title: id,
				}),
			);
			const getVideoInfoSpy = vi
				.spyOn(InfoExtract.getServiceAdapter("direct"), "fetchVideoInfo")
				.mockImplementation(async id => {
					const video = videos.slice(0, available).find(video => video.id === id);
					if (!video) {
						throw new OttException("Video unavailable");
					}
					return video;
				});
			const query = { input: videos.map(video => video.id).join("\n") };
			const expectedVideos = videos.map(video => ({
				...video,
				originalReference: { service: video.service, id: video.id },
			}));
			try {
				const failed = await request(app)
					.get("/api/data/previewAdd")
					.set({ Authorization: "Bearer foobar" })
					.query(query);
				if (available === 0) {
					expect(failed.status).toBe(400);
					expect(failed.body.success).toBe(false);
					expect(failed.headers["cache-control"]).toBeUndefined();
				} else {
					expect(failed.status).toBe(200);
					expect(failed.body.success).toBe(true);
					expect(failed.body.result).toContainEqual(expectedVideos[0]);
					expect(failed.headers["cache-control"]).toBe("no-store");
				}

				getVideoInfoSpy.mockImplementation(
					async id => videos.find(video => video.id === id)!,
				);
				const retried = await request(app)
					.get("/api/data/previewAdd")
					.set({ Authorization: "Bearer foobar" })
					.query(query);
				expect(retried.status).toBe(200);
				expect(retried.body.result).toEqual(expectedVideos);
				expect(retried.headers["cache-control"]).toContain("max-age=3600");
			} finally {
				getVideoInfoSpy.mockRestore();
			}
		},
	);
});
