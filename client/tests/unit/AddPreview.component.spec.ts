import { beforeEach, describe, expect, it, vi } from "vitest";
import AddPreview from "@/components/AddPreview.vue";
import MusicPreview from "@/components/music/MusicPreview.vue";
import { QueueMode } from "ott-common/models/types";
import { flush, mountComponent } from "./component-test-utils";

const { API } = vi.hoisted(() => ({
	API: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock("@/common-http", () => ({ API }));

describe("AddPreview component", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("immediately makes a single query if given a URL", async () => {
		API.get.mockResolvedValueOnce({
			data: {
				success: true,
				result: [
					{ service: "youtube", id: "1", title: "Foo", description: "Bar", length: 100 },
				],
			},
		});
		const { wrapper, store } = mountComponent(AddPreview);
		store.state.production = true;

		store.state.production = true;
		await wrapper.vm.$nextTick();
		await wrapper
			.get('[data-cy="add-preview-input"]')
			.setValue("https://youtube.com/watch?v=LP8GRjv6AIo");
		await new Promise(resolve => setTimeout(resolve, 1100));
		await flush();

		expect(API.get).toHaveBeenCalledWith(
			"/data/previewAdd?input=https%3A%2F%2Fyoutube.com%2Fwatch%3Fv%3DLP8GRjv6AIo",
		);
		expect(wrapper.findAll(".video")).toHaveLength(1);
	});

	it("does not query non-URLs until manual search", async () => {
		API.get.mockResolvedValueOnce({
			data: {
				success: true,
				result: [
					{ service: "youtube", id: "1", title: "Foo", description: "Bar", length: 100 },
				],
			},
		});
		const { wrapper, store } = mountComponent(AddPreview);
		store.state.production = true;

		store.state.production = true;
		await wrapper.vm.$nextTick();
		await wrapper.get('[data-cy="add-preview-input"]').setValue("foo");
		await flush();
		expect(API.get).not.toHaveBeenCalled();

		await wrapper.get('[data-cy="add-preview-manual-search"]').trigger("click");
		await flush();

		expect(API.get).toHaveBeenCalledWith("/data/previewAdd?input=foo");
		expect(wrapper.findAll(".video")).toHaveLength(1);
	});

	it("does not show test videos in prod environment", async () => {
		const { wrapper, store } = mountComponent(AddPreview);
		store.state.production = true;
		await wrapper.vm.$nextTick();

		expect(wrapper.find('[data-cy="test-video"]').exists()).toBe(false);
	});

	it("keeps stable provider references for individual music previews and removes bulk admission", async () => {
		API.get.mockResolvedValueOnce({
			data: {
				success: true,
				result: [
					{ service: "youtube", id: "original", title: "Track" },
					{ service: "vimeo", id: "second", title: "Other" },
				],
			},
		});
		const { wrapper, store } = mountComponent(AddPreview);
		store.commit("room/SYNC", { queueMode: QueueMode.Music });
		await wrapper.get('[data-cy="add-preview-input"]').setValue("search");
		await wrapper.get('[data-cy="add-preview-manual-search"]').trigger("click");
		await flush();
		await flush();
		expect(wrapper.findAllComponents(MusicPreview)).toHaveLength(2);
		expect(wrapper.findAllComponents(MusicPreview)[0].props("reference")).toEqual({
			service: "youtube",
			id: "original",
		});
		expect(wrapper.text()).not.toContain("Add all");
		expect(wrapper.findAll(".video")).toHaveLength(0);
		expect(API.post).not.toHaveBeenCalled();
	});

	it.each(["direct", "hls", "dash", "odysee"])(
		"does not invent catalogue identity from an ephemeral %s preview",
		async service => {
			API.get.mockResolvedValueOnce({
				data: {
					success: true,
					result: [
						{
							service,
							id: "https://cdn.example.org/temporary-stream",
							title: "Resolved track",
						},
					],
				},
			});
			const { wrapper, store } = mountComponent(AddPreview);
			store.commit("room/SYNC", { queueMode: QueueMode.Music });
			await wrapper.get('[data-cy="add-preview-input"]').setValue("search");
			await wrapper.get('[data-cy="add-preview-manual-search"]').trigger("click");
			await flush();
			await flush();
			expect(wrapper.getComponent(MusicPreview).props("reference")).toBeUndefined();
			expect(wrapper.get('[data-cy="music-add-mix"]').attributes("disabled")).toBeDefined();
			expect(API.post).not.toHaveBeenCalled();
		},
	);
	it.each(["direct", "hls", "dash", "odysee"])(
		"uses a returned original reference for transformed %s previews",
		async service => {
			const originalReference = { service: "invidious", id: "inv.example:studio" };
			API.get.mockResolvedValueOnce({
				data: {
					success: true,
					result: [
						{
							service,
							id: "https://cdn.example/rotating-stream",
							title: "Same title",
							originalReference,
						},
					],
				},
			});
			const { wrapper, store } = mountComponent(AddPreview);
			store.commit("room/SYNC", { queueMode: QueueMode.Music });
			await wrapper.get('[data-cy="add-preview-input"]').setValue("search");
			await wrapper.get('[data-cy="add-preview-manual-search"]').trigger("click");
			await flush();
			await flush();
			expect(wrapper.getComponent(MusicPreview).props("reference")).toEqual(
				originalReference,
			);
		},
	);
	it("preserves a highlighted original identity separately from a collection with matching titles", async () => {
		const highlighted = {
			service: "dash",
			id: "https://cdn.example/highlight",
			title: "Same title",
			originalReference: { service: "invidious", id: "inv.example:live" },
		};
		const item = {
			service: "direct",
			id: "https://cdn.example/other",
			title: "Same title",
			originalReference: { service: "invidious", id: "inv.example:studio" },
		};
		API.get.mockResolvedValueOnce({ data: { success: true, result: [item], highlighted } });
		const { wrapper, store } = mountComponent(AddPreview);
		store.commit("room/SYNC", { queueMode: QueueMode.Music });
		await wrapper.get('[data-cy="add-preview-input"]').setValue("collection search");
		await wrapper.get('[data-cy="add-preview-manual-search"]').trigger("click");
		await flush();
		await flush();
		expect(wrapper.findAllComponents(MusicPreview).map(p => p.props("reference"))).toEqual([
			highlighted.originalReference,
			item.originalReference,
		]);
	});
});
