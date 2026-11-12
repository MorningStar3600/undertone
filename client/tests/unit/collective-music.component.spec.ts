import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import { flushPromises } from "@vue/test-utils";
import { DEFAULT_MOODS } from "ott-common/models/music";
import type {
	MusicRoomActionInput,
	MusicRoomPublic,
	MusicRoomRequestSummary,
	MusicRoomResult,
} from "ott-common/models/music-room";
import { QueueMode, Role, PlayerStatus } from "ott-common/models/types";
import { Grants, parseIntoGrantMask } from "ott-common/permissions";
import {
	provideMusicRoom,
	MUSIC_RESULT_TIMEOUT,
	type MusicRoomCommands,
} from "@/composables/use-music-room";
import RoomMusicFilters from "@/components/music/RoomMusicFilters.vue";
import RoomMusicQueue from "@/components/music/RoomMusicQueue.vue";
import RoomMusicSettings from "@/components/music/RoomMusicSettings.vue";
import RoomMusicConfirmation from "@/components/music/RoomMusicConfirmation.vue";
import MusicPreview from "@/components/music/MusicPreview.vue";
import * as playbackSession from "@/playback/playback-session";
import { mountComponent } from "./component-test-utils";

const { API } = vi.hoisted(() => ({
	API: {
		request: vi.fn(async () => ({
			data: { success: true, items: [] as unknown[], total: 0, offset: 0, limit: 100 },
		})),
	},
}));
vi.mock("@/common-http", () => ({ API }));
const [focus, energetic] = DEFAULT_MOODS;
const reference = { service: "youtube" as const, id: "original-id" };
const entry = {
	entryId: "occurrence",
	trackId: "00000000-0000-4000-8000-000000000001",
	sourceId: "source",
	contributorId: "account:2",
	artists: ["Artist"],
	title: "Shared track",
	origin: "manual" as const,
};
const pending = (
	conflicts = [{ participantId: "account:2", moodId: focus.id }],
): MusicRoomRequestSummary => ({
	requestId: "manual",
	entryId: entry.entryId,
	trackId: entry.trackId,
	intent: "next",
	status: "pending",
	conflicts,
});
function publicState(revision = 12): MusicRoomPublic {
	return {
		revision,
		planRevision: revision,
		queue: [entry],
		queueTotal: 26,
		current: null,
		participants: [
			{
				participantId: "account:1",
				name: "Viewer",
				clientIds: ["own-tab", "other-own-tab"],
				includeMoodIds: [],
				excludeMoodIds: [],
			},
			{
				participantId: "account:2",
				name: "Léa",
				clientIds: ["lea"],
				includeMoodIds: [energetic.id],
				excludeMoodIds: [focus.id],
			},
		],
		settings: {
			fairShare: true,
			autoAdmitOnJoin: true,
			removeDepartedEntries: true,
			recencyEpsilon: 0.02,
			recencyTau: 10,
			artistRepeatWeight: 0.1,
			styleRepeatWeight: 0.5,
		},
	};
}
async function setup(permissions = ["*"], account = false) {
	let room!: MusicRoomCommands;
	const Host = defineComponent({
		setup() {
			room = provideMusicRoom();
			return () =>
				h("main", [
					h(RoomMusicFilters),
					h(RoomMusicQueue),
					h(RoomMusicSettings),
					h(RoomMusicConfirmation),
					h(MusicPreview, {
						item: {
							...reference,
							title: "Preview",
							startAt: 12,
							endAt: 90,
							subtitleUrl: "https://example.org/subs.vtt",
						},
						reference,
					}),
				]);
		},
	});
	const mounted = mountComponent(Host);
	if (account) {
		mounted.store.commit("LOGIN", { username: "Viewer", loggedIn: true, discordLinked: false });
	}
	mounted.store.state.users.you = { id: "own-tab" };
	mounted.store.state.users.users = new Map([
		[
			"own-tab",
			{
				id: "own-tab",
				name: "Viewer",
				role: Role.UnregisteredUser,
				isLoggedIn: false,
				status: PlayerStatus.ready,
			},
		],
	]);
	mounted.store.commit("room/SYNC", {
		queueMode: QueueMode.Music,
		name: "music-room",
		music: publicState(),
		queue: [{ service: "youtube", id: "phantom-legacy", title: "Phantom" }],
		currentSource: null,
		grants: new Grants(new Map([[Role.UnregisteredUser, parseIntoGrantMask(permissions)]])),
	});
	mounted.connection.connected.value = true;
	await flushPromises();
	const commands = () =>
		mounted.connection.sent.flatMap(m =>
			m.action === "req" && "command" in m.request ? [m.request.command] : [],
		);
	const latest = (action: string) =>
		commands()
			.filter(c => c.action === action)
			.at(-1)!;
	function reply(action: string, result: Partial<MusicRoomResult> = {}) {
		const command = latest(action);
		mounted.connection.mockReceive({
			action: "music-result",
			result: {
				correlationId: command.correlationId,
				status: "applied",
				revision: 12,
				...result,
			},
		});
	}
	return { ...mounted, room, commands, latest, reply };
}

