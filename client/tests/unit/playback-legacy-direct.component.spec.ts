import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import Room from "@/views/Room.vue";
import { OttRoomConnectionMock, connectionInjectKey } from "@/plugins/connection";
import { OttSfx } from "@/plugins/sfx";
import { mountComponent } from "./component-test-utils";

vi.mock("@/common-http", () => ({
	API: { get: vi.fn(() => new Promise(() => undefined)), post: vi.fn() },
}));
vi.mock("@/util/token", () => ({ waitForToken: vi.fn(async () => undefined) }));
vi.mock("@/components/composables/media-audio-boost", () => ({
	useMediaAudioBoost: () => ({ setBoost: vi.fn(), resetFailedSetup: vi.fn() }),
}));

describe("legacy direct playback negotiation", () => {
	beforeEach(() => {
		vi.spyOn(OttSfx.prototype, "loadSfx").mockResolvedValue();
		vi.stubGlobal(
			"matchMedia",
			vi.fn(() => ({
				matches: false,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
			})),
		);
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
		vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("restores buffered legacy playback and exposes local autoplay recovery without another sync", async () => {
		const play = vi
			.spyOn(HTMLMediaElement.prototype, "play")
			.mockRejectedValue(new DOMException("Gesture required", "NotAllowedError"));
		const connection = new OttRoomConnectionMock();
		const mounted = mountComponent(Room, {
			global: { provide: { [connectionInjectKey as symbol]: connection } },
		});
		await mounted.router.push("/room/legacy");
		await flushPromises();
		connection.mockReceive({
			action: "sync",
			name: "legacy",
			currentSource: {
				service: "direct",
				id: "https://example.invalid/test.mp4",
				mime: "video/mp4",
				length: 200,
			},
			isPlaying: true,
			playbackPosition: 9,
			playbackSpeed: 2,
		});
		await vi.waitFor(() => expect(mounted.wrapper.find("video").exists()).toBe(true), {
			timeout: 2000,
		});
		await mounted.wrapper.get("video").trigger("canplay");
		await vi.waitFor(() =>
			expect(mounted.wrapper.find('[data-cy="playback-activate"]').exists()).toBe(true),
		);
		expect(play).toHaveBeenCalled();
		expect(mounted.store.state.room.isPlaying).toBe(true);
		const video = mounted.wrapper.get("video").element as HTMLVideoElement;
		expect(video.playbackRate).toBe(2);

		connection.mockReset();
		play.mockClear().mockResolvedValue();
		await mounted.wrapper.get('[data-cy="playback-activate"]').trigger("click");
		await flushPromises();
		expect(play).toHaveBeenCalled();
		await vi.waitFor(() => expect(video.currentTime).toBeGreaterThanOrEqual(9));
		expect(mounted.wrapper.find('[data-cy="playback-activate"]').exists()).toBe(false);
		expect(
			connection.sent.filter(message => ["req", "playback-command"].includes(message.action)),
		).toEqual([]);
	});
});
