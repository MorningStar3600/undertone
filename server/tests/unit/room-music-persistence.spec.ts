/* eslint-disable vitest/no-conditional-in-test -- Shared concurrency scenarios vary the revoked authority. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sequelize, type Transaction } from "sequelize";
import { Room, RoomUser } from "../../room.js";
import tokens, { type SessionInfo } from "../../auth/tokens.js";
import usermanager from "../../usermanager.js";
import type { User } from "../../models/user.js";
import { SqlMusicRoomStore } from "../../music/room-music-storage.js";
import { musicTransaction } from "../../music/room-music-db.js";
import { musicRoomModels } from "../../models/music-room.js";
import { createCatalogueFixture } from "./music-test-helpers.js";
import { PlayerStatus, QueueMode, Role } from "ott-common/models/types.js";
import { RoomRequestType, type RoomRequest } from "ott-common/models/messages.js";
import permissions from "ott-common/permissions.js";

describe("Music authorization inside persistence", () => {
	const releases: Array<() => void> = [];
	let fixture: Awaited<ReturnType<typeof createCatalogueFixture>>;
	let room: Room;
	let store: SqlMusicRoomStore;
	const context = { username: "one", clientId: "tab1", role: Role.RegisteredUser };
	const setupRoom = (queueMode = QueueMode.Music) => {
		room = new Room(
			{ name: "persistence-test", queueMode },
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
		for (const release of releases.splice(0)) {
			release();
		}
		room.throttledSync.cancel?.();
		vi.useRealTimers();
		vi.restoreAllMocks();
		await fixture.connection.close();
	});
	const gate = () => {
		let enter!: () => void, release!: () => void;
		releases.push(() => release());
		return {
			entered: new Promise<void>(resolve => {
				enter = resolve;
			}),
			waiting: new Promise<void>(resolve => {
				release = resolve;
			}),
			enter: () => enter(),
			release: () => release(),
		};
	};
	const captureError = async (operation: () => Promise<void>) => {
		try {
			await operation();
			return undefined;
		} catch (error) {
			return error;
		}
	};
	const play = () =>
		room.processRequest({ type: RoomRequestType.PlaybackRequest, state: true }, context);
	const revoke = (change: string) => {
		if (change === "grants") {
			for (const role of [Role.UnregisteredUser, Role.RegisteredUser]) {
				room.grants.setRoleGrants(role, 0);
			}
		} else if (change === "leave") {
			room.realusers = [];
		} else if (change === "mode") {
			room.queueMode = QueueMode.Manual;
		} else if (change === "expired") {
			vi.mocked(tokens.getSessionInfo).mockRejectedValue(new Error("expired"));
		} else if (change === "logout") {
			vi.mocked(tokens.getSessionInfo).mockResolvedValue({
				isLoggedIn: false,
				username: "guest",
			});
		} else if (change === "account") {
			vi.mocked(tokens.getSessionInfo).mockResolvedValue({ isLoggedIn: true, user_id: 2 });
		}
	};
	const assertUnchanged = async (
		before: Awaited<ReturnType<SqlMusicRoomStore["load"]>>,
		count: number,
	) => {
		expect(await store.load(room.name)).toEqual(before);
		expect(room.musicState!.history.events).toHaveLength(0);
		expect(room.isPlaying).toBe(false);
		expect(vi.mocked(room.publish).mock.calls).toHaveLength(count);
	};

	it.each(["grants", "logout", "leave", "expired", "account", "mode"])(
		"rolls back a play revoked by %s while queued behind a real SQLite writer",
		async change => {
			await room.dequeueNext();
			const before = await store.load(room.name),
				count = vi.mocked(room.publish).mock.calls.length;
			const hold = gate(),
				saving = gate(),
				original = store.save.bind(store);
			// Occupy the shared writer only after mood reads, so the action reaches save's queue.
			const authorize = vi.mocked(tokens.getSessionInfo).getMockImplementation()!;
			let blocker: Promise<unknown> | undefined;
			vi.mocked(tokens.getSessionInfo).mockImplementationOnce(async token => {
				blocker = musicTransaction(fixture.connection, async () => {
					hold.enter();
					await hold.waiting;
				});
				await hold.entered;
				return authorize(token);
			});
			vi.spyOn(store, "save").mockImplementationOnce((...args) => {
				saving.enter();
				return original(...args);
			});
			const pending = captureError(play);
			try {
				await saving.entered;
				revoke(change);
			} finally {
				hold.release();
			}
			await blocker;
			expect(await pending).toBeInstanceOf(Error);
			await assertUnchanged(before, count);
		},
	);

	it("rechecks cancellation authority inside the real shared writer queue", async () => {
		const request = {
			type: RoomRequestType.MusicRoomRequest,
			command: {
				action: "request",
				requestId: "cancel-me",
				intent: "mix",
				reference: { service: "youtube", id: "manual" },
				correlationId: "request",
				expectedRevision: room.music!.revision,
			},
		} as RoomRequest;
		await room.processRequest(request, context);
		const before = await store.load(room.name),
			count = vi.mocked(room.publish).mock.calls.length;
		const hold = gate(),
			saving = gate(),
			original = store.save.bind(store);
		let blocker: Promise<unknown> | undefined;
		const snapshot = fixture.catalogue.roomSnapshot.bind(fixture.catalogue);
		vi.spyOn(fixture.catalogue, "roomSnapshot").mockImplementationOnce(async (...args) => {
			const result = await snapshot(...args);
			blocker = musicTransaction(fixture.connection, async () => {
				hold.enter();
				await hold.waiting;
			});
			await hold.entered;
			return result;
		});
		vi.spyOn(store, "save").mockImplementationOnce((...args) => {
			saving.enter();
			return original(...args);
		});
		const pending = captureError(() =>
			room.processRequest(
				{
					type: RoomRequestType.MusicRoomRequest,
					command: {
						action: "cancel",
						requestId: "cancel-me",
						correlationId: "cancel",
						expectedRevision: room.music!.revision,
					},
				},
				context,
			),
		);
		try {
			await saving.entered;
			revoke("logout");
		} finally {
			hold.release();
		}
		await blocker;
		expect(await pending).toBeInstanceOf(Error);
		expect(await store.load(room.name)).toEqual(before);
		expect(vi.mocked(room.publish).mock.calls).toHaveLength(count);
	});

	it("rolls back all normalized SQL writes when authority expires during SQL work", async () => {
		await room.dequeueNext();
		const before = await store.load(room.name),
			count = vi.mocked(room.publish).mock.calls.length;
		const score = musicRoomModels(fixture.connection).Score,
			original = score.upsert.bind(score),
			hold = gate();
		vi.spyOn(score, "upsert").mockImplementationOnce(async (...args) => {
			const result = await original(...args);
			hold.enter();
			await hold.waiting;
			return result;
		});
		const pending = captureError(play);
		try {
			await hold.entered;
			revoke("logout");
		} finally {
			hold.release();
		}
		expect(await pending).toBeInstanceOf(Error);
		await assertUnchanged(before, count);
	});

	it("reauthorizes each whole transaction retry and never publishes a rolled-back start", async () => {
		await room.dequeueNext();
		const before = await store.load(room.name),
			count = vi.mocked(room.publish).mock.calls.length;
		const score = musicRoomModels(fixture.connection).Score;
		vi.spyOn(score, "upsert").mockImplementationOnce(async () => {
			revoke("grants");
			throw Object.assign(new Error("busy"), { original: { code: "SQLITE_BUSY" } });
		});
		await expect(play()).rejects.toThrow();
		expect(score.upsert).toHaveBeenCalledTimes(1);
		await assertUnchanged(before, count);
	});

	it("bounds a queued transaction without running its callback later", async () => {
		const hold = gate(),
			callback = vi.fn(async () => undefined);
		const blocker = musicTransaction(fixture.connection, async () => {
			hold.enter();
			await hold.waiting;
		});
		await hold.entered;
		try {
			await expect(musicTransaction(fixture.connection, callback, false, 20)).rejects.toThrow(
				"timeout",
			);
		} finally {
			hold.release();
			await blocker;
		}
		await musicTransaction(fixture.connection, async () => undefined);
		expect(callback).not.toHaveBeenCalled();
	});

	it.each(["moods", "authorize", "writer", "sql", "final-authorize"])(
		"timestamps playback and SQL history after independent %s latency",
		async waitingFor => {
			await room.dequeueNext();
			await room.seek({ type: RoomRequestType.SeekRequest, value: 75 }, context);
			await room.setPlaybackSpeed(
				{ type: RoomRequestType.PlaybackSpeedRequest, speed: 1.5 },
				context,
			);
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date("2026-11-09T12:00:00Z"));
			const hold = gate(),
				originalSave = store.save.bind(store);
			let blocker: Promise<unknown> | undefined;
			if (waitingFor === "moods") {
				const snapshot = fixture.catalogue.roomSnapshot.bind(fixture.catalogue);
				vi.spyOn(fixture.catalogue, "roomSnapshot").mockImplementation(async (...args) => {
					const result = await snapshot(...args);
					if (args[2]?.length) {
						hold.enter();
						await hold.waiting;
					}
					return result;
				});
			} else if (waitingFor === "authorize") {
				vi.mocked(tokens.getSessionInfo).mockImplementationOnce(async () => {
					hold.enter();
					await hold.waiting;
					return { isLoggedIn: true, user_id: 1 };
				});
			} else if (waitingFor === "writer") {
				vi.spyOn(store, "save").mockImplementationOnce(async (...args) => {
					blocker = musicTransaction(fixture.connection, async () => {
						hold.enter();
						await hold.waiting;
					});
					await hold.entered;
					return originalSave(...args);
				});
			} else if (waitingFor === "sql") {
				const score = musicRoomModels(fixture.connection).Score,
					original = score.upsert.bind(score);
				vi.spyOn(score, "upsert").mockImplementationOnce(async (...args) => {
					const result = await original(...args);
					hold.enter();
					await hold.waiting;
					return result;
				});
			} else {
				let checks = 0;
				vi.mocked(tokens.getSessionInfo).mockImplementation(async () => {
					if (++checks === 3) {
						hold.enter();
						await hold.waiting;
					}
					return { isLoggedIn: true, user_id: 1 };
				});
			}
			const pending = play();
			try {
				await hold.entered;
				vi.setSystemTime(new Date("2026-11-09T12:00:15Z"));
			} finally {
				hold.release();
			}
			await blocker;
			await pending;
			expect(room.realPlaybackPosition).toBe(75);
			expect(room.playbackSpeed).toBe(1.5);
			const saved = (await store.load(room.name))!;
			expect(saved.playback.playbackStart).toBe(new Date(Date.now()).toISOString());
			expect(saved.state.history.events[0].startedAt).toBe(Date.now());
			expect(saved.state.history).toEqual(room.musicState!.history);
			await room.pause();
			await room.play();
			await room.play();
			expect(room.musicState!.history.events).toHaveLength(1);
			expect(room.realPlaybackPosition).toBe(75);
		},
	);

	it.each([true, false])(
		"stops when all resolved heads fail late availability validation, playing=%s",
		async playing => {
			await room.dequeueNext();
			if (playing) {
				await room.play();
			}
			const original = fixture.resolver.video;
			const video = vi.spyOn(fixture.resolver, "video").mockImplementation(async source => {
				const result = await original(source);
				await fixture.models.TrackSource.update(
					{ availability: "unavailable" },
					{ where: { id: source.id } },
				);
				return result;
			});
			await room.dequeueNext();
			await room.update();
			expect(room.isPlaying).toBe(false);
			expect(room.currentSource).toBeNull();
			expect(room.music!.queueTotal).toBe(0);
			expect(room.musicState!.history.events).toHaveLength(playing ? 1 : 0);
			const calls = video.mock.calls.length;
			await room.update();
			await room.update();
			expect(video).toHaveBeenCalledTimes(calls);
		},
	);

	it("clears cached account and user when a logged-out session omits its username", async () => {
		room.queueMode = QueueMode.Manual;
		room.owner = { id: 2, username: "owner" } as User;
		const owner = new RoomUser("owner", "owner");
		await owner.updateInfo({ id: owner.id, user_id: 2 });
		room.realusers.push(owner);
		vi.mocked(tokens.getSessionInfo).mockImplementation(async token =>
			token === "owner"
				? { isLoggedIn: true, user_id: 2 }
				: ({ isLoggedIn: false } as SessionInfo),
		);
		await room.processUnauthorizedRequest(
			{
				type: RoomRequestType.ApplySettingsRequest,
				settings: { queueMode: QueueMode.Music },
			},
			{ clientId: owner.id, token: owner.token },
		);
		const guest = room.getUser("tab1")!;
		expect(guest.user_id).toBeUndefined();
		expect(guest.user).toBeNull();
		expect(guest.username).toBe("");
		expect(room.music!.participants.map(p => p.participantId)).not.toContain("account:1");
		expect(owner.user_id).toBe(2);
		expect(owner.user!.id).toBe(2);
	});
	it.each(["account", "session"])(
		"does not restore owner authority when an old %s lookup finishes after logout",
		async stage => {
			room.owner = { id: 1, username: "owner" } as User;
			for (const role of [Role.UnregisteredUser, Role.RegisteredUser]) {
				room.grants.setRoleGrants(role, 0);
			}
			const held = gate();
			if (stage === "account") {
				vi.mocked(usermanager.getUser).mockImplementationOnce(async () => {
					held.enter();
					await held.waiting;
					return { id: 1, username: "old-owner" } as User;
				});
			} else {
				vi.mocked(tokens.getSessionInfo).mockImplementationOnce(async () => {
					held.enter();
					await held.waiting;
					return { isLoggedIn: true, user_id: 1 };
				});
			}
			const delayed = room.updateUser(
				{
					type: RoomRequestType.UpdateUser,
					info: { id: "tab1", status: PlayerStatus.ready },
				},
				context,
			);
			await held.entered;
			vi.mocked(tokens.getSessionInfo).mockResolvedValue({
				isLoggedIn: false,
				username: "guest",
			});
			await room.updateUser(
				{
					type: RoomRequestType.UpdateUser,
					info: { id: "tab1", status: PlayerStatus.buffering },
				},
				context,
			);
			held.release();
			await delayed;
			const user = room.getUser("tab1")!;
			expect(user.user_id).toBeUndefined();
			expect(user.user).toBeNull();
			expect(user.playerStatus).toBe(PlayerStatus.buffering);
			expect(room.getRole(user)).toBe(Role.UnregisteredUser);
			const before = await store.load(room.name);
			await expect(
				room.processUnauthorizedRequest(
					{
						type: RoomRequestType.MusicRoomRequest,
						command: {
							action: "settings",
							correlationId: "logout-race",
							expectedRevision: room.music!.revision,
							settings: { fairShare: !room.music!.settings.fairShare },
						},
					},
					{ clientId: "tab1", token: "member" },
				),
			).rejects.toThrow();
			expect(await store.load(room.name)).toEqual(before);
		},
	);
	it("keeps a newer account and status when an older account lookup completes", async () => {
		const user = room.getUser("tab1")!;
		const held = gate();
		vi.mocked(usermanager.getUser).mockImplementationOnce(async () => {
			held.enter();
			await held.waiting;
			return { id: 1, username: "old" } as User;
		});
		const old = user.updateInfo({ id: user.id, user_id: 1, status: PlayerStatus.ready });
		await held.entered;
		await user.updateSession({ isLoggedIn: true, user_id: 2 }, PlayerStatus.buffering);
		held.release();
		await old;
		expect(user.user_id).toBe(2);
		expect(user.user!.id).toBe(2);
		expect(user.playerStatus).toBe(PlayerStatus.buffering);
	});
	it("checks Music grants against the session even if the cached user object is inconsistent", async () => {
		room.owner = { id: 1, username: "owner" } as User;
		for (const role of [Role.UnregisteredUser, Role.RegisteredUser]) {
			room.grants.setRoleGrants(role, 0);
		}
		const user = room.getUser("tab1")!;
		user.user_id = undefined;
		vi.mocked(tokens.getSessionInfo).mockResolvedValue({
			isLoggedIn: false,
			username: "guest",
		});
		const before = await store.load(room.name);
		await expect(
			room.processRequest(
				{
					type: RoomRequestType.MusicRoomRequest,
					command: {
						action: "settings",
						correlationId: "stale-cache",
						expectedRevision: room.music!.revision,
						settings: { fairShare: false },
					},
				},
				{ ...context, role: Role.Owner },
			),
		).rejects.toThrow();
		expect(await store.load(room.name)).toEqual(before);
	});
	const addVoters = async () => {
		for (const id of ["tab2", "tab3"]) {
			const user = new RoomUser(id, id);
			await user.updateInfo({ id, user_id: 2 });
			room.realusers.push(user);
		}
		vi.mocked(tokens.getSessionInfo).mockImplementation(async token => ({
			isLoggedIn: true,
			user_id: token === "member" ? 1 : 2,
		}));
		room.enableVoteSkip = true;
	};
	const vote = (id: string, token = id) =>
		room.processUnauthorizedRequest(
			{ type: RoomRequestType.SkipRequest },
			{ clientId: id, token },
		);

	it("preserves a valid skip vote through status and display-name refreshes", async () => {
		await room.dequeueNext();
		await room.play();
		await addVoters();
		const playbackId = room.music!.current!.playbackId;
		await vote("tab1", "member");
		vi.mocked(usermanager.getUser).mockImplementation(
			async ({ id }) => ({ id, username: "renamed" }) as User,
		);
		for (const status of [PlayerStatus.ready, PlayerStatus.buffering]) {
			await room.processUnauthorizedRequest(
				{ type: RoomRequestType.UpdateUser, info: { id: "tab1", status } },
				{ clientId: "tab1", token: "member" },
			);
			expect(room.votesToSkip.has("tab1")).toBe(true);
		}
		await vote("tab2");
		expect(room.music!.current!.playbackId).not.toBe(playbackId);
	});
	it.each(["logout", "expired"])(
		"rejects every %s vote before insertion or quorum evaluation",
		async change => {
			await room.dequeueNext();
			await room.play();
			await addVoters();
			const playbackId = room.music!.current!.playbackId;
			vi.mocked(tokens.getSessionInfo).mockImplementation(async token => {
				if (token === "member") {
					if (change === "expired") {
						throw new Error("expired");
					}
					return { isLoggedIn: false, username: "guest" };
				}
				return { isLoggedIn: true, user_id: 2 };
			});
			await expect(vote("tab1", "member")).rejects.toThrow();
			expect(room.votesToSkip.has("tab1")).toBe(false);
			await vote("tab2");
			expect(room.music!.current!.playbackId).toBe(playbackId);
			expect([...room.votesToSkip]).toEqual(["tab2"]);
		},
	);

	it.each(["logout", "expired", "rejoin", "role", "grants", "source"])(
		"prunes an earlier authenticated vote after %s changes",
		async change => {
			await room.dequeueNext();
			await room.play();
			await addVoters();
			if (change === "role") {
				room.userRoles.get(Role.Moderator)!.add(1);
			}
			await vote("tab1", "member");
			expect(room.votesToSkip.has("tab1")).toBe(true);
			if (change === "logout" || change === "expired") {
				vi.mocked(tokens.getSessionInfo).mockImplementation(async token => {
					if (token === "member") {
						if (change === "expired") {
							throw new Error("expired");
						}
						return { isLoggedIn: false, username: "guest" };
					}
					return { isLoggedIn: true, user_id: 2 };
				});
			} else if (change === "rejoin") {
				const user = new RoomUser("tab1", "member");
				await user.updateInfo({ id: user.id, user_id: 1 });
				room.realusers[0] = user;
			} else if (change === "role") {
				room.userRoles.get(Role.Moderator)!.clear();
			} else if (change === "grants") {
				room.grants.setRoleGrants(Role.UnregisteredUser, 0);
				room.grants.setRoleGrants(
					Role.RegisteredUser,
					permissions.parseIntoGrantMask(["playback.skip"]),
				);
			} else {
				await room.dequeueNext();
			}
			const playbackId = room.music!.current!.playbackId;
			await vote("tab2");
			expect(room.votesToSkip.has("tab1")).toBe(false);
			expect(room.music!.current!.playbackId).toBe(playbackId);
		},
	);

	it("allows authenticated guests to vote using inherited skip grants", async () => {
		await room.dequeueNext();
		await room.play();
		room.enableVoteSkip = true;
		for (const id of ["guest1", "guest2"]) {
			const user = new RoomUser(id, id);
			await user.updateSession({ isLoggedIn: false, username: id });
			room.realusers.push(user);
		}
		vi.mocked(tokens.getSessionInfo).mockImplementation(async token =>
			token === "member"
				? { isLoggedIn: true, user_id: 1 }
				: { isLoggedIn: false, username: token },
		);
		const playbackId = room.music!.current!.playbackId;
		await vote("guest1");
		expect(room.music!.current!.playbackId).toBe(playbackId);
		await vote("guest2");
		expect(room.music!.current!.playbackId).not.toBe(playbackId);
		expect(room.musicState!.history.events).toHaveLength(2);
	});

	it("does not transfer a delayed vote to a new occurrence", async () => {
		await room.dequeueNext();
		await room.play();
		await addVoters();
		const hold = gate();
		vi.mocked(tokens.getSessionInfo).mockImplementationOnce(async () => {
			hold.enter();
			await hold.waiting;
			return { isLoggedIn: true, user_id: 1 };
		});
		const pending = captureError(() => vote("tab1", "member"));
		try {
			await hold.entered;
			await room.dequeueNext();
		} finally {
			hold.release();
		}
		const playbackId = room.music!.current!.playbackId;
		expect(await pending).toBeInstanceOf(Error);
		expect(room.votesToSkip.size).toBe(0);
		expect(room.music!.current!.playbackId).toBe(playbackId);
	});
	it("rechecks captured membership after asynchronous quorum validation", async () => {
		await room.dequeueNext();
		await room.play();
		await addVoters();
		await vote("tab1", "member");
		const playbackId = room.music!.current!.playbackId,
			hold = gate();
		let blocked = false;
		vi.mocked(tokens.getSessionInfo).mockImplementation(async token => {
			if (token === "tab3" && !blocked) {
				blocked = true;
				hold.enter();
				await hold.waiting;
			}
			return { isLoggedIn: true, user_id: token === "member" ? 1 : 2 };
		});
		const pending = vote("tab2");
		try {
			await hold.entered;
			const user = new RoomUser("tab1", "member");
			await user.updateInfo({ id: user.id, user_id: 1 });
			room.realusers[0] = user;
		} finally {
			hold.release();
		}
		await pending;
		expect([...room.votesToSkip]).toEqual(["tab2"]);
		expect(room.music!.current!.playbackId).toBe(playbackId);
	});

	it("checks authority again after a PostgreSQL CAS wait (adapter test, no live database)", async () => {
		const saved = (await store.load(room.name))!;
		const draft = { ...saved, state: { ...saved.state, revision: saved.state.revision + 1 } };
		const connection = new Sequelize({ dialect: "postgres", logging: false });
		const models = musicRoomModels(connection),
			hold = gate();
		vi.spyOn(connection, "query").mockResolvedValue([] as never);
		vi.spyOn(connection, "transaction").mockImplementation((async (...args: unknown[]) => {
			const operation = args.at(-1) as (transaction: Transaction) => Promise<unknown>;
			return operation({} as Transaction);
		}) as typeof connection.transaction);
		vi.spyOn(models.State, "update").mockImplementationOnce(async () => {
			hold.enter();
			await hold.waiting;
			return [1];
		});
		vi.spyOn(models.Score, "upsert").mockResolvedValue([{} as never, true]);
		let allowed = true;
		const authorize = vi.fn(() => {
			if (!allowed) {
				throw new Error("revoked");
			}
		});
		const finalize = vi.fn(() => draft);
		const pending = new SqlMusicRoomStore(() => connection).save(draft, saved.state.revision, {
			authorize,
			finalize,
		});
		try {
			await hold.entered;
			allowed = false;
		} finally {
			hold.release();
		}
		await expect(pending).rejects.toThrow("revoked");
		expect(authorize).toHaveBeenCalledTimes(2);
		expect(finalize).not.toHaveBeenCalled();
		expect(vi.mocked(connection.query).mock.calls.map(args => args[0])).toEqual([
			"SET LOCAL lock_timeout = '5s'",
			"SET LOCAL statement_timeout = '10s'",
		]);
		await connection.close();
	});

	it("validates the finalized snapshot and rolls back invalid history", async () => {
		const before = (await store.load(room.name))!;
		const draft = {
			...before,
			state: { ...before.state, revision: before.state.revision + 1 },
		};
		const invalid = structuredClone(draft);
		invalid.state.history.scores[0].plays = -1;
		await expect(
			store.save(draft, before.state.revision, { finalize: () => invalid }),
		).rejects.toThrow();
		expect(await store.load(room.name)).toEqual(before);
	});
	it("rejects finalizers that would orphan already staged normalized history", async () => {
		const initial = (await store.load(room.name))!;
		await room.dequeueNext();
		await room.play();
		const before = (await store.load(room.name))!;
		const draft = {
			...before,
			state: { ...before.state, revision: before.state.revision + 1 },
		};
		const reset = { ...initial, state: { ...initial.state, revision: draft.state.revision } };
		await expect(
			store.save(draft, before.state.revision, { finalize: () => reset }),
		).rejects.toThrow("history keys");
		expect(await store.load(room.name)).toEqual(before);
	});
});
