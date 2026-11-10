import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import PeertubePlayer from "@/components/players/PeertubePlayer.vue";
import VimeoPlayer from "@/components/players/VimeoPlayer.vue";
import DirectPlayer from "@/components/players/DirectPlayer.vue";
import OmniPlayer from "@/components/players/OmniPlayer.vue";
import { shallowRef } from "vue";
import type { PlayerSurface } from "@/playback/player-surface";
import { mountComponent } from "./component-test-utils";
import type { MediaPlayerWithPlaybackRate } from "@/components/composables/media-player";

const { peer, vimeo } = vi.hoisted(() => ({
	peer: {
		ready: Promise.resolve(),
		getPlaybackRates: vi.fn(async () => [1, 2]),
		getPlaybackRate: vi.fn(async () => 1),
		getCurrentPosition: vi.fn(async () => 12),
		setPlaybackRate: vi.fn(async () => undefined),
		seek: vi.fn(async () => undefined),
		play: vi.fn(async () => undefined),
		pause: vi.fn(async () => undefined),
		setVolume: vi.fn(),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		destroy: vi.fn(),
		channel: { destroy: vi.fn() },
	},
	vimeo: {
		on: vi.fn(),
		destroy: vi.fn(async () => undefined),
		play: vi.fn(async () => undefined),
		pause: vi.fn(async () => undefined),
		getCurrentTime: vi.fn(async () => 7),
		setCurrentTime: vi.fn(async () => 9),
		setVolume: vi.fn(),
	},
}));
vi.mock("@peertube/embed-api", () => ({ PeerTubePlayer: vi.fn(() => peer) }));
vi.mock("@/common-http", () => ({
	API: { get: vi.fn(() => new Promise(() => undefined)), post: vi.fn() },
}));
vi.mock("@vimeo/player", () => ({ default: vi.fn(() => vimeo) }));
vi.mock("@/components/composables/media-audio-boost", () => ({
	useMediaAudioBoost: () => ({ setBoost: vi.fn(), resetFailedSetup: vi.fn() }),
}));
describe("captured provider surfaces", () => {
	it("forwards native waiting and playing through the timeline buffering bridge", async () => {
		vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
		vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
		const source = {
			service: "direct",
			id: "https://example.test/movie.mp4",
			mime: "video/mp4",
			length: 200,
		} as const;
		const report = vi.fn();
		const surface = {
			key: 1,
			source: shallowRef(source),
			bind: vi.fn(),
			ready: vi.fn(),
			report,
			active: true,
		} satisfies PlayerSurface;
		const { wrapper } = mountComponent(OmniPlayer, { props: { source, surface } });
		await vi.waitFor(() => expect(wrapper.find("video").exists()).toBe(true));
		await flushPromises();
		await wrapper.get("video").trigger("canplay");
		expect(surface.ready).toHaveBeenCalled();
		report.mockClear();
		await wrapper.get("video").trigger("waiting");
		expect(report).toHaveBeenCalledWith({ type: "buffering" });
		await wrapper.get("video").trigger("playing");
		expect(report).toHaveBeenCalledWith({ type: "resumed" });
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});
	it("awaits PeerTube rate discovery, keeps synchronous capability reads and tears down its channel", async () => {
		const wrapper = mount(PeertubePlayer, {
			props: { videoId: "example.test:video" },
			global: { mocks: { $t: (key: string) => key } },
		});
		await flushPromises();
		expect(wrapper.emitted("apiready")).toHaveLength(1);
		const api = wrapper.vm as unknown as MediaPlayerWithPlaybackRate;
		expect(api.getAvailablePlaybackRates()).toEqual([1, 2]);
		expect(await api.getPosition()).toBe(12);
		await api.setPlaybackRate(2);
		expect(peer.setPlaybackRate).toHaveBeenCalledWith(2);
		wrapper.unmount();
		expect(peer.removeEventListener).toHaveBeenCalledOnce();
		expect(peer.channel.destroy).toHaveBeenCalledOnce();
	});
	it("ignores PeerTube readiness/rate results after teardown", async () => {
		let resolve!: (rates: number[]) => void;
		peer.getPlaybackRates.mockImplementationOnce(
			() =>
				new Promise<number[]>(done => {
					resolve = done;
				}),
		);
		const wrapper = mount(PeertubePlayer, {
			props: { videoId: "example.test:video" },
			global: { mocks: { $t: (key: string) => key } },
		});
		await flushPromises();
		wrapper.unmount();
		resolve([1, 2]);
		await flushPromises();
		expect(wrapper.emitted("apiready")).toBeUndefined();
		expect(peer.addEventListener).not.toHaveBeenCalled();
	});
	it("preserves async Vimeo operations and scopes iframe teardown to its own container", async () => {
		const sibling = document.createElement("iframe");
		document.body.append(sibling);
		const wrapper = mount(VimeoPlayer, { props: { videoId: "123" } });
		await flushPromises();
		const api = wrapper.vm as unknown as MediaPlayerWithPlaybackRate;
		expect(await api.getPosition()).toBe(7);
		expect(await api.setPosition(9)).toBe(9);
		expect(api.getAvailablePlaybackRates()).toEqual([1]);
		wrapper.unmount();
		expect(sibling.isConnected).toBe(true);
		sibling.remove();
		expect(vimeo.destroy).toHaveBeenCalledOnce();
	});
	it.each([
		["video/mp4", "https://example.test/video.mp4"],
		["audio/mpeg", "https://example.test/song.mp3"],
	])("loads %s silently in timeline mode and retains playback controls", async (mime, url) => {
		const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
		vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
		const { wrapper, unmount } = mountComponent(DirectPlayer, {
			props: {
				service: "direct",
				videoUrl: url,
				videoMime: mime,
				silent: true,
			},
		});
		await flushPromises();
		const media = wrapper.get("video");
		expect(media.element.src).toBe(url);
		expect(wrapper.emitted("apiready")).toHaveLength(1);
		await media.trigger("canplay");
		expect(wrapper.emitted("ready")).toHaveLength(1);
		expect(play).not.toHaveBeenCalled();
		const player = wrapper.vm.$.exposed as unknown as MediaPlayerWithPlaybackRate;
		await player.play();
		expect(play).toHaveBeenCalledOnce();
		player.setPosition(25);
		expect(player.getPosition()).toBe(25);
		player.pause();
		expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledOnce();
		unmount();
	});
});
