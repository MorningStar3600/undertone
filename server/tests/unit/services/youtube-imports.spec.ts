import { describe, expect, it, vi } from "vitest";
import YouTubeAdapter from "../../../services/youtube.js";
import { ServiceAdapter } from "../../../serviceadapter.js";
import type { RedisClientType } from "redis";

const entry = (id: string, privacyStatus = "public") => ({
	status: { privacyStatus },
	snippet: { resourceId: { videoId: id } },
});
const video = (id: string) => ({
	id,
	snippet: { title: "Track", liveBroadcastContent: "none" },
	contentDetails: { duration: "PT3M" },
	status: { privacyStatus: "public", embeddable: true, uploadStatus: "processed" },
});
describe("YouTube full playlist reference pages", () => {
	it("requests nextPageToken and full bounded metadata pages independently of previews", async () => {
		const adapter = new YouTubeAdapter("mock-key", {} as RedisClientType);
		const get = vi.spyOn(adapter.api, "get");
		get.mockResolvedValueOnce({
			data: {
				nextPageToken: "page2",
				items: Array.from({ length: 50 }, (_, i) => entry(`v-${i}`)),
			},
		})
			.mockResolvedValueOnce({
				data: { items: Array.from({ length: 50 }, (_, i) => video(`v-${i}`)) },
			})
			.mockResolvedValueOnce({
				data: {
					items: [
						entry("last"),
						entry("private", "private"),
						entry("deleted", "privacyStatusUnspecified"),
						entry("missing"),
						entry("live"),
					],
				},
			})
			.mockResolvedValueOnce({
				data: {
					items: [
						video("last"),
						{
							...video("live"),
							snippet: { title: "Live", liveBroadcastContent: "live" },
						},
					],
				},
			});
		const signal = new AbortController().signal;
		const first = await adapter.fetchCollectionPage("PLmock", null, signal);
		const second = await adapter.fetchCollectionPage("PLmock", first.nextCursor, signal);
		expect(first.entries).toHaveLength(50);
		expect(second.entries).toHaveLength(1);
		expect(second.unavailable).toBe(4);
		expect(second.nextCursor).toBeNull();
		expect(get.mock.calls[2][1]).toMatchObject({
			signal,
			timeout: 15000,
			params: { key: "mock-key", pageToken: "page2", maxResults: 50 },
		});
		expect(get.mock.calls[0][1]?.params.fields).toContain("nextPageToken");
		expect(second.entries[0].reference).toEqual({ service: "youtube", id: "last" });
		expect(new ServiceAdapter().supportsCollectionPagination).toBe(false);
	});
	it("does not silently truncate malformed pages or fall back on provider failure", async () => {
		const adapter = new YouTubeAdapter("mock-key", {} as RedisClientType);
		const get = vi
			.spyOn(adapter.api, "get")
			.mockResolvedValueOnce({
				data: { items: Array.from({ length: 51 }, () => entry("a")) },
			})
			.mockRejectedValueOnce(new Error("provider rejected"));
		await expect(
			adapter.fetchCollectionPage("PLmock", null, new AbortController().signal),
		).rejects.toThrow();
		await expect(
			adapter.fetchCollectionPage("PLmock", null, new AbortController().signal),
		).rejects.toThrow("provider rejected");
		expect(get).toHaveBeenCalledTimes(2);
	});
});
