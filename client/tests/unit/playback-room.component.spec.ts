import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import Room from "@/views/Room.vue";
import OmniPlayer from "@/components/players/OmniPlayer.vue";
import PlaybackRateSwitcher from "@/components/controls/PlaybackRateSwitcher.vue";
import { OttRoomConnectionMock, connectionInjectKey } from "@/plugins/connection";
import { OttSfx } from "@/plugins/sfx";
import { getSdk } from "@/util/playerHelper";
import { Grants } from "ott-common/permissions";
import { getPlaybackSession } from "@/playback/playback-session";
import { mountComponent } from "./component-test-utils";

vi.mock("@/common-http", () => ({
	API: { get: vi.fn(() => new Promise(() => undefined)), post: vi.fn() },
}));
vi.mock("@/util/token", () => ({ waitForToken: vi.fn(async () => undefined) }));
vi.mock("@/util/playerHelper", () => ({ getSdk: vi.fn() }));

type Events = {
	onReady(): void;
	onAutoplayBlocked(): void;
	onStateChange(event: { data: number }): void;
	onPlaybackRateChange(): void;
};
const providers: { events: Events; api: ReturnType<typeof mockApi> }[] = [];
let blockPlay = false;
function mockApi(events: Events) {
	return {
		cueVideoById: vi.fn(),
		loadVideoById: vi.fn(),
		playVideo: vi.fn(() =>
			blockPlay ? events.onAutoplayBlocked() : events.onStateChange({ data: 1 }),
		),
		pauseVideo: vi.fn(() => events.onStateChange({ data: 2 })),
		seekTo: vi.fn(),
		getCurrentTime: vi.fn(() => 12),
		setPlaybackRate: vi.fn(),
		getPlaybackRate: () => 1,
		getAvailablePlaybackRates: () => [1, 2],
		getOptions: () => [],
		getOption: () => [],
		setOption: vi.fn(),
		loadModule: vi.fn(),
		unloadModule: vi.fn(),
		setVolume: vi.fn(),
		unMute: vi.fn(),
		getVolume: () => 100,
		isMuted: () => false,
		getVideoLoadedFraction: () => 1,
		setSize: vi.fn(),
		destroy: vi.fn(),
	};
}
const capability = { action: "playback-capabilities", version: 1, recovery: "snapshot" } as const;
async function mountRoom(playing = false) {
	const connection = new OttRoomConnectionMock();
	connection.mockReceive(capability);
	const handlers = new Map<string, MediaSessionActionHandler | null>();
	Object.defineProperty(navigator, "mediaSession", {
		configurable: true,
		value: {
			setActionHandler: (action: string, handler: MediaSessionActionHandler | null) =>
				handlers.set(action, handler),
		},
	});
	const mounted = mountComponent(Room, {
		global: { provide: { [connectionInjectKey as symbol]: connection } },
	});
	mounted.store.commit("room/SYNC", { grants: new Grants(), playbackEstablished: false });
	await mounted.router.push("/room/foo");
	await mounted.router.isReady();
	await flushPromises();
	const probe = connection.sent.findLast(m => m.action === "clock-probe")!;
	if (probe.action === "clock-probe") {
		connection.mockReceive({
			action: "clock-reply",
			generation: probe.generation,
			nonce: probe.nonce,
			serverReceiveMs: 1000,
			serverSendMs: 1000,
		});
	}
	const subscribe = connection.sent.findLast(m => m.action === "playback-subscribe")!;
	if (subscribe.action !== "playback-subscribe") {
		throw new Error("Missing subscription");
	}
	connection.mockReceive({
		action: "playback-snapshot",
		nonce: subscribe.nonce,
		timeline: {
			version: 1,
			epoch: "epoch",
			baseline: {
				serverTimeMs: 1000,
				sequence: 1,
				lastEffectiveAtMs: 1000,
				lastOccurrenceId: 1,
				state: {
					occurrenceId: 1,
					media: { service: "adapter", id: "private-mapping" },
					positionSeconds: 12,
					isPlaying: playing,
					rate: 1,
				},
			},
			events: [],
		},
		attachment: {
			epoch: "epoch",
			sequence: 1,
			occurrenceId: 1,
			media: { service: "adapter", id: "private-mapping" },
			item: {
				service: "youtube",
				id: "public-youtube",
				length: 180,
				title: "A public video",
			},
		},
	});
	await flushPromises();
	await mounted.wrapper.vm.$nextTick();
	await flushPromises();
	await vi.waitFor(() => expect(providers.length).toBeGreaterThan(0));
	const provider = providers.at(-1)!;
	provider.events.onReady();
	provider.events.onStateChange({ data: 5 });
	await flushPromises();
	return { ...mounted, connection, provider, handlers };
}
describe("Room timeline with real OmniPlayer and mock YouTube SDK", () => {
	it("shows the authoritative rate applied to the captured provider", async () => {
		const s = await mountRoom();
		s.connection.mockReceive({
			action: "playback-event",
			event: {
				epoch: "epoch",
				sequence: 2,
				occurrenceId: 1,
				effectiveAtMs: 1000,
				type: "rate",
				rate: 2,
			},
		});
		await vi.waitFor(() => expect(s.provider.api.setPlaybackRate).toHaveBeenCalledWith(2));
		expect(s.store.state.room.playbackSpeed).toBe(2);
		expect(s.wrapper.getComponent(PlaybackRateSwitcher).get("button").text()).toBe("2x");
	});
	it("keeps personal mute and its saved volume across occurrence replacement", async () => {
		const s = await mountRoom();
		const savedVolume = s.store.state.settings.volume;
		await s.wrapper.get('button[aria-label="Mute"]').trigger("click");
		await flushPromises();
		expect(s.store.state.settings.muted).toBe(true);
		expect(s.provider.api.setVolume).toHaveBeenLastCalledWith(0);
		s.connection.mockReceive({
			action: "playback-event",
			event: {
				epoch: "epoch",
				sequence: 2,
				occurrenceId: 2,
				effectiveAtMs: 1000,
				type: "load",
				media: { service: "adapter", id: "replacement" },
				positionSeconds: 0,
				isPlaying: false,
				rate: 1,
			},
			attachment: {
				epoch: "epoch",
				sequence: 2,
				occurrenceId: 2,
				media: { service: "adapter", id: "replacement" },
				item: { service: "youtube", id: "second-video", length: 180 },
			},
		});
		await vi.waitFor(() => expect(providers).toHaveLength(2));
		const replacement = providers[1];
		replacement.events.onReady();
		replacement.events.onStateChange({ data: 5 });
		await flushPromises();
		expect(s.store.state.settings.muted).toBe(true);
		expect(replacement.api.setVolume).toHaveBeenLastCalledWith(0);
		await s.wrapper.get('button[aria-label="Unmute"]').trigger("click");
		await flushPromises();
		expect(s.store.state.settings.muted).toBe(false);
		expect(replacement.api.setVolume).toHaveBeenLastCalledWith(savedVolume);
	});
	beforeEach(() => {
		vi.stubGlobal(
			"AudioContext",
			class {
				createGain() {
					return { connect: () => undefined, gain: { value: 1 } };
				}
			},
		);
		providers.length = 0;
		blockPlay = false;
		vi.spyOn(OttSfx.prototype, "loadSfx").mockResolvedValue();
		vi.stubGlobal(
			"matchMedia",
			vi.fn(() => ({
				matches: false,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
			})),
		);
		vi.mocked(getSdk).mockResolvedValue({
			Player: vi.fn((_element: HTMLElement, options: { events: Events }) => {
				const api = mockApi(options.events);
				providers.push({ events: options.events, api });
				return api;
			}),
		});
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});
	it("mounts from early capability using the real provider id, cues paused without autoplay and ignores legacy rendering sync", async () => {
		const s = await mountRoom();
		expect(s.provider.api.cueVideoById).toHaveBeenCalledWith("public-youtube");
		expect(s.provider.api.loadVideoById).not.toHaveBeenCalled();
		expect(s.provider.api.playVideo).not.toHaveBeenCalled();
		expect(s.provider.api.seekTo).toHaveBeenCalledWith(12);
		const surface = s.wrapper.getComponent(OmniPlayer).vm;
		s.connection.mockReceive({
			action: "sync",
			currentSource: { service: "youtube", id: "legacy-stale" },
			isPlaying: true,
			playbackPosition: 99,
			playbackSpeed: 2,
			queue: [{ service: "youtube", id: "queued" }],
		});
		await flushPromises();
		expect(s.store.state.room.currentSource?.id).toBe("public-youtube");
		expect(s.store.state.room.isPlaying).toBe(false);
		expect(s.store.state.room.queue[0].id).toBe("queued");
		expect(s.wrapper.getComponent(OmniPlayer).vm).toBe(surface);
	});
	it("uses timeline commands from bottom controls, keyboard and Media Session with current metadata/grants", async () => {
		const s = await mountRoom();
		s.connection.mockReset();
		await s.wrapper.get('[data-cy="playback-toggle"]').trigger("click");
		window.dispatchEvent(new KeyboardEvent("keydown", { code: "Home" }));
		s.handlers.get("seekto")?.({ action: "seekto", seekTime: 33 });
		s.handlers.get("nexttrack")?.({ action: "nexttrack" });
		const commands = s.connection.sent.filter(m => m.action === "playback-command");
		expect(commands.map(m => m.command.command)).toEqual(["play", "seek", "seek", "next"]);
		for (const message of commands) {
			expect(message.command).toMatchObject({ epoch: "epoch", occurrenceId: 1 });
		}
		expect(s.provider.api.playVideo).not.toHaveBeenCalled(); // intent waits for authoritative event
	});
	it("recovers autoplay locally on the gesture without sending a room pause/next", async () => {
		blockPlay = true;
		const s = await mountRoom(true);
		expect(getPlaybackSession(s.connection)?.controller.getStatus().code).toBe(
			"autoplay-blocked",
		);
		s.connection.mockReset();
		blockPlay = false;
		const button = s.wrapper.get('[data-cy="playback-activate"]');
		expect(button).toBeDefined();
		await button.trigger("click");
		await vi.waitFor(() =>
			expect(getPlaybackSession(s.connection)?.controller.getStatus().code).toBe("playing"),
		);
		await flushPromises();
		expect(getPlaybackSession(s.connection)?.controller.getStatus().code).toBe("playing");
		expect(s.connection.sent.filter(m => m.action === "playback-command")).toEqual([]);
	});
	it("clear destroys the captured provider synchronously and removes Media Session handlers on unmount", async () => {
		const s = await mountRoom();
		s.connection.mockReceive({
			action: "playback-event",
			event: {
				epoch: "epoch",
				sequence: 2,
				occurrenceId: 1,
				effectiveAtMs: 1000,
				type: "clear",
			},
		});
		expect(s.provider.api.destroy).toHaveBeenCalledOnce();
		await flushPromises();
		expect(s.wrapper.findComponent(OmniPlayer).exists()).toBe(false);
		s.unmount();
		expect([...s.handlers.values()].every(handler => handler === null)).toBe(true);
	});
	it("reconciles buffering and native-control remount without provider feedback room commands", async () => {
		const s = await mountRoom();
		s.connection.mockReset();
		s.provider.events.onStateChange({ data: 3 });
		s.provider.events.onStateChange({ data: 2 });
		await vi.waitFor(() =>
			expect(getPlaybackSession(s.connection)?.controller.getStatus().code).toBe("paused"),
		);
		expect(s.connection.sent.filter(m => m.action === "playback-command")).toEqual([]);
		s.store.commit("settings/UPDATE", {
			nativeYoutubeControls: !s.store.state.settings.nativeYoutubeControls,
		});
		await s.wrapper.vm.$nextTick();
		expect(s.provider.api.destroy).toHaveBeenCalledOnce();
		const probe = s.connection.sent.findLast(m => m.action === "clock-probe")!;
		expect(probe.action).toBe("clock-probe");

		s.connection.mockReceive({
			action: "clock-reply",
			generation: probe.generation,
			nonce: probe.nonce,
			serverReceiveMs: 2000,
			serverSendMs: 2000,
		});
		await vi.waitFor(() => expect(providers).toHaveLength(2));
		const replacement = providers[1];
		replacement.events.onReady();
		replacement.events.onStateChange({ data: 5 });
		await vi.waitFor(() => expect(replacement.api.seekTo).toHaveBeenCalledWith(12));
		expect(replacement.api.playVideo).not.toHaveBeenCalled();
		expect(s.wrapper.findAllComponents(OmniPlayer)).toHaveLength(1);
	});
	it("invalidates the old room generation on navigation and waits for new capability", async () => {
		const s = await mountRoom();
		s.connection.mockReset();
		await s.router.push("/room/another");
		await s.wrapper.vm.$nextTick();
		expect(s.provider.api.destroy).toHaveBeenCalledOnce();
		expect(s.connection.playbackCapability).toBe(false);
		s.handlers.get("play")?.({ action: "play" });
		expect(s.connection.sent).toEqual([]);
	});
});
