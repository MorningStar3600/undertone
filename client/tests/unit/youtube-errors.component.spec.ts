import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YoutubePlayer from "@/components/players/YoutubePlayer.vue";
import OmniPlayer from "@/components/players/OmniPlayer.vue";
import { getSdk } from "@/util/playerHelper.js";
import { mountComponent } from "./component-test-utils";

vi.mock("@/util/playerHelper.js", () => ({ getSdk: vi.fn() }));
vi.mock("@/common-http", () => ({
	API: { get: vi.fn(() => new Promise(() => undefined)), post: vi.fn() },
}));

describe("YouTube music playback failures", () => {
	let events: {
		onReady(): void;
		onError(event: { data: number }): void;
	};
	let wrapper: VueWrapper;
	const api = {
		cueVideoById: vi.fn(),
		playVideo: vi.fn(),
		pauseVideo: vi.fn(),
		getOptions: vi.fn(() => []),
		getAvailablePlaybackRates: vi.fn(() => [1]),
		getVolume: vi.fn(() => 100),
		isMuted: vi.fn(() => false),
		unMute: vi.fn(),
		setVolume: vi.fn(),
		setSize: vi.fn(),
		destroy: vi.fn(),
	};
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe = vi.fn();
				disconnect = vi.fn();
			},
		);
		vi.mocked(getSdk).mockResolvedValue({
			Player: vi.fn((_element: HTMLElement, options: { events: typeof events }) => {
				events = options.events;
				return api;
			}),
		});
	});
	afterEach(() => {
		wrapper?.unmount();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	const mountPlayer = async () => {
		wrapper = mount(YoutubePlayer, {
			props: { videoId: "5MO2drnQIFM", silent: true },
			global: { stubs: { DebugPlayerWatcher: true } },
		});
		await flushPromises();
		events.onReady();
		return wrapper.vm.$.exposed as unknown as { play(): Promise<void> };
	};

	it("cues the exact music track without finding a different video", async () => {
		await mountPlayer();
		expect(api.cueVideoById).toHaveBeenCalledWith("5MO2drnQIFM");
		expect(api.playVideo).not.toHaveBeenCalled();
	});

	it.each([
		[100, "youtube-unavailable"],
		[101, "youtube-embed-disabled"],
		[150, "youtube-embed-disabled"],
		[153, "youtube-embed-identity"],
		[2, "unknown"],
		[5, "unknown"],
		[999, "unknown"],
	] as const)("classifies SDK error %s without exposing provider details", async (code, type) => {
		await mountPlayer();
		events.onError({ data: code });
		expect(wrapper.emitted("error")).toEqual([[{ type }]]);
	});

	it("rejects a pending play on provider failure without waiting for an autoplay timeout", async () => {
		const player = await mountPlayer();
		vi.useFakeTimers();
		const playing = player.play();
		const failure = expect(playing).rejects.toThrow("YouTube playback failed");
		events.onError({ data: 150 });
		await failure;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("ignores a provider error delivered after teardown", async () => {
		await mountPlayer();
		wrapper.unmount();
		events.onError({ data: 100 });
		expect(wrapper.emitted("error")).toBeUndefined();
	});

	it("renders an English explanation for disabled embedding through OmniPlayer", async () => {
		const mounted = mountComponent(OmniPlayer, {
			props: { source: { service: "youtube", id: "5MO2drnQIFM" } },
		});
		await vi.waitFor(() =>
			expect(mounted.wrapper.findComponent(YoutubePlayer).exists()).toBe(true),
		);
		await flushPromises();
		events.onError({ data: 150 });
		await flushPromises();
		expect(mounted.wrapper.get(".playback-error").text()).toContain(
			"The owner does not allow this track to play in embedded players.",
		);
		expect(mounted.wrapper.get(".playback-error").text()).not.toContain("150");
		expect(mounted.store.state.toast.notifications).toHaveLength(1);
		expect(mounted.store.state.toast.notifications[0].content).toContain(
			"The owner does not allow this track to play in embedded players.",
		);
		events.onError({ data: 150 });
		await flushPromises();
		expect(mounted.store.state.toast.notifications).toHaveLength(1);
	});
});
