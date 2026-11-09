import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { API } from "@/common-http";
import LocalLibrary from "@/components/music/LocalLibrary.vue";
import { mountComponent } from "./component-test-utils";
import type { LocalMediaStatus } from "ott-common/models/local-media";

describe("local library operator configuration UI", () => {
	let status: LocalMediaStatus;
	beforeEach(() => {
		status = { enabled: true, reason: null, roots: [] };
		vi.spyOn(API, "request").mockImplementation(
			async config =>
				({
					data: config.url?.startsWith("/local-media")
						? { success: true, ...status }
						: { success: true, items: [], total: 0, offset: 0, limit: 20 },
				}) as never,
		);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});
	it("explains no configured roots and never asks for a directory or owner", async () => {
		const { wrapper, store, unmount } = mountComponent(LocalLibrary);
		store.commit("LOGIN", { username: "owner", discordLinked: false });
		await flushPromises();
		expect(wrapper.text()).toContain("No audio folders are configured");
		expect(wrapper.findAll("input")).toHaveLength(0);
		expect(vi.mocked(API.request).mock.calls.some(([config]) => config.method === "POST")).toBe(
			false,
		);
		unmount();
	});
	it("runs only the configured root ID and clears statuses on logout", async () => {
		status.roots = [
			{ id: "collection", status: "idle", processed: 0, available: 0, completedAt: null },
		];
		const { wrapper, store, unmount } = mountComponent(LocalLibrary);
		store.commit("LOGIN", { username: "owner", discordLinked: false });
		await flushPromises();
		await wrapper
			.findAll("button")
			.find(button => button.text() === "Scan library")!
			.trigger("click");
		await flushPromises();
		expect(API.request).toHaveBeenCalledWith(
			expect.objectContaining({
				method: "POST",
				url: "/local-media/roots/collection/scan",
				data: {},
				headers: { "X-Local-Media-Scan": "1" },
				signal: expect.any(AbortSignal),
			}),
		);
		expect(wrapper.emitted("changed")).toHaveLength(1);
		store.commit("LOGOUT");
		await flushPromises();
		expect(wrapper.text()).not.toContain("collection");
		unmount();
	});
	it("disables the local path on balancer instances", async () => {
		status = { enabled: false, reason: "balancer", roots: [] };
		const { wrapper, store, unmount } = mountComponent(LocalLibrary, {
			props: { select: true },
		});
		store.commit("LOGIN", { username: "owner", discordLinked: false });
		await flushPromises();
		expect(wrapper.text()).toContain("disabled on clustered instances");
		expect(wrapper.findAll("button").some(button => button.text() === "Scan library")).toBe(
			false,
		);
		unmount();
	});
});
