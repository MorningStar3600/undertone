import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import VueSlider from "vue-slider-component";
import { PlayerStatus, Role } from "ott-common/models/types";
import { RoomRequestType } from "ott-common/models/messages";
import { Grants, parseIntoGrantMask } from "ott-common/permissions";
import VideoControls from "@/components/controls/VideoControls.vue";
import VideoProgressSlider from "@/components/controls/VideoProgressSlider.vue";
import TrackMoods from "@/components/music/TrackMoods.vue";
import { mountComponent } from "./component-test-utils";

const source = {
	service: "direct" as const,
	id: "https://example.com/song.mp3",
	title: "A song",
	length: 120,
	thumbnail: "https://example.com/cover.jpg",
};

async function controls(permissions = ["playback"]) {
	const result = mountComponent(VideoControls, {
		props: { sliderPosition: 30, truePosition: 30 },
	});
	result.store.state.users.you.id = "listener";
	result.store.state.users.users = new Map([
		[
			"listener",
			{
				id: "listener",
				name: "Listener",
				role: Role.UnregisteredUser,
				isLoggedIn: false,
				status: PlayerStatus.ready,
			},
		],
	]);
	result.store.commit("room/SYNC", {
		currentSource: { ...source },
		isPlaying: false,
		enableVoteSkip: false,
		votesToSkip: new Set(),
		grants: new Grants(new Map([[Role.UnregisteredUser, parseIntoGrantMask(permissions)]])),
	});
	await nextTick();
	result.connection.mockReset();
	return result;
}

