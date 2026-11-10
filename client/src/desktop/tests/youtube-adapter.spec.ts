import { afterEach, describe, expect, it, vi } from "vitest";
import { createYoutubeAdapter, type YoutubeSdk, type YoutubeApi } from "../youtube-adapter";
import type { PlaybackAdapterContext } from "../../playback/playback-controller";

afterEach(() => {
	vi.useRealTimers();
	document.body.replaceChildren();
});
function fixture() {
	vi.useFakeTimers();
	const abort = new AbortController();
	const root = document.createElement("div");
	document.body.append(root);
	const report = vi.fn();
	let events: ConstructorParameters<YoutubeSdk["Player"]>[1]["events"];
	const api: YoutubeApi = {
		destroy: vi.fn(),
		cueVideoById: vi.fn(),
		playVideo: vi.fn(),
		pauseVideo: vi.fn(),
		getCurrentTime: () => 12,
		seekTo: vi.fn(),
		getAvailablePlaybackRates: () => [1, 2],
		getPlaybackRate: () => 1,
		setPlaybackRate: vi.fn(),
		setVolume: vi.fn(),
		mute: vi.fn(),
		unMute: vi.fn(),
	};
	const construct = vi.fn();
	const sdk: YoutubeSdk = {
		Player: class {
			constructor(_element, options) {
				events = options.events;
				construct();
				return api;
			}
		} as YoutubeSdk["Player"],
	};
	const context: PlaybackAdapterContext = {
		epoch: "fixture",
		occurrenceId: 1,
		generation: 1,
		media: { service: "adapter", id: "mapping" },
		signal: abort.signal,
		report,
	};
	const adapter = createYoutubeAdapter(
		context,
		root,
		() => 0,
		async () => sdk,
	);
	async function ready() {
		const promise = adapter.ready(abort.signal);
		await vi.advanceTimersByTimeAsync(50);
		events.onReady();
		await vi.advanceTimersByTimeAsync(50);
		await promise;
	}
	return {
		adapter,
		abort,
		api,
		report,
		root,
		construct,
		sdk,
		context,
		ready,
		events: () => events,
	};
}
describe("captured desktop YouTube adapter", () => {
	it("cues silently, waits for usability, applies local mute, and exposes the existing controller contract", async () => {
		const f = fixture();
		await f.ready();
		expect(f.api.mute).toHaveBeenCalled();
		let settled = false;
		const load = Promise.resolve(
			f.adapter.load({ service: "youtube", id: "abcdefghijk" }, f.abort.signal),
		).then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(50);
		expect(settled).toBe(false);
		expect(f.api.playVideo).not.toHaveBeenCalled();
		f.events().onStateChange({ data: 5 });
		await vi.advanceTimersByTimeAsync(50);
		await load;
		expect(f.adapter.getPosition(f.abort.signal)).toBe(12);
		f.adapter.dispose();
		expect(f.root.children).toHaveLength(0);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("cancels pending play and rejects a late PLAYING callback after newer pause intent", async () => {
		const f = fixture();
		await f.ready();
		const playAbort = new AbortController();
		const play = Promise.resolve(f.adapter.play(playAbort.signal)).catch(error => error);
		playAbort.abort();
		expect((await play).name).toBe("AbortError");
		const before = vi.mocked(f.api.pauseVideo).mock.calls.length;
		f.events().onStateChange({ data: 1 });
		expect(vi.mocked(f.api.pauseVideo).mock.calls.length).toBe(before + 1);
		f.adapter.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("disposes while SDK readiness is pending and never allocates a late provider", async () => {
		const f = fixture();
		let resolveSdk: (value: YoutubeSdk) => void;
		const sdk = new Promise<YoutubeSdk>(resolve => {
			resolveSdk = resolve;
		});
		const adapter = createYoutubeAdapter(
			f.context,
			f.root,
			() => 0,
			() => sdk,
		);
		const ready = Promise.resolve(adapter.ready(f.abort.signal)).catch(error => error);
		adapter.dispose();
		expect((await ready).name).toBe("AbortError");
		resolveSdk!(f.sdk);
		await vi.advanceTimersByTimeAsync(100);
		expect(f.construct).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		f.adapter.dispose();
	});
	it("clears pending play on provider error and ignores callbacks after disposal", async () => {
		const f = fixture();
		await f.ready();
		const play = Promise.resolve(f.adapter.play(f.abort.signal)).catch(error => error);
		f.events().onError();
		expect((await play).name).toBe("Error");
		f.adapter.dispose();
		const before = f.report.mock.calls.length;
		f.events().onStateChange({ data: 3 });
		f.events().onAutoplayBlocked();
		expect(f.report).toHaveBeenCalledTimes(before);
		expect(f.api.destroy).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});