describe("Collective music commands and views", () => {
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
	afterEach(() => {
		vi.useRealTimers();
	});
	it("edits only the authenticated participant's filters with accessible exclusions", async () => {
		const { wrapper, latest, store } = await setup();
		await wrapper.get(`[data-include-mood="${focus.id}"]`).trigger("click");
		await wrapper.get(`[data-include-mood="${energetic.id}"]`).trigger("contextmenu");
		expect(
			wrapper.get(`[data-exclude-mood="${energetic.id}"]`).attributes("aria-pressed"),
		).toBe("true");
		await wrapper.get('[data-cy="music-apply-filters"]').trigger("click");
		expect(latest("preferences")).toMatchObject({
			action: "preferences",
			expectedRevision: 12,
			includeMoodIds: [focus.id],
			excludeMoodIds: [energetic.id],
			content: "keep",
		});
		expect(latest("preferences")).not.toHaveProperty("participantId");
		expect(store.state.room.music?.participants[0].includeMoodIds).toEqual([]);
	});
	it("uses the explicit touch exclusion control without tagging the track", async () => {
		const { wrapper, latest, commands } = await setup();
		await wrapper.get(`[data-exclude-mood="${focus.id}"]`).trigger("click");
		await wrapper.get('[data-cy="music-apply-filters"]').trigger("click");
		expect(latest("preferences")).toMatchObject({
			includeMoodIds: [],
			excludeMoodIds: [focus.id],
		});
		expect(commands().some(c => c.action === "request")).toBe(false);
	});
	it("renders music provenance and totals and pages the authoritative queue", async () => {
		const { wrapper, room, latest, reply } = await setup();
		expect(wrapper.get('[data-cy="music-queue"]').text()).toContain("Shared track");
		expect(wrapper.get('[data-cy="music-queue"]').text()).toContain("Léa");
		expect(wrapper.get('[data-cy="music-queue"]').text()).toContain("26");
		expect(wrapper.text()).not.toContain("Phantom");
		await wrapper.get('[data-cy="music-full-queue"]').trigger("click");
		expect(latest("queue")).toMatchObject({ offset: 0, limit: 25 });
		reply("queue", { page: { items: [entry], total: 26, offset: 0, limit: 25 } });
		await flushPromises();
		const load = room.queue.load(25);
		reply("queue", {
			page: {
				items: [{ ...entry, entryId: "last", title: "Last" }],
				total: 26,
				offset: 25,
				limit: 25,
			},
		});
		await load;
		expect(room.queue.offset.value).toBe(25);
		expect(room.queue.items.value[0].title).toBe("Last");
		await wrapper.get('[data-cy="music-remove"]').trigger("click");
		expect(latest("remove")).toMatchObject({ entryId: "last" });
	});
	it("checks add, order, removal and settings grants at command time", async () => {
		const { wrapper, room, commands } = await setup(["manage-queue.add"]);
		expect(wrapper.find('[data-cy="music-remove"]').exists()).toBe(false);
		expect(wrapper.get('[data-cy="music-add-mix"]').attributes("disabled")).toBeUndefined();
		expect(wrapper.get('[data-cy="music-add-next"]').attributes("disabled")).toBeDefined();
		await room.run({ action: "settings", settings: { fairShare: false } });
		await room.run({ action: "replan", content: "renew" });
		await room.run({ action: "remove", entryId: "occurrence" });
		expect(commands().every(c => c.action === "requests")).toBe(true);
	});
	it("uses single provider references, idempotence IDs and playback extras for next", async () => {
		const { wrapper, latest, commands, store } = await setup();
		await wrapper.get('[data-cy="music-add-next"]').trigger("click");
		expect(latest("request")).toMatchObject({
			reference,
			intent: "next",
			extras: { startAt: 12, endAt: 90, subtitleUrl: "https://example.org/subs.vtt" },
		});
		expect(latest("request")).toHaveProperty("requestId");
		expect(commands().filter(c => c.action === "request")).toHaveLength(1);
		expect(store.state.room.currentSource).toBeNull();
	});
	it("ignores foreign correlations, reports stale revisions, and retries the identical intent explicitly", async () => {
		const { wrapper, room, latest, reply, connection } = await setup();
		await wrapper.get('[data-cy="music-add-next"]').trigger("click");
		const original = latest("request");
		connection.mockReceive({
			action: "music-result",
			result: {
				correlationId: "foreign",
				revision: 300,
				status: "applied",
				request: pending(),
			},
		});
		expect(room.busy.value).toBe(true);
		expect(room.confirmation.value).toBeNull();
		reply("request", { status: "revision-conflict", revision: 13 });
		await flushPromises();
		expect(room.status.value).toBe("revision-conflict");
		const retry = room.retry();
		expect(latest("request")).toMatchObject({
			...original,
			expectedRevision: 13,
			correlationId: expect.any(String),
		});
		expect(latest("request").correlationId).not.toBe(original.correlationId);
		reply("request", { status: "slot-conflict", revision: 13 });
		await retry;
		expect(
			(latest("request") as Extract<MusicRoomActionInput, { action: "request" }>).intent,
		).toBe("next");
	});
	it("groups offered conflicts, resolves names, and echoes only each newly offered pair", async () => {
		const { wrapper, room, latest, reply } = await setup();
		await wrapper.get('[data-cy="music-add-next"]').trigger("click");
		const offered = [
			{ participantId: "account:2", moodId: focus.id },
			{ participantId: "account:1", moodId: energetic.id },
		];
		reply("request", {
			status: "confirmation-required",
			request: pending(offered),
			revision: 13,
		});
		await flushPromises();
		expect(document.querySelector('[data-cy="music-conflicts"]')?.textContent).toContain("Léa");
		expect(document.querySelector('[data-cy="music-conflicts"]')?.textContent).toContain(
			"Viewer",
		);
		expect(document.querySelector('[data-cy="music-conflicts"]')?.textContent).toContain(
			focus.name,
		);
		const confirm = room.confirm();
		expect(latest("confirm")).toMatchObject({
			trackId: entry.trackId,
			conflicts: offered,
			expectedRevision: 13,
		});
		reply("confirm", {
			status: "confirmation-required",
			request: pending([{ participantId: "account:2", moodId: energetic.id }]),
			revision: 14,
		});
		await confirm;
		await nextTick();
		expect(room.confirmation.value?.conflicts).toEqual([
			{ participantId: "account:2", moodId: energetic.id },
		]);
		const second = room.confirm();
		expect(latest("confirm")).toMatchObject({
			conflicts: [{ participantId: "account:2", moodId: energetic.id }],
			expectedRevision: 14,
		});
		reply("confirm", {
			request: { ...pending(), status: "admitted", conflicts: [] },
			revision: 15,
		});
		await second;
		expect(room.confirmation.value).toBeNull();
	});
	it("cancels a pending request without enqueueing or confirming", async () => {
		const { wrapper, room, commands, reply } = await setup();
		await wrapper.get('[data-cy="music-add-next"]').trigger("click");
		reply("request", { status: "confirmation-required", request: pending() });
		await flushPromises();
		(document.querySelector('[data-cy="music-cancel"]') as HTMLButtonElement).click();
		await nextTick();
		expect(commands().at(-1)).toMatchObject({ action: "cancel", requestId: "manual" });
		reply("cancel", { request: { ...pending(), status: "cancelled", conflicts: [] } });
		await flushPromises();
		expect(room.confirmation.value).toBeNull();
		expect(commands().filter(c => c.action === "request")).toHaveLength(1);
		expect(commands().some(c => c.action === "confirm")).toBe(false);
	});
	it("refreshes private requests on public revision changes and keeps responses private", async () => {
		const { room, store, latest, reply } = await setup();
		reply("requests", { page: { items: [pending()], total: 30, offset: 0, limit: 25 } });
		await flushPromises();
		expect(room.requests.items.value).toHaveLength(1);
		store.commit("room/SYNC", { music: publicState(20) });
		await nextTick();
		expect(latest("requests")).toMatchObject({
			action: "requests",
			expectedRevision: 20,
			offset: 0,
		});
		reply("requests", {
			revision: 20,
			page: {
				items: [pending([{ participantId: "account:2", moodId: energetic.id }])],
				total: 30,
				offset: 0,
				limit: 25,
			},
		});
		await flushPromises();
		expect(room.requests.items.value[0].conflicts[0].moodId).toBe(energetic.id);
		expect(store.state.room.music).not.toHaveProperty("requests");
	});
	it.each(["logout", "token", "room"])(
		"clears private state and ignores late replies after %s",
		async kind => {
			const { wrapper, store, room, connection, latest } = await setup();
			await wrapper.get('[data-cy="music-add-next"]').trigger("click");
			const old = latest("request");
			const reset = {
				logout: () => store.commit("LOGOUT"),
				token: () => store.commit("users/SET_AUTH_TOKEN", "synthetic-test-token"),
				room: () =>
					store.commit("room/SYNC", { name: "another-room", music: publicState(1) }),
			};
			reset[kind as keyof typeof reset]();
			connection.mockReceive({
				action: "music-result",
				result: {
					correlationId: old.correlationId,
					revision: 99,
					status: "confirmation-required",
					request: pending(),
				},
			});
			await flushPromises();
			expect(room.confirmation.value).toBeNull();
			expect(room.requests.items.value).toEqual([]);
			expect(room.busy.value).toBe(false);
			expect(room.status.value).toBeNull();
		},
	);
	it("bounds pending lifetime and disposes its private listener", async () => {
		const { room, connection, latest, unmount } = await setup();
		vi.useFakeTimers();
		const action = room.request(reference, {}, "mix");
		const old = latest("request");
		await vi.advanceTimersByTimeAsync(MUSIC_RESULT_TIMEOUT);
		await action;
		expect(room.busy.value).toBe(false);
		expect(room.status.value).toBe("timeout");
		unmount();
		connection.mockReceive({
			action: "music-result",
			result: {
				correlationId: old.correlationId,
				revision: 30,
				status: "confirmation-required",
				request: pending(),
			},
		});
		expect(room.confirmation.value).toBeNull();
	});

	it("resolves guest custom rules and offered conflicts without account vocabulary reads", async () => {
		const { wrapper, room, reply, commands, store } = await setup();
		const reads = API.request.mock.calls.length;
		const custom = {
			id: "00000000-0000-4000-8000-000000000099",
			name: "Epic custom",
			normalizedName: "epic custom",
			iconKey: "flame" as const,
		};
		const offer = pending([{ participantId: "account:2", moodId: custom.id }]);
		await wrapper.get('[data-cy="music-add-next"]').trigger("click");
		reply("request", { status: "confirmation-required", request: offer });
		await flushPromises();
		expect(
			(document.querySelector('[data-cy="music-confirm"]') as HTMLButtonElement).disabled,
		).toBe(true);
		const later = [...document.querySelectorAll("button")].find(
			b => b.textContent === "Review later",
		)!;
		later.click();
		await flushPromises();
		expect(room.confirmation.value).toBeNull();
		expect(commands().some(c => c.action === "cancel")).toBe(false);
		store.commit("room/SYNC", { music: { ...publicState(13), ruleMoods: [custom] } });
		room.confirmation.value = {
			...offer,
			conflictMetadata: [
				{ ...offer.conflicts[0], mood: custom, participantName: "Last authoritative name" },
			],
		};
		// The excluding participant can depart after the server offered the confirmation.
		store.commit("room/SYNC", {
			music: {
				...publicState(14),
				participants: publicState().participants.slice(0, 1),
				ruleMoods: [custom],
			},
		});
		await flushPromises();
		expect(wrapper.get(`[data-include-mood="${custom.id}"]`).text()).toContain(custom.name);
		expect(document.querySelector('[data-cy="music-conflicts"]')?.textContent).toContain(
			custom.name,
		);
		expect(
			(document.querySelector('[data-cy="music-confirm"]') as HTMLButtonElement).disabled,
		).toBe(false);
		expect(document.querySelector('[data-cy="music-conflicts"]')?.textContent).toContain(
			"Last authoritative name",
		);
		expect(API.request.mock.calls.length).toBe(reads);
	});
	it("refreshes a bounded pending slice separately from history and purges late session replies", async () => {
		const { room, commands, connection, store, wrapper } = await setup();
		const pendingCommand = () =>
			commands()
				.filter(c => c.action === "requests" && c.filter === "pending")
				.at(-1)!;
		const respond = (command: MusicRoomActionInput, revision: number, title: string) =>
			connection.mockReceive({
				action: "music-result",
				result: {
					correlationId: command.correlationId,
					status: "applied",
					revision,
					pendingCount: 27,
					page: { items: [{ ...pending(), title }], total: 27, offset: 0, limit: 25 },
				},
			});
		expect(pendingCommand()).toMatchObject({ offset: 0, limit: 25 });
		respond(pendingCommand(), 12, "Old request needing review");
		await flushPromises();
		expect(wrapper.get('[data-cy="pending-requests"]').text()).toContain(
			"Old request needing review",
		);
		expect(room.pendingRequests.total.value).toBe(27);
		expect(room.requests.items.value).toEqual([]);
		const more = room.pendingRequests.load(25);
		expect(pendingCommand()).toMatchObject({ filter: "pending", offset: 25, limit: 25 });
		respond(pendingCommand(), 12, "Page two");
		await more;
		store.commit("room/SYNC", { music: publicState(20) });
		await nextTick();
		expect(pendingCommand()).toMatchObject({ offset: 0, expectedRevision: 20 });
		const stale = pendingCommand();
		respond(stale, 19, "Stale");
		await flushPromises();
		expect(room.pendingRequests.items.value).toEqual([]);
		expect(pendingCommand().correlationId).not.toBe(stale.correlationId);
		expect(commands().filter(c => c.action === "requests" && (c.offset ?? 0) > 0)).toHaveLength(
			1,
		);
		const old = pendingCommand();
		store.commit("users/SET_AUTH_TOKEN", "replacement-session");
		respond(old, 21, "Other session");
		await flushPromises();
		expect(room.pendingRequests.items.value).toEqual([]);
		expect(room.pendingRequests.total.value).toBe(0);
	});

	it("uses a synchronous public revision and discards pages from older revisions", async () => {
		const { store, room, latest, reply } = await setup();
		store.commit("room/SYNC", { music: publicState(30) });
		const mutation = room.run({ action: "settings", settings: { fairShare: false } });
		expect(latest("settings").expectedRevision).toBe(30);
		reply("settings", { revision: 30 });
		await mutation;
		const load = room.queue.load(25);
		const firstCorrelation = latest("queue").correlationId;
		reply("queue", {
			revision: 29,
			page: { items: [entry], total: 26, offset: 25, limit: 25 },
		});
		await load;
		expect(room.queue.items.value).toEqual([]);
		expect(latest("queue")).toMatchObject({ offset: 0, expectedRevision: 30 });
		expect(latest("queue").correlationId).not.toBe(firstCorrelation);
	});

	it("clears outstanding intent on disconnect and waits for a new explicit action", async () => {
		const { room, connection, latest, commands } = await setup();
		const request = room.request(reference, {}, "next");
		const before = latest("request");
		connection.connected.value = false;
		await request;
		expect(room.busy.value).toBe(false);
		expect(room.retryCommand.value).toBeNull();
		connection.mockReceive({
			action: "music-result",
			result: {
				correlationId: before.correlationId,
				revision: 50,
				status: "confirmation-required",
				request: pending(),
			},
		});
		connection.connected.value = true;
		await flushPromises();
		expect(room.confirmation.value).toBeNull();
		expect(commands().filter(c => c.action === "request")).toHaveLength(1);
	});
});

