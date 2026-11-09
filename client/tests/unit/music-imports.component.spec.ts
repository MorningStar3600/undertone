import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { flushPromises } from "@vue/test-utils";
import type { AxiosRequestConfig } from "axios";
import { API } from "@/common-http";
import LibraryImports from "@/components/music/imports/LibraryImports.vue";
import { useMusicImports } from "@/composables/use-music-imports";
import { mountComponent } from "./component-test-utils";
import type { MusicImportSource } from "ott-common/models/music-imports";

const source: MusicImportSource = {
	id: "10000000-0000-4000-8000-000000000001",
	service: "youtube",
	daily: false,
	removed: false,
	nextRunAt: null,
	lastSuccessAt: null,
	lastCompletionAt: null,
	lastJob: null,
};
const account = (username = "viewer") => ({ username, discordLinked: false });
describe("personal playlist import management", () => {
	let calls: AxiosRequestConfig[];
	let respond: (config: AxiosRequestConfig) => Promise<unknown>;
	beforeEach(() => {
		calls = [];
		respond = async config =>
			config.method === "GET"
				? {
						success: true,
						items: config.url === "/music/imports/sources" ? [source] : [],
						total: config.url === "/music/imports/sources" ? 41 : 0,
						offset: config.params.offset,
						limit: config.params.limit,
					}
				: { success: true };
		vi.spyOn(API, "request").mockImplementation(config => {
			calls.push(config);
			return respond(config).then(data => ({ data })) as never;
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});
	it("sends explicit typed source/run/schedule/cancel/stop commands, with bounded pages and no queue requests", async () => {
		const { wrapper, store, unmount } = mountComponent(LibraryImports);
		store.commit("LOGIN", account());
		await flushPromises();
		expect(calls.filter(c => c.url === "/music/imports/sources")).toHaveLength(1);
		await wrapper.get("input").setValue("https://youtube.com/playlist?list=PLexample");
		await wrapper.get("form").trigger("submit");
		await flushPromises();
		expect(calls.find(c => c.method === "POST")?.data).toEqual({
			url: "https://youtube.com/playlist?list=PLexample",
		});
		await wrapper
			.findAll("button")
			.find(b => b.text() === "Run now")!
			.trigger("click");
		await flushPromises();
		expect(
			calls.some(
				c => c.method === "POST" && c.url === `/music/imports/sources/${source.id}/run`,
			),
		).toBe(true);
		await wrapper.get('[role="switch"]').trigger("click");
		await flushPromises();
		expect(
			calls.some(
				c => c.method === "PUT" && c.url?.endsWith("/schedule") && c.data.daily === true,
			),
		).toBe(true);
		await wrapper
			.findAll("button")
			.find(b => b.text() === "Run history")!
			.trigger("click");
		await flushPromises();
		expect(calls.some(c => c.url?.endsWith("/jobs") && c.params.limit === 20)).toBe(true);
		await wrapper
			.findAll("button")
			.find(b => b.text() === "Next")!
			.trigger("click");
		await flushPromises();
		expect(calls.some(c => c.url === "/music/imports/sources" && c.params?.offset === 20)).toBe(
			true,
		);
		expect(calls.some(c => c.params?.offset === 40)).toBe(false);
		await wrapper
			.findAll("button")
			.find(b => b.text() === "Stop source")!
			.trigger("click");
		await flushPromises();
		expect(
			calls.some(
				c => c.method === "DELETE" && c.url === `/music/imports/sources/${source.id}`,
			),
		).toBe(true);
		expect(
			calls.every(
				c =>
					!c.url?.includes("queue") &&
					!c.url?.includes("room") &&
					!JSON.stringify(c.data ?? {}).includes("userId"),
			),
		).toBe(true);
		unmount();
	});
	it("aborts stale account/token requests and clears reports without silently draining pages", async () => {
		let api!: ReturnType<typeof useMusicImports>;
		const Host = defineComponent({
			setup() {
				api = useMusicImports(() => undefined);
				return () => h("div");
			},
		});
		const { store, unmount } = mountComponent(Host);
		store.commit("LOGIN", account());
		await flushPromises();
		api.selected.value = source.id;
		await flushPromises();
		let release!: (value: unknown) => void;
		respond = config =>
			config.method === "POST"
				? new Promise(resolve => {
						release = resolve;
					})
				: Promise.resolve({ success: true, items: [], total: 0, offset: 0, limit: 20 });
		const work = api.run(source.id);
		await flushPromises();
		const request = calls.at(-1)!;
		store.commit("LOGIN", account("second"));
		expect(request.signal?.aborted).toBe(true);
		expect(api.sources.items.value).toEqual([]);
		expect(api.jobs.items.value).toEqual([]);
		expect(api.selected.value).toBeNull();
		release({ success: true });
		await work;
		store.commit("users/SET_AUTH_TOKEN", "new-test-token");
		await flushPromises();
		expect(api.sources.items.value).toEqual([]);
		expect(api.pending.value).toBe(false);
		const latest = calls.at(-1)!;
		unmount();
		expect(latest.signal?.aborted).toBe(true);
	});
	it("renders partial progress and allows a saved-progress retry without exposing provider details", async () => {
		respond = async config => ({
			success: true,
			items:
				config.url === "/music/imports/sources"
					? [
							{
								...source,
								lastJob: {
									id: "job",
									sourceId: source.id,
									status: "failed",
									pages: 3,
									processed: 102,
									added: 90,
									existing: 10,
									unavailable: 2,
									failures: 5,
									retryCount: 5,
									error: "provider",
									completedAt: 123,
									createdAt: 1,
									nextAttemptAt: 456,
								},
							},
						]
					: [],
			total: 1,
			offset: 0,
			limit: 20,
		});
		const { wrapper, store, unmount } = mountComponent(LibraryImports);
		store.commit("LOGIN", account());
		await flushPromises();
		expect(wrapper.text()).toContain("102 entries");
		expect(wrapper.text()).toContain("2 unavailable");
		await wrapper
			.findAll("button")
			.find(b => b.text() === "Retry from saved progress")!
			.trigger("click");
		await flushPromises();
		expect(calls.some(c => c.method === "POST" && c.url?.endsWith("/run"))).toBe(true);
		await wrapper
			.findAll("button")
			.find(b => b.text() === "Cancel run")!
			.trigger("click");
		await flushPromises();
		expect(calls.some(c => c.method === "POST" && c.url?.endsWith("/cancel"))).toBe(true);
		unmount();
	});
});
