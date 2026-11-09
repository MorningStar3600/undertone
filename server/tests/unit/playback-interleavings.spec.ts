/* eslint-disable vitest/no-conditional-in-test -- Shared adversarial interleaving scenarios. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Room, RoomUser } from "../../room.js";
import { BalancerClient, Client, ClientJoinStatus } from "../../client.js";
import type { BalancerConnection } from "../../balancer.js";
import { addClient, handlePlaybackMessage, setup } from "../../clientmanager.js";
import roommanager from "../../roommanager.js";
import usermanager from "../../usermanager.js";
import { PlayerStatus, QueueMode, Role } from "ott-common/models/types.js";
import {
	RoomRequestType,
	type ServerMessage,
	type UndoRequest,
} from "ott-common/models/messages.js";
import type { User } from "../../models/user.js";
import permissions from "ott-common/permissions.js";
import { ok } from "ott-common/result.js";
import { PlaybackReceipts } from "../../playback/receipts.js";
import { PlaybackJournal } from "../../playback/journal.js";
import { createCatalogueFixture } from "./music-test-helpers.js";
import { SqlMusicRoomStore } from "../../music/room-music-storage.js";
const mocks = vi.hoisted(() => ({ session: vi.fn(), handlers: new Map(), balancer: vi.fn() }));
vi.mock("../../auth/tokens.js", () => ({
	getSessionInfo: mocks.session,
	default: { getSessionInfo: mocks.session },
	setSessionInfo: vi.fn(),
}));
vi.mock("../../roommanager.js", () => ({
	default: {
		getRoom: vi.fn(),
		publish: vi.fn(),
		on: (event, fn) => mocks.handlers.set(event, fn),
	},
}));
vi.mock("../../websockets.js", () => ({ wss: { on: vi.fn() } }));
vi.mock("../../balancer.js", () => ({
	balancerManager: { on: vi.fn(), getConnection: mocks.balancer },
	buildGossipMessage: vi.fn(),
	initBalancerConnections: vi.fn(),
}));
const gate = () => {
	let release!: () => void;
	const promise = new Promise<void>(resolve => {
		release = resolve;
	});
	return { promise, release };
};
class TestClient extends Client {
	messages: ServerMessage[] = [];
	get clientType() {
		return "test";
	}
	sendRaw(data: string) {
		this.messages.push(JSON.parse(data));
	}
	kick() {
		this.emit("disconnect", this);
	}
}
const source = { service: "youtube" as const, id: "first", length: 180 };
const session = async (token: string) =>
	token === "session"
		? { isLoggedIn: true as const, user_id: 1 }
		: { isLoggedIn: false as const, username: "other" };
function fixture() {
	const room = new Room({ name: "review-" + Math.random(), currentSource: source });
	room.throttledSync.cancel();
	room.throttledSync = vi.fn() as unknown as typeof room.throttledSync;
	const user = new RoomUser("tab", "session");
	user.user_id = 1;
	room.realusers.push(user);
	room.grants.setRoleGrants(Role.RegisteredUser, permissions.parseIntoGrantMask(["*"]));
	room.grants.setRoleGrants(Role.UnregisteredUser, 0);
	vi.spyOn(room, "publish").mockResolvedValue(undefined);
	vi.mocked(roommanager.getRoom).mockResolvedValue(ok(room));
	const client = new TestClient(room.name);
	client.id = "tab";
	client.token = "session";
	client.joinStatus = ClientJoinStatus.Joined;
	client.playbackSubscribed = true;
	return { room, client };
}
const command = (room: Room, id: string, kind = "play") => ({
	action: "playback-command",
	command: {
		requestId: id,
		epoch: room.playbackSnapshot("a").timeline.epoch,
		occurrenceId: 1,
		command: kind,
	},
});
describe("Playback review interleavings", () => {
	beforeEach(() => {
		mocks.session.mockReset().mockImplementation(session);
		vi.spyOn(usermanager, "getUser").mockResolvedValue({ id: 1, username: "one" } as User);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});
	it("rejects an in-flight transport command after reauth during session lookup", async () => {
		const { room, client } = fixture();
		addClient(client);
		const entered = gate(),
			blocked = gate();
		let calls = 0;
		mocks.session.mockImplementation(async token => {
			if (++calls === 2) {
				entered.release();
				await blocked.promise;
			}
			return session(token);
		});
		const pending = handlePlaybackMessage(client, command(room, "reauth"));
		await entered.promise;
		await client.auth("other");
		await vi.waitFor(() =>
			expect(client.messages.some(m => m.action === "playback-capabilities")).toBe(true),
		);
		expect(client.token).toBe("other");
		expect(client.playbackSubscribed).toBe(false);
		expect(room.getUser("tab")?.token).toBe("other");
		blocked.release();
		await pending;
		expect(room.isPlaying).toBe(false);
		expect(room.playbackSnapshot("after").timeline.baseline.sequence).toBe(1);
	});
	it("preserves reported player readiness through same-session reauthentication", async () => {
		const { room, client } = fixture();
		addClient(client);
		await client.auth("session");
		await vi.waitFor(() =>
			expect(client.messages.filter(m => m.action === "playback-capabilities")).toHaveLength(
				1,
			),
		);
		await room.processUnauthorizedRequest(
			{ type: RoomRequestType.UpdateUser, info: { id: "tab", status: PlayerStatus.ready } },
			client.captureAuthorization(),
		);
		await client.auth("session");
		await vi.waitFor(() =>
			expect(client.messages.filter(m => m.action === "playback-capabilities")).toHaveLength(
				2,
			),
		);
		expect(room.getUserInfo("tab").status).toBe(PlayerStatus.ready);
	});
	it.each([undefined, PlayerStatus.none])(
		"retains the latest status after identity lookup unless status %s is explicit",
		async status => {
			const { room, client } = fixture();
			const entered = gate(),
				blocked = gate();
			vi.mocked(usermanager.getUser).mockImplementationOnce(async () => {
				entered.release();
				await blocked.promise;
				return { id: 1, username: "one" } as User;
			});
			const pending = room.joinRoom(
				{ type: RoomRequestType.JoinRequest, info: { id: "tab", user_id: 1, status } },
				{
					username: "one",
					role: Role.RegisteredUser,
					clientId: "tab",
					auth: client.captureAuthorization(),
				},
			);
			await entered.promise;
			await room.getUser("tab")!.updateInfo({ id: "tab", status: PlayerStatus.ready });
			blocked.release();
			await pending;
			expect(room.getUserInfo("tab").status).toBe(status ?? PlayerStatus.ready);
		},
	);
	it("delivers each timeline and regular broadcast once after same-session reauth", async () => {
		const { room, client } = fixture();
		await setup();
		addClient(client);
		await client.auth("session");
		await vi.waitFor(() =>
			expect(client.messages.filter(m => m.action === "playback-capabilities")).toHaveLength(
				1,
			),
		);
		await client.auth("session");
		await vi.waitFor(() =>
			expect(client.messages.filter(m => m.action === "playback-capabilities")).toHaveLength(
				2,
			),
		);
		await handlePlaybackMessage(client, {
			action: "playback-subscribe",
			version: 1,
			nonce: "new",
		});
		client.messages.length = 0;
		const snapshot = room.playbackSnapshot("s");
		await mocks.handlers.get("publish")(room.name, {
			action: "playback-event",
			event: {
				type: "play",
				epoch: snapshot.timeline.epoch,
				sequence: 2,
				occurrenceId: 1,
				effectiveAtMs: Date.now(),
			},
		});
		expect(client.messages.filter(m => m.action === "playback-event")).toHaveLength(1);
		await mocks.handlers.get("publish")(room.name, { action: "sync", isPlaying: true });
		expect(client.messages.filter(m => m.action === "sync")).toHaveLength(1);
		client.emit("disconnect", client);
		client.messages.length = 0;
		await mocks.handlers.get("publish")(room.name, { action: "sync", isPlaying: false });
		await mocks.handlers.get("publish")(room.name, {
			action: "playback-event",
			event: { type: "pause" },
		});
		expect(client.messages).toHaveLength(0);
	});
	it("rejects invalid legacy undo before changing playback, queue or journal", async () => {
		const { room } = fixture();
		const before = room.playbackSnapshot("before");
		await expect(
			room.processUnauthorizedRequest(
				{
					type: RoomRequestType.UndoRequest,
					event: {
						action: "event",
						request: { type: RoomRequestType.SkipRequest },
						user: { name: "one", isLoggedIn: true },
						additional: { video: { ...source, id: "other" }, prevPosition: -1 },
					},
				} as any,
				{ token: "session", clientId: "tab" },
			),
		).rejects.toThrow();
		expect(room.currentSource?.id).toBe("first");
		expect(room.playbackPosition).toBe(0);
		expect(room.queue.items).toEqual([]);
		expect(room.publish).not.toHaveBeenCalled();
		expect(room.playbackSnapshot("after").timeline).toEqual(before.timeline);
		expect(room.playbackSnapshot("after").attachment?.item.id).toBe("first");
	});
	it("expired completed receipts execute again while expired pending receipts stay reserved", async () => {
		vi.useFakeTimers();
		try {
			const receipts = new PlaybackReceipts(),
				blocked = gate();
			let executions = 0;
			const value = { requestId: "id", epoch: "e", sequence: 1, status: "applied" as const };
			const reject = code => ({ ...value, status: "rejected" as const, code });
			const run = () => {
				executions++;
				return Promise.resolve(value);
			};
			const pending = receipts.run("pending", "same", reject, async () => {
				await blocked.promise;
				return value;
			});
			await receipts.run("done", "same", reject, run);
			vi.advanceTimersByTime(300001);
			expect(receipts.run("pending", "same", reject, run)).toBe(pending);
			await receipts.run("done", "same", reject, run);
			expect(executions).toBe(2);
			blocked.release();
			await pending;
		} finally {
			vi.useRealTimers();
		}
	});
	it("snapshot and staged candidate inputs cannot mutate live source attachments", () => {
		const journal = new PlaybackJournal(vi.fn());
		const value = {
			currentSource: { ...source, contributorId: "guest:private-fingerprint" },
			positionSeconds: 0,
			isPlaying: false,
			rate: 1,
		};
		const install = journal.stage(value);
		value.currentSource.id = "mutated";
		install();
		const snap = journal.snapshot("first");
		expect(snap.attachment?.item.id).toBe("first");
		expect(snap.attachment?.item.contributorId).toBeUndefined();
		snap.attachment!.item.id = "tampered";
		expect(journal.snapshot("second").attachment?.item.id).toBe("first");
	});
	it("malformed/oversized clock probes and attempts after the limit perform no session I/O", async () => {
		const { client } = fixture();
		mocks.session.mockClear();
		await handlePlaybackMessage(client, {
			action: "clock-probe",
			generation: 0,
			nonce: "x".repeat(2049),
		});
		await handlePlaybackMessage(client, { action: "clock-probe", generation: 1.5, nonce: "x" });
		expect(mocks.session).not.toHaveBeenCalled();
		for (let i = 0; i < 25; i++) {
			await handlePlaybackMessage(client, {
				action: "clock-probe",
				generation: 7,
				nonce: "0001",
			});
		}
		expect(mocks.session).toHaveBeenCalledTimes(18);
		expect(client.messages).toHaveLength(18);
		expect(client.messages[0]).toMatchObject({ generation: 7, nonce: "0001" });
		const reply = client.messages[0] as Extract<ServerMessage, { action: "clock-reply" }>;
		expect(reply.serverSendMs).toBeGreaterThanOrEqual(reply.serverReceiveMs);
	});
	it("legacy seek without websocket context remains permitted with a valid authorized session", async () => {
		const { room } = fixture();
		room.realusers.splice(0);
		await room.processUnauthorizedRequest(
			{ type: RoomRequestType.SeekRequest, value: 0 },
			{ token: "session" },
		);
		expect(room.playbackPosition).toBe(0);
		expect(room.playbackSnapshot("after").timeline.baseline.sequence).toBe(2);
	});
	it("Music next keeps committed clear but rejects load when permission is revoked during provider wait", async () => {
		const f = await createCatalogueFixture();
		try {
			for (const id of ["a", "b"]) {
				await f.catalogue.addLibraryTrack(1, { reference: { service: "youtube", id } });
			}
			const store = new SqlMusicRoomStore(() => f.connection);
			const room = new Room(
				{ name: "music-review", queueMode: QueueMode.Music },
				{ catalogue: f.catalogue, store },
			);
			room.throttledSync.cancel();
			room.throttledSync = vi.fn() as any;
			vi.spyOn(room, "publish").mockResolvedValue(undefined);
			const user = new RoomUser("tab", "session");
			user.user_id = 1;
			room.realusers.push(user);
			room.grants.setRoleGrants(Role.RegisteredUser, permissions.parseIntoGrantMask(["*"]));
			await room.musicEngine.refresh(true);
			await room.dequeueNext();
			await room.play();
			const before = room.playbackSnapshot("before");
			const entered = gate(),
				blocked = gate();
			const original = f.resolver.video;
			vi.spyOn(f.resolver, "video").mockImplementation(async s => {
				entered.release();
				await blocked.promise;
				return original(s);
			});
			const pending = room.executePlaybackCommand(
				{
					requestId: "next",
					epoch: before.timeline.epoch,
					occurrenceId: before.timeline.baseline.state!.occurrenceId,
					command: "next",
				},
				{ token: "session", clientId: "tab" },
			);
			await entered.promise;
			expect(room.playbackSnapshot("clear").timeline.baseline.state).toBeNull();
			const sequence = room.playbackSnapshot("clear").timeline.baseline.sequence;
			room.grants.setRoleGrants(Role.UnregisteredUser, 0);
			room.grants.setRoleGrants(Role.RegisteredUser, 0);
			expect(room.grants.granted(Role.RegisteredUser, "playback.skip")).toBe(false);
			blocked.release();
			expect((await pending).code).toBe("unauthorized");
			expect(room.playbackSnapshot("after").timeline.baseline.sequence).toBe(sequence);
			expect(room.currentSource).toBeNull();
			expect((await store.load(room.name))!.playback.currentSource).toBeNull();
		} finally {
			await f.connection.close();
		}
	});

	it("rejects Music resume after source wait and reauth without adding durable history", async () => {
		const f = await createCatalogueFixture();
		try {
			await f.catalogue.addLibraryTrack(1, { reference: { service: "youtube", id: "a" } });
			const room = new Room(
				{ name: "music-reauth", queueMode: QueueMode.Music },
				{ catalogue: f.catalogue, store: new SqlMusicRoomStore(() => f.connection) },
			);
			room.throttledSync.cancel();
			room.throttledSync = vi.fn() as any;
			vi.spyOn(room, "publish").mockResolvedValue(undefined);
			const user = new RoomUser("tab", "session");
			user.user_id = 1;
			room.realusers.push(user);
			room.grants.setRoleGrants(Role.UnregisteredUser, 0);
			room.grants.setRoleGrants(Role.RegisteredUser, permissions.parseIntoGrantMask(["*"]));
			await room.musicEngine.refresh(true);
			await room.dequeueNext();
			vi.mocked(roommanager.getRoom).mockResolvedValue(ok(room));
			const client = new TestClient(room.name);
			client.id = "tab";
			addClient(client);
			await client.auth("session");
			await vi.waitFor(() =>
				expect(client.messages.some(m => m.action === "playback-capabilities")).toBe(true),
			);
			await handlePlaybackMessage(client, {
				action: "playback-subscribe",
				version: 1,
				nonce: "first",
			});
			const before = room.playbackSnapshot("before");
			const entered = gate(),
				blocked = gate(),
				original = f.resolver.video;
			vi.spyOn(f.resolver, "video").mockImplementation(async s => {
				entered.release();
				await blocked.promise;
				return original(s);
			});
			const pending = handlePlaybackMessage(client, command(room, "provider-reauth"));
			await entered.promise;
			await client.auth("other");
			await vi.waitFor(() =>
				expect(
					client.messages.filter(m => m.action === "playback-capabilities"),
				).toHaveLength(2),
			);
			expect(client.playbackSubscribed).toBe(false);
			expect(room.grants.granted(Role.UnregisteredUser, "playback.play-pause")).toBe(false);
			blocked.release();
			await pending;
			expect(room.isPlaying).toBe(false);
			expect(room.musicState!.history.events).toHaveLength(0);
			expect(room.playbackSnapshot("after").timeline).toEqual(before.timeline);
			const saved = await new SqlMusicRoomStore(() => f.connection).load(room.name);
			expect(saved!.playback.isPlaying).toBe(false);
			expect(saved!.state.history.events).toHaveLength(0);
		} finally {
			await f.connection.close();
		}
	});
	it("balancer event delivery is targeted and excludes unsubscribed connections and failed joins", async () => {
		const { room } = fixture();
		const { BalancerClient } = await import("../../client.js");
		await setup();
		const conn = { send: vi.fn() };
		const joined = new BalancerClient(room.name, "tab", conn as any),
			failed = new BalancerClient(room.name, "missing", conn as any);
		for (const client of [joined, failed]) {
			client.token = "session";
			client.joinStatus = ClientJoinStatus.Joined;
			addClient(client);
		}
		await joined.auth("session");
		await vi.waitFor(() =>
			expect(
				conn.send.mock.calls.some(
					([m]) => m.payload?.payload?.action === "playback-capabilities",
				),
			).toBe(true),
		);
		await handlePlaybackMessage(joined, {
			action: "playback-subscribe",
			version: 1,
			nonce: "joined",
		});
		await handlePlaybackMessage(failed, {
			action: "playback-subscribe",
			version: 1,
			nonce: "failed",
		});
		expect(failed.playbackSubscribed).toBe(false);
		conn.send.mockClear();
		await mocks.handlers.get("publish")(room.name, {
			action: "playback-event",
			event: { type: "play" },
		});
		expect(conn.send).toHaveBeenCalledTimes(1);
		expect(conn.send.mock.calls[0][0].payload.client_id).toBe("tab");
		joined.playbackSubscribed = false;
		conn.send.mockClear();
		await mocks.handlers.get("publish")(room.name, {
			action: "playback-event",
			event: { type: "pause" },
		});
		expect(conn.send).not.toHaveBeenCalled();
	});

	it.each(["same-token", "disconnect", "room-change"])(
		"rejects seek after a commit authorization wait and %s",
		async change => {
			const { room, client } = fixture();
			const entered = gate(),
				blocked = gate();
			let calls = 0;
			mocks.session.mockImplementation(async token => {
				// Ingress, initial command auth, context auth, then seek commit auth.
				if (++calls === 4) {
					entered.release();
					await blocked.promise;
				}
				return session(token);
			});
			const before = room.playbackSnapshot("before");
			const input = command(room, "seek-lifetime", "seek");
			const pending = handlePlaybackMessage(client, {
				...input,
				command: { ...input.command, positionSeconds: 25 },
			});
			await entered.promise;
			if (change === "same-token") {
				await client.auth("session");
			}
			if (change === "disconnect") {
				client.emit("disconnect", client);
			}
			if (change === "room-change") {
				client.room = "another-room";
			}
			blocked.release();
			await pending;
			expect(room.playbackPosition).toBe(0);
			expect(room.playbackSnapshot("after").timeline).toEqual(before.timeline);
			expect(room.publish).not.toHaveBeenCalled();
			expect(client.messages).toEqual([]);
		},
	);

	it("recovery during a pending command preserves its authority and session dedupe across reauth", async () => {
		const { room, client } = fixture();
		addClient(client);
		const entered = gate(),
			blocked = gate();
		let calls = 0;
		mocks.session.mockImplementation(async token => {
			if (++calls === 2) {
				entered.release();
				await blocked.promise;
			}
			return session(token);
		});
		const input = command(room, "recovery");
		const pending = handlePlaybackMessage(client, input);
		await entered.promise;
		await handlePlaybackMessage(client, {
			action: "playback-subscribe",
			version: 1,
			nonce: "recover",
		});
		blocked.release();
		await pending;
		expect(room.isPlaying).toBe(true);
		const committed = room.playbackSnapshot("committed");
		await client.auth("session");
		await vi.waitFor(() =>
			expect(client.messages.some(m => m.action === "playback-capabilities")).toBe(true),
		);
		client.playbackSubscribed = true;
		await handlePlaybackMessage(client, input);
		expect(room.playbackSnapshot("after").timeline).toEqual(committed.timeline);
		expect(client.messages.filter(m => m.action === "playback-result")).toHaveLength(2);
	});

	it("a retry after same-token reauth cannot reattach authority to a pending reservation", async () => {
		const { room, client } = fixture();
		addClient(client);
		const entered = gate(),
			blocked = gate();
		let calls = 0;
		mocks.session.mockImplementation(async token => {
			if (++calls === 2) {
				entered.release();
				await blocked.promise;
			}
			return session(token);
		});
		const input = command(room, "pending-retry");
		const pending = handlePlaybackMessage(client, input);
		await entered.promise;
		await client.auth("session");
		await vi.waitFor(() =>
			expect(client.messages.some(m => m.action === "playback-capabilities")).toBe(true),
		);
		client.playbackSubscribed = true;
		const retry = handlePlaybackMessage(client, input);
		blocked.release();
		await Promise.all([pending, retry]);
		expect(room.isPlaying).toBe(false);
		expect(room.playbackSnapshot("after").timeline.baseline.sequence).toBe(1);
		expect(client.messages.filter(m => m.action === "playback-result")).toMatchObject([
			{ result: { status: "rejected", code: "unauthorized" } },
		]);
	});

	it.each(["session-lookup", "room-lookup", "user-lookup", "disconnect"])(
		"superseded authentication cannot install state after %s",
		async waitAt => {
			const { room, client } = fixture();
			addClient(client);
			const entered = gate(),
				blocked = gate();
			if (waitAt === "session-lookup" || waitAt === "disconnect") {
				mocks.session.mockImplementationOnce(async () => {
					entered.release();
					await blocked.promise;
					return session("session");
				});
			} else if (waitAt === "room-lookup") {
				vi.mocked(roommanager.getRoom).mockImplementationOnce(async () => {
					entered.release();
					await blocked.promise;
					return ok(room);
				});
			} else {
				vi.mocked(usermanager.getUser).mockImplementationOnce(async () => {
					entered.release();
					await blocked.promise;
					return { id: 1, username: "one" } as any;
				});
			}
			const pending = client.auth("session");
			await entered.promise;
			if (waitAt === "disconnect") {
				client.emit("disconnect", client);
			} else {
				await client.auth("other");
				await vi.waitFor(() => expect(room.getUser("tab")?.token).toBe("other"));
			}
			blocked.release();
			await pending;
			await new Promise(resolve => setImmediate(resolve));
			if (waitAt === "disconnect") {
				expect(client.token).toBeNull();
				expect(room.getUser("tab")).toBeUndefined();
				expect(client.messages).toEqual([]);
			} else {
				expect(client.token).toBe("other");
				expect(client.session?.isLoggedIn).toBe(false);
				expect(room.getUser("tab")?.token).toBe("other");
				expect(room.getUser("tab")?.user_id).toBeUndefined();
				expect(
					client.messages.filter(m => m.action === "playback-capabilities"),
				).toHaveLength(1);
			}
		},
	);

	it.each(["same-token", "disconnect"])(
		"rejects Music next load after its committed clear and %s during provider I/O",
		async change => {
			const f = await createCatalogueFixture();
			try {
				for (const id of ["a", "b"]) {
					await f.catalogue.addLibraryTrack(1, { reference: { service: "youtube", id } });
				}
				const store = new SqlMusicRoomStore(() => f.connection);
				const room = new Room(
					{ name: "music-next-lifetime", queueMode: QueueMode.Music },
					{ catalogue: f.catalogue, store },
				);
				room.throttledSync.cancel();
				room.throttledSync = vi.fn() as any;
				vi.spyOn(room, "publish").mockResolvedValue(undefined);
				const user = new RoomUser("tab", "session");
				user.user_id = 1;
				room.realusers.push(user);
				room.grants.setRoleGrants(
					Role.RegisteredUser,
					permissions.parseIntoGrantMask(["*"]),
				);
				await room.musicEngine.refresh(true);
				await room.dequeueNext();
				await room.play();
				const client = new TestClient(room.name);
				client.id = "tab";
				client.token = "session";
				client.joinStatus = ClientJoinStatus.Joined;
				const entered = gate(),
					blocked = gate(),
					original = f.resolver.video;
				vi.spyOn(f.resolver, "video").mockImplementation(async source => {
					entered.release();
					await blocked.promise;
					return original(source);
				});
				const pending = room.executePlaybackCommand(
					command(room, "next-lifetime", "next").command,
					client.captureAuthorization(),
				);
				await entered.promise;
				const cleared = room.playbackSnapshot("cleared"),
					history = structuredClone(room.musicState!.history);
				if (change === "same-token") {
					await client.auth("session");
				} else {
					client.emit("disconnect", client);
				}
				blocked.release();
				expect((await pending).code).toBe("unauthorized");
				expect(room.currentSource).toBeNull();
				expect(room.playbackSnapshot("after").timeline).toEqual(cleared.timeline);
				expect(room.musicState!.history).toEqual(history);
				const saved = await store.load(room.name);
				expect(saved!.playback.currentSource).toBeNull();
				expect(saved!.state.history).toEqual(history);
			} finally {
				await f.connection.close();
			}
		},
	);

	it.each(
		["play", "seek", "next"].flatMap(kind =>
			["authorization", "finalization"].map(waitAt => ({ kind, waitAt })),
		),
	)(
		"rolls back Music $kind when same-token reauth invalidates SQL $waitAt",
		async ({ kind, waitAt }) => {
			const f = await createCatalogueFixture();
			try {
				await f.catalogue.addLibraryTrack(1, {
					reference: { service: "youtube", id: "a" },
				});
				const store = new SqlMusicRoomStore(() => f.connection);
				const room = new Room(
					{ name: "music-sql-lifetime", queueMode: QueueMode.Music },
					{ catalogue: f.catalogue, store },
				);
				room.throttledSync.cancel();
				room.throttledSync = vi.fn() as any;
				vi.spyOn(room, "publish").mockResolvedValue(undefined);
				const user = new RoomUser("tab", "session");
				user.user_id = 1;
				room.realusers.push(user);
				room.grants.setRoleGrants(
					Role.RegisteredUser,
					permissions.parseIntoGrantMask(["*"]),
				);
				await room.musicEngine.refresh(true);
				await room.dequeueNext();
				const client = new TestClient(room.name);
				client.id = "tab";
				client.token = "session";
				client.joinStatus = ClientJoinStatus.Joined;
				const before = room.playbackSnapshot("before"),
					durable = await store.load(room.name);
				vi.mocked(room.publish).mockClear();
				const entered = gate(),
					blocked = gate(),
					original = store.save.bind(store);
				vi.spyOn(store, "save").mockImplementation(async (value, revision, hooks) => {
					let checks = 0;
					await original(value, revision, {
						...hooks,
						authorize: async () => {
							if (waitAt === "finalization") {
								await hooks?.authorize?.();
							}
							if (++checks === 2) {
								entered.release();
								await blocked.promise;
							}
							if (waitAt === "authorization") {
								await hooks?.authorize?.();
							}
						},
					});
				});
				const input = {
					...command(room, "sql-lifetime", kind).command,
					...(kind === "seek" ? { positionSeconds: 30 } : {}),
				};
				const pending = room.executePlaybackCommand(input, client.captureAuthorization());
				await entered.promise;
				await client.auth("session");
				blocked.release();
				expect((await pending).code).toBe("unauthorized");
				expect(room.playbackSnapshot("after").timeline).toEqual(before.timeline);
				expect(await store.load(room.name)).toEqual(durable);
				expect(room.publish).not.toHaveBeenCalled();
			} finally {
				await f.connection.close();
			}
		},
	);

	it("preserves independent tabs and balancer recipients through reauth and disconnect", async () => {
		const { room, client } = fixture();
		await setup();
		const second = new TestClient(room.name);
		second.id = "second";
		const conn = { id: "shared-balancer", send: vi.fn() };
		mocks.balancer.mockReturnValue(conn);
		const remote = ["remote1", "remote2"].map(
			id => new BalancerClient(room.name, id, conn as unknown as BalancerConnection),
		);
		for (const member of [client, second, ...remote]) {
			addClient(member);
			await member.auth("session");
		}
		await vi.waitFor(() => expect(room.realusers).toHaveLength(4));
		await new Promise(resolve => setImmediate(resolve));
		await client.auth("session");
		await new Promise(resolve => setImmediate(resolve));
		for (const member of [client, second, ...remote]) {
			await handlePlaybackMessage(member, {
				action: "playback-subscribe",
				version: 1,
				nonce: "ready",
			});
		}
		client.messages.length = 0;
		second.messages.length = 0;
		conn.send.mockClear();
		await mocks.handlers.get("publish")(room.name, {
			action: "playback-event",
			event: { type: "play" },
		});
		expect(client.messages).toHaveLength(1);
		expect(second.messages).toHaveLength(1);
		expect(conn.send.mock.calls.map(([m]) => m.payload.client_id)).toEqual([
			"remote1",
			"remote2",
		]);
		conn.send.mockClear();
		await mocks.handlers.get("publish")(room.name, { action: "sync", isPlaying: true });
		expect(client.messages).toHaveLength(2);
		expect(second.messages).toHaveLength(2);
		expect(conn.send).toHaveBeenCalledTimes(1);
		expect(conn.send.mock.calls[0][0].payload.client_id).toBeUndefined();
		client.emit("disconnect", client);
		remote[0].leave();
		await vi.waitFor(() => expect(room.realusers).toHaveLength(2));
		client.messages.length = 0;
		second.messages.length = 0;
		conn.send.mockClear();
		await mocks.handlers.get("publish")(room.name, {
			action: "playback-event",
			event: { type: "pause" },
		});
		expect(client.messages).toHaveLength(0);
		expect(second.messages).toHaveLength(1);
		expect(conn.send.mock.calls.map(([m]) => m.payload.client_id)).toEqual(["remote2"]);
	});

	const undoRequest = (type: RoomRequestType, additional: unknown): UndoRequest =>
		({
			type: RoomRequestType.UndoRequest,
			event: {
				action: "event",
				request: { type },
				user: { name: "one", isLoggedIn: true },
				additional,
			},
		}) as UndoRequest;
	it.each([
		...[-1, NaN, Infinity, -Infinity, 1e9 + 1, undefined, null].map(prevPosition => ({
			video: { ...source, id: "other" },
			prevPosition,
		})),
		{ prevPosition: 0 },
		{ video: { id: "incomplete" }, prevPosition: 0 },
		{ video: { ...source, startAt: -1 }, prevPosition: 0 },
		{ video: { ...source, endAt: Infinity }, prevPosition: 0 },
		{ video: { ...source, length: NaN }, prevPosition: 0 },
	])("rejects malformed skip undo atomically: %j", async additional => {
		const { room } = fixture();
		const before = room.serializeState(),
			snapshot = room.playbackSnapshot("same");
		vi.mocked(room.throttledSync).mockClear();
		await expect(
			room.processUnauthorizedRequest(undoRequest(RoomRequestType.SkipRequest, additional), {
				token: "session",
				clientId: "tab",
			}),
		).rejects.toThrow();
		expect(room.serializeState()).toBe(before);
		expect(room.playbackSnapshot("same")).toEqual(snapshot);
		expect(room.throttledSync).not.toHaveBeenCalled();
		expect(room.publish).not.toHaveBeenCalled();
	});
	it.each([-1, NaN, Infinity, 1e9 + 1, undefined])(
		"rejects malformed seek undo atomically: %s",
		async prevPosition => {
			const { room } = fixture();
			const before = room.serializeState(),
				snapshot = room.playbackSnapshot("same");
			await expect(
				room.processUnauthorizedRequest(
					undoRequest(RoomRequestType.SeekRequest, { prevPosition }),
					{ token: "session", clientId: "tab" },
				),
			).rejects.toThrow();
			expect(room.serializeState()).toBe(before);
			expect(room.playbackSnapshot("same")).toEqual(snapshot);
			expect(room.publish).not.toHaveBeenCalled();
		},
	);
	it("valid skip undo mints a new occurrence, seek undo reaches zero, and add undo clears", async () => {
		const { room } = fixture();
		const authorization = { token: "session", clientId: "tab" };
		await room.processUnauthorizedRequest(
			undoRequest(RoomRequestType.SkipRequest, {
				video: { ...source, id: "restored" },
				prevPosition: 12,
			}),
			authorization,
		);
		expect(room.currentSource?.id).toBe("restored");
		expect(room.queue.items).toEqual([source]);
		expect(room.playbackSnapshot("restored").timeline.baseline.state).toMatchObject({
			occurrenceId: 2,
			positionSeconds: 12,
		});
		await room.processUnauthorizedRequest(
			undoRequest(RoomRequestType.SeekRequest, { prevPosition: 0 }),
			authorization,
		);
		expect(room.playbackSnapshot("seek").timeline.baseline.state).toMatchObject({
			occurrenceId: 2,
			positionSeconds: 0,
		});
		await room.queue.set([]);
		const clear = undoRequest(RoomRequestType.AddRequest, {});
		clear.event.request = { type: RoomRequestType.AddRequest, video: source };
		await room.processUnauthorizedRequest(clear, authorization);
		expect(room.currentSource).toBeNull();
		expect(room.playbackSnapshot("clear").attachment).toBeNull();
	});
});
