import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { PlayerStatus, Role } from "ott-common/models/types";
import { Grants, parseIntoGrantMask } from "ott-common/permissions";
import VideoQueue from "@/components/VideoQueue.vue";
import * as playbackSession from "@/playback/playback-session";
import { mountComponent } from "./component-test-utils";

const song = (id: string, title: string) => ({
	service: "youtube" as const,
	id,
	title,
	length: 200,
});

describe("regular queue history", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("shows played tracks and the current one above the queue, and goes back in one step", async () => {
		const command = vi.fn(() => true);
		vi.spyOn(playbackSession, "getPlaybackSession").mockReturnValue({
			command,
		} as unknown as NonNullable<ReturnType<typeof playbackSession.getPlaybackSession>>);
		const { wrapper, store } = mountComponent(VideoQueue);
		store.state.users.you.id = "me";
		store.state.users.users = new Map([
			[
				"me",
				{
					id: "me",
					name: "Me",
					role: Role.UnregisteredUser,
					isLoggedIn: false,
					status: PlayerStatus.ready,
				},
			],
		]);
		store.commit("room/SYNC", {
			playedTracks: [song("goldman01", "Quand tu danses"), song("faouzia1", "Unethical")],
			currentSource: song("nowplay1", "Now playing song"),
			queue: [song("nextsong", "Next song")],
			enableVoteSkip: false,
			grants: new Grants(new Map([[Role.UnregisteredUser, parseIntoGrantMask(["*"])]])),
		});
		await nextTick();
		const rows = wrapper.get('[data-cy="queue-history"]').findAll("li");
		expect(rows.map(row => row.text())).toEqual([
			expect.stringContaining("Quand tu danses"),
			expect.stringContaining("Unethical"),
			expect.stringContaining("Now playing song"),
		]);
		expect(rows[2].attributes("aria-current")).toBe("true");
		expect(rows[0].get("img").attributes("src")).toBe(
			"https://i.ytimg.com/vi/goldman01/mqdefault.jpg",
		);
		const again = wrapper.findAll('[data-cy="queue-play-again"]');
		await again[0].trigger("click");
		expect(command).toHaveBeenCalledWith({ command: "previous", steps: 2 });
		store.commit("room/SYNC", { playedTracks: [], currentSource: null, queue: [] });
	});
});
