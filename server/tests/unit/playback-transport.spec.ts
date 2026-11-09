import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { PlaybackJournal } from "../../playback/journal.js";
import { PlaybackReceipts } from "../../playback/receipts.js";
import { Room, RoomUser } from "../../room.js";
import { Client, ClientJoinStatus, BalancerClient } from "../../client.js";
import type { BalancerConnection } from "../../balancer.js";
import { handlePlaybackMessage } from "../../clientmanager.js";
import roommanager from "../../roommanager.js";
import tokens from "../../auth/tokens.js";
import usermanager from "../../usermanager.js";
import infoextractor from "../../infoextractor.js";
import { conf } from "../../ott-config.js";
import { QueueMode, Role } from "ott-common/models/types.js";
import { RoomRequestType, type ServerMessage } from "ott-common/models/messages.js";
import { acceptPlaybackEvent, expectedPlaybackAt } from "ott-common/playback/index.js";
import {
	PlaybackCommandSchema,
	type PlaybackCommandResult,
	type PlaybackServerMessage,
} from "ott-common/playback/transport.js";
import permissions from "ott-common/permissions.js";
import { ok } from "ott-common/result.js";
import { createCatalogueFixture } from "./music-test-helpers.js";
import { SqlMusicRoomStore } from "../../music/room-music-storage.js";
import type { User } from "../../models/user.js";

vi.mock("../../roommanager.js", () => ({ default: { getRoom: vi.fn(), publish: vi.fn() } }));
vi.mock("../../websockets.js", () => ({ wss: {} }));
vi.mock("../../balancer.js", () => ({
	balancerManager: {},
	buildGossipMessage: vi.fn(),
	initBalancerConnections: vi.fn(),
}));

const context = {
	username: "guest",
	role: Role.UnregisteredUser,
	clientId: "tab",
	auth: { token: "session", clientId: "tab" },
};
const gate = () => {
	let release!: () => void;
	const promise = new Promise<void>(resolve => {
		release = resolve;
	});
	return { promise, release };
};
const current = { service: "youtube" as const, id: "ordinary-video", length: 180 };
const makeRoom = () => {
	const room = new Room({ name: "transport", currentSource: current });
	room.throttledSync.cancel();
	room.throttledSync = vi.fn() as unknown as typeof room.throttledSync;
	room.realusers.push(new RoomUser("tab", "session"));
	room.grants.setRoleGrants(Role.UnregisteredUser, permissions.parseIntoGrantMask(["*"]));
	vi.spyOn(room, "publish").mockResolvedValue(undefined);
	return room;
};
const command = (room: Room, requestId: string, extra: Record<string, unknown> = {}) => ({
	requestId,
	epoch: room.playbackSnapshot("before").timeline.epoch,
	occurrenceId: room.playbackSnapshot("before").timeline.baseline.state!.occurrenceId,
	command: "pause",
	...extra,
});
const events = (room: Room) =>
	vi
		.mocked(room.publish)
		.mock.calls.map(([m]) => m)
		.filter(
			(m): m is Extract<PlaybackServerMessage, { action: "playback-event" }> =>
				m.action === "playback-event",
		);

