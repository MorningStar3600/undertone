import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import extractor from "../../infoextractor.js";
import InvidiousAdapter from "../../services/invidious.js";
import storage from "../../storage.js";
import dataApi from "../../api/data.js";
import type { Video, VideoId } from "ott-common/models/video.js";
import { MusicCatalogue } from "../../music/catalogue.js";
import { createCatalogueFixture } from "./music-test-helpers.js";

vi.mock("../../rate-limit.js", () => ({ consumeRateLimitPoints: vi.fn(async () => true) }));

describe("Original preview references through adapter aliases", () => {
	let adapter: InvidiousAdapter;
	const ref = (id: string): VideoId => ({ service: "invidious", id: `inv.example:${id}` });
	beforeEach(() => {
		adapter = new InvidiousAdapter();
		adapter.allowedHosts = ["inv.example"];
		vi.spyOn(extractor, "getServiceAdapter").mockReturnValue(adapter);
		vi.spyOn(extractor, "getServiceAdapterForURL").mockReturnValue(adapter);
		vi.spyOn(extractor, "getCachedVideo").mockImplementation(async (service, id) => [
			{ service, id },
			["title"],
		]);
		vi.spyOn(storage, "getManyVideoInfo").mockImplementation(async ids =>
			ids.map(id => ({ ...id })),
		);
		vi.spyOn(storage, "getVideoInfoFields").mockReturnValue(["title"]);
		vi.spyOn(storage, "updateVideoInfo").mockResolvedValue(true);
		vi.spyOn(extractor, "updateCache").mockResolvedValue();
		// Actual parseAsDirect/probeManifest code, with transport fixture responses only.
		vi.spyOn(adapter.api, "get").mockImplementation(async url => {
			if (url.includes("missing")) {
				throw new Error("Fixture unavailable");
			}
			if (url.includes("/api/v1/videos/")) {
				return { data: { title: "Same title", lengthSeconds: 180, formatStreams: [] } };
			}
			if (url.includes("/hls/id/hls")) {
				return {
					data: "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\nvariant.m3u8\n",
				};
			}
			if (url.includes("/dash/id/dash")) {
				return {
					data: '<MPD><Period><AdaptationSet><Representation bandwidth="3000000" width="1920" height="1080" /></AdaptationSet></Period></MPD>',
				};
			}
			throw new Error("Fixture manifest unavailable");
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});
	it.each(["direct", "hls", "dash"])(
		"retains provider identity alongside playable %s metadata",
		async kind => {
			const preview = await extractor.resolveVideoQuery(
				`https://inv.example/watch?v=${kind}`,
				"invidious",
			);
			expect(preview.videos[0]).toMatchObject({
				service: kind,
				originalReference: ref(kind),
				title: "Same title",
			});
			expect(preview.videos[0].id).toContain("https://inv.example/");
			expect(preview.videos[0].id).not.toBe(ref(kind).id);
		},
	);
	it("matches batch aliases by original service and ID across missing, reordered and duplicate-title results", async () => {
		const fetch = adapter.fetchManyVideoInfo.bind(adapter);
		vi.spyOn(adapter, "fetchManyVideoInfo").mockImplementation(async requests =>
			(await fetch(requests)).reverse(),
		);
		const preview = await extractor.resolveVideoQuery(
			"https://inv.example/watch?v=missing\nhttps://inv.example/watch?v=hls\nhttps://inv.example/watch?v=direct",
			"invidious",
		);
		expect(preview.cacheDuration).toBe(0);
		expect(preview.videos.map(v => v.originalReference)).toEqual([
			ref("missing"),
			ref("hls"),
			ref("direct"),
		]);
		expect(preview.videos[0].title).toBeUndefined();
		expect(preview.videos[1].service).toBe("hls");
		expect(preview.videos[2].service).toBe("direct");
	});
	it("preserves collection and highlighted aliases in the legacy HTTP response", async () => {
		vi.spyOn(adapter, "isCollectionURL").mockReturnValue(true);
		vi.spyOn(adapter, "resolveURL").mockResolvedValue({
			videos: [ref("direct"), ref("hls")],
			highlighted: ref("dash"),
		});
		const app = express().use(dataApi);
		const response = await request(app)
			.get("/previewAdd")
			.query({ input: "https://inv.example/collection" })
			.expect(200);
		expect(response.body.result.map((v: Video) => v.originalReference)).toEqual([
			ref("direct"),
			ref("hls"),
		]);
		expect(response.body.highlighted).toMatchObject({
			service: "dash",
			originalReference: ref("dash"),
		});
		expect(response.headers["cache-control"]).toContain("public");
	});
	it("keeps identity on cached search and cached metadata, and preserves generic direct inputs", async () => {
		vi.spyOn(extractor, "getCachedSearchResults").mockResolvedValue([ref("hls")]);
		vi.spyOn(adapter, "searchVideos").mockRejectedValue(new Error("Must use cache"));
		expect((await extractor.searchVideos("invidious", "cached query"))[0]).toMatchObject({
			service: "hls",
			originalReference: ref("hls"),
		});
		const direct = { service: "direct" as const, id: "https://media.example/song.mp3" };
		vi.mocked(extractor.getCachedVideo).mockResolvedValue([{ ...direct, title: "Song" }, []]);
		vi.spyOn(adapter, "postProcessVideo").mockImplementation(video => video);
		expect(await extractor.getVideoInfo(direct.service, direct.id)).toMatchObject({
			...direct,
			originalReference: direct,
		});
	});
	it("caches fresh search references before alias resolution", async () => {
		vi.spyOn(extractor, "getCachedSearchResults").mockResolvedValue([]);
		const references = [ref("missing"), ref("hls")];
		vi.spyOn(adapter, "searchVideos").mockResolvedValue(references);
		const cache = vi.spyOn(extractor, "cacheSearchResults").mockResolvedValue();
		const videos = await extractor.searchVideos("invidious", "fresh query");
		expect(videos[1]).toMatchObject({ service: "hls", originalReference: ref("hls") });
		expect(cache).toHaveBeenCalledWith("invidious", "fresh query", references);
		expect(references).toEqual([ref("missing"), ref("hls")]);
	});
	it("never accepts originalReference as a catalogue grant and never merges same-title recordings", async () => {
		const fixture = await createCatalogueFixture();
		try {
			const catalogue = new MusicCatalogue(
				() => fixture.connection,
				() => fixture.models,
			);
			const studio = await catalogue.resolveTrack(ref("direct"));
			const live = await catalogue.resolveTrack(ref("hls"));
			expect(studio.track.title).toBe(live.track.title);
			expect(studio.track.id).not.toBe(live.track.id);
			expect(studio.source.providerId).toBe(ref("direct").id);
			expect((await catalogue.toQueueItem(studio.track.id, studio.source.id)).service).toBe(
				"direct",
			);
			const transport = vi.mocked(adapter.api.get).getMockImplementation()!;
			vi.mocked(adapter.api.get).mockImplementation(async (url, config) =>
				url.includes("/hls/id/direct")
					? { data: "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nvariant.m3u8\n" }
					: transport(url, config),
			);
			expect((await catalogue.toQueueItem(studio.track.id, studio.source.id)).service).toBe(
				"hls",
			);
			expect((await catalogue.resolveTrack(ref("direct"))).source.id).toBe(studio.source.id);
			await expect(
				catalogue.resolveTrack({
					service: "direct",
					id: "file:///private/song",
					originalReference: ref("direct"),
				} as Video),
			).rejects.toThrow();
		} finally {
			await fixture.connection.close();
		}
	});
	it.each(["file:///private/music", "https://user:synthetic-secret@media.example/music"])(
		"omits unsafe original reference %s from generic preview metadata",
		async id => {
			vi.spyOn(extractor, "resolveVideoQuery").mockResolvedValue({
				videos: [
					{
						service: "direct",
						id: "https://media.example/play",
						originalReference: { service: "direct", id },
					},
				],
				cacheDuration: 0,
			});
			const response = await request(express().use(dataApi))
				.get("/previewAdd")
				.query({ input: "safe query" })
				.expect(200);
			expect(response.body.result[0]).not.toHaveProperty("originalReference");
			expect(JSON.stringify(response.body)).not.toContain("/private/music");
			expect(JSON.stringify(response.body)).not.toContain("synthetic-secret");
		},
	);
});