describe("music queue history", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("shows played tracks before the current one and goes back to any of them in one step", async () => {
		const command = vi.fn(() => true);
		vi.spyOn(playbackSession, "getPlaybackSession").mockReturnValue({
			command,
		} as unknown as NonNullable<ReturnType<typeof playbackSession.getPlaybackSession>>);
		const mounted = await setup();
		const first = { ...entry, entryId: "first", title: "First song" };
		const second = {
			...entry,
			entryId: "second",
			title: "Second song",
			artworkUrl: "https://i.ytimg.com/vi/second12/mqdefault.jpg",
		};
		mounted.store.commit("room/SYNC", {
			music: {
				...publicState(),
				played: [first, second],
				current: {
					...entry,
					entryId: "now",
					title: "Now song",
					playbackId: "p-now",
					started: true,
					contributorMoodIds: [],
					contributorMoods: [],
				},
			},
		});
		await nextTick();
		const queue = mounted.wrapper.get('[data-cy="music-played"]');
		const rows = queue.findAll("li");
		expect(rows.map(row => row.text())).toEqual([
			expect.stringContaining("First song"),
			expect.stringContaining("Second song"),
			expect.stringContaining("Now song"),
		]);
		expect(rows[2].attributes("aria-current")).toBe("true");
		expect(rows[1].get("img").attributes("src")).toContain("second12");
		const again = queue.findAll('[data-cy="queue-play-again"]');
		await again[0].trigger("click");
		await again[1].trigger("click");
		expect(command).toHaveBeenNthCalledWith(1, { command: "previous", steps: 2 });
		expect(command).toHaveBeenNthCalledWith(2, { command: "previous", steps: 1 });

		mounted.store.commit("room/SYNC", { enableVoteSkip: true });
		await nextTick();
		expect(again[0].attributes("disabled")).toBeDefined();
	});
});
