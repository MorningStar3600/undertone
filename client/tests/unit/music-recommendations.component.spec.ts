import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { DOMWrapper, flushPromises } from "@vue/test-utils";
import type { AxiosRequestConfig } from "axios";
import { DEFAULT_MOODS } from "ott-common/models/music";
import type { MusicRecommendation } from "ott-common/models/music-recommendations";
import { API } from "@/common-http";
import LibrarySuggestions from "@/components/music/recommendations/LibrarySuggestions.vue";
import TrackPublication from "@/components/music/recommendations/TrackPublication.vue";
import { useMusicRecommendations } from "@/composables/use-music-recommendations";
import { mountComponent } from "./component-test-utils";

const [like, focus] = DEFAULT_MOODS;
const item: MusicRecommendation = {
	id: "10000000-0000-4000-8000-000000000001",
	track: {
		id: "20000000-0000-4000-8000-000000000001",
		title: "Shared song",
		artists: [],
		styles: [],
		duration: 180,
	},
	moods: [like, focus],
};
const account = (username = "viewer") => ({ username, discordLinked: false });
describe("explicit personal music suggestions and publication", () => {
	let calls: AxiosRequestConfig[];
	let respond: (config: AxiosRequestConfig) => Promise<unknown>;
	beforeEach(() => {
		calls = [];
		respond = async config => {
			if (config.url === "/music/recommendations") {
				return { success: true, items: [item], next: item.track.id };
			}
			if (config.url?.endsWith("/adopt")) {
				return {
					success: true,
					adoption: {
						trackId: item.track.id,
						inLibrary: true,
						moodIds: config.data.moodIds,
					},
				};
			}
			if (config.url?.includes("/publications/")) {
				return { success: true, publication: { eligible: true, moods: [] } };
			}
			return {
				success: true,
				items: config.url === "/music/moods" ? DEFAULT_MOODS : [],
				total: config.url === "/music/moods" ? 5 : 0,
				offset: config.params?.offset ?? 0,
				limit: config.params?.limit ?? 20,
			};
		};
		vi.spyOn(API, "request").mockImplementation(config => {
			calls.push(config);
			return respond(config).then(data => ({ data })) as never;
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});
	it("loads only on request, requires a confirmation dialog, sends edited tags, removes success and keeps the keyset cursor", async () => {
		const { wrapper, store } = mountComponent(LibrarySuggestions);
		store.commit("LOGIN", account());
		await flushPromises();
		expect(calls.some(c => c.url === "/music/recommendations")).toBe(false);
		await wrapper.findAll(`[data-mood-id="${like.id}"]`)[0].trigger("click");
		await wrapper
			.findAll("button")
			.find(b => b.text() === "Load suggestions")!
			.trigger("click");
		await flushPromises();
		expect(calls.find(c => c.url === "/music/recommendations")?.params).toEqual({
			moods: like.id,
			limit: 20,
		});
		await wrapper
			.findAll("button")
			.find(b => b.text() === "Review suggested moods")!
			.trigger("click");
		await flushPromises();
		expect(calls.some(c => c.method === "POST")).toBe(false);
		const body = new DOMWrapper(document.body);
		expect(body.get('[role="dialog"]').text()).toContain("Add to your library?");
		await body.findAll('[role="checkbox"]')[0].trigger("click");
		await body
			.findAll("button")
			.find(b => b.text() === "Confirm and add to my library")!
			.trigger("click");
		await flushPromises();
		expect(calls.find(c => c.method === "POST")?.data).toEqual({ moodIds: [focus.id] });
		expect(wrapper.text()).not.toContain("Shared song");
		expect(wrapper.emitted("changed")).toHaveLength(1);
		await wrapper
			.findAll("button")
			.find(b => b.text() === "Next suggestions")!
			.trigger("click");
		await flushPromises();
		expect(calls.filter(c => c.url === "/music/recommendations").at(-1)?.params.after).toBe(
			item.track.id
		);
		expect(calls.some(c => /queue|room/.test(c.url ?? ""))).toBe(false);
	});
	it("shows retry on discovery errors without implicitly adopting anything", async () => {
		const normal = respond;
		let failed = false;
		respond = async config => {
			if (config.url === "/music/recommendations" && !failed) {
				failed = true;
				throw { response: { status: 429 } };
			}
			return normal(config);
		};
		const { wrapper, store } = mountComponent(LibrarySuggestions);
		store.commit("LOGIN", account());
		await flushPromises();
		await wrapper
			.findAll("button")
			.find(b => b.text() === "Load suggestions")!
			.trigger("click");
		await flushPromises();
		expect(wrapper.find('[role="alert"]').exists()).toBe(true);
		await wrapper
			.findAll("button")
			.find(b => b.text() === "Try again")!
			.trigger("click");
		await flushPromises();
		expect(wrapper.text()).toContain("Shared song");
		expect(calls.some(c => c.method === "POST")).toBe(false);
	});
	it("keeps confirmation and errors on adoption failure or an unverified membership/tag response", async () => {
		const normal = respond;
		let attempt = 0;
		respond = async config => {
			if (config.url?.endsWith("/adopt")) {
				attempt++;
				if (attempt === 1) {
					throw { response: { status: 404 } };
				}
				if (attempt === 2) {
					return {
						success: true,
						adoption: { trackId: item.track.id, inLibrary: true, moodIds: [] },
					};
				}
			}
			return normal(config);
		};
		const { wrapper, store } = mountComponent(LibrarySuggestions);
		store.commit("LOGIN", account());
		await flushPromises();
		await wrapper
			.findAll("button")
			.find(b => b.text() === "Load suggestions")!
			.trigger("click");
		await flushPromises();
		await wrapper
			.findAll("button")
			.find(b => b.text() === "Review suggested moods")!
			.trigger("click");
		await flushPromises();
		const body = new DOMWrapper(document.body);
		const confirm = () =>
			body.findAll("button").find(b => b.text() === "Confirm and add to my library")!;
		await confirm().trigger("click");
		await flushPromises();
		expect(body.get('[role="dialog"]').find('[role="alert"]').exists()).toBe(true);
		expect(wrapper.emitted("changed")).toBeUndefined();
		await confirm().trigger("click");
		await flushPromises();
		expect(wrapper.emitted("changed")).toBeUndefined();
		expect(body.find('[role="dialog"]').exists()).toBe(true);
		await confirm().trigger("click");
		await flushPromises();
		expect(wrapper.emitted("changed")).toHaveLength(1);
	});
	it("aborts late query/adoption responses across account and token resets and never auto-reloads", async () => {
		let api!: ReturnType<typeof useMusicRecommendations>;
		const changed = vi.fn();
		const Host = defineComponent({
			setup() {
				api = useMusicRecommendations(changed);
				return () => h("div");
			},
		});
		const { store } = mountComponent(Host);
		store.commit("LOGIN", account());
		await flushPromises();
		const normal = respond;
		let resolve!: (value: unknown) => void;
		respond = async config =>
			config.url === "/music/recommendations"
				? new Promise(r => {
						resolve = r;
				  })
				: normal(config);
		const query = api.load();
		await flushPromises();
		const signal = calls.find(c => c.url === "/music/recommendations")!.signal;
		store.commit("LOGIN", account("other"));
		expect(signal?.aborted).toBe(true);
		resolve({ success: true, items: [item], next: null });
		await query;
		expect(api.items.value).toEqual([]);
		expect(api.loaded.value).toBe(false);
		respond = normal;
		await api.load();
		api.choose(item);
		respond = async config =>
			config.url?.endsWith("/adopt")
				? new Promise(r => {
						resolve = r;
				  })
				: normal(config);
		const adoption = api.adopt();
		await flushPromises();
		const mutationSignal = calls.find(c => c.method === "POST")!.signal;
		store.commit("users/SET_AUTH_TOKEN", "new-fixture-token");
		expect(mutationSignal?.aborted).toBe(true);
		resolve({
			success: true,
			adoption: { trackId: item.track.id, inLibrary: true, moodIds: [like.id, focus.id] },
		});
		await adoption;
		expect(api.items.value).toEqual([]);
		expect(api.selected.value).toBeNull();
		expect(api.pending.value).toBe(false);
		expect(changed).not.toHaveBeenCalled();
		expect(calls.filter(c => c.url === "/music/recommendations")).toHaveLength(2);
	});
	it("publishes only explicitly selected known own annotations and leaves the unknown 101st annotation paginated", async () => {
		const normal = respond;
		const own = Array.from({ length: 101 }, (_, i) => ({
			...like,
			id: `30000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
			name: `Own ${i + 1}`,
		}));
		respond = async config => {
			if (config.url === `/music/tracks/${item.track.id}/moods`) {
				return {
					success: true,
					items: own.slice(
						config.params.offset,
						config.params.offset + config.params.limit
					),
					total: 101,
					offset: config.params.offset,
					limit: config.params.limit,
				};
			}
			if (config.url?.includes("/publications/") && config.method === "PUT") {
				return { success: true, publication: { eligible: true, moods: [own[0]] } };
			}
			return normal(config);
		};
		const { wrapper, store } = mountComponent(TrackPublication, {
			props: { trackId: item.track.id },
		});
		store.commit("LOGIN", account());
		await flushPromises();
		expect(calls.some(c => c.method === "PUT")).toBe(false);
		expect(wrapper.findAll('[role="checkbox"]')).toHaveLength(100);
		expect(wrapper.text()).toContain("Unloaded moods have unknown state");
		await wrapper.findAll('[role="checkbox"]')[0].trigger("click");
		await wrapper
			.findAll("button")
			.find(b => b.text() === "Publish selected own moods")!
			.trigger("click");
		await flushPromises();
		expect(calls.find(c => c.method === "PUT")?.data).toEqual({ moodIds: [own[0].id] });
		expect(
			calls.filter(c => c.url?.endsWith("/moods") && c.params?.offset === 100)
		).toHaveLength(0);
		await wrapper
			.findAll("button")
			.find(b => b.text() === "Withdraw publication")!
			.trigger("click");
		await flushPromises();
		expect(calls.some(c => c.method === "DELETE" && c.url?.includes("/publications/"))).toBe(
			true
		);
		expect(wrapper.findAll('[role="checkbox"][aria-checked="true"]')).toHaveLength(0);
	});
});
