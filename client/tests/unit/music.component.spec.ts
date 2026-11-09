import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref } from "vue";
import { flushPromises } from "@vue/test-utils";
import type { AxiosRequestConfig } from "axios";
import { API } from "@/common-http";
import { DEFAULT_MOODS, type Mood, type LibraryTrack } from "ott-common/models/music";
import { useMusic, useMusicAnnotations, useMusicPage } from "@/composables/use-music";
import { MUSIC_MAX_OFFSET } from "@/util/music-api";
import TrackMoods from "@/components/music/TrackMoods.vue";
import MoodPicker from "@/components/music/MoodPicker.vue";
import MusicFavorites from "@/components/music/MusicFavorites.vue";
import MusicPagination from "@/components/music/MusicPagination.vue";
import LibraryImport from "@/components/music/LibraryImport.vue";
import Library from "@/views/Library.vue";
import { mountComponent } from "./component-test-utils";

const [like, focus, energetic] = DEFAULT_MOODS;
const custom: Mood = {
	id: "00000000-0000-4000-8000-000000000099",
	name: "dreamy",
	normalizedName: "dreamy",
	iconKey: "moon",
};
const trackA = "10000000-0000-4000-8000-000000000001";
const trackB = "10000000-0000-4000-8000-000000000002";
const entry: LibraryTrack = {
	track: { id: trackA, title: "", artists: [], styles: [], duration: null, artworkUrl: null },
	sources: [
		{
			id: "source",
			trackId: trackA,
			service: "youtube",
			availability: "unknown",
			capabilities: { seek: false, backgroundPlayback: "unknown" },
		},
	],
	addedAt: "2026-11-09",
	importKind: "reference",
};
const account = (username = "viewer") => ({ username, discordLinked: false });
const pageResponse = (items: unknown[], config?: AxiosRequestConfig, total = items.length) => ({
	success: true,
	items,
	total,
	offset: config?.params?.offset ?? 0,
	limit: config?.params?.limit ?? 20,
});
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("personal music API integration", () => {
	let tags: Record<string, Mood[]>;
	let favorites: Mood[];
	let calls: AxiosRequestConfig[];
	let respond: (config: AxiosRequestConfig) => unknown | Promise<unknown>;
	beforeEach(() => {
		tags = { [trackA]: [like, custom], [trackB]: [] };
		favorites = [like, focus];
		calls = [];
		respond = config => {
			if (config.method !== "GET") {
				return { success: true };
			}
			if (config.url === "/music/favorites") {
				return pageResponse(favorites, config);
			}
			if (config.url === "/music/moods") {
				return pageResponse([...DEFAULT_MOODS, custom], config);
			}
			if (config.url === "/music/library") {
				return pageResponse([entry], config);
			}
			return pageResponse(tags[config.url?.split("/")[3] ?? ""] ?? [], config);
		};
		vi.spyOn(API, "request").mockImplementation(config => {
			calls.push(config);
			return Promise.resolve(respond(config)).then(data => ({ data })) as never;
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("groups and deduplicates moods; only viewer tags are pressed, including nonfavorites", async () => {
		const { wrapper, store } = mountComponent(TrackMoods, {
			props: { trackId: trackA, contributorMoodIds: [energetic.id, like.id, like.id] },
		});
		store.commit("LOGIN", account());
		await flushPromises();
		expect(wrapper.findAll(`[data-mood-id="${like.id}"]`)).toHaveLength(1);
		expect(wrapper.get(`[data-mood-id="${energetic.id}"]`).attributes("aria-pressed")).toBe(
			"false",
		);
		expect(wrapper.get(`[data-mood-id="${like.id}"]`).attributes("aria-pressed")).toBe("true");
		expect(wrapper.get(`[data-mood-id="${custom.id}"]`).attributes("aria-pressed")).toBe(
			"true",
		);
		expect(wrapper.get(`[data-mood-id="${focus.id}"]`).attributes("aria-pressed")).toBe(
			"false",
		);
		expect(calls.every(c => !c.url?.includes("user"))).toBe(true);
	});

	it("keeps confirmed tag state on write failure and retries the same idempotent method", async () => {
		const { wrapper, store } = mountComponent(TrackMoods, {
			props: { trackId: trackA, contributorMoodIds: [] },
		});
		store.commit("LOGIN", account());
		await flushPromises();
		const original = respond;
		let fail = true;
		respond = config => {
			if (config.method === "DELETE" && fail) {
				return Promise.reject({ response: { status: 500 } });
			}
			return original(config);
		};
		await wrapper.get(`[data-mood-id="${like.id}"]`).trigger("click");
		await flushPromises();
		expect(wrapper.get(`[data-mood-id="${like.id}"]`).attributes("aria-pressed")).toBe("true");
		expect(wrapper.text()).toContain("Try again");
		fail = false;
		await wrapper
			.findAll("button")
			.find(b => b.text() === "Try again")!
			.trigger("click");
		await flushPromises();
		expect(wrapper.get(`[data-mood-id="${like.id}"]`).attributes("aria-pressed")).toBe("false");
		expect(calls.filter(c => c.method === "DELETE")).toHaveLength(2);
		expect(
			calls
				.filter(c => c.method === "DELETE")
				.every(c => c.data && Object.keys(c.data).length === 0),
		).toBe(true);
		expect(calls.some(c => c.method === "DELETE" && c.url?.includes("favorites"))).toBe(false);
	});

	it("removes a favorite without touching tags, and shares the change with annotations", async () => {
		const Host = defineComponent({
			setup: () => () =>
				h("div", [
					h(TrackMoods, { trackId: trackA, contributorMoodIds: [] }),
					h(MusicFavorites),
				]),
		});
		const { wrapper, store } = mountComponent(Host);
		store.commit("LOGIN", account());
		await flushPromises();
		const annotation = wrapper.getComponent(TrackMoods);
		await wrapper
			.getComponent(MusicFavorites)
			.findAll(`[data-mood-id="${like.id}"]`)[0]
			.trigger("click");
		await flushPromises();
		expect(calls.filter(c => c.method === "DELETE").map(c => c.url)).toEqual([
			`/music/favorites/${like.id}`,
		]);
		expect(annotation.get(`[data-mood-id="${like.id}"]`).attributes("aria-pressed")).toBe(
			"true",
		);
	});

	it("ignores a delayed tag read from the previous track", async () => {
		const delayed = deferred<unknown>();
		const original = respond;
		respond = config =>
			config.url === `/music/tracks/${trackA}/moods` ? delayed.promise : original(config);
		const { wrapper, store } = mountComponent(TrackMoods, {
			props: { trackId: trackA, contributorMoodIds: [] },
		});
		store.commit("LOGIN", account());
		await wrapper.setProps({ trackId: trackB });
		await flushPromises();
		delayed.resolve(pageResponse([custom]));
		await flushPromises();
		expect(wrapper.find(`[data-mood-id="${custom.id}"]`).exists()).toBe(false);
		expect(calls.find(c => c.url === `/music/tracks/${trackA}/moods`)?.signal?.aborted).toBe(
			true,
		);
	});

	it("does not apply an old track's pending mutation to a new track", async () => {
		const delayed = deferred<unknown>();
		const { wrapper, store } = mountComponent(TrackMoods, {
			props: { trackId: trackA, contributorMoodIds: [] },
		});
		store.commit("LOGIN", account());
		await flushPromises();
		const original = respond;
		respond = config => (config.method === "PUT" ? delayed.promise : original(config));
		await wrapper.get(`[data-mood-id="${focus.id}"]`).trigger("click");
		await wrapper.setProps({ trackId: trackB });
		await flushPromises();
		delayed.resolve({ success: true });
		await flushPromises();
		expect(wrapper.get(`[data-mood-id="${focus.id}"]`).attributes("aria-pressed")).toBe(
			"false",
		);
	});

	it("aborts and clears private pages synchronously on logout and account replacement", async () => {
		let music!: ReturnType<typeof useMusic>;
		const Host = defineComponent({
			setup() {
				music = useMusic();
				return () => h("div");
			},
		});
		const { store } = mountComponent(Host);
		store.commit("LOGIN", account("A"));
		await flushPromises();
		expect(music.favorites.items.value).toHaveLength(2);
		const delayed = deferred<unknown>();
		respond = () => delayed.promise;
		const loading = music.favorites.load();
		store.commit("LOGOUT");
		expect(music.favorites.items.value).toEqual([]);
		expect(calls.at(-1)?.signal?.aborted).toBe(true);
		const count = calls.length;
		await music.favorites.load();
		expect(calls).toHaveLength(count);
		favorites = [];
		respond = config => pageResponse([], config);
		store.commit("LOGIN", account("B"));
		await flushPromises();
		delayed.resolve(pageResponse([custom]));
		await loading;
		expect(music.favorites.items.value).toEqual([]);
		store.commit("LOGIN", account("C"));
		expect(music.favorites.items.value).toEqual([]);
	});

	it("never fetches privately as a guest and locks requests after a 401", async () => {
		const { wrapper, store } = mountComponent(Library);
		await flushPromises();
		expect(calls).toEqual([]);
		expect(wrapper.text()).toContain("Sign in");
		respond = () => Promise.reject({ response: { status: 401 } });
		store.commit("LOGIN", account());
		await flushPromises();
		expect(wrapper.text()).toContain("session has expired");
		expect(wrapper.findComponent(LibraryImport).exists()).toBe(false);
		const count = calls.length;
		await flushPromises();
		expect(calls).toHaveLength(count);
	});

	it("loads only requested library pages, retains retry offset, and enforces the server boundary", async () => {
		let music!: ReturnType<typeof useMusic>;
		let page!: ReturnType<typeof useMusicPage<LibraryTrack>>;
		const Host = defineComponent({
			setup() {
				music = useMusic();
				page = useMusicPage<LibraryTrack>(music, () => "/library");
				return () => h("div");
			},
		});
		const { store } = mountComponent(Host);
		respond = config => pageResponse([entry], config, 12000);
		store.commit("LOGIN", account());
		await flushPromises();
		expect(calls.filter(c => c.url === "/music/library")).toHaveLength(1);
		await page.load(20);
		expect(page.offset.value).toBe(20);
		respond = () => Promise.reject({ response: { status: 429 } });
		await page.load(40);
		expect(page.error.value).toBe("rate-limit");
		respond = config => pageResponse([entry], config, 12000);
		await page.retry();
		expect(page.offset.value).toBe(40);
		await page.load(MUSIC_MAX_OFFSET + 1);
		expect(calls.at(-1)?.params).toEqual({ limit: 20, offset: 40 });
		await page.load(MUSIC_MAX_OFFSET);
		expect(page.hasMore.value).toBe(false);
	});

	it("creates with the allowlisted icon, uses the server's normalized result, then tags once", async () => {
		const { wrapper, store } = mountComponent(TrackMoods, {
			props: { trackId: trackA, contributorMoodIds: [] },
		});
		store.commit("LOGIN", account());
		await flushPromises();
		await wrapper
			.findAll("button")
			.find(b => b.text() === "Find or create a mood")!
			.trigger("click");
		await flushPromises();
		const original = respond;
		respond = config =>
			config.method === "POST" && config.url === "/music/moods"
				? { success: true, mood: custom }
				: original(config);
		const picker = wrapper.getComponent(MoodPicker);
		await picker
			.findAll("input")
			.find(i => i.attributes("type") !== "search")!
			.setValue("  DREAMY  ");
		await picker.get('[aria-label="Moon"]').trigger("click");
		await picker.get("form").trigger("submit");
		await flushPromises();
		expect(calls.find(c => c.method === "POST")?.data).toEqual({
			name: "  DREAMY  ",
			iconKey: "moon",
		});
		expect(calls.filter(c => c.method === "PUT").map(c => c.url)).toEqual([
			`/music/tracks/${trackA}/moods/${custom.id}`,
		]);
		expect(
			wrapper
				.get(
					`[aria-label="Your tags and favorite shortcuts"] [data-mood-id="${custom.id}"]`,
				)
				.attributes("aria-pressed"),
		).toBe("true");
	});

	it("imports a URL and removes membership using only library endpoints; unknown metadata is readable", async () => {
		const { wrapper, store } = mountComponent(Library);
		store.commit("LOGIN", account());
		await flushPromises();
		expect(wrapper.text()).toContain("Artist unknown");
		expect(wrapper.text()).toContain("YouTube");
		expect(wrapper.text()).not.toContain(trackA);
		await wrapper.getComponent(LibraryImport).get("input").setValue("https://youtu.be/test");
		await wrapper.getComponent(LibraryImport).get("form").trigger("submit");
		await flushPromises();
		expect(calls.find(c => c.method === "POST")?.data).toEqual({
			url: "https://youtu.be/test",
		});
		await wrapper
			.findAll("button")
			.find(b => b.text() === "Remove")!
			.trigger("click");
		await flushPromises();
		expect(calls.filter(c => c.method === "DELETE").map(c => c.url)).toEqual([
			`/music/library/${trackA}`,
		]);
		expect(calls.some(c => c.url?.includes("/tracks/"))).toBe(false);
	});

	it("disables next pagination at offset 10000", () => {
		const { wrapper } = mountComponent(MusicPagination, {
			props: { offset: 10000, limit: 100, total: 12000, loading: false },
		});
		expect(
			wrapper
				.findAll("button")
				.find(b => b.text() === "Next")!
				.attributes("disabled"),
		).toBeDefined();
	});

	it("retries failed favorite writes without changing tags or the confirmed shortcut", async () => {
		const { wrapper, store } = mountComponent(MusicFavorites);
		store.commit("LOGIN", account());
		await flushPromises();
		const original = respond;
		respond = config =>
			config.method === "DELETE"
				? Promise.reject({ response: { status: 429 } })
				: original(config);
		await wrapper.findAll(`[data-mood-id="${focus.id}"]`)[0].trigger("click");
		await flushPromises();
		expect(wrapper.text()).toContain("Too many requests");
		expect(wrapper.findAll(`[data-mood-id="${focus.id}"]`)[0].attributes("aria-pressed")).toBe(
			"true",
		);
		respond = original;
		await wrapper
			.findAll("button")
			.find(b => b.text() === "Try again")!
			.trigger("click");
		await flushPromises();
		expect(wrapper.getComponent(MoodPicker).props("selectedIds")).not.toContain(focus.id);
		expect(calls.filter(c => c.method === "DELETE")).toHaveLength(2);
		expect(calls.some(c => c.url?.includes("/tracks/"))).toBe(false);
	});

	it("retries an annotation read failure before enabling tag changes", async () => {
		const original = respond;
		respond = config =>
			config.url?.includes("/tracks/")
				? Promise.reject({ response: { status: 500 } })
				: original(config);
		const { wrapper, store } = mountComponent(TrackMoods, {
			props: { trackId: trackA, contributorMoodIds: [like.id] },
		});
		store.commit("LOGIN", account());
		await flushPromises();
		expect(wrapper.get(`[data-mood-id="${like.id}"]`).attributes("disabled")).toBeDefined();
		respond = original;
		await wrapper
			.findAll("button")
			.find(b => b.text() === "Try again")!
			.trigger("click");
		await flushPromises();
		expect(wrapper.get(`[data-mood-id="${like.id}"]`).attributes("aria-pressed")).toBe("true");
		expect(wrapper.get(`[data-mood-id="${like.id}"]`).attributes("disabled")).toBeUndefined();
	});

	it("ignores a pending favorite mutation when switching accounts without logging out first", async () => {
		let music!: ReturnType<typeof useMusic>;
		const Host = defineComponent({
			setup() {
				music = useMusic();
				return () => h("div");
			},
		});
		const { store } = mountComponent(Host);
		store.commit("LOGIN", account("A"));
		await flushPromises();
		const delayed = deferred<unknown>();
		const original = respond;
		respond = config => (config.method === "PUT" ? delayed.promise : original(config));
		const write = music.setFavorite(custom, true);
		favorites = [];
		store.commit("LOGIN", account("B"));
		expect(music.favorites.items.value).toEqual([]);
		await flushPromises();
		delayed.resolve({ success: true });
		await write;
		expect(music.favorites.items.value).toEqual([]);
		expect(music.favoritePending.size).toBe(0);
		expect(calls.find(c => c.method === "PUT")?.signal?.aborted).toBe(true);
	});

	it("does not tag either track after a mood creation's picker has been replaced", async () => {
		const { wrapper, store } = mountComponent(TrackMoods, {
			props: { trackId: trackA, contributorMoodIds: [] },
		});
		store.commit("LOGIN", account());
		await flushPromises();
		await wrapper
			.findAll("button")
			.find(b => b.text() === "Find or create a mood")!
			.trigger("click");
		await flushPromises();
		const delayed = deferred<unknown>();
		const original = respond;
		respond = config => (config.method === "POST" ? delayed.promise : original(config));
		const picker = wrapper.getComponent(MoodPicker);
		await picker
			.findAll("input")
			.find(i => i.attributes("type") !== "search")!
			.setValue("dreamy");
		await picker.get("form").trigger("submit");
		await wrapper.setProps({ trackId: trackB });
		delayed.resolve({ success: true, mood: custom });
		await flushPromises();
		expect(calls.some(c => c.method === "PUT")).toBe(false);
	});

	it("keeps membership on a failed removal and retries the library operation", async () => {
		const { wrapper, store } = mountComponent(Library);
		store.commit("LOGIN", account());
		await flushPromises();
		const original = respond;
		respond = config =>
			config.method === "DELETE"
				? Promise.reject({ response: { status: 500 } })
				: original(config);
		await wrapper
			.findAll("button")
			.find(b => b.text() === "Remove")!
			.trigger("click");
		await flushPromises();
		expect(wrapper.text()).toContain("Untitled track");
		respond = config =>
			config.method === "GET" && config.url === "/music/library"
				? pageResponse([], config)
				: original(config);
		await wrapper
			.findAll("button")
			.find(b => b.text() === "Try again")!
			.trigger("click");
		await flushPromises();
		expect(wrapper.text()).toContain("Your library is empty");
		expect(calls.filter(c => c.method === "DELETE").map(c => c.url)).toEqual([
			`/music/library/${trackA}`,
			`/music/library/${trackA}`,
		]);
	});

	it("imports an explicit provider reference with no URL or user ID in the payload", async () => {
		const { wrapper } = mountComponent(LibraryImport, { props: { disabled: false } });
		await wrapper.get('[data-slot="toggle-group-item"][value="reference"]').trigger("click");
		await wrapper.get("input").setValue("one-provider-id");
		await wrapper.get("form").trigger("submit");
		expect(wrapper.emitted("import")?.[0]).toEqual([
			{ reference: { service: "youtube", id: "one-provider-id" } },
		]);
	});

	it.each(["contributor", "favorite"])(
		"does not invert an unloaded personal tag shown as %s",
		async group => {
			const vocabulary: Mood[] = Array.from({ length: 100 }, (_, index) => ({
				...custom,
				id: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
			}));
			tags[trackA] = [...vocabulary, custom];
			favorites = group === "favorite" ? [custom, like] : [like];
			const original = respond;
			respond = config =>
				config.method === "GET" && config.url?.includes("/tracks/")
					? pageResponse(
							tags[trackA].slice(
								config.params.offset,
								config.params.offset + config.params.limit,
							),
							config,
							tags[trackA].length,
						)
					: original(config);
			const { wrapper, store } = mountComponent(TrackMoods, {
				props: {
					trackId: trackA,
					contributorMoodIds: group === "contributor" ? [custom.id] : [],
					contributorMoods: [custom],
				},
			});
			store.commit("LOGIN", account());
			await flushPromises();
			const button = wrapper.get(`[data-mood-id="${custom.id}"]`);
			expect(button.attributes("aria-pressed")).toBeUndefined();
			expect(button.attributes("data-selection")).toBe("unknown");
			expect(button.attributes("disabled")).toBeDefined();
			await button.trigger("click");
			expect(calls.every(c => c.method === "GET")).toBe(true);
			expect(
				wrapper.get(`[data-mood-id="${vocabulary[0].id}"]`).attributes("aria-pressed"),
			).toBe("true");
			await wrapper
				.findAll("button")
				.find(b => b.text() === "Load more personal tags")!
				.trigger("click");
			await flushPromises();
			expect(button.attributes("aria-pressed")).toBe("true");
			expect(button.attributes("disabled")).toBeUndefined();
			expect(wrapper.get(`[data-mood-id="${like.id}"]`).attributes("aria-pressed")).toBe(
				"false",
			);
			await button.trigger("click");
			await flushPromises();
			expect(calls.filter(c => c.method !== "GET").map(c => [c.method, c.url])).toEqual([
				["DELETE", `/music/tracks/${trackA}/moods/${custom.id}`],
			]);
		},
	);

	it("keeps unloaded favorite selections unknown through a page error until explicit retry", async () => {
		const vocabulary: Mood[] = Array.from({ length: 100 }, (_, index) => ({
			...custom,
			id: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
		}));
		favorites = [...vocabulary, like];
		let fail = true;
		const original = respond;
		respond = config => {
			if (config.method === "GET" && config.url === "/music/favorites") {
				if (config.params.offset === 100 && fail) {
					return Promise.reject({ response: { status: 500 } });
				}
				return pageResponse(
					favorites.slice(
						config.params.offset,
						config.params.offset + config.params.limit,
					),
					config,
					favorites.length,
				);
			}
			return original(config);
		};
		const { wrapper, store } = mountComponent(MusicFavorites);
		store.commit("LOGIN", account());
		await flushPromises();
		const button = wrapper.getComponent(MoodPicker).findAll(`[data-mood-id="${like.id}"]`)[0];
		expect(button.attributes("aria-pressed")).toBeUndefined();
		expect(button.attributes("disabled")).toBeDefined();
		await button.trigger("click");
		expect(calls.every(c => c.method === "GET")).toBe(true);
		await wrapper
			.findAll("button")
			.find(b => b.text() === "Load more favorites")!
			.trigger("click");
		await flushPromises();
		expect(button.attributes("data-selection")).toBe("unknown");
		fail = false;
		await wrapper
			.findAll("button")
			.find(b => b.text() === "Try again")!
			.trigger("click");
		await flushPromises();
		expect(button.attributes("aria-pressed")).toBe("true");
		await button.trigger("click");
		await flushPromises();
		expect(calls.filter(c => c.method !== "GET").map(c => [c.method, c.url])).toEqual([
			["DELETE", `/music/favorites/${like.id}`],
		]);
	});

	it("loads extra personal tag/favorite pages only on explicit request", async () => {
		const vocabulary = Array.from(
			{ length: 101 },
			(_, index): Mood => ({
				id: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
				name: `mood ${index}`,
				normalizedName: `mood ${index}`,
				iconKey: "coffee",
			}),
		);
		respond = config =>
			pageResponse(
				vocabulary.slice(config.params.offset, config.params.offset + config.params.limit),
				config,
				vocabulary.length,
			);
		const { wrapper, store } = mountComponent(TrackMoods, {
			props: { trackId: trackA, contributorMoodIds: [] },
		});
		store.commit("LOGIN", account());
		await flushPromises();
		expect(calls).toHaveLength(2);
		expect(calls.every(c => c.params.offset === 0 && c.params.limit === 100)).toBe(true);
		expect(wrapper.find(`[data-mood-id="${vocabulary[100].id}"]`).exists()).toBe(false);
		await wrapper
			.findAll("button")
			.find(b => b.text() === "Load more personal tags")!
			.trigger("click");
		await flushPromises();
		expect(
			wrapper.get(`[data-mood-id="${vocabulary[100].id}"]`).attributes("aria-pressed"),
		).toBe("true");
		expect(calls.filter(c => c.url?.includes("/tracks/"))).toHaveLength(2);
		expect(calls.filter(c => c.url === "/music/favorites")).toHaveLength(1);
		await wrapper
			.findAll("button")
			.find(b => b.text() === "Load more favorites")!
			.trigger("click");
		await flushPromises();
		expect(calls.at(-1)?.params).toEqual({ limit: 100, offset: 100 });
		expect(wrapper.findAll(`[data-mood-id="${vocabulary[100].id}"]`)).toHaveLength(1);
	});
});
