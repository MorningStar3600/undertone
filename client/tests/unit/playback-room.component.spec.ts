import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import Room from "@/views/Room.vue";
import OmniPlayer from "@/components/players/OmniPlayer.vue";
import PlaybackRateSwitcher from "@/components/controls/PlaybackRateSwitcher.vue";
import { OttRoomConnectionMock, connectionInjectKey } from "@/plugins/connection";
import { OttSfx } from "@/plugins/sfx";
import { getSdk } from "@/util/playerHelper";
import { Grants } from "ott-common/permissions";
import {
	RoomRequestType,
	type ClientMessage,
	type ServerMessage,
} from "ott-common/models/messages";
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
let deferPlay = false;
function mockApi(events: Events) {
	return {
		cueVideoById: vi.fn(),
		loadVideoById: vi.fn(),
		playVideo: vi.fn(() => {
			if (!deferPlay) {
				blockPlay ? events.onAutoplayBlocked() : events.onStateChange({ data: 1 });
			}
		}),
		pauseVideo: vi.fn(() => events.onStateChange({ data: 2 })),
		seekTo: vi.fn<[number], void>(),
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
function sentMessage<Action extends ClientMessage["action"]>(
	connection: OttRoomConnectionMock,
	action: Action,
) {
	const message = connection.sent.findLast(
		(message): message is Extract<ClientMessage, { action: Action }> =>
			message.action === action,
	);
	if (!message) {
		throw new Error(`Missing ${action}`);
	}
	return message;
}
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
	mounted.store.commit("room/SYNC", { grants: new Grants() });
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
	const snapshot = {
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
	} satisfies ServerMessage;
	connection.mockReceive(snapshot);
	await flushPromises();
	await mounted.wrapper.vm.$nextTick();
	await flushPromises();
	await vi.waitFor(() => expect(providers.length).toBeGreaterThan(0));
	const provider = providers.at(-1)!;
	provider.events.onReady();
	provider.events.onStateChange({ data: 5 });
	await flushPromises();
	return { ...mounted, connection, provider, handlers, snapshot };
}
describe("Room timeline with real OmniPlayer and mock YouTube SDK", () => {
	it("defaults to audio and switches display without replacing or commanding the player", async () => {
		const s = await mountRoom(true);
		const source = s.wrapper.getComponent(OmniPlayer).vm;
		const calls = {
			play: s.provider.api.playVideo.mock.calls.length,
			pause: s.provider.api.pauseVideo.mock.calls.length,
			seek: s.provider.api.seekTo.mock.calls.length,
		};
		s.connection.mockReset();
		expect(s.wrapper.get('[data-cy="room-mode-audio"]').attributes("aria-pressed")).toBe(
			"true",
		);
		expect(s.wrapper.get('[data-cy="room-video-surface"]').attributes("aria-hidden")).toBe(
			"true",
		);
		expect(s.wrapper.find('[data-cy="room-audio-view"]').exists()).toBe(true);
		await s.wrapper.get('[data-cy="room-mode-audio"]').trigger("click");
		expect(s.wrapper.get('[data-cy="room-mode-audio"]').attributes("aria-pressed")).toBe(
			"true",
		);
		await s.wrapper.get('[data-cy="room-mode-video"]').trigger("click");
		expect(s.wrapper.find('[data-cy="room-audio-view"]').exists()).toBe(false);
		expect(
			s.wrapper.get('[data-cy="room-video-surface"]').attributes("aria-hidden"),
		).toBeUndefined();
		await s.wrapper.get('[data-cy="room-mode-audio"]').trigger("click");
		await flushPromises();
		expect(s.wrapper.getComponent(OmniPlayer).vm).toBe(source);
		expect(providers).toHaveLength(1);
		expect(s.provider.api.destroy).not.toHaveBeenCalled();
		expect(s.provider.api.playVideo).toHaveBeenCalledTimes(calls.play);
		expect(s.provider.api.pauseVideo).toHaveBeenCalledTimes(calls.pause);
		expect(s.provider.api.seekTo).toHaveBeenCalledTimes(calls.seek);
		expect(
			s.connection.sent.filter(m => m.action === "playback-command" || m.action === "req"),
		).toEqual([]);
		expect(s.store.state.room.isPlaying).toBe(true);
	});
	it("starts a newly entered room in audio mode", async () => {
		const s = await mountRoom();
		await s.wrapper.get('[data-cy="room-mode-video"]').trigger("click");
		await s.router.push("/room/another");
		await s.wrapper.vm.$nextTick();
		expect(s.wrapper.get('[data-cy="room-mode-audio"]').attributes("aria-pressed")).toBe(
			"true",
		);
	});
	it("routes clicks over YouTube through room authority without directly controlling the SDK", async () => {
		const s = await mountRoom(true);
		await s.wrapper.get('[data-cy="room-mode-video"]').trigger("click");
		expect(s.wrapper.get('[data-cy="room-video-surface"]').attributes("inert")).toBeDefined();
		s.connection.mockReset();
		s.provider.api.playVideo.mockClear();
		s.provider.api.pauseVideo.mockClear();
		const button = s.wrapper.get('[data-cy="room-video-toggle"]');
		expect(button.attributes("aria-label")).toBe("Pause");
		await button.trigger("click");
		expect(sentMessage(s.connection, "playback-command").command.command).toBe("pause");
		expect(s.provider.api.pauseVideo).not.toHaveBeenCalled();
		s.connection.mockReceive({
			action: "playback-event",
			event: {
				epoch: "epoch",
				sequence: 2,
				occurrenceId: 1,
				effectiveAtMs: 1000,
				type: "pause",
			},
		});
		await vi.waitFor(() => expect(s.provider.api.pauseVideo).toHaveBeenCalledOnce());
		expect(button.attributes("aria-label")).toBe("Play");
		await button.trigger("click");
		expect(sentMessage(s.connection, "playback-command").command.command).toBe("play");
		expect(s.provider.api.playVideo).not.toHaveBeenCalled();
	});
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
		deferPlay = false;
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
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});
	it("permits intentional vote-unvote after completion while suppressing pending duplicates", async () => {
		const s = await mountRoom();
		s.store.commit("room/SYNC", { enableVoteSkip: true, votesToSkip: new Set() });
		s.store.commit("users/SET_YOU", { info: { id: "session-client" } });
		s.connection.mockReset();
		const skip = s.wrapper.get('[data-cy="playback-skip"]');
		await skip.trigger("click");
		await skip.trigger("click");
		const first = sentMessage(s.connection, "playback-command");
		expect(s.connection.sent).toHaveLength(1);
		s.connection.mockReceive({
			action: "playback-result",
			result: {
				requestId: first.command.requestId,
				epoch: "epoch",
				sequence: 1,
				status: "applied",
			},
		});
		s.connection.mockReceive({ action: "sync", votesToSkip: [s.store.state.users.you.id] });
		await flushPromises();
		expect(skip.attributes("aria-pressed")).toBe("true");
		await skip.trigger("click");
		const commands = s.connection.sent.filter(m => m.action === "playback-command");
		expect(commands).toHaveLength(2);
		expect(commands[1].command.requestId).not.toBe(first.command.requestId);
		s.connection.mockReceive({
			action: "playback-result",
			result: {
				requestId: commands[1].command.requestId,
				epoch: "epoch",
				sequence: 1,
				status: "applied",
			},
		});
		s.connection.mockReceive({ action: "sync", votesToSkip: [] });
		await flushPromises();
		expect(skip.attributes("aria-pressed")).toBe("false");
		await skip.trigger("click");
		expect(s.connection.sent.filter(m => m.action === "playback-command")).toHaveLength(3);
	});
	it("allows the Room skip button to retry a rejected vote", async () => {
		const s = await mountRoom();
		s.store.commit("room/SYNC", { enableVoteSkip: true, votesToSkip: new Set() });
		s.connection.mockReset();
		const skip = s.wrapper.get('[data-cy="playback-skip"]');
		await skip.trigger("click");
		const first = sentMessage(s.connection, "playback-command");
		s.connection.mockReceive({
			action: "playback-result",
			result: {
				requestId: first.command.requestId,
				epoch: "epoch",
				sequence: 1,
				status: "rejected",
				code: "unauthorized",
			},
		});
		await skip.trigger("click");
		const commands = s.connection.sent.filter(m => m.action === "playback-command");
		expect(commands).toHaveLength(2);
		expect(commands[1].command.requestId).not.toBe(first.command.requestId);
		expect(skip.attributes("aria-pressed")).toBe("false");
	});
	it("projects a new legacy generation's full sync plus partial updates before restoring buttons", async () => {
		const s = await mountRoom();
		vi.useFakeTimers();
		s.connection.mockLifecycle();
		s.connection.mockReset();
		s.connection.mockReceive({
			action: "sync",
			name: "foo",
			currentSource: { service: "youtube", id: "legacy-video", length: 200 },
			isPlaying: true,
			playbackPosition: 9,
			playbackSpeed: 1,
		});
		s.connection.mockReceive({
			action: "sync",
			isPlaying: false,
			playbackPosition: 17,
			playbackSpeed: 2,
		});
		await s.wrapper.vm.$nextTick();
		expect(s.wrapper.findComponent(OmniPlayer).exists()).toBe(false);
		await s.wrapper.get('[data-cy="playback-toggle"]').trigger("click");
		expect(s.connection.sent).toEqual([]);
		await vi.advanceTimersByTimeAsync(1_000);
		await flushPromises();
		expect(s.store.state.room).toMatchObject({
			playbackEstablished: false,
			currentSource: { id: "legacy-video" },
			isPlaying: false,
			playbackPosition: 17,
			playbackSpeed: 2,
		});
		expect(s.wrapper.findComponent(OmniPlayer).exists()).toBe(true);
		await s.wrapper.get('[data-cy="playback-toggle"]').trigger("click");
		expect(s.connection.sent).toContainEqual({
			action: "req",
			request: { type: RoomRequestType.PlaybackRequest, state: true },
		});
	});
	it.each([false, true])(
		"waits for a fresh modern snapshot when capability arrives after fallback: %s",
		async late => {
			const s = await mountRoom();
			vi.useFakeTimers();
			s.connection.mockLifecycle();
			s.connection.mockReset();
			s.connection.mockReceive({
				action: "sync",
				name: "foo",
				currentSource: { service: "youtube", id: "legacy-new", length: 200 },
				isPlaying: true,
				playbackPosition: 19,
				playbackSpeed: 2,
			});
			await vi.advanceTimersByTimeAsync(late ? 1_000 : 999);
			await flushPromises();
			expect(s.store.state.room.currentSource?.id).toBe(late ? "legacy-new" : undefined);
			s.connection.mockReceive(capability);
			await flushPromises();
			expect(s.store.state.room.currentSource).toBeNull();
			expect(s.wrapper.findComponent(OmniPlayer).exists()).toBe(false);
			await s.wrapper.get('[data-cy="playback-toggle"]').trigger("click");
			expect(s.connection.sent.filter(m => m.action === "req")).toEqual([]);
			await vi.advanceTimersByTimeAsync(2_000);
			expect(s.store.state.room.currentSource).toBeNull();
			const subscribe = sentMessage(s.connection, "playback-subscribe");
			const probe = sentMessage(s.connection, "clock-probe");
			// Prior generation's valid envelope cannot re-establish rendering.
			s.connection.mockReceive(s.snapshot);
			expect(s.store.state.room.currentSource).toBeNull();
			s.connection.mockReceive({
				action: "clock-reply",
				generation: probe.generation,
				nonce: probe.nonce,
				serverReceiveMs: 1_000,
				serverSendMs: 1_000,
			});
			s.connection.mockReceive({ ...s.snapshot, nonce: subscribe.nonce });
			await flushPromises();
			expect(s.store.state.room.currentSource?.id).toBe("public-youtube");
			expect(s.wrapper.findComponent(OmniPlayer).exists()).toBe(true);
			expect(s.store.state.room.playbackEstablished).toBe(true);
			expect(s.provider.api.playVideo).not.toHaveBeenCalled();
		},
	);
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
	it("recovers deferred background replacement play on focus without room commands", async () => {
		let time = 0;
		vi.spyOn(performance, "now").mockImplementation(() => time);
		const s = await mountRoom(true);
		const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
		vi.useFakeTimers();
		deferPlay = true;
		s.connection.mockReset();
		s.connection.mockReceive({
			action: "playback-event",
			event: {
				epoch: "epoch",
				sequence: 2,
				occurrenceId: 2,
				effectiveAtMs: 1000,
				type: "load",
				media: { service: "adapter", id: "replacement" },
				positionSeconds: 20,
				isPlaying: true,
				rate: 1,
			},
			attachment: {
				epoch: "epoch",
				sequence: 2,
				occurrenceId: 2,
				media: { service: "adapter", id: "replacement" },
				item: { service: "youtube", id: "background-track", length: 180 },
			},
		});
		await flushPromises();
		const replacement = providers[1];
		expect(s.provider.api.destroy).toHaveBeenCalledOnce();
		replacement.events.onReady();
		replacement.events.onStateChange({ data: 5 });
		await flushPromises();
		// The hidden window receives and commands the new track before any focus event.
		expect(replacement.api.playVideo).toHaveBeenCalledOnce();
		time = 4500;
		await vi.advanceTimersByTimeAsync(4500);
		await flushPromises();
		expect(getPlaybackSession(s.connection)?.controller.getStatus().code).not.toBe(
			"autoplay-blocked",
		);
		deferPlay = false;
		visibility.mockReturnValue("visible");
		window.dispatchEvent(new Event("focus"));
		document.dispatchEvent(new Event("visibilitychange"));
		window.dispatchEvent(new Event("pageshow"));
		await flushPromises();
		expect(replacement.api.playVideo).toHaveBeenCalledTimes(2);
		expect(replacement.api.seekTo).toHaveBeenLastCalledWith(24.5);
		expect(replacement.api.destroy).not.toHaveBeenCalled();
		expect(providers).toHaveLength(2);
		expect(s.connection.sent.filter(m => m.action === "playback-command")).toEqual([]);
		s.unmount();
		const calls = replacement.api.getCurrentTime.mock.calls.length;
		window.dispatchEvent(new Event("focus"));
		document.dispatchEvent(new Event("visibilitychange"));
		await flushPromises();
		expect(replacement.api.getCurrentTime).toHaveBeenCalledTimes(calls);
		visibility.mockRestore();
	});
	it("measures a small actual offset promptly on focus and coalesces lifecycle signals", async () => {
		vi.spyOn(performance, "now").mockReturnValue(0);
		const s = await mountRoom(true);
		s.provider.api.getCurrentTime.mockReturnValue(11.92);
		s.provider.api.seekTo.mockImplementation(position => {
			s.provider.api.getCurrentTime.mockReturnValue(position);
		});
		s.provider.api.seekTo.mockClear();
		s.connection.mockReset();
		window.dispatchEvent(new Event("focus"));
		document.dispatchEvent(new Event("visibilitychange"));
		window.dispatchEvent(new Event("pageshow"));
		await flushPromises();
		expect(s.provider.api.seekTo).toHaveBeenCalledOnce();
		expect(s.provider.api.seekTo).toHaveBeenCalledWith(12);
		expect(s.provider.api.playVideo).toHaveBeenCalledOnce();
		expect(s.provider.api.pauseVideo).not.toHaveBeenCalled();
		expect(s.provider.api.destroy).not.toHaveBeenCalled();
		expect(s.connection.sent.filter(m => m.action === "playback-command")).toEqual([]);
	});
	it("preserves the provider when hiding, showing or restoring the page", async () => {
		const s = await mountRoom(true);
		const visibility = vi.spyOn(document, "visibilityState", "get");
		try {
			visibility.mockReturnValue("hidden");
			document.dispatchEvent(new Event("visibilitychange"));
			await flushPromises();
			expect(s.provider.api.destroy).not.toHaveBeenCalled();
			visibility.mockReturnValue("visible");
			document.dispatchEvent(new Event("visibilitychange"));
			window.dispatchEvent(new Event("pageshow"));
			await flushPromises();
			expect(s.provider.api.destroy).not.toHaveBeenCalled();
			expect(providers).toHaveLength(1);
		} finally {
			visibility.mockRestore();
		}
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
	it("cancels a pending legacy fallback when navigating to another room", async () => {
		const s = await mountRoom();
		vi.useFakeTimers();
		s.connection.mockLifecycle();
		s.connection.mockReceive({
			action: "sync",
			name: "foo",
			currentSource: { service: "youtube", id: "prior-room" },
			isPlaying: true,
			playbackPosition: 99,
			playbackSpeed: 2,
		});
		await vi.advanceTimersByTimeAsync(500);
		await s.router.push("/room/another");
		await s.wrapper.vm.$nextTick();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(s.store.state.room.currentSource).toBeNull();
		expect(s.store.state.room.playbackEstablished).toBe(true);
		s.connection.mockReceive({ action: "sync", name: "another", currentSource: null });
		await vi.advanceTimersByTimeAsync(1_000);
		expect(s.store.state.room).toMatchObject({
			playbackEstablished: false,
			currentSource: null,
			isPlaying: false,
			playbackPosition: 0,
			playbackSpeed: 1,
		});
	});
});
