import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sequelize } from "sequelize";
import { Room, RoomUser } from "../../room.js";
import { RoomMusic, musicIdentity } from "../../music/room-music.js";
import { SqlMusicRoomStore } from "../../music/room-music-storage.js";
import { musicRoomModels } from "../../models/music-room.js";
import { createCatalogueFixture } from "./music-test-helpers.js";
import { DEFAULT_MOODS } from "ott-common/models/music.js";
import { MusicRoomActionSchema, type MusicRoomAction } from "ott-common/models/music-room.js";
import { QueueMode, Role } from "ott-common/models/types.js";
import { RoomRequestType } from "ott-common/models/messages.js";
import permissions from "ott-common/permissions.js";
import tokens from "../../auth/tokens.js";
import usermanager from "../../usermanager.js";
import type { User } from "../../models/user.js";
import { createMusicModels } from "../../models/music.js";
import { MusicCatalogue } from "../../music/catalogue.js";

const PRIVATE_SYNC_FIELDS =
	/tagsByUser|offeredConflicts|candidates|token-|history|loadedPlaybackIds/;
const PRIVATE_REQUEST_FIELDS = /providerId|tagsByUser|mediaRef/;
const require = createRequire(import.meta.url);
vi.mock("../../infoextractor.js", () => ({
	default: { getVideoInfo: vi.fn(), getServiceAdapterForURL: vi.fn() },
}));