describe("Playback transport", () => {
	beforeEach(() => {
		vi.spyOn(tokens, "getSessionInfo").mockResolvedValue({
			isLoggedIn: false,
			username: "guest",
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	describe("authoritative legacy publication", () => {
		it("replays play/pause, explicit seeks and rate continuity without sync", async () => {
			vi.useFakeTimers();
			vi.setSystemTime(10_000);
			const room = makeRoom();
			let replay = room.playbackSnapshot("initial").timeline;
			await room.play();
			vi.setSystemTime(12_000);
			await room.setPlaybackSpeed(
				{ type: RoomRequestType.PlaybackSpeedRequest, speed: 2 },
				context,
			);
			vi.setSystemTime(13_000);
			await room.pause();
			expect(room.realPlaybackPosition).toBe(4);
			await room.seek({ type: RoomRequestType.SeekRequest, value: 0 }, context);
			expect(events(room).map(m => m.event.type)).toEqual(["play", "rate", "pause", "seek"]);
			for (const message of events(room)) {
				replay = acceptPlaybackEvent(replay, message.event).timeline;
			}
			expect(expectedPlaybackAt(replay, 13_000)).toEqual(
				expectedPlaybackAt(room.playbackSnapshot("after").timeline, 13_000),
			);
			room.throttledSync.cancel?.();
		});
		it.each([QueueMode.Manual, QueueMode.Dj, QueueMode.Loop, QueueMode.Vote])(
			"mints fresh same-source occurrences in queue mode %s and clears when exhausted",
			async queueMode => {
				const room = makeRoom();
				room.queueMode = queueMode;
				await room.queue.enqueue(current);
				await room.dequeueNext();
				expect(events(room)[0].event).toMatchObject({ type: "load", occurrenceId: 2 });
				room.queueMode = QueueMode.Manual;
				await room.queue.set([]);
				await room.dequeueNext();
				expect(events(room).at(-1)?.event.type).toBe("clear");
				expect(room.playbackSnapshot("empty").attachment).toBeNull();
			},
		);
		it("publishes SponsorBlock seekRaw and endAt transitions, coalesces overlapping updates", async () => {
			const room = makeRoom();
			await room.play();
			room.videoSegments = [
				{ category: "sponsor", startTime: 0, endTime: 10 },
			] as typeof room.videoSegments;
			vi.spyOn(conf, "get").mockImplementation((key =>
				key === "video.sponsorblock.enabled" ? true : 3600) as typeof conf.get);
			const first = room.update();
			expect(room.update()).toBe(first);
			await first;
			expect(events(room).at(-1)?.event).toMatchObject({ type: "seek", positionSeconds: 10 });
			room.currentSource = { ...current, endAt: 5 };
			await room.update();
			expect(events(room).at(-1)?.event.type).toBe("clear");
		});
		it("undo restores position zero as a new occurrence; undo add clears", async () => {
			const room = makeRoom();
			await room.undo(
				{
					type: RoomRequestType.UndoRequest,
					event: {
						action: "event",
						request: { type: RoomRequestType.SkipRequest },
						user: { name: "guest", isLoggedIn: false },
						additional: { video: current, prevPosition: 0 },
					},
				},
				context,
			);
			expect(events(room).at(-1)?.event).toMatchObject({
				type: "load",
				occurrenceId: 2,
				positionSeconds: 0,
			});
			await room.queue.set([]);
			await room.undo(
				{
					type: RoomRequestType.UndoRequest,
					event: {
						action: "event",
						request: { type: RoomRequestType.AddRequest, video: current },
						user: { name: "guest", isLoggedIn: false },
						additional: {},
					},
				},
				context,
			);
			expect(events(room).at(-1)?.event.type).toBe("clear");
		});
		it("rechecks legacy playNow permission, membership and session after metadata waits", async () => {
			const room = makeRoom();
			const wait = gate();
			const entered = gate();
			vi.spyOn(infoextractor, "getVideoInfo").mockImplementation(async () => {
				entered.release();
				await wait.promise;
				return { ...current, id: "next" };
			});
			const pending = room.processUnauthorizedRequest(
				{ type: RoomRequestType.PlayNowRequest, video: { ...current, id: "next" } },
				context.auth,
			);
			await entered.promise;
			room.realusers.splice(0);
			wait.release();
			await expect(pending).rejects.toThrow("membership");
			expect(events(room)).toHaveLength(0);
			expect(room.currentSource?.id).toBe(current.id);
		});
	});

	describe("playback command receipts and authorization", () => {
		it("reserves concurrent IDs before auth waits, rejects changed payloads and caches zero-event skip votes", async () => {
			const room = makeRoom();
			room.enableVoteSkip = true;
			for (let i = 0; i < 4; i++) {
				room.realusers.push(new RoomUser(`other${i}`, `other-session${i}`));
			}
			const wait = gate();
			vi.mocked(tokens.getSessionInfo).mockImplementation(async () => {
				await wait.promise;
				return { isLoggedIn: false, username: "guest" };
			});
			const input = command(room, "vote", { command: "next" });
			const first = room.executePlaybackCommand(input, context.auth);
			const retry = room.executePlaybackCommand(input, context.auth);
			expect(first).toBe(retry);
			const conflict = await room.executePlaybackCommand(
				{ ...input, command: "play" },
				context.auth,
			);
			expect(conflict.code).toBe("request-conflict");
			wait.release();
			expect((await first).status).toBe("applied");
			expect(await retry).toEqual(await first);
			expect(room.votesToSkip.has("tab")).toBe(true);
			expect(events(room)).toHaveLength(0);
		});
		it("rejects stale occurrences, cross epochs, account switches and permission revocation", async () => {
			const room = makeRoom();
			const old = command(room, "old");
			await room.queue.enqueue(current);
			await room.dequeueNext();
			expect((await room.executePlaybackCommand(old, context.auth)).code).toBe(
				"stale-occurrence",
			);
			expect(
				(
					await room.executePlaybackCommand(
						command(room, "epoch", { epoch: "other" }),
						context.auth,
					)
				).code,
			).toBe("stale-epoch");
			vi.mocked(tokens.getSessionInfo).mockResolvedValue({ isLoggedIn: true, user_id: 2 });
			expect(
				(await room.executePlaybackCommand(command(room, "account"), context.auth)).code,
			).toBe("unauthorized");
			vi.mocked(tokens.getSessionInfo).mockResolvedValue({
				isLoggedIn: false,
				username: "guest",
			});
			room.grants.setRoleGrants(Role.UnregisteredUser, 0);
			expect(
				(await room.executePlaybackCommand(command(room, "role"), context.auth)).code,
			).toBe("unauthorized");
		});
		it("validates finite numeric domains and bounds reservations without evicting pending work", async () => {
			const room = makeRoom();
			expect(() =>
				PlaybackCommandSchema.parse(
					command(room, "nan", { command: "seek", positionSeconds: NaN }),
				),
			).toThrow();
			await expect(
				room.setPlaybackSpeed(
					{ type: RoomRequestType.PlaybackSpeedRequest, speed: Infinity },
					context,
				),
			).rejects.toThrow();
			const receipts = new PlaybackReceipts();
			const wait = gate();
			const reject = (code: "capacity" | "request-conflict"): PlaybackCommandResult => ({
				requestId: "id",
				epoch: "epoch",
				sequence: 0,
				status: "rejected",
				code,
			});
			const work = async (): Promise<PlaybackCommandResult> => {
				await wait.promise;
				return { requestId: "id", epoch: "epoch", sequence: 0, status: "applied" };
			};
			const pending = Array.from({ length: 512 }, (_, i) =>
				receipts.run(String(i), "same", reject, work),
			);
			expect((await receipts.run("overflow", "same", reject, work)).code).toBe("capacity");
			wait.release();
			await Promise.all(pending);
		});
	});

	describe("adapter mapping and authenticated recovery/clock", () => {
		it("keeps only current URLs, versions same-ID source refresh, and discards speculative candidates", () => {
			const messages: PlaybackServerMessage[] = [];
			const journal = new PlaybackJournal(m => messages.push(m));
			const value = {
				currentSource: { service: "direct" as const, id: "https://private.example/old" },
				positionSeconds: 3,
				isPlaying: false,
				rate: 1,
				playbackId: "persistent",
			};
			journal.commit(value);
			const old = journal.snapshot("one");
			journal.stage({ ...value, positionSeconds: 8 }, { seek: true });
			expect(journal.sequence).toBe(1);
			journal.commit({
				...value,
				currentSource: { ...value.currentSource, src_url: "https://private.example/new" },
			});
			const snapshot = journal.snapshot("two");
			expect(messages.at(-1)).toMatchObject({
				action: "playback-event",
				event: { type: "source", occurrenceId: 1 },
			});
			expect(snapshot.attachment?.media).not.toEqual(old.attachment?.media);
			expect(JSON.stringify(snapshot.timeline)).not.toContain("private.example");
			expect(snapshot.attachment?.playbackId).toBe("persistent");
			for (let i = 0; i < 1100; i++) {
				journal.commit({ ...value, positionSeconds: i }, { seek: true });
			}
			expect(journal.snapshot("bounded").timeline.events).toHaveLength(0);
			expect(journal.sequence).toBeGreaterThan(1024);
		});
		it("echoes numeric generation and nonce exactly; sends targeted snapshots, gates auth and rate limits", async () => {
			const room = makeRoom();
			vi.mocked(roommanager.getRoom).mockResolvedValue(ok(room));
			class TestClient extends Client {
				messages: ServerMessage[] = [];
				get clientType() {
					return "test";
				}
				sendRaw(data: string) {
					this.messages.push(JSON.parse(data));
				}
				kick() {
					/* No socket in this fixture. */
				}
			}
			const client = new TestClient(room.name);
			client.id = "tab";
			client.token = "session";
			await handlePlaybackMessage(client, {
				action: "clock-probe",
				generation: 42,
				nonce: "001",
			});
			expect(client.messages).toHaveLength(0);
			client.joinStatus = ClientJoinStatus.Joined;
			await handlePlaybackMessage(client, {
				action: "clock-probe",
				generation: 42,
				nonce: "001",
			});
			expect(client.messages[0]).toMatchObject({
				action: "clock-reply",
				generation: 42,
				nonce: "001",
			});
			await handlePlaybackMessage(client, {
				action: "playback-subscribe",
				version: 1,
				nonce: "recover",
				resume: { epoch: "expired", lastSequence: 1000 },
			});
			expect(client.messages[1]).toMatchObject({
				action: "playback-snapshot",
				nonce: "recover",
				timeline: room.playbackSnapshot("x").timeline,
			});
			expect(client.playbackSubscribed).toBe(true);
			const stale = gate();
			vi.mocked(tokens.getSessionInfo).mockImplementationOnce(async () => {
				await stale.promise;
				return { isLoggedIn: false, username: "guest" };
			});
			const delayed = handlePlaybackMessage(client, {
				action: "playback-subscribe",
				version: 1,
				nonce: "old-request",
			});
			await handlePlaybackMessage(client, {
				action: "playback-subscribe",
				version: 1,
				nonce: "latest-request",
			});
			stale.release();
			await delayed;
			expect(
				client.messages.filter(m => m.action === "playback-snapshot").map(m => m.nonce),
			).toEqual(["recover", "latest-request"]);
			for (let i = 0; i < 30; i++) {
				await handlePlaybackMessage(client, {
					action: "clock-probe",
					generation: 42,
					nonce: String(i),
				});
			}
			expect(client.messages.length).toBeLessThanOrEqual(19);
			const conn = { send: vi.fn() };
			const balancer = new BalancerClient(
				room.name,
				"tab",
				conn as unknown as BalancerConnection,
			);
			balancer.token = "session";
			balancer.joinStatus = ClientJoinStatus.Joined;
			await handlePlaybackMessage(balancer, {
				action: "clock-probe",
				generation: 7,
				nonce: "001",
			});
			expect(conn.send).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "room_msg",
					payload: expect.objectContaining({
						client_id: "tab",
						payload: expect.objectContaining({
							action: "clock-reply",
							generation: 7,
							nonce: "001",
						}),
					}),
				}),
			);
		});
	});

	describe("Music journal SQL boundary", () => {
		it("publishes only after successful save, retries finalizers without gaps and preserves playbackId on restart", async () => {
			const fixture = await createCatalogueFixture();
			try {
				vi.mocked(tokens.getSessionInfo).mockResolvedValue({
					isLoggedIn: true,
					user_id: 1,
				});
				vi.spyOn(usermanager, "getUser").mockResolvedValue({
					id: 1,
					username: "one",
				} as User);
				await fixture.catalogue.addLibraryTrack(1, {
					reference: { service: "youtube", id: "track" },
				});
				await fixture.catalogue.addLibraryTrack(1, {
					reference: { service: "youtube", id: "track2" },
				});
				const store = new SqlMusicRoomStore(() => fixture.connection);
				const setup = () => {
					const room = new Room(
						{ name: "durable-transport", queueMode: QueueMode.Music },
						{ catalogue: fixture.catalogue, store },
					);
					room.throttledSync.cancel();
					room.throttledSync = vi.fn() as unknown as typeof room.throttledSync;
					const user = new RoomUser("tab", "session");
					user.user_id = 1;
					room.realusers.push(user);
					room.grants.setRoleGrants(
						Role.RegisteredUser,
						permissions.parseIntoGrantMask(["*"]),
					);
					vi.spyOn(room, "publish").mockResolvedValue(undefined);
					return room;
				};
				const room = setup();
				await room.musicEngine.refresh(true);
				await room.dequeueNext();
				const before = room.playbackSnapshot("before");
				const original = store.save.bind(store);
				const save = vi
					.spyOn(store, "save")
					.mockImplementationOnce(async (_value, _revision, hooks) => {
						hooks?.finalize?.();
						hooks?.finalize?.();
						throw Error("SQL rollback");
					});
				await expect(
					room.musicEngine.setPlayback({ playbackPosition: 40 }),
				).rejects.toThrow("SQL rollback");
				expect(room.playbackSnapshot("after").timeline).toEqual(before.timeline);
				expect(events(room)).toHaveLength(1);
				save.mockImplementation(async (value, revision, hooks) => {
					hooks?.finalize?.();
					hooks?.finalize?.();
					await original(value, revision, hooks);
				});
				await room.musicEngine.setPlayback({ playbackPosition: 40 });
				expect(events(room).map(m => m.event.sequence)).toEqual([1, 2]);
				expect(events(room).at(-1)?.event).toMatchObject({
					type: "seek",
					positionSeconds: 40,
				});
				const restart = setup();
				await restart.initializeMusic();
				expect(restart.playbackSnapshot("restart").timeline.epoch).not.toBe(
					before.timeline.epoch,
				);
				expect(restart.music?.current?.playbackId).toBe(room.music?.current?.playbackId);
				expect(restart.musicState?.history.scores).toEqual(room.musicState?.history.scores);
				await room.play();
				await room.pause();
				const persistent = room.music!.current!;
				const occurrence =
					room.playbackSnapshot("paused").timeline.baseline.state!.occurrenceId;
				const source = (await fixture.models.TrackSource.findByPk(
					persistent.sourceId,
				))!.get({
					plain: true,
				});
				await fixture.models.TrackSource.create({
					...source,
					id: randomUUID(),
					providerId: "fallback",
					availability: "available",
				});
				await fixture.models.TrackSource.update(
					{ availability: "unavailable" },
					{ where: { id: persistent.sourceId } },
				);
				await room.play();
				expect(
					events(room)
						.slice(-2)
						.map(m => m.event.type),
				).toEqual(["source", "play"]);
				expect(
					room.playbackSnapshot("fallback").timeline.baseline.state!.occurrenceId,
				).toBe(occurrence);
				expect(room.music!.current!.playbackId).toBe(persistent.playbackId);
				expect(room.musicState!.history.events).toHaveLength(1);
				const wait = gate(),
					entered = gate();
				const originalVideo = fixture.resolver.video;
				vi.spyOn(fixture.resolver, "video").mockImplementation(async source => {
					entered.release();
					await wait.promise;
					return originalVideo(source);
				});
				const next = command(room, "next", { command: "next" });
				const pending = room.executePlaybackCommand(next, context.auth);
				await entered.promise;
				expect(room.playbackSnapshot("resolving").timeline.baseline.state).toBeNull();
				expect(room.isPlaying).toBe(true);
				expect(
					(
						await room.executePlaybackCommand(
							{ ...next, requestId: "other-next" },
							context.auth,
						)
					).code,
				).toBe("stale-occurrence");
				wait.release();
				expect((await pending).status).toBe("applied");
				expect(await room.executePlaybackCommand(next, context.auth)).toEqual(
					await pending,
				);
				expect(
					events(room)
						.slice(-2)
						.map(m => m.event.type),
				).toEqual(["clear", "load"]);
				expect(room.isPlaying).toBe(true);
				await room.pause();
				const staleWait = gate(),
					staleEntered = gate();
				let firstResolution = true;
				vi.mocked(fixture.resolver.video).mockImplementation(async source => {
					if (firstResolution) {
						firstResolution = false;
						staleEntered.release();
						await staleWait.promise;
					}
					return originalVideo(source);
				});
				const stalePlay = room.executePlaybackCommand(
					command(room, "stale-play", { command: "play" }),
					context.auth,
				);
				await staleEntered.promise;
				await room.dequeueNext();
				const afterAdvance = room.playbackSnapshot("advanced");
				staleWait.release();
				expect((await stalePlay).code).toBe("stale-occurrence");
				expect(room.playbackSnapshot("unchanged").timeline).toEqual(afterAdvance.timeline);
			} finally {
				await fixture.connection.close();
			}
		});
	});
});
