/* eslint-disable vitest/no-conditional-in-test -- Parameterized boundary scenarios share setup and assertions. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Room, RoomUser } from "../../room.js";
import { addClient } from "../../clientmanager.js";
import { Client, ClientJoinStatus } from "../../client.js";
import roommanager from "../../roommanager.js";
import tokens from "../../auth/tokens.js";
import usermanager from "../../usermanager.js";
import type { User } from "../../models/user.js";
import { SqlMusicRoomStore } from "../../music/room-music-storage.js";
import { createCatalogueFixture } from "./music-test-helpers.js";
import { QueueMode, Role, PlayerStatus } from "ott-common/models/types.js";
import {
	RoomRequestType,
	type RoomRequest,
	type ClientMessage,
} from "ott-common/models/messages.js";
import { ok } from "ott-common/result.js";
import permissions from "ott-common/permissions.js";
import { MusicRoomActionSchema } from "ott-common/models/music-room.js";
import { DEFAULT_MOODS } from "ott-common/models/music.js";

vi.mock("../../roommanager.js", () => ({ default: { getRoom: vi.fn() } }));
vi.mock("../../websockets.js", () => ({ wss: {} }));
vi.mock("../../balancer.js", () => ({
	balancerManager: {},
	buildGossipMessage: vi.fn(),
	initBalancerConnections: vi.fn(),
}));

const PRIVATE_SYNC_FIELDS = /tagsByUser|candidates|history/;

describe("Room authentication and music commit boundaries", () => {
	let fixture: Awaited<ReturnType<typeof createCatalogueFixture>>;
	let room: Room;
	let store: SqlMusicRoomStore;
	const context = { username: "one", clientId: "tab1", role: Role.RegisteredUser };
	const setupRoom = (queueMode = QueueMode.Music) => {
		room = new Room(
			{ name: "boundary-test", queueMode },
			{ catalogue: fixture.catalogue, store },
		);
		room.throttledSync.cancel();
		room.throttledSync = vi.fn() as unknown as typeof room.throttledSync;
		vi.spyOn(room, "publish").mockResolvedValue(undefined);
		vi.spyOn(room, "command").mockResolvedValue(undefined);
		for (const role of [Role.RegisteredUser, Role.UnregisteredUser]) {
			room.grants.setRoleGrants(role, permissions.parseIntoGrantMask(["*"]));
		}
	};
	beforeEach(async () => {
		fixture = await createCatalogueFixture();
		store = new SqlMusicRoomStore(() => fixture.connection);
		vi.spyOn(tokens, "getSessionInfo").mockImplementation(async token =>
			token === "guest"
				? { isLoggedIn: false, username: "" }
				: { isLoggedIn: true, user_id: token === "owner" ? 2 : 1 },
		);
		vi.spyOn(usermanager, "getUser").mockImplementation(
			async ({ id }) => ({ id, username: `user-${id}` }) as User,
		);
		setupRoom();
		const user = new RoomUser("tab1", "member");
		await user.updateInfo({ id: user.id, user_id: 1 });
		room.realusers.push(user);
		for (let i = 0; i < 3; i++) {
			await fixture.catalogue.addLibraryTrack(1, {
				reference: { service: "youtube", id: `track-${i}` },
			});
		}
		await room.musicEngine.refresh(true);
	});
	afterEach(async () => {
		room.throttledSync.cancel?.();
		vi.useRealTimers();
		vi.restoreAllMocks();
		await fixture.connection.close();
	});
	const execute = (data: Record<string, unknown>) =>
		room.musicEngine.execute(
			MusicRoomActionSchema.parse({
				correlationId: "boundary",
				expectedRevision: room.music!.revision,
				...data,
			}),
			"account:1",
		);
	const blockVideo = () => {
		let release!: () => void, enter!: () => void;
		const entered = new Promise<void>(resolve => {
			enter = resolve;
		});
		const waiting = new Promise<void>(resolve => {
			release = resolve;
		});
		const original = fixture.resolver.video;
		let first = true;
		vi.spyOn(fixture.resolver, "video").mockImplementation(async source => {
			if (first) {
				first = false;
				enter();
				await waiting;
			}
			return original(source);
		});
		return { entered, release };
	};

	it("rejects internal/malformed wire discriminators, preserves typed events and authenticates a legacy mode switch", async () => {
		setupRoom(QueueMode.Manual);
		room.owner = { id: 2, username: "owner" } as User;
		await fixture.catalogue.addLibraryTrack(2, {
			reference: { service: "youtube", id: "owner-private" },
		});
		const guest = new RoomUser("attacker", "guest");
		room.realusers.push(guest);
		room.grants.setRoleGrants(Role.UnregisteredUser, 0);
		vi.mocked(roommanager.getRoom).mockResolvedValue(ok(room));
		let onMessage!: (client: Client, message: ClientMessage) => Promise<void>;
		const client = new (class extends Client {
			get clientType() {
				return "boundary";
			}
			sendRaw = vi.fn();
			kick = vi.fn();
		})(room.name);
		client.id = guest.id;
		client.token = guest.token;
		client.joinStatus = ClientJoinStatus.Joined;
		vi.spyOn(client, "on").mockImplementation((event, handler) => {
			if (event === "message") {
				onMessage = handler as typeof onMessage;
			}
		});
		addClient(client);
		for (const type of [
			0,
			1,
			10,
			"0",
			"1",
			"10",
			"2",
			"13",
			"010",
			"1e1",
			"10.0",
			10.1,
			-1,
			21,
			null,
			{},
			[],
			"__proto__",
			"constructor",
		]) {
			await onMessage(client, {
				action: "req",
				request: {
					type,
					info: { id: guest.id, user_id: 2 },
					state: true,
					settings: { queueMode: QueueMode.Music },
				},
			} as unknown as ClientMessage);
			expect(guest.user_id).toBeUndefined();
			expect(room.getRole(guest)).toBe(Role.UnregisteredUser);
			expect(room.queueMode).toBe(QueueMode.Manual);
			expect(room.isPlaying).toBe(false);
		}
		// The actual status path still produces a legitimate typed internal UpdateUser.
		await onMessage(client, { action: "status", status: PlayerStatus.ready });
		expect(guest.playerStatus).toBe(PlayerStatus.ready);
		await onMessage(client, {
			action: "req",
			request: {
				type: RoomRequestType.ApplySettingsRequest,
				settings: { queueMode: QueueMode.Music },
			},
		});
		expect(room.queueMode).toBe(QueueMode.Manual);
		// Simulate a stale identity forged before the boundary fix. It cannot authorize Music.
		await guest.updateInfo({ id: guest.id, user_id: 2 });
		await onMessage(client, {
			action: "req",
			request: {
				type: RoomRequestType.ApplySettingsRequest,
				settings: { queueMode: QueueMode.Music },
			},
		});
		expect(guest.user_id).toBeUndefined();
		expect(room.queueMode).toBe(QueueMode.Manual);
		// A real owner can enter Music; the stale guest cannot contribute the owner's library.
		const owner = new RoomUser("owner-tab", "owner");
		await owner.updateInfo({ id: owner.id, user_id: 2 });
		room.realusers.push(owner);
		await guest.updateInfo({ id: guest.id, user_id: 1 });
		await room.processUnauthorizedRequest(
			{
				type: RoomRequestType.ApplySettingsRequest,
				settings: { queueMode: QueueMode.Music },
			},
			{ clientId: owner.id, token: owner.token },
		);
		expect(room.music!.participants.map(p => p.participantId)).toContain("account:2");
		expect(room.music!.participants.map(p => p.participantId)).not.toContain("account:1");
		expect(room.musicState!.candidates.every(c => c.contributorId === "account:2")).toBe(true);
		expect(guest.user_id).toBeUndefined();
		await onMessage(client, { action: "status", status: PlayerStatus.buffering });
		expect(guest.playerStatus).toBe(PlayerStatus.buffering);
	});

	it.each(["10", "2", "__proto__", "constructor", null, NaN, Infinity, 2.5, -1, 21])(
		"rejects malformed internal dispatch type %s",
		async type => {
			const before = room.musicState;
			await expect(
				room.processRequest(
					{
						type,
						info: { id: "tab1", user_id: 2 },
						state: true,
					} as unknown as RoomRequest,
					context,
				),
			).rejects.toThrow("Invalid room request type");
			expect(room.musicState).toEqual(before);
		},
	);

	it("does not count 15 seconds of provider latency as playback and retains committed seek/speed/extras on retry", async () => {
		await execute({
			action: "request",
			requestId: "segment",
			intent: "next",
			reference: { service: "youtube", id: "segment" },
			extras: { startAt: 12, endAt: 120 },
		});
		await room.dequeueNext();
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-11-09T12:00:00Z"));
		const gate = blockVideo();
		const pending = room.play();
		await gate.entered;
		await room.seek({ type: RoomRequestType.SeekRequest, value: 75 }, context);
		await room.setPlaybackSpeed(
			{ type: RoomRequestType.PlaybackSpeedRequest, speed: 1.5 },
			context,
		);
		vi.setSystemTime(new Date("2026-11-09T12:00:15Z"));
		gate.release();
		await pending;
		expect(room.realPlaybackPosition).toBe(75);
		expect(room.currentSource).toMatchObject({ startAt: 12, endAt: 120 });
		expect(room.playbackSpeed).toBe(1.5);
		expect(room.musicState!.history.events).toHaveLength(1);
		expect(room.musicState!.history.events[0].startedAt).toBe(Date.now());
		vi.setSystemTime(new Date("2026-11-09T12:00:17Z"));
		await room.play();
		expect(room.realPlaybackPosition).toBe(78);
		await room.pause();
		await room.play();
		expect(room.realPlaybackPosition).toBe(78);
		expect(room.musicState!.history.events).toHaveLength(1);
	});

	it("starts at the paused position after slow provider resolution", async () => {
		await room.dequeueNext();
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-11-09T12:00:00Z"));
		const gate = blockVideo(),
			pending = room.play();
		await gate.entered;
		vi.setSystemTime(new Date("2026-11-09T12:00:15Z"));
		gate.release();
		await pending;
		expect(room.realPlaybackPosition).toBe(0);
	});

	it.each(["grants", "role", "leave", "logout", "account", "expired", "mode"])(
		"rechecks %s after provider playback I/O, publishing no unauthorized start",
		async change => {
			await room.dequeueNext();
			if (change === "role") {
				room.userRoles.set(Role.Moderator, new Set([1]));
				room.grants.setRoleGrants(Role.UnregisteredUser, 0);
				room.grants.setRoleGrants(Role.RegisteredUser, 0);
				room.grants.setRoleGrants(Role.Moderator, permissions.parseIntoGrantMask(["*"]));
			}
			const gate = blockVideo();
			const pending = room.processRequest(
				{ type: RoomRequestType.PlaybackRequest, state: true },
				{ ...context, role: change === "role" ? Role.Moderator : context.role },
			);
			await gate.entered;
			if (change === "grants") {
				room.grants.setRoleGrants(Role.UnregisteredUser, 0);
				room.grants.setRoleGrants(Role.RegisteredUser, 0);
			}
			if (change === "role") {
				room.userRoles.get(Role.Moderator)!.clear();
			}
			if (change === "leave") {
				room.realusers = [];
			}
			if (change === "logout") {
				vi.mocked(tokens.getSessionInfo).mockResolvedValue({
					isLoggedIn: false,
					username: "logged-out",
				});
			}
			if (change === "account") {
				vi.mocked(tokens.getSessionInfo).mockResolvedValue({
					isLoggedIn: true,
					user_id: 2,
				});
			}
			if (change === "expired") {
				vi.mocked(tokens.getSessionInfo).mockRejectedValue(new Error("expired"));
			}
			if (change === "mode") {
				room.queueMode = QueueMode.Manual;
			}
			const before = await store.load(room.name),
				publications = vi.mocked(room.publish).mock.calls.length;
			gate.release();
			await expect(pending).rejects.toThrow();
			expect(room.isPlaying).toBe(false);
			expect(room.musicState!.history.events).toHaveLength(0);
			expect(await store.load(room.name)).toEqual(before);
			expect(vi.mocked(room.publish).mock.calls).toHaveLength(publications);
		},
	);

	it("rechecks skip authorization after resolving the successor", async () => {
		await room.dequeueNext();
		await room.play();
		const gate = blockVideo();
		const pending = room.processRequest({ type: RoomRequestType.SkipRequest }, context);
		await gate.entered;
		room.realusers = [];
		const before = await store.load(room.name),
			publications = vi.mocked(room.publish).mock.calls.length;
		gate.release();
		await expect(pending).rejects.toThrow();
		expect(room.musicState!.history.events).toHaveLength(1);
		expect(await store.load(room.name)).toEqual(before);
		expect(vi.mocked(room.publish).mock.calls).toHaveLength(publications);
	});

	it.each(["not-found", "invalid-confirmation", "failed-save"])(
		"does not swallow remote exclusion invalidation on %s",
		async failure => {
			await execute({
				action: "preferences",
				includeMoodIds: [],
				excludeMoodIds: [DEFAULT_MOODS[0].id],
			});
			const track = room.music!.queue[0].trackId;
			let requestId = "nonexistent";
			if (failure === "invalid-confirmation") {
				const source = room.musicState!.queue[0].mediaRef as { id: string };
				requestId = "pending";
				await execute({
					action: "request",
					requestId,
					intent: "mix",
					reference: { service: "youtube", id: source.id },
				});
			}
			await fixture.catalogue.setTrackMood(1, track, DEFAULT_MOODS[0].id, true);
			if (failure === "failed-save") {
				const before = room.musicState,
					publications = vi.mocked(room.publish).mock.calls.length;
				vi.spyOn(store, "save").mockRejectedValueOnce(new Error("disk full"));
				await expect(execute({ action: "replan", content: "keep" })).rejects.toThrow(
					"disk full",
				);
				expect(room.musicState).toEqual(before);
				expect(vi.mocked(room.publish).mock.calls).toHaveLength(publications);
			} else {
				const result = await execute({
					action: "confirm",
					requestId,
					trackId: track,
					conflicts:
						failure === "invalid-confirmation"
							? [{ participantId: "account:1", moodId: DEFAULT_MOODS[1].id }]
							: [],
				});
				expect(result.status).toBe(failure);
			}
			vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6000);
			await room.musicEngine.refresh();
			expect(room.music!.queue.some(e => e.trackId === track)).toBe(false);
			await room.dequeueNext();
			await room.play();
			expect(room.music!.current!.trackId).not.toBe(track);
			expect(JSON.stringify(room.syncableState())).not.toMatch(PRIVATE_SYNC_FIELDS);
		},
	);

	it.each([true, false])(
		"continues past an unavailable head while preserving playing=%s",
		async playing => {
			await room.dequeueNext();
			if (playing) {
				await room.play();
			}
			const bad = room.music!.queue[0].sourceId,
				original = fixture.resolver.video;
			vi.spyOn(fixture.resolver, "video").mockImplementation(async source => {
				if (source.id === bad) {
					throw new Error("offline");
				}
				return original(source);
			});
			await room.dequeueNext();
			await room.update();
			expect(room.currentSource).not.toBeNull();
			expect(room.isPlaying).toBe(playing);
			expect(room.music!.current!.sourceId).not.toBe(bad);
			expect(room.musicState!.history.events).toHaveLength(playing ? 2 : 0);
			expect(room.musicState!.history.events.every(e => e.actualSourceId !== bad)).toBe(true);
		},
	);

	it("terminates all-failed recovery without fake history or a per-tick provider loop", async () => {
		await room.dequeueNext();
		await room.play();
		const video = vi.spyOn(fixture.resolver, "video").mockRejectedValue(new Error("offline"));
		await room.dequeueNext();
		expect(room.currentSource).toBeNull();
		expect(room.isPlaying).toBe(false);
		expect(room.music!.queueTotal).toBe(0);
		expect(room.musicState!.history.events).toHaveLength(1);
		const calls = video.mock.calls.length;
		await room.update();
		await room.update();
		expect(video).toHaveBeenCalledTimes(calls);
		expect(calls).toBeLessThanOrEqual(3);
	});

	it("does not apply a delayed play to a replacement occurrence", async () => {
		await room.dequeueNext();
		const gate = blockVideo(),
			pending = room.play();
		await gate.entered;
		await room.dequeueNext();
		const replacement = room.music!.current!.playbackId;
		gate.release();
		await expect(pending).rejects.toThrow("occurrence changed");
		expect(room.music!.current!.playbackId).toBe(replacement);
		expect(room.isPlaying).toBe(false);
		expect(room.musicState!.history.events).toHaveLength(0);
	});

	it.each(["membership", "annotation"])(
		"retains %s invalidation arriving during context persistence",
		async change => {
			const save = store.save.bind(store);
			let release!: () => void, entered!: () => void;
			const waiting = new Promise<void>(resolve => {
				release = resolve;
			});
			const started = new Promise<void>(resolve => {
				entered = resolve;
			});
			vi.spyOn(store, "save").mockImplementationOnce(async (...args) => {
				entered();
				await waiting;
				await save(...args);
			});
			const pending = execute({ action: "replan", content: "keep" });
			await started;
			const track = room.music!.queue[0].trackId;
			if (change === "membership") {
				room.realusers = [];
			} else {
				await fixture.catalogue.setTrackMood(1, track, DEFAULT_MOODS[0].id, true);
				room.invalidateMusic(1);
			}
			release();
			await pending;
			// No five-second wait: an invalidation observed during save must stay dirty.
			const revision = room.music!.revision;
			await room.musicEngine.refresh();
			expect(room.music!.revision).toBeGreaterThan(revision);
			if (change === "membership") {
				expect(room.music!.participants).toHaveLength(0);
				expect(room.music!.queueTotal).toBe(0);
			} else {
				expect(
					room.musicState!.candidates.find(c => c.trackId === track)!.tagsByUser[
						"account:1"
					],
				).toContain(DEFAULT_MOODS[0].id);
			}
		},
	);

	it("skips a head whose primary and equivalent sources both fail without debiting it", async () => {
		await room.dequeueNext();
		await room.play();
		const bad = room.music!.queue[0],
			original = fixture.resolver.video;
		const source = (await fixture.models.TrackSource.findByPk(bad.sourceId))!.get({
			plain: true,
		});
		await fixture.models.TrackSource.create({
			...source,
			id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			providerId: "bad-equivalent",
		});
		vi.spyOn(fixture.resolver, "video").mockImplementation(async source => {
			if (source.trackId === bad.trackId) {
				throw new Error("offline");
			}
			return original(source);
		});
		await room.dequeueNext();
		expect(room.isPlaying).toBe(true);
		expect(room.music!.current!.trackId).not.toBe(bad.trackId);
		expect(room.musicState!.history.events).toHaveLength(2);
		expect(room.musicState!.history.events.every(e => e.entry.entryId !== bad.entryId)).toBe(
			true,
		);
	});

	it("revalidates availability changed during head resolution and preserves a concurrent pause", async () => {
		await room.dequeueNext();
		await room.play();
		const head = room.music!.queue[0];
		const gate = blockVideo(),
			pending = room.dequeueNext();
		await gate.entered;
		await room.pause();
		await fixture.models.TrackSource.update(
			{ availability: "unavailable" },
			{ where: { id: head.sourceId } },
		);
		gate.release();
		await pending;
		expect(room.isPlaying).toBe(false);
		expect(room.music!.current!.sourceId).not.toBe(head.sourceId);
		expect(room.musicState!.history.events).toHaveLength(1);
	});

	it("revalidates failed-head recovery after a concurrent published replan", async () => {
		await room.dequeueNext();
		await room.play();
		const original = fixture.resolver.video;
		let release!: () => void,
			enter!: () => void,
			first = true;
		const waiting = new Promise<void>(resolve => {
			release = resolve;
		});
		const entered = new Promise<void>(resolve => {
			enter = resolve;
		});
		vi.spyOn(fixture.resolver, "video").mockImplementation(async source => {
			if (first) {
				first = false;
				enter();
				await waiting;
				throw new Error("obsolete failure");
			}
			return original(source);
		});
		const pending = room.dequeueNext();
		await entered;
		await execute({ action: "replan", content: "renew" });
		const head = room.music!.queue[0];
		release();
		await pending;
		expect(room.music!.current!.entryId).toBe(head.entryId);
		expect(room.isPlaying).toBe(true);
		expect(room.musicState!.history.events).toHaveLength(2);
	});

	it("reconciles arrivals during the two context reads of a preference change", async () => {
		await fixture.catalogue.addLibraryTrack(2, {
			reference: { service: "youtube", id: "arrival" },
		});
		const snapshot = fixture.catalogue.roomSnapshot.bind(fixture.catalogue);
		let release!: () => void, enter!: () => void;
		const waiting = new Promise<void>(resolve => {
			release = resolve;
		});
		const entered = new Promise<void>(resolve => {
			enter = resolve;
		});
		vi.spyOn(fixture.catalogue, "roomSnapshot").mockImplementationOnce(async (...args) => {
			const result = await snapshot(...args);
			enter();
			await waiting;
			return result;
		});
		const pending = execute({ action: "preferences", includeMoodIds: [], excludeMoodIds: [] });
		await entered;
		const arrival = new RoomUser("arrival", "owner");
		await arrival.updateInfo({ id: arrival.id, user_id: 2 });
		room.realusers.push(arrival);
		release();
		await pending;
		expect(room.music!.participants.map(p => p.participantId)).toContain("account:2");
		expect(room.musicState!.candidates.some(c => c.contributorId === "account:2")).toBe(true);
	});

	it("preserves typed internal join, user-change and leave routes without trusting supplied accounts", async () => {
		vi.mocked(tokens.getSessionInfo).mockResolvedValue({ isLoggedIn: false, username: "" });
		await room.processRequest(
			{ type: RoomRequestType.UpdateUser, info: { id: "tab1", user_id: 2 } },
			context,
		);
		expect(room.getUser("tab1")!.user_id).toBeUndefined();
		expect(room.getRole(room.getUser("tab1"))).toBe(Role.UnregisteredUser);
		vi.mocked(tokens.getSessionInfo).mockResolvedValue({ isLoggedIn: true, user_id: 1 });
		await room.processRequest(
			{ type: RoomRequestType.UpdateUser, info: { id: "tab1", user_id: 2 } },
			context,
		);
		expect(room.getUser("tab1")!.user_id).toBe(1);
		await room.processRequest({ type: RoomRequestType.LeaveRequest }, context);
		expect(room.getUser("tab1")).toBeUndefined();
		await room.processRequest(
			{ type: RoomRequestType.JoinRequest, info: { id: "tab1", user_id: 2 } },
			{ ...context, auth: { token: "member" } },
		);
		expect(room.getUser("tab1")!.user_id).toBe(1);
	});

	it("bounds a large all-failed queue to five heads per advance and eventually stops", async () => {
		for (let i = 3; i < 12; i++) {
			await fixture.catalogue.addLibraryTrack(1, {
				reference: { service: "youtube", id: "extra-" + i },
			});
		}
		await room.musicEngine.refresh(true);
		await room.dequeueNext();
		await room.play();
		const video = vi.spyOn(fixture.resolver, "video").mockRejectedValue(new Error("offline"));
		await room.dequeueNext();
		expect(video).toHaveBeenCalledTimes(5);
		expect(room.isPlaying).toBe(true);
		await room.update();
		expect(video.mock.calls.length).toBeLessThanOrEqual(10);
		await room.update();
		expect(room.currentSource).toBeNull();
		expect(room.music!.queueTotal).toBe(0);
		expect(room.isPlaying).toBe(false);
		expect(room.musicState!.history.events).toHaveLength(1);
		const calls = video.mock.calls.length;
		await room.update();
		expect(video).toHaveBeenCalledTimes(calls);
	});
});