describe("Music Room protocol and durable transactions", () => {
	let fixture: Awaited<ReturnType<typeof createCatalogueFixture>>;
	let room: Room;
	let store: SqlMusicRoomStore;
	const context = { username: "one", clientId: "tab1", role: Role.UnregisteredUser };
	const reference = (id: string) => ({ service: "youtube" as const, id });
	const identity = "account:1";
	beforeEach(async () => {
		fixture = await createCatalogueFixture();
		vi.spyOn(tokens, "getSessionInfo").mockImplementation(async token => ({
			isLoggedIn: true,
			user_id: token === "token-2" ? 2 : 1,
		}));
		vi.spyOn(usermanager, "getUser").mockImplementation(
			async ({ id }) => ({ id, username: "fixture" }) as User,
		);
		store = new SqlMusicRoomStore(() => fixture.connection);
		room = new Room(
			{ name: "music-test", queueMode: QueueMode.Music },
			{ catalogue: fixture.catalogue, store },
		);
		room.throttledSync.cancel();
		room.throttledSync = vi.fn() as unknown as typeof room.throttledSync;
		vi.spyOn(room, "publish").mockResolvedValue(undefined);
		vi.spyOn(room, "command").mockResolvedValue(undefined);
		for (const [id, account] of [
			["tab1", 1],
			["tab2", 2],
		] as const) {
			const user = new RoomUser(id, `token-${account}`);
			user.user_id = account;
			room.realusers.push(user);
		}
		room.grants.setRoleGrants(Role.UnregisteredUser, permissions.parseIntoGrantMask(["*"]));
		for (let i = 0; i < 24; i++) {
			await fixture.catalogue.addLibraryTrack((i % 2) + 1, {
				reference: reference(`track-${i}`),
			});
		}
		await room.musicEngine.refresh(true);
	});
	afterEach(async () => {
		room.throttledSync.cancel?.();
		vi.restoreAllMocks();
		await fixture.connection.close();
	});
	const execute = async (command: Record<string, unknown>, owner = identity) =>
		room.musicEngine.execute(
			MusicRoomActionSchema.parse({
				expectedRevision: room.music!.revision,
				correlationId: randomUUID(),
				...command,
			}),
			owner,
		);
	const manual = async (id: string, intent = "mix") =>
		execute({ action: "request", requestId: randomUUID(), reference: reference(id), intent });
	it("supplies authoritative guest names through Room's real private confirmation path", async () => {
		const author = new RoomUser("guest-author", "guest-author-token");
		author.unregisteredUsername = "Guest requester";
		const excluder = new RoomUser("guest-excluder", "guest-excluder-token");
		excluder.unregisteredUsername = "Guest listener";
		room.realusers.push(author, excluder);
		vi.spyOn(tokens, "getSessionInfo").mockResolvedValue({
			isLoggedIn: false,
			username: author.username,
		});
		const mood = await fixture.catalogue.createMood(2, {
			name: "Guest custom conflict",
			iconKey: "moon",
		});
		const { track } = await fixture.catalogue.resolveTrack(reference("guest-real-room"));
		await fixture.catalogue.setTrackMood(2, track.id, mood.id, true);
		await room.musicEngine.refresh(true);
		await execute(
			{ action: "preferences", includeMoodIds: [], excludeMoodIds: [mood.id] },
			musicIdentity(excluder),
		);
		const send = (action: Record<string, unknown>) =>
			room.processUnauthorizedRequest(
				{
					type: RoomRequestType.MusicRoomRequest,
					command: MusicRoomActionSchema.parse({
						expectedRevision: room.music!.revision,
						correlationId: randomUUID(),
						...action,
					}),
				},
				{ clientId: author.id, token: author.token },
			);
		await send({
			action: "request",
			requestId: "guest-real-request",
			reference: reference("guest-real-room"),
			intent: "mix",
		});
		expect(room.command).toHaveBeenLastCalledWith(
			expect.objectContaining({
				type: "send",
				clientId: author.id,
				message: expect.objectContaining({
					action: "music-result",
					result: expect.objectContaining({
						status: "confirmation-required",
						request: expect.objectContaining({
							conflictMetadata: [
								{
									participantId: musicIdentity(excluder),
									moodId: mood.id,
									mood,
									participantName: "Guest listener",
								},
							],
						}),
					}),
				}),
			}),
		);
		expect(room.music!.ruleMoods).toContainEqual(mood);
		await send({
			action: "confirm",
			requestId: "guest-real-request",
			trackId: track.id,
			conflicts: [{ participantId: musicIdentity(excluder), moodId: mood.id }],
		});
		expect(
			room.musicState!.requests.find(request => request.requestId === "guest-real-request")
				?.status,
		).toBe("admitted");
	});
	it("discovers old and off-page pending requests without leaking another author's history", async () => {
		const early = await manual("early");
		const { track } = await fixture.catalogue.resolveTrack(reference("early"));
		for (let i = 0; i < 28; i++) {
			await manual("early");
		}
		await fixture.catalogue.setTrackMood(2, track.id, DEFAULT_MOODS[0].id, true);
		await execute(
			{ action: "preferences", includeMoodIds: [], excludeMoodIds: [DEFAULT_MOODS[0].id] },
			"account:2",
		);
		const late = await manual("early");
		const lookup = vi.spyOn(fixture.catalogue, "moodsByIds");
		const pending = await execute({ action: "requests", filter: "pending", limit: 1 });
		expect(pending.pendingCount).toBe(30);
		expect(pending.page).toMatchObject({ total: 30, offset: 0, limit: 1 });
		expect(pending.page!.items).toEqual([
			expect.objectContaining({
				requestId: early.request!.requestId,
				title: "Same title",
				status: "pending",
			}),
		]);
		expect(lookup).not.toHaveBeenCalled();
		const second = await execute({
			action: "requests",
			filter: "pending",
			offset: 29,
			limit: 1,
		});
		expect(second.page!.items[0]).toMatchObject({ requestId: late.request!.requestId });
		const history = await execute({ action: "requests" });
		expect(history.page!.total).toBe(30);
		expect(history.page!.items).toHaveLength(25);
		const other = await execute({ action: "requests", filter: "pending" }, "account:2");
		expect(other.pendingCount).toBe(0);
		expect(other.page!.items).toEqual([]);
		expect(JSON.stringify(pending)).not.toMatch(PRIVATE_REQUEST_FIELDS);
		await execute({ action: "cancel", requestId: early.request!.requestId });
		expect((await execute({ action: "requests", filter: "pending" })).pendingCount).toBe(29);
		await room.processRequest(
			{
				type: RoomRequestType.MusicRoomRequest,
				command: MusicRoomActionSchema.parse({
					action: "requests",
					filter: "pending",
					offset: 25,
					expectedRevision: 0,
					correlationId: "targeted-pending",
				}),
			},
			context,
		);
		expect(room.command).toHaveBeenLastCalledWith(
			expect.objectContaining({
				type: "send",
				clientId: "tab1",
				message: expect.objectContaining({
					action: "music-result",
					result: expect.objectContaining({
						correlationId: "targeted-pending",
						pendingCount: 29,
						page: expect.objectContaining({ offset: 25, total: 29 }),
					}),
				}),
			}),
		);
	});
	it("publishes only active rule vocabulary and supplies custom conflict names to guests", async () => {
		const custom = await fixture.catalogue.createMood(2, {
			name: "Dreamy custom",
			iconKey: "moon",
		});
		const unrelated = await fixture.catalogue.createMood(2, {
			name: "Private unrelated",
			iconKey: "moon",
		});
		const guest = musicIdentity({ token: "synthetic-guest" });
		const otherGuest = musicIdentity({ token: "different-session" });
		let people = [guest, otherGuest, "account:2"];
		let names = [
			{ participantId: guest, name: "Guest name" },
			{ participantId: "account:2", name: "Authoritative name" },
		];
		const engine = new RoomMusic(
			"guest-vocabulary",
			() => people,
			async () => undefined,
			fixture.catalogue,
			store,
			undefined,
			() => names,
		);
		await engine.refresh(true);
		const act = (action: Record<string, unknown>, owner = guest) =>
			engine.execute(
				MusicRoomActionSchema.parse({
					expectedRevision: engine.publicState!.revision,
					correlationId: randomUUID(),
					...action,
				}),
				owner,
			);
		await act(
			{ action: "preferences", includeMoodIds: [], excludeMoodIds: [custom.id] },
			"account:2",
		);
		expect(engine.publicState!.ruleMoods).toEqual([custom]);
		const withRules = new RoomMusic(
			"guest-vocabulary",
			() => people,
			async () => undefined,
			fixture.catalogue,
			store,
		);
		await withRules.initialize();
		expect(withRules.publicState!.ruleMoods).toEqual([custom]);
		expect(JSON.stringify(engine.publicState)).not.toContain(unrelated.id);
		const { track } = await fixture.catalogue.resolveTrack(reference("guest-custom"));
		await fixture.catalogue.setTrackMood(2, track.id, custom.id, true);
		const pending = await act({
			action: "request",
			requestId: "guest-offer",
			reference: reference("guest-custom"),
			intent: "next",
		});
		expect(pending.request!.conflictMetadata).toEqual([
			{
				participantId: "account:2",
				moodId: custom.id,
				mood: custom,
				participantName: "Authoritative name",
			},
		]);
		// Authoritative last names survive a departure between an offer and a private reread.
		expect(
			(await act({ action: "requests", filter: "pending" }, otherGuest)).page!.items,
		).toEqual([]);
		people = [guest];
		names = [names[0]];
		const reread = await act({ action: "requests", filter: "pending" });
		expect(reread.page!.items[0]).toMatchObject({
			conflictMetadata: pending.request!.conflictMetadata,
		});
		const accepted = await act({
			action: "confirm",
			requestId: "guest-offer",
			trackId: track.id,
			conflicts: pending.request!.conflicts,
		});
		expect(["applied", "duplicate"]).toContain(accepted.status);
		expect(accepted.request!.status).toBe("admitted");
		expect(engine.publicState!.ruleMoods).toEqual([]);
		const restored = new RoomMusic(
			"guest-vocabulary",
			() => people,
			async () => undefined,
			fixture.catalogue,
			store,
		);
		await restored.initialize();
		expect(restored.publicState!.ruleMoods).toEqual([]);
	});
	it("keeps strict legacy paging defaults and validates references independently of preview metadata", async () => {
		expect(
			MusicRoomActionSchema.parse({
				action: "requests",
				expectedRevision: 0,
				correlationId: "old",
			}),
		).toMatchObject({ filter: "all", offset: 0, limit: 25 });
		for (const fields of [{ filter: "unknown" }, { pendingOnly: true }, { limit: 101 }]) {
			expect(
				MusicRoomActionSchema.safeParse({
					action: "requests",
					expectedRevision: 0,
					correlationId: "bad",
					...fields,
				}).success,
			).toBe(false);
		}
		await expect(
			execute({
				action: "request",
				requestId: "disk",
				reference: { service: "direct", id: "file:///private/music.mp3" },
				intent: "mix",
			}),
		).rejects.toThrow();
		expect(
			MusicRoomActionSchema.safeParse({
				action: "request",
				expectedRevision: 0,
				correlationId: "bad",
				requestId: "forged",
				reference: { ...reference("valid"), originalReference: reference("bypass") },
				intent: "mix",
			}).success,
		).toBe(false);
	});
	it("sanitizes private request titles without falling back to provider URLs", async () => {
		const resolve = fixture.resolver.resolve;
		vi.mocked(resolve).mockResolvedValueOnce({
			reference: reference("signed-title"),
			video: {
				service: "direct",
				id: "https://media.example/private?token=synthetic",
				title: "https://media.example/private?token=synthetic",
			},
		});
		const pending = await manual("signed-title");
		expect(pending.request!.title).toBe("Untitled track");
		const page = await execute({ action: "requests" });
		expect(page.page!.items[0].title).toBe("Untitled track");
		expect(JSON.stringify(page)).not.toContain("synthetic");
	});
	it("keeps numeric OTT requests, bounded public state, real two-person Q and manual excess", async () => {
		expect(RoomRequestType.UpdateQueueItemRequest).toBe(19);
		expect(RoomRequestType.MusicRoomRequest).toBe(20);
		expect(room.music!.participants).toHaveLength(2);
		expect(room.music!.queueTotal).toBe(10);
		for (let i = 0; i < 4; i++) {
			await manual(`manual-${i}`);
		}
		expect(room.music!.queueTotal).toBe(14);
		const sync = JSON.parse(room.serializeSyncableState());
		expect(sync.music.queue).toHaveLength(10);
		expect(sync.queue).toEqual([]);
		expect(JSON.stringify(sync)).not.toMatch(PRIVATE_SYNC_FIELDS);
		for (const total of [13, 12, 11, 10, 9]) {
			await room.dequeueNext();
			expect(room.music!.queueTotal).toBe(total);
		}
		expect(room.musicState!.history.events).toHaveLength(0); // all loaded paused
		await room.play();
		expect(room.music!.queueTotal).toBe(10);
		expect(room.musicState!.history.events).toHaveLength(1);
		await room.pause();
		await room.play();
		await room.seek({ type: RoomRequestType.SeekRequest, value: 12 }, context);
		expect(room.musicState!.history.events).toHaveLength(1);
	});
	it("requires server-issued exclusions only, ignores inclusion for manual, and keeps next noninterrupting", async () => {
		const { track } = await fixture.catalogue.resolveTrack(reference("outside-library"));
		await fixture.catalogue.setTrackMood(2, track.id, DEFAULT_MOODS[0].id, true);
		await execute(
			{
				action: "preferences",
				includeMoodIds: [DEFAULT_MOODS[1].id],
				excludeMoodIds: [DEFAULT_MOODS[0].id],
			},
			"account:2",
		);
		await room.dequeueNext();
		await room.play();
		const current = room.currentSource;
		const pending = await manual("outside-library", "next");
		expect(pending.status).toBe("confirmation-required");
		expect(pending.request!.conflicts).toEqual([
			{ participantId: "account:2", moodId: DEFAULT_MOODS[0].id },
		]);
		const forged = await execute({
			action: "confirm",
			requestId: pending.request!.requestId,
			trackId: track.id,
			conflicts: [{ participantId: "account:1", moodId: DEFAULT_MOODS[0].id }],
		});
		expect(forged.status).toBe("invalid-confirmation");
		const confirmed = await execute({
			action: "confirm",
			requestId: pending.request!.requestId,
			trackId: track.id,
			conflicts: pending.request!.conflicts,
		});
		expect(confirmed.status).toBe("applied");
		expect(room.currentSource).toEqual(current);
		expect(room.music!.queue[0].trackId).toBe(track.id);
		expect(room.musicState!.candidates.some(c => c.trackId === track.id)).toBe(false);
		await fixture.catalogue.setTrackMood(2, track.id, DEFAULT_MOODS[2].id, true);
		await execute(
			{
				action: "preferences",
				includeMoodIds: [],
				excludeMoodIds: [DEFAULT_MOODS[0].id, DEFAULT_MOODS[2].id],
			},
			"account:2",
		);
		const page = await execute({ action: "requests", offset: 0, limit: 1 });
		expect(page.page!.items[0]).toMatchObject({
			status: "pending",
			conflicts: [{ participantId: "account:2", moodId: DEFAULT_MOODS[2].id }],
		});
		expect(room.currentSource).toEqual(current);
	});
	it("makes simultaneous next claims atomic and rejects stale revision mutations", async () => {
		const revision = room.music!.revision;
		const commands = ["next-a", "next-b"].map(id =>
			MusicRoomActionSchema.parse({
				action: "request",
				expectedRevision: revision,
				correlationId: id,
				requestId: id,
				reference: reference(id),
				intent: "next",
			}),
		);
		const results = await Promise.all(
			commands.map(command => room.musicEngine.execute(command, identity)),
		);
		expect(results.map(r => r.status).sort()).toEqual(["applied", "revision-conflict"]);
		const occupied = await manual("next-c", "next");
		expect(occupied.status).toBe("slot-conflict");
		expect(
			room.musicState!.requests.filter(r => r.intent === "next" && r.status === "admitted"),
		).toHaveLength(1);
	});
	it("pages private requests and occurrence queue without provider/tag disclosure", async () => {
		for (let i = 0; i < 27; i++) {
			await manual(`manual-${i}`);
		}
		const first = await execute({ action: "requests", offset: 0, limit: 7 });
		const second = await execute({ action: "requests", offset: 7, limit: 7 });
		expect(first.page!.total).toBe(27);
		expect(first.page!.items).toHaveLength(7);
		expect(
			new Set(
				[...first.page!.items, ...second.page!.items].map(
					item => (item as { requestId: string }).requestId,
				),
			).size,
		).toBe(14);
		const others = await execute({ action: "requests", offset: 0, limit: 100 }, "account:2");
		expect(others.page!.total).toBe(0);
		const queue = await execute({ action: "queue", offset: 30, limit: 100 });
		expect(queue.page!.total).toBe(37);
		expect(queue.page!.items).toHaveLength(7);
		expect(JSON.stringify(first)).not.toMatch(PRIVATE_REQUEST_FIELDS);
		expect(
			MusicRoomActionSchema.safeParse({
				action: "requests",
				expectedRevision: 1,
				correlationId: "x",
				limit: 101,
			}).success,
		).toBe(false);
	});
	it("checks grants, ownership and strict input on the real Room dispatcher and targets replies", async () => {
		const command = MusicRoomActionSchema.parse({
			action: "request",
			expectedRevision: room.music!.revision,
			correlationId: "private",
			requestId: "private-request",
			reference: reference("private"),
			intent: "mix",
		});
		room.grants.setRoleGrants(Role.UnregisteredUser, 0);
		await expect(
			room.processRequest({ type: RoomRequestType.MusicRoomRequest, command }, context),
		).rejects.toThrow();
		room.grants.setRoleGrants(Role.UnregisteredUser, permissions.parseIntoGrantMask(["*"]));
		await room.processRequest({ type: RoomRequestType.MusicRoomRequest, command }, context);
		expect(room.command).toHaveBeenLastCalledWith(
			expect.objectContaining({
				type: "send",
				clientId: "tab1",
				message: expect.objectContaining({ action: "music-result" }),
			}),
		);
		await expect(
			execute({ action: "cancel", requestId: "private-request" }, "account:2"),
		).rejects.toThrow("another participant");
		await expect(
			room.processRequest(
				{
					type: RoomRequestType.MusicRoomRequest,
					command: {
						...command,
						contributorId: "account:2",
					} as unknown as MusicRoomAction,
				},
				context,
			),
		).rejects.toThrow();
		for (const request of [
			{ type: RoomRequestType.AddRequest, video: reference("bypass") },
			{ type: RoomRequestType.PlayNowRequest, video: reference("bypass") },
			{ type: RoomRequestType.RemoveRequest, video: reference("bypass") },
			{ type: RoomRequestType.OrderRequest, fromIdx: 0, toIdx: 1 },
		]) {
			await expect(
				room.processRequest(
					request as import("ott-common/models/messages.js").RoomRequest,
					context,
				),
			).rejects.toThrow("occurrence-based");
		}
	});
	it("does not publish or debit on SQL failure, and does not double debit after retry/reload", async () => {
		await room.dequeueNext();
		const before = room.musicState!,
			published = vi.mocked(room.publish).mock.calls.length;
		const save = vi.spyOn(store, "save").mockRejectedValueOnce(new Error("disk full"));
		await expect(room.play()).rejects.toThrow("disk full");
		expect(room.musicState).toEqual(before);
		expect(room.isPlaying).toBe(false);
		expect(vi.mocked(room.publish).mock.calls).toHaveLength(published);
		save.mockRestore();
		await room.play();
		expect(await musicRoomModels(fixture.connection).Event.count()).toBe(1);
		const raw = JSON.parse(room.serializeState());
		expect(raw.musicState.history.events).toHaveLength(1);
		expect(raw.music).toBeUndefined();
		const restored = new Room(
			{ name: room.name, queueMode: QueueMode.Music, musicState: raw.musicState },
			{ catalogue: fixture.catalogue, store },
		);
		vi.spyOn(restored, "publish").mockResolvedValue(undefined);
		restored.throttledSync.cancel();
		restored.throttledSync = vi.fn() as unknown as typeof restored.throttledSync;
		await restored.initializeMusic();
		await restored.play();
		expect(restored.musicState!.history.events).toHaveLength(1);
		expect(restored.music!.current!.playbackId).toBe(room.music!.current!.playbackId);
		const rival = new SqlMusicRoomStore(() => fixture.connection);
		const state = await rival.load(room.name);
		state!.state.revision++;
		await expect(rival.save(state!, 0)).rejects.toThrow("revision");
	});
	it("deduplicates tabs, preserves returner debt, removes upcoming contributions but never current", async () => {
		const tab = new RoomUser("tab3", "different-token");
		tab.user_id = 1;
		room.realusers.push(tab);
		await room.musicEngine.refresh(true);
		expect(room.music!.participants).toHaveLength(2);
		expect(room.music!.queueTotal).toBe(10);
		await room.dequeueNext();
		await room.play();
		const current = room.music!.current!;
		const scores = room.musicState!.history.scores;
		room.realusers = room.realusers.filter(u => u.user_id !== 1);
		await room.musicEngine.refresh(true);
		expect(room.music!.participants).toHaveLength(1);
		expect(room.music!.current!.entryId).toBe(current.entryId);
		expect(room.musicState!.queue.every(e => e.contributorId !== "account:1")).toBe(true);
		room.realusers.push(tab);
		await room.musicEngine.refresh(true);
		expect(room.musicState!.history.scores).toEqual(scores);
		expect(musicIdentity(new RoomUser("a", "same-token"))).toBe(
			musicIdentity(new RoomUser("b", "same-token")),
		);
	});
	it("authenticates joins rather than trusting numeric account IDs supplied in info", async () => {
		vi.spyOn(tokens, "getSessionInfo").mockResolvedValue({ isLoggedIn: true, user_id: 1 });
		vi.spyOn(usermanager, "getUser").mockResolvedValue({ id: 1, username: "real" } as User);
		await room.joinRoom(
			{ type: RoomRequestType.JoinRequest, info: { id: "joined", user_id: 999 } },
			{ ...context, clientId: "joined", auth: { token: "authenticated" } },
		);
		expect(room.getUser("joined")!.user_id).toBe(1);
		expect(room.music!.participants).toHaveLength(2);
		await room.leaveRoom(
			{ type: RoomRequestType.LeaveRequest },
			{ ...context, clientId: "joined" },
		);
		expect(room.music!.participants).toHaveLength(2);
	});
	it("detects remote catalogue versions, ignores favorites, and retains opaque playback options", async () => {
		const before = room.music!.revision;
		await fixture.catalogue.setFavorite(1, DEFAULT_MOODS[0].id, true);
		await room.musicEngine.refresh();
		expect(room.music!.revision).toBe(before);
		const result = await execute({
			action: "request",
			requestId: "segments",
			reference: reference("segments"),
			extras: { startAt: 12, endAt: 42, subtitleUrl: "https://media.example/a.vtt" },
			intent: "next",
		});
		expect(result.status).toBe("applied");
		await room.dequeueNext();
		expect(room.currentSource).toMatchObject({
			startAt: 12,
			endAt: 42,
			subtitleUrl: "https://media.example/a.vtt",
			id: "segments",
			src_url: "https://media.example/stream",
		});
		const eventBefore = room.musicState!.history.events.length;
		await room.play();
		expect(room.musicState!.history.events.length).toBe(eventBefore + 1);
		// No in-process invalidation: force the bounded SQL version poll as another monolith would.
		await fixture.catalogue.removeLibraryTrack(
			1,
			room.musicState!.candidates.find(c => c.contributorId === identity)!.trackId,
		);
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6000);
		await room.musicEngine.refresh();
		expect(room.music!.revision).toBeGreaterThan(result.revision);
	});
	it("rolls back the snapshot and history together if a SQL history write fails", async () => {
		await room.dequeueNext();
		const snapshot = await store.load(room.name);
		const event = musicRoomModels(fixture.connection).Event;
		vi.spyOn(event, "upsert").mockRejectedValueOnce(new Error("history unavailable"));
		await expect(room.play()).rejects.toThrow("history unavailable");
		expect(await store.load(room.name)).toEqual(snapshot);
		expect(await event.count()).toBe(0);
	});
	it("restores from reopened SQL without Redis, including manual confirmations and idempotency", async () => {
		const directory = await mkdtemp(join(tmpdir(), "undertone-room-")),
			path = join(directory, "room.sqlite");
		const f = await createCatalogueFixture(path);
		let second: Sequelize | undefined;
		try {
			await f.catalogue.addLibraryTrack(1, { reference: reference("durable") });
			const store = new SqlMusicRoomStore(() => f.connection),
				people = () => [identity];
			const engine = new RoomMusic(
				"durable-room",
				people,
				async () => undefined,
				f.catalogue,
				store,
			);
			await engine.refresh(true);
			await engine.advance();
			await engine.setPlayback({ isPlaying: true });
			const durableCommand = (command: Record<string, unknown>) =>
				engine.execute(
					MusicRoomActionSchema.parse({
						expectedRevision: engine.publicState!.revision,
						correlationId: randomUUID(),
						...command,
					}),
					identity,
				);
			const manualTrack = await f.catalogue.resolveTrack(reference("durable-manual"));
			await f.catalogue.setTrackMood(1, manualTrack.track.id, DEFAULT_MOODS[0].id, true);
			await durableCommand({
				action: "preferences",
				includeMoodIds: [],
				excludeMoodIds: [DEFAULT_MOODS[0].id],
			});
			const pending = await durableCommand({
				action: "request",
				requestId: "durable-confirmed",
				reference: reference("durable-manual"),
				intent: "next",
			});
			expect(pending.status).toBe("confirmation-required");
			await durableCommand({
				action: "confirm",
				requestId: "durable-confirmed",
				trackId: manualTrack.track.id,
				conflicts: pending.request!.conflicts,
			});
			const state = engine.state!;
			await f.connection.close();
			second = new Sequelize({ dialect: "sqlite", storage: path, logging: false });
			const catalogue = new MusicCatalogue(
				() => second!,
				() => createMusicModels(second!),
				f.resolver,
			);
			const restored = new RoomMusic(
				"durable-room",
				people,
				async () => undefined,
				catalogue,
				new SqlMusicRoomStore(() => second!),
			);
			await restored.initialize();
			expect(restored.state).toEqual(state);
			await restored.setPlayback({ isPlaying: true });
			expect(restored.state!.history.events).toHaveLength(1);
			expect(restored.state!.requests[0].acceptedConflicts).toHaveLength(1);
			const repeated = await restored.execute(
				MusicRoomActionSchema.parse({
					action: "request",
					requestId: "durable-confirmed",
					reference: reference("durable-manual"),
					intent: "next",
					expectedRevision: restored.publicState!.revision,
					correlationId: "repeat",
				}),
				identity,
			);
			expect(repeated.status).toBe("duplicate");
			expect(restored.state!.requests).toHaveLength(1);
		} finally {
			if (second) {
				await second.close();
			} else {
				await f.connection.close();
			}
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("revalidates a paused source before starting and closes failures without a fictitious event", async () => {
		await room.dequeueNext();
		const current = room.music!.current!;
		await fixture.models.TrackSource.update(
			{ availability: "unavailable" },
			{ where: { id: current.sourceId } },
		);
		await expect(room.play()).rejects.toThrow("no longer available");
		expect(room.currentSource).toBeNull();
		expect(room.music!.current).toBeNull();
		expect(room.musicState!.history.events).toHaveLength(0);
		expect(await musicRoomModels(fixture.connection).Event.count()).toBe(0);
	});
	it("persists seek/speed/pause and never republishes the current source on mood-only replans", async () => {
		await room.dequeueNext();
		await room.play();
		await room.seek({ type: RoomRequestType.SeekRequest, value: 32 }, context);
		await room.setPlaybackSpeed(
			{ type: RoomRequestType.PlaybackSpeedRequest, speed: 1.5 },
			context,
		);
		await room.pause();
		const saved = await store.load(room.name);
		expect(saved!.playback).toMatchObject({
			isPlaying: false,
			playbackSpeed: 1.5,
			playbackStart: null,
		});
		expect(saved!.playback.playbackPosition).toBeGreaterThanOrEqual(32);
		vi.mocked(room.publish).mockClear();
		await execute({ action: "preferences", includeMoodIds: [], excludeMoodIds: [] });
		expect(
			vi
				.mocked(room.publish)
				.mock.calls.filter(([message]) => message.action === "sync")
				.every(([message]) => !("currentSource" in message)),
		).toBe(true);
		expect(room.musicState!.history.events).toHaveLength(1);
	});
	it("accepts a formerly offered conflict that disappeared without asking a second time", async () => {
		const { track } = await fixture.catalogue.resolveTrack(reference("vanished"));
		await fixture.catalogue.setTrackMood(2, track.id, DEFAULT_MOODS[0].id, true);
		await execute(
			{ action: "preferences", includeMoodIds: [], excludeMoodIds: [DEFAULT_MOODS[0].id] },
			"account:2",
		);
		const pending = await manual("vanished");
		await fixture.catalogue.setTrackMood(2, track.id, DEFAULT_MOODS[0].id, false);
		const confirmed = await execute({
			action: "confirm",
			requestId: pending.request!.requestId,
			trackId: track.id,
			conflicts: pending.request!.conflicts,
		});
		expect(["applied", "duplicate"]).toContain(confirmed.status);
		expect(confirmed.request!.status).toBe("admitted");
	});
	it("keeps admitted contributions on departure when removal is disabled", async () => {
		const candidate = room.musicState!.candidates.find(
			candidate => candidate.contributorId === identity,
		)!;
		await fixture.catalogue.setTrackMood(1, candidate.trackId, DEFAULT_MOODS[0].id, true);
		await execute(
			{ action: "preferences", includeMoodIds: [DEFAULT_MOODS[0].id], excludeMoodIds: [] },
			"account:2",
		);
		await execute({ action: "settings", settings: { removeDepartedEntries: false } });
		const ids = room
			.musicState!.queue.filter(entry => entry.contributorId === identity)
			.map(entry => entry.entryId);
		room.realusers = room.realusers.filter(user => user.user_id !== 1);
		await room.musicEngine.refresh(true);
		expect(
			room
				.musicState!.queue.filter(entry => entry.contributorId === identity)
				.map(entry => entry.entryId)
				.sort(),
		).toEqual(ids.sort());
		expect(
			room.musicState!.candidates.every(candidate => candidate.contributorId !== identity),
		).toBe(true);
	});
	it("revalidates a resolved head against a concurrent published replan", async () => {
		const original = fixture.resolver.video;
		let release!: () => void, entered!: () => void;
		const waiting = new Promise<void>(resolve => {
				release = resolve;
			}),
			started = new Promise<void>(resolve => {
				entered = resolve;
			});
		let first = true;
		vi.spyOn(fixture.resolver, "video").mockImplementation(async source => {
			if (first) {
				first = false;
				entered();
				await waiting;
			}
			return original(source);
		});
		const advance = room.dequeueNext();
		await started;
		await execute({ action: "replan", content: "renew" });
		const head = room.music!.queue[0];
		release();
		await advance;
		expect(room.music!.current!.entryId).toBe(head.entryId);
		expect(room.musicState!.history.events).toHaveLength(0);
	});
	it("rechecks grants after a provider resolves outside the room mutex", async () => {
		const original = fixture.resolver.resolve;
		let release!: () => void, entered!: () => void;
		const waiting = new Promise<void>(resolve => {
				release = resolve;
			}),
			started = new Promise<void>(resolve => {
				entered = resolve;
			});
		vi.spyOn(fixture.resolver, "resolve").mockImplementation(async reference => {
			entered();
			await waiting;
			return original(reference);
		});
		const command = MusicRoomActionSchema.parse({
			action: "request",
			requestId: "revoked",
			correlationId: "revoke",
			reference: reference("revoked"),
			intent: "mix",
			expectedRevision: room.music!.revision,
		});
		const pending = room.processRequest(
			{ type: RoomRequestType.MusicRoomRequest, command },
			context,
		);
		await started;
		room.grants.setRoleGrants(Role.UnregisteredUser, 0);
		room.grants.setRoleGrants(Role.RegisteredUser, 0);
		release();
		await expect(pending).rejects.toThrow();
		expect(room.musicState!.requests).toHaveLength(0);
	});

	it("uses an equivalent fallback on resume without a second start or changed occurrence", async () => {
		await room.dequeueNext();
		await room.play();
		await room.pause();
		const current = room.music!.current!,
			fallbackId = randomUUID();
		const original = (await fixture.models.TrackSource.findByPk(current.sourceId))!.get({
			plain: true,
		});
		await fixture.models.TrackSource.create({
			...original,
			id: fallbackId,
			providerId: "fallback-recording",
			availability: "available",
		});
		await fixture.models.TrackSource.update(
			{ availability: "unavailable" },
			{ where: { id: current.sourceId } },
		);
		await room.play();
		expect(room.music!.current).toMatchObject({
			entryId: current.entryId,
			playbackId: current.playbackId,
			sourceId: fallbackId,
			started: true,
		});
		expect(room.musicState!.history.events).toHaveLength(1);
		expect(room.musicState!.history.events[0].actualSourceId).toBe(fallbackId);
		const saved = await store.load(room.name);
		expect(saved!.state.current!.entry.sourceId).toBe(fallbackId);
	});

	it("invalidates annotations across rooms through durable versions while favorites leave versions intact", async () => {
		const other = new RoomMusic(
			"other-room",
			() => room.realusers.map(musicIdentity),
			async () => undefined,
			fixture.catalogue,
			store,
		);
		await other.refresh(true);
		const before = await fixture.catalogue.roomVersions([1, 2]);
		await fixture.catalogue.setFavorite(1, DEFAULT_MOODS[1].id, true);
		expect(await fixture.catalogue.roomVersions([1, 2])).toBe(before);
		const track = room.musicState!.candidates[0].trackId;
		await fixture.catalogue.setTrackMood(1, track, DEFAULT_MOODS[0].id, true);
		expect(await fixture.catalogue.roomVersions([1, 2])).not.toBe(before);
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6000);
		await room.musicEngine.refresh();
		await other.refresh();
		for (const engine of [room.musicEngine, other]) {
			expect(
				engine.state!.candidates.find(candidate => candidate.trackId === track)!.tagsByUser[
					identity
				],
			).toContain(DEFAULT_MOODS[0].id);
		}
	});

	it("publishes full metadata only for the current contributor moods, including custom moods", async () => {
		await room.dequeueNext();
		const current = room.music!.current!,
			account = Number(current.contributorId.slice(8)),
			other = account === 1 ? 2 : 1;
		const custom = await fixture.catalogue.createMood(account, {
			name: "Current custom mood",
			iconKey: "moon",
		});
		await fixture.catalogue.setTrackMood(account, current.trackId, custom.id, true);
		await fixture.catalogue.setTrackMood(other, current.trackId, DEFAULT_MOODS[0].id, true);
		room.invalidateMusic(account);
		await room.musicEngine.refresh();
		expect(room.music!.current).toMatchObject({
			entryId: current.entryId,
			contributorMoodIds: [custom.id],
			contributorMoods: [custom],
		});
		expect(room.music!.current!.contributorMoodIds).not.toContain(DEFAULT_MOODS[0].id);
		expect(room.musicState!.history.events).toHaveLength(0);
	});
	it("keeps provider fallback URLs out of shared musical titles", async () => {
		const original = fixture.resolver.resolve;
		vi.spyOn(fixture.resolver, "resolve").mockImplementation(async ref => {
			const resolved = await original(ref);
			return {
				...resolved,
				video: { ...resolved.video, title: "https://media.example/private?token=secret" },
			};
		});
		const pending = await manual("safe-title", "next");
		expect(pending.status).toBe("applied");
		expect(room.music!.queue[0].title).toBe("Untitled track");
		await room.dequeueNext();
		expect(room.music!.current!.title).toBe("Untitled track");
	});
	it("runs room migration up/down transactionally without altering existing OTT tables", async () => {
		const migration = require("../../migrations/20261109200000-create-music-rooms.js");
		await migration.down(fixture.connection.getQueryInterface());
		const tables = await fixture.connection.getQueryInterface().showAllTables();
		expect(tables).toContain("Tracks");
		expect(tables).not.toContain("MusicRoomStates");
		await migration.up(fixture.connection.getQueryInterface(), Sequelize);
		expect(await musicRoomModels(fixture.connection).State.count()).toBe(0);
	});
});