describe("Persistent player controls", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"matchMedia",
			vi.fn(() => ({
				matches: false,
				addEventListener: () => undefined,
				removeEventListener: () => undefined,
			})),
		);
	});

	it("sends the existing synchronized play, pause and next requests", async () => {
		const { wrapper, store, connection } = await controls();
		await wrapper.get('[data-cy="playback-toggle"]').trigger("click");
		expect(connection.sent).toEqual([
			{ action: "req", request: { type: RoomRequestType.PlaybackRequest, state: true } },
		]);
		// State remains server-owned until the next sync.
		expect(store.state.room.isPlaying).toBe(false);
		store.commit("room/SYNC", { isPlaying: true });
		await nextTick();
		await wrapper.get('[data-cy="playback-toggle"]').trigger("click");
		await wrapper.get('[data-cy="playback-skip"]').trigger("click");
		expect(connection.sent.slice(1)).toEqual([
			{ action: "req", request: { type: RoomRequestType.PlaybackRequest, state: false } },
			{ action: "req", request: { type: RoomRequestType.SkipRequest } },
		]);
	});

	it("announces vote-skip state and sends the same skip request for voting/unvoting", async () => {
		const { wrapper, store, connection } = await controls();
		store.commit("room/SYNC", { enableVoteSkip: true });
		await nextTick();
		const skip = wrapper.get('[data-cy="playback-skip"]');
		expect(skip.attributes("aria-label")).toBe("Vote to skip video");
		expect(skip.attributes("aria-pressed")).toBe("false");
		await skip.trigger("click");
		store.commit("room/SYNC", { votesToSkip: new Set(["listener"]) });
		await nextTick();
		expect(skip.attributes("aria-pressed")).toBe("true");
		await skip.trigger("click");
		expect(connection.sent).toHaveLength(2);
		expect(
			connection.sent.every(
				message =>
					message.action === "req" &&
					message.request.type === RoomRequestType.SkipRequest,
			),
		).toBe(true);
	});

	it("disables common commands without grants while leaving personal volume usable", async () => {
		const { wrapper, connection } = await controls([]);
		expect(wrapper.get('[data-cy="playback-toggle"]').attributes("disabled")).toBeDefined();
		expect(wrapper.get('[data-cy="playback-skip"]').attributes("disabled")).toBeDefined();
		expect(wrapper.getComponent(VueSlider).props("disabled")).toBe(true);
		expect(wrapper.find('[data-cy="timestamp-display"] button').exists()).toBe(false);
		await wrapper.get('[data-cy="playback-toggle"]').trigger("click");
		await wrapper.get('[data-cy="playback-skip"]').trigger("click");
		wrapper.getComponent(VueSlider).vm.$emit("change", 45);
		await wrapper.get('[data-cy="volume-slider"]').setValue("35");
		expect(connection.sent).toEqual([]);
	});

	it("clamps seeks, rejects stale permission changes and handles streams with no duration", async () => {
		const { wrapper, store, connection } = await controls();
		const slider = wrapper.getComponent(VueSlider);
		slider.vm.$emit("change", 500);
		expect(connection.sent).toEqual([
			{ action: "req", request: { type: RoomRequestType.SeekRequest, value: 120 } },
		]);
		store.state.room.grants.setRoleGrants(Role.UnregisteredUser, 0);
		slider.vm.$emit("change", 45);
		expect(connection.sent).toHaveLength(1);
		store.commit("room/SYNC", { currentSource: { ...source, length: undefined } });
		await nextTick();
		expect(wrapper.getComponent(VueSlider).props("disabled")).toBe(true);
		expect(wrapper.findComponent(VideoProgressSlider).exists()).toBe(true);
	});

	it("resets only the progress widget when the next source has a shorter duration", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const { wrapper, store } = await controls();
		await wrapper.setProps({ sliderPosition: 110 });
		const transport = wrapper.get('[data-cy="playback-toggle"]').element;
		store.commit("room/SYNC", { currentSource: { ...source, id: "short-song", length: 15 } });
		await nextTick();
		expect(wrapper.getComponent(VueSlider).props("modelValue")).toBe(15);
		expect(wrapper.get('[data-cy="playback-toggle"]').element).toBe(transport);
		expect(errors).not.toHaveBeenCalled();
		errors.mockRestore();
	});

	it("supports exact keyboard seeking and ignores invalid timestamps", async () => {
		const { wrapper, connection } = await controls();
		const timestamp = wrapper.get('[data-cy="timestamp-display"]');
		await timestamp.get("button").trigger("click");
		await timestamp.get("input").setValue("01:00");
		await timestamp.get("input").trigger("keydown", { key: "Enter" });
		expect(connection.sent).toEqual([
			{ action: "req", request: { type: RoomRequestType.SeekRequest, value: 60 } },
		]);
		await timestamp.get("button").trigger("click");
		await timestamp.get("input").setValue("");
		await timestamp.get("input").trigger("keydown", { key: "Enter" });
		expect(connection.sent).toHaveLength(1);
	});

	it("unmutes to the level chosen with the personal slider, without a room request", async () => {
		const { wrapper, store, connection } = await controls();
		await wrapper.get('[data-cy="volume-slider"]').setValue("60");
		await wrapper.get('button[aria-label="Mute"]').trigger("click");
		expect(wrapper.get('button[aria-label="Unmute"]').attributes("aria-pressed")).toBe("true");
		await wrapper.get('[data-cy="volume-slider"]').setValue("25");
		await nextTick();
		expect(store.state.settings.muted).toBe(false);
		expect(store.state.settings.volume).toBe(25);
		expect((wrapper.get('[data-cy="volume-slider"]').element as HTMLInputElement).value).toBe(
			"25",
		);
		expect(connection.sent).toEqual([]);
	});

	it("keeps primary commands mounted while the secondary panel opens and restores focus", async () => {
		const { wrapper } = await controls();
		const transport = wrapper.get('[data-cy="playback-toggle"]').element;
		const more = wrapper.get('button[aria-label="More player controls"]');
		await more.trigger("click");
		await nextTick();
		expect(more.attributes("aria-expanded")).toBe("true");
		expect(wrapper.get('[data-cy="playback-toggle"]').element).toBe(transport);
		expect(wrapper.get('[data-cy="volume-slider"]').isVisible()).toBe(true);
		const panel = wrapper.get('section[role="region"]');
		expect(panel.isVisible()).toBe(true);
		expect(document.activeElement).toBe(panel.get("h2").element);
		await panel.trigger("keydown", { key: "Escape" });
		await nextTick();
		expect(more.attributes("aria-expanded")).toBe("false");
		expect(document.activeElement).toBe(more.element);
	});

	it("updates title and artwork without remounting transport, and disables commands when empty", async () => {
		const { wrapper, store } = await controls();
		const transport = wrapper.get('[data-cy="playback-toggle"]').element;
		store.commit("room/SYNC", {
			currentSource: {
				...source,
				title: "Another song",
				thumbnail: "https://example.com/other.jpg",
			},
		});
		await nextTick();
		expect(wrapper.get('[data-cy="current-title"]').text()).toBe("Another song");
		expect(wrapper.get("img").attributes("src")).toContain("other.jpg");
		expect(wrapper.get('[data-cy="playback-toggle"]').element).toBe(transport);
		store.commit("room/SYNC", { currentSource: null });
		await nextTick();
		expect(wrapper.get('[data-cy="current-title"]').text()).toBe("Nothing playing.");
		expect(wrapper.get('[data-cy="playback-toggle"]').attributes("disabled")).toBeDefined();
	});

	it("coordinates mood and secondary panels while retaining transport and actual track metadata", async () => {
		const { wrapper, store } = await controls();
		const custom = {
			id: "00000000-0000-4000-8000-000000000001",
			name: "Custom dreamy",
			normalizedName: "custom dreamy",
			iconKey: "moon" as const,
		};
		store.commit("room/SYNC", {
			music: {
				current: {
					trackId: "catalogue-track",
					contributorMoodIds: [custom.id],
					contributorMoods: [custom],
				},
			},
		});
		await nextTick();
		const transport = wrapper.get('[data-cy="playback-toggle"]').element;
		const volume = wrapper.get('[data-cy="volume-slider"]').element;
		await wrapper.get('[data-cy="player-moods"]').trigger("click");
		await nextTick();
		await nextTick();
		const annotations = wrapper.getComponent(TrackMoods);
		expect(annotations.props()).toMatchObject({
			trackId: "catalogue-track",
			contributorMoodIds: [custom.id],
			contributorMoods: [custom],
		});
		expect(document.querySelector('[data-cy="player-moods-panel"]')?.textContent).toContain(
			"Sign in",
		);
		expect(
			document.querySelector(`[data-mood-id="${custom.id}"]`)?.getAttribute("aria-pressed"),
		).not.toBe("true");
		await wrapper.get('button[aria-label="More player controls"]').trigger("click");
		await nextTick();
		await nextTick();
		expect(wrapper.get('[data-cy="player-moods"]').attributes("aria-expanded")).toBe("false");
		expect(
			wrapper.get('button[aria-label="More player controls"]').attributes("aria-expanded"),
		).toBe("true");
		expect(wrapper.get('[data-cy="playback-toggle"]').element).toBe(transport);
		expect(wrapper.get('[data-cy="volume-slider"]').element).toBe(volume);
	});

	it("uses explicit Media Session actions, rechecks grants and clears handlers on unmount", async () => {
		const handlers = new Map<string, MediaSessionActionHandler | null>();
		const mediaSession = {
			setActionHandler: vi.fn((name, handler) => handlers.set(name, handler)),
			metadata: null,
			playbackState: "none",
		};
		vi.stubGlobal(
			"MediaMetadata",
			class {
				constructor(data: object) {
					Object.assign(this, data);
				}
			},
		);
		Object.defineProperty(navigator, "mediaSession", {
			configurable: true,
			value: mediaSession,
		});
		const { store, connection, unmount } = await controls();
		handlers.get("pause")?.({ action: "pause" });
		expect(connection.sent).toEqual([]);
		handlers.get("play")?.({ action: "play" });
		expect(connection.sent).toHaveLength(1);
		store.commit("room/SYNC", { isPlaying: true });
		handlers.get("play")?.({ action: "play" });
		expect(connection.sent).toHaveLength(1);
		handlers.get("pause")?.({ action: "pause" });
		handlers.get("seekto")?.({ action: "seekto", seekTime: 80 });
		expect(connection.sent).toHaveLength(3);
		store.state.room.grants.setRoleGrants(Role.UnregisteredUser, 0);
		handlers.get("nexttrack")?.({ action: "nexttrack" });
		handlers.get("seekto")?.({ action: "seekto", seekTime: 60 });
		expect(connection.sent).toHaveLength(3);
		await nextTick();
		expect(mediaSession.metadata).toMatchObject({ title: "A song" });
		unmount();
		expect([...handlers.values()].every(handler => handler === null)).toBe(true);
		expect(mediaSession.metadata).toBeNull();
		Reflect.deleteProperty(navigator, "mediaSession");
	});
});
