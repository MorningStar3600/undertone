import { afterEach, expect, it, vi } from "vitest";
import type { ClientMessage } from "ott-common/models/messages";
import type { YoutubeApi, YoutubeSdk } from "../youtube-adapter";

afterEach(() => {
	window.undertone?.dispose();
	delete window.YT;
	vi.restoreAllMocks();
	vi.useRealTimers();
	document.body.replaceChildren();
});

async function fixture() {
	vi.resetModules();
	vi.useFakeTimers();
	vi.setSystemTime(1000);
	vi.spyOn(performance, "now").mockImplementation(() => Date.now() - 1000);
	document.body.innerHTML = '<div id="player"></div>';
	const sent: Array<{ kind: string; code?: string; message?: ClientMessage }> = [];
	window.ipc = { postMessage: body => sent.push(JSON.parse(body)) };
	let blocked = true;
	let events: ConstructorParameters<YoutubeSdk["Player"]>[1]["events"];
	const api: YoutubeApi = {
		destroy: vi.fn(),
		cueVideoById: vi.fn(() => setTimeout(() => events.onStateChange({ data: 5 }), 0)),
		playVideo: vi.fn(() =>
			setTimeout(() => {
				if (blocked) {
					events.onAutoplayBlocked();
				} else {
					events.onStateChange({ data: 1 });
				}
			}, 0),
		),
		pauseVideo: vi.fn(() => setTimeout(() => events.onStateChange({ data: 2 }), 0)),
		getCurrentTime: () => 0,
		seekTo: vi.fn(),
		getAvailablePlaybackRates: () => [1],
		getPlaybackRate: () => 1,
		setPlaybackRate: vi.fn(),
		setVolume: vi.fn(),
		mute: vi.fn(),
		unMute: vi.fn(),
	};
	window.YT = {
		Player: class {
			constructor(_target, options) {
				events = options.events;
				setTimeout(() => events.onReady(), 0);
				return api;
			}
		} as YoutubeSdk["Player"],
	};
	await import("../host");
	const host = window.undertone;
	host.start();
	const subscribe = sent.find(x => x.message?.action === "playback-subscribe")!.message;
	const probe = sent.find(x => x.message?.action === "clock-probe")!.message;
	if (subscribe?.action !== "playback-subscribe" || probe?.action !== "clock-probe") {
		throw new Error("Missing subscription or clock probe");
	}
	host.receive({
		action: "playback-snapshot",
		nonce: subscribe.nonce,
		timeline: {
			version: 1,
			epoch: "fixture",
			baseline: {
				sequence: 1,
				serverTimeMs: 1000,
				lastEffectiveAtMs: 1000,
				lastOccurrenceId: 1,
				state: {
					occurrenceId: 1,
					media: { service: "adapter", id: "mapping" },
					positionSeconds: 0,
					isPlaying: true,
					rate: 1,
				},
			},
			events: [],
		},
		attachment: {
			epoch: "fixture",
			sequence: 1,
			occurrenceId: 1,
			media: { service: "adapter", id: "mapping" },
			item: { service: "youtube", id: "abcdefghijk", length: 120 },
		},
	});
	host.receive({
		action: "clock-reply",
		generation: probe.generation,
		nonce: probe.nonce,
		serverReceiveMs: 1000,
		serverSendMs: 1000,
	});
	await vi.advanceTimersByTimeAsync(500);
	return {
		host,
		sent,
		api,
		allowPlayback: () => {
			blocked = false;
		},
		button: document.getElementById("activate-playback") as HTMLButtonElement,
	};
}

it("offers a synchronous local gesture after autoplay denial without changing room playback", async () => {
	const f = await fixture();
	expect(f.sent.some(x => x.kind === "status" && x.code === "autoplay-blocked")).toBe(true);
	expect(f.button.hidden).toBe(false);
	f.allowPlayback();
	const attempts = vi.mocked(f.api.playVideo).mock.calls.length;
	f.button.click();
	// The SDK call stays in the browser click stack, before promise/timer processing.
	expect(f.api.playVideo).toHaveBeenCalledTimes(attempts + 1);
	await vi.advanceTimersByTimeAsync(500);
	expect(f.button.hidden).toBe(true);
	expect(f.sent.filter(x => x.kind === "status").at(-1)?.code).toBe("playing");
	expect(f.sent.filter(x => x.message?.action === "playback-command")).toHaveLength(0);
});

it("hides activation on room pause and rejects a stale click after disposal", async () => {
	const f = await fixture();
	f.host.receive({
		action: "playback-event",
		event: {
			epoch: "fixture",
			sequence: 2,
			occurrenceId: 1,
			type: "pause",
			effectiveAtMs: 1500,
		},
	});
	await vi.advanceTimersByTimeAsync(300);
	expect(f.button.hidden).toBe(true);
	expect(f.sent.filter(x => x.kind === "status").at(-1)?.code).toBe("paused");
	expect(f.api.destroy).not.toHaveBeenCalled();
	const attempts = vi.mocked(f.api.playVideo).mock.calls.length;
	f.button.click();
	expect(f.api.playVideo).toHaveBeenCalledTimes(attempts);
	f.host.dispose();
	expect(f.api.destroy).toHaveBeenCalledTimes(1);
	f.button.click();
	expect(f.api.playVideo).toHaveBeenCalledTimes(attempts);
	expect(document.getElementById("activate-playback")).toBeNull();
});
