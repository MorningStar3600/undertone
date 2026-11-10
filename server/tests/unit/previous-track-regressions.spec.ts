/* eslint-disable vitest/no-conditional-in-test -- Parameterized protocol and revocation interleavings. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Room, RoomUser } from "../../room.js";
import tokens from "../../auth/tokens.js";
import usermanager from "../../usermanager.js";
import { QueueMode, Role } from "ott-common/models/types.js";
import { RoomRequestType } from "ott-common/models/messages.js";
import permissions from "ott-common/permissions.js";
import { SqlMusicRoomStore } from "../../music/room-music-storage.js";
import { createCatalogueFixture } from "./music-test-helpers.js";
import { restoreMusicScheduler } from "../../music/music-scheduler.js";
import { DEFAULT_MOODS } from "ott-common/models/music.js";
import type { User } from "../../models/user.js";
import { randomUUID } from "node:crypto";
import { notifyCatalogueChanges, subscribeCatalogueChanges } from "../../music/catalogue.js";
vi.mock("../../roommanager.js", () => ({ default: { publish: vi.fn() } }));
vi.mock("../../websockets.js", () => ({ wss: {} }));
vi.mock("../../balancer.js", () => ({ balancerManager: {}, buildGossipMessage: vi.fn() }));
const auth = { token: "session", clientId: "tab" };
const track = (id: string) => ({ service: "youtube" as const, id, length: 180 });
const prepare = (room: Room) => {
	room.throttledSync.cancel();
	room.throttledSync = vi.fn() as unknown as typeof room.throttledSync;
	const user = new RoomUser("tab", "session");
	user.user_id = 1;
	room.realusers.push(user);
	room.grants.setRoleGrants(Role.UnregisteredUser, 0);
	room.grants.setRoleGrants(Role.RegisteredUser, permissions.parseIntoGrantMask(["*"]));
	vi.spyOn(room, "publish").mockResolvedValue(undefined);
	return room;
};
const command = (room: Room, requestId: string, kind = "previous") => {
	const s = room.playbackSnapshot("probe").timeline;
	return {
		command: kind,
		requestId,
		epoch: s.epoch,
		occurrenceId: s.baseline.state?.occurrenceId ?? 0,
		...(kind === "previous" ? { sequence: s.baseline.sequence } : {}),
	};
};
const previous = (room: Room, id = "previous") =>
	room.executePlaybackCommand(command(room, id), auth);
async function fixture(twoPeople = false) {
	const f = await createCatalogueFixture();
	for (const id of ["a", "b", "c"]) {
		await f.catalogue.addLibraryTrack(1, { reference: { service: "youtube", id } });
	}
	const store = new SqlMusicRoomStore(() => f.connection);
	const room = prepare(
		new Room({ name: "probe", queueMode: QueueMode.Music }, { catalogue: f.catalogue, store }),
	);
	if (twoPeople) {
		const second = new RoomUser("other", "second");
		second.user_id = 2;
		room.realusers.push(second);
	}
	await room.musicEngine.refresh(true);
	await room.dequeueNext();
	await room.play();
	return { ...f, store, room };
}
describe("previous track regression boundaries", () => {
	beforeEach(() => {
		vi.spyOn(tokens, "getSessionInfo").mockImplementation(async token => ({
			isLoggedIn: true,
			user_id: token === "second" ? 2 : 1,
		}));
		vi.spyOn(usermanager, "getUser").mockImplementation(
			async ({ id }) => ({ id, username: String(id) }) as User,
		);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("fences relevant catalogue notifications before asynchronous subscribers and releases watches", async () => {
		const f = await fixture();
		const trackId = f.room.music!.current!.trackId;
		const watch = f.catalogue.watchEligibility([1], [trackId]);
		const unrelated = f.catalogue.watchEligibility([2], [randomUUID()]);
		let release!: () => void;
		const waiting = new Promise<void>(resolve => {
			release = resolve;
		});
		const stop = subscribeCatalogueChanges(async () => {
			await waiting;
		});
		try {
			const pending = notifyCatalogueChanges([
				{ kind: "metadata", userId: 1, trackId, action: "updated" },
			]);
			expect(watch.isCurrent()).toBe(false);
			expect(unrelated.isCurrent()).toBe(true);
			release();
			await pending;
			const disposed = f.catalogue.watchEligibility([1], [trackId]);
			disposed.release();
			await notifyCatalogueChanges([
				{ kind: "metadata", userId: 1, trackId, action: "updated" },
			]);
			expect(disposed.isCurrent()).toBe(true);
		} finally {
			release();
			stop();
			watch.release();
			unrelated.release();
			await f.connection.close();
		}
	});

	it("drops more than five unusable future entries including an unstarted occurrence without charging them", async () => {
		const f = await fixture();
		try {
			const { room, catalogue, models, store } = f;
			for (let i = 0; i < 6; i++) {
				await catalogue.addLibraryTrack(1, {
					reference: { service: "youtube", id: `extra-${i}` },
				});
			}
			await room.musicEngine.refresh(true);
			for (let i = 0; i < 6; i++) {
				await room.dequeueNext();
			}
			await room.pause();
			await room.dequeueNext();
			for (let i = 0; i < 7; i++) {
				expect((await previous(room, `back-${i}`)).status).toBe("applied");
			}
			const future = room.musicState!.navigation!.future;
			expect(future).toHaveLength(7);
			expect(future[6].started).toBe(false);
			const history = room.musicState!.history;
			await catalogue.addLibraryTrack(1, {
				reference: { service: "youtube", id: "survivor" },
			});
			await models.TrackSource.update(
				{ availability: "unavailable" },
				{ where: { id: future.map(item => item.entry.sourceId) } },
			);
			expect(
				(await room.executePlaybackCommand(command(room, "forward", "next"), auth)).status,
			).toBe("applied");
			expect(future.map(item => item.playbackId)).not.toContain(
				room.music!.current!.playbackId,
			);
			expect(room.music!.current!.started).toBe(false);
			expect(room.isPlaying).toBe(false);
			expect(room.musicState!.navigation!.future).toEqual([]);
			expect(room.musicState!.history).toEqual(history);
			expect((await store.load(room.name))!.state).toEqual(room.musicState);
			await room.play();
			expect(room.musicState!.history.events).toHaveLength(history.events.length + 1);
		} finally {
			await f.connection.close();
		}
	});

	it.each(["membership", "catalogue", "permission", "session", "connection"])(
		"rechecks %s invalidation between eligibility validation and finalization",
		async kind => {
			const f = await fixture(true);
			try {
				const { room, store } = f;
				const target = room.music!.current!;
				await room.dequeueNext();
				const before = room.musicState!;
				const save = store.save.bind(store);
				let invalidated = false,
					attempts = 0;
				vi.spyOn(store, "save").mockImplementation(async (value, revision, hooks) =>
					save(value, revision, {
						...hooks,
						validate: hooks?.validate
							? async transaction => {
									attempts++;
									await hooks.validate!(transaction);
									if (!invalidated) {
										invalidated = true;
										if (kind === "membership") {
											room.realusers.splice(0, 1);
										} else if (kind === "permission") {
											room.grants.setRoleGrants(Role.RegisteredUser, 0);
										} else if (kind === "session") {
											vi.mocked(tokens.getSessionInfo).mockResolvedValue({
												isLoggedIn: false,
												username: "guest",
											});
										} else if (kind === "catalogue") {
											await notifyCatalogueChanges([
												{
													kind: "metadata",
													userId: 1,
													trackId: target.trackId,
													action: "updated",
												},
											]);
										}
									}
								}
							: undefined,
					}),
				);
				const result = await room.executePlaybackCommand(command(room, "late"), {
					token: "second",
					clientId: "other",
					assertCurrent: () => {
						if (kind === "connection" && invalidated) {
							throw Error("reauth");
						}
					},
				});
				if (kind !== "catalogue") {
					expect(result.status).toBe("rejected");
					expect(room.music!.current!.playbackId).toBe(before.current!.playbackId);
					expect(room.musicState!.navigation).toEqual(before.navigation);
				} else {
					expect(result.status).toBe("applied");
					expect(attempts).toBe(2);
					expect(room.music!.current!.playbackId).toBe(target.playbackId);
				}
				expect(room.musicState!.history.scores).toEqual(before.history.scores);
				expect(room.musicState!.history.events).toHaveLength(before.history.events.length);
				expect((await store.load(room.name))!.state).toEqual(room.musicState);
			} finally {
				await f.connection.close();
			}
		},
	);

	it("rechecks source authorization on a whole SQLite transaction retry", async () => {
		const f = await fixture();
		try {
			const { room, catalogue, store } = f;
			await room.dequeueNext();
			const before = room.musicState!;
			const save = store.save.bind(store);
			let attempts = 0;
			vi.spyOn(store, "save").mockImplementation(async (value, revision, hooks) =>
				save(value, revision, {
					...hooks,
					validate: hooks?.validate
						? async transaction => {
								attempts++;
								await hooks.validate!(transaction);
								if (attempts === 1) {
									vi.spyOn(catalogue, "localSourceAllowed").mockResolvedValue(
										false,
									);
									throw Object.assign(new Error("busy"), {
										original: { code: "SQLITE_BUSY" },
									});
								}
							}
						: undefined,
				}),
			);
			expect((await previous(room, "retry")).status).toBe("rejected");
			expect(attempts).toBe(2);
			expect(room.music!.current!.playbackId).toBe(before.current!.playbackId);
			expect(room.musicState!.navigation).toEqual(before.navigation);
			expect(room.musicState!.history).toEqual(before.history);
			expect((await store.load(room.name))!.state).toEqual(room.musicState);
		} finally {
			await f.connection.close();
		}
	});
	it.each([QueueMode.Manual, QueueMode.Vote, QueueMode.Loop, QueueMode.Dj])(
		"legacy %s synchronizes availability, trims, paused state and fresh transport occurrence",
		async queueMode => {
			const room = prepare(
				new Room({
					name: "legacy",
					queueMode,
					currentSource: { ...track("a"), startAt: 12, endAt: 160 },
					isPlaying: false,
				}),
			);
			await room.queue.set([track("b")]);
			await room.dequeueNext();
			const occurrence =
				room.playbackSnapshot("before").timeline.baseline.state!.occurrenceId;
			expect((await previous(room)).status).toBe("applied");
			expect(room.currentSource).toMatchObject({ id: "a", startAt: 12, endAt: 160 });
			expect(room.playbackPosition).toBe(12);
			expect(room.isPlaying).toBe(false);
			expect(room.playbackSpeed).toBe(1);
			expect(
				room.playbackSnapshot("after").timeline.baseline.state!.occurrenceId,
			).toBeGreaterThan(occurrence);
			expect(room.syncableState()).toMatchObject({ previousAvailable: false });
			expect(room.syncableState()).not.toHaveProperty("previousTracks");
			await room.sync();
			expect(
				vi
					.mocked(room.publish)
					.mock.calls.some(
						([message]) =>
							message.action === "sync" && message.previousAvailable === false,
					),
			).toBe(true);
		},
	);

	it("finite manual Music queue exhausts and Previous restores paused at startAt without extra debit", async () => {
		const f = await createCatalogueFixture();
		try {
			const store = new SqlMusicRoomStore(() => f.connection);
			const room = prepare(
				new Room(
					{ name: "manual-finite", queueMode: QueueMode.Music },
					{ catalogue: f.catalogue, store },
				),
			);
			await room.musicEngine.refresh(true);
			for (const id of ["a", "b"]) {
				await room.musicEngine.execute(
					{
						action: "request",
						correlationId: id,
						expectedRevision: room.music!.revision,
						requestId: id,
						reference: { service: "youtube", id },
						intent: "mix",
						extras: { startAt: 13, endAt: 80 },
					},
					"account:1",
				);
			}
			await room.dequeueNext();
			await room.play();
			await room.dequeueNext();
			const last = room.music!.current!;
			const scores = room.musicState!.history.scores;
			await room.dequeueNext();
			expect(room.currentSource).toBeNull();
			expect(room.isPlaying).toBe(false);
			expect((await previous(room, "empty")).status).toBe("applied");
			expect(room.music!.current!.playbackId).toBe(last.playbackId);
			expect(room.isPlaying).toBe(false);
			expect(room.playbackPosition).toBe(13);
			expect(room.musicState!.history.scores).toEqual(scores);
			expect(room.musicState!.history.events).toHaveLength(2);
			expect((await store.load(room.name))!.state).toEqual(room.musicState);
		} finally {
			await f.connection.close();
		}
	});

	it("unstarted future survives renew, SQL reload and repeated navigation, and is charged exactly once", async () => {
		const f = await fixture();
		try {
			const { room, store } = f;
			await room.pause();
			await room.dequeueNext();
			const unstarted = room.music!.current!,
				before = room.musicState!.history;
			await previous(room, "back");
			await room.musicEngine.execute(
				{
					action: "replan",
					correlationId: "renew",
					expectedRevision: room.music!.revision,
					content: "renew",
				},
				"account:1",
			);
			expect(room.music!.queue[0].entryId).toBe(unstarted.entryId);
			expect((await store.load(room.name))!.state.navigation!.future[0].started).toBe(false);
			await room.dequeueNext();
			expect(room.music!.current!.started).toBe(false);
			expect(room.musicState!.history).toEqual(before);
			await previous(room, "back-again");
			await room.play();
			await room.dequeueNext();
			expect(room.music!.current!.playbackId).toBe(unstarted.playbackId);
			expect(room.music!.current!.started).toBe(true);
			expect(room.musicState!.history.events).toHaveLength(before.events.length + 1);
			const scores = room.musicState!.history.scores;
			await previous(room, "back-final");
			await room.dequeueNext();
			expect(room.musicState!.history.scores).toEqual(scores);
			expect((await store.load(room.name))!.state).toEqual(room.musicState);
		} finally {
			await f.connection.close();
		}
	});

	it("SQL finalizer failure leaves navigation, normalized history, playback and publication unchanged", async () => {
		const f = await fixture();
		try {
			const { room, store } = f;
			await room.dequeueNext();
			const before = (await store.load(room.name))!,
				timeline = room.playbackSnapshot("before").timeline;
			const save = store.save.bind(store);
			const published = vi.mocked(room.publish).mock.calls.length;
			vi.spyOn(store, "save").mockImplementation(async (value, revision, hooks) =>
				save(value, revision, {
					...hooks,
					finalize: () => {
						hooks?.finalize?.();
						throw Error("probe rollback");
					},
				}),
			);
			expect((await previous(room, "finalize-fail")).code).toBe("failed");
			expect(await store.load(room.name)).toEqual(before);
			expect(room.musicState).toEqual(before.state);
			expect(room.playbackSnapshot("after").timeline).toEqual(timeline);
			expect(vi.mocked(room.publish).mock.calls).toHaveLength(published);
		} finally {
			await f.connection.close();
		}
	});

	it.each(["unavailable", "excluded"])(
		"drops ineligible future %s and resumes scheduled advancement",
		async kind => {
			const f = await fixture();
			try {
				const { room, catalogue, models } = f;
				await room.dequeueNext();
				const future = room.music!.current!;
				await previous(room);
				const current = room.music!.current!;
				if (kind === "unavailable") {
					await models.TrackSource.update(
						{ availability: "unavailable" },
						{ where: { id: future.sourceId } },
					);
				} else {
					await catalogue.setTrackMood(1, future.trackId, DEFAULT_MOODS[0].id, true);
					await room.musicEngine.execute(
						{
							action: "preferences",
							correlationId: "exclude",
							content: "keep",
							expectedRevision: room.music!.revision,
							includeMoodIds: [],
							excludeMoodIds: [DEFAULT_MOODS[0].id],
						},
						"account:1",
					);
				}
				expect(room.music!.queueTotal).toBeGreaterThan(1);
				const before = room.musicState!.history;
				await room.dequeueNext();
				expect(room.music!.current!.playbackId).not.toBe(current.playbackId);
				expect(room.music!.current!.playbackId).not.toBe(future.playbackId);
				expect(room.musicState!.navigation!.future).toEqual([]);
				expect(
					room.musicState!.history.events.filter(e => e.playbackId === future.playbackId),
				).toEqual(before.events.filter(e => e.playbackId === future.playbackId));
				expect(room.musicState!.history.events).toHaveLength(before.events.length + 1);
				expect(
					(await room.executePlaybackCommand(command(room, "next", "next"), auth)).status,
				).toBe("applied");
				expect((await f.store.load(room.name))!.state).toEqual(room.musicState);
			} finally {
				await f.connection.close();
			}
		},
	);

	it("refuses replay when the contributor leaves during navigation commit", async () => {
		const f = await fixture(true);
		try {
			const { room, store } = f;
			const target = room.music!.current!;
			await room.dequeueNext();
			const save = store.save.bind(store);
			let leave: Promise<void> | undefined,
				once = true;
			vi.spyOn(store, "save").mockImplementation(async (value, revision, hooks) => {
				if (once && value.state.navigation?.future.length) {
					once = false;
					leave = room.processUnauthorizedRequest(
						{ type: RoomRequestType.LeaveRequest },
						auth,
					);
					await vi.waitFor(() =>
						expect(room.realusers.some(u => u.user_id === 1)).toBe(false),
					);
				}
				await save(value, revision, hooks);
			});
			const result = await room.executePlaybackCommand(command(room, "departed"), {
				token: "second",
				clientId: "other",
			});
			await leave;
			expect(result.status).toBe("rejected");
			expect(room.realusers.some(u => u.user_id === 1)).toBe(false);
			expect(room.musicState!.settings.removeDepartedEntries).toBe(true);
			expect(room.music!.current!.playbackId).not.toBe(target.playbackId);
		} finally {
			await f.connection.close();
		}
	});

	it.each(["permission", "membership", "session", "mode", "vote-policy", "connection"])(
		"rolls back Previous when %s changes after staged SQL",
		async kind => {
			const f = await fixture();
			try {
				const { room, store } = f;
				await room.dequeueNext();
				const before = (await store.load(room.name))!,
					timeline = room.playbackSnapshot("before").timeline;
				const save = store.save.bind(store);
				let revoked = false;
				vi.spyOn(store, "save").mockImplementation(async (value, revision, hooks) => {
					let checks = 0;
					await save(value, revision, {
						...hooks,
						authorize: async () => {
							if (value.state.navigation?.future.length && ++checks === 2) {
								revoked = true;
								if (kind === "permission") {
									room.grants.setRoleGrants(Role.RegisteredUser, 0);
								}
								if (kind === "membership") {
									room.realusers.splice(0);
								}
								if (kind === "session") {
									vi.mocked(tokens.getSessionInfo).mockResolvedValue({
										isLoggedIn: false,
										username: "other",
									});
								}
								if (kind === "mode") {
									room.queueMode = QueueMode.Manual;
								}
								if (kind === "vote-policy") {
									room.enableVoteSkip = true;
								}
							}
							await hooks?.authorize?.();
						},
					});
				});
				const result = await room.executePlaybackCommand(command(room, "rollback"), {
					...auth,
					assertCurrent: () => {
						if (kind === "connection" && revoked) {
							throw Error("reauth");
						}
					},
				});
				expect(result.status).toBe("rejected");
				expect(await store.load(room.name)).toEqual(before);
				expect(room.musicEngine.state).toEqual(before.state);
				expect(room.playbackSnapshot("after").timeline).toEqual(timeline);
			} finally {
				await f.connection.close();
			}
		},
	);

	it("rolls back replay when its source is revoked just before SQL commit", async () => {
		const f = await fixture();
		try {
			const { room, store, models } = f;
			const target = room.music!.current!;
			await room.dequeueNext();
			const save = store.save.bind(store);
			vi.spyOn(store, "save").mockImplementation(async (value, rev, hooks) => {
				if (value.state.navigation?.future.length) {
					await models.TrackSource.update(
						{ availability: "unavailable" },
						{ where: { id: target.sourceId } },
					);
				}
				await save(value, rev, hooks);
			});
			const before = room.musicState!;
			expect((await previous(room)).status).toBe("rejected");
			expect(room.music!.current!.playbackId).toBe(before.current!.playbackId);
			expect(room.musicState!.history).toEqual(before.history);
			expect(room.musicState!.navigation).toEqual(before.navigation);
			expect((await models.TrackSource.findByPk(target.sourceId))!.get("availability")).toBe(
				"unavailable",
			);
		} finally {
			await f.connection.close();
		}
	});

	it("source fallback keeps immutable history identity, survives SQL reload and navigates both ways", async () => {
		const f = await fixture();
		try {
			const { room, models, store } = f;
			const target = room.music!.current!;
			await room.dequeueNext();
			const source = (await models.TrackSource.findByPk(target.sourceId))!.get({
				plain: true,
			});
			const fallbackId = randomUUID();
			await models.TrackSource.create({ ...source, id: fallbackId, providerId: "fallback" });
			await models.TrackSource.update(
				{ availability: "unavailable" },
				{ where: { id: source.id } },
			);
			const history = room.musicState!.history;
			expect((await previous(room)).status).toBe("applied");
			expect(room.music!.current!.sourceId).toBe(fallbackId);
			expect(room.musicState!.history.events[0]).toEqual(history.events[0]);
			expect((await store.load(room.name))!.state).toEqual(room.musicState);
			await room.dequeueNext();
			expect((await previous(room, "fallback-again")).status).toBe("applied");
			expect((await store.load(room.name))!.state).toEqual(room.musicState);
		} finally {
			await f.connection.close();
		}
	});

	it("old snapshots derive navigation and reject altered historical identity", async () => {
		const f = await fixture();
		try {
			const { room } = f;
			await room.dequeueNext();
			await room.dequeueNext();
			const state = room.musicState!;
			delete state.navigation;
			restoreMusicScheduler(state);
			const saved = {
				...state,
				navigation: {
					past: [{ ...state.current!, playbackId: state.history.events[0].playbackId }],
					future: [],
				},
			};
			expect(() => restoreMusicScheduler(saved)).toThrow();
		} finally {
			await f.connection.close();
		}
	});

	it("SQL snapshots predating navigation derive the usable back cursor without resetting history", async () => {
		const f = await fixture();
		try {
			const { room, store, catalogue } = f;
			await room.dequeueNext();
			await room.dequeueNext();
			const saved = (await store.load(room.name))!;
			const revision = saved.state.revision;
			delete saved.state.navigation;
			saved.state.revision++;
			await store.save(saved, revision);
			const restart = prepare(
				new Room({ name: room.name, queueMode: QueueMode.Music }, { catalogue, store }),
			);
			await restart.initializeMusic();
			expect((await previous(restart, "upgrade")).status).toBe("applied");
			expect(restart.music!.current!.playbackId).toBe(
				saved.state.history.events.at(-2)!.playbackId,
			);
			expect(restart.musicState!.history.scores).toEqual(saved.state.history.scores);
			expect(restart.musicState!.history.events).toHaveLength(
				saved.state.history.events.length,
			);
			expect((await store.load(room.name))!.state).toEqual(restart.musicState);
		} finally {
			await f.connection.close();
		}
	});

	it("manual replay reuses only original server confirmations and rejects newly excluded moods", async () => {
		const f = await createCatalogueFixture();
		try {
			const store = new SqlMusicRoomStore(() => f.connection);
			const room = prepare(
				new Room(
					{ name: "manual-confirm", queueMode: QueueMode.Music },
					{ catalogue: f.catalogue, store },
				),
			);
			const send = (action: any) =>
				room.musicEngine.execute(
					{
						...action,
						correlationId: randomUUID(),
						expectedRevision: room.music!.revision,
					},
					"account:1",
				);
			await room.musicEngine.refresh(true);
			const { track: a } = await f.catalogue.resolveTrack({
				service: "youtube",
				id: "manual-a",
			});
			const [first, second] = DEFAULT_MOODS;
			await f.catalogue.setTrackMood(1, a.id, first.id, true);
			await send({
				action: "preferences",
				includeMoodIds: [],
				excludeMoodIds: [first.id],
				content: "keep",
			});
			const request = await send({
				action: "request",
				requestId: "a",
				reference: { service: "youtube", id: "manual-a" },
				intent: "mix",
			});
			expect(request.status).toBe("confirmation-required");
			await send({
				action: "confirm",
				requestId: "a",
				trackId: a.id,
				conflicts: [{ participantId: "account:1", moodId: first.id }],
			});
			await send({
				action: "request",
				requestId: "b",
				reference: { service: "youtube", id: "manual-b" },
				intent: "mix",
			});
			await room.dequeueNext();
			await room.play();
			await room.dequeueNext();
			expect((await previous(room, "confirmed")).status).toBe("applied");
			await room.dequeueNext();
			await f.catalogue.setTrackMood(1, a.id, second.id, true);
			await send({
				action: "preferences",
				includeMoodIds: [],
				excludeMoodIds: [first.id, second.id],
				content: "keep",
			});
			const before = (await store.load(room.name))!;
			expect((await previous(room, "new-conflict")).code).toBe("failed");
			expect((await store.load(room.name))!).toEqual(before);
		} finally {
			await f.connection.close();
		}
	});

	it("rejects a legacy Next queued behind Previous using its captured playbackId", async () => {
		const f = await fixture();
		try {
			const { room } = f;
			await room.dequeueNext();
			await room.dequeueNext();
			await previous(room, "back-one"); // b current, c future, a past
			const b = room.music!.current!.playbackId;
			let release!: () => void;
			const gate = new Promise<void>(resolve => (release = resolve));
			let entered!: () => void;
			const ready = new Promise<void>(resolve => (entered = resolve));
			const prior = room.musicEngine.previous(
				Object.assign(async () => {
					entered();
					await gate;
				}, {}),
			);
			await ready;
			const next = room.musicEngine.advance("skipped", async () => undefined);
			const rejected = expect(next).rejects.toThrow("Music occurrence changed"); // captures b while Previous is waiting
			release();
			await prior;
			const a = room.music!.current!.playbackId;
			expect(a).not.toBe(b);
			await rejected;
			expect(room.music!.current!.playbackId).toBe(a);
		} finally {
			await f.connection.close();
		}
	});

	it.each(["legacy", "modern"])(
		"queued %s Next during provider resolution of Previous",
		async protocol => {
			const f = await fixture();
			try {
				const { room, catalogue } = f;
				await room.dequeueNext();
				await room.dequeueNext();
				await previous(room, "back-one");
				const b = room.music!.current!.playbackId;
				let release!: () => void, entered!: () => void, nextEntered!: () => void;
				const gate = new Promise<void>(resolve => (release = resolve)),
					ready = new Promise<void>(resolve => (entered = resolve)),
					nextReady = new Promise<void>(resolve => (nextEntered = resolve));
				const resolve = catalogue.toQueueItem.bind(catalogue);
				let block = true;
				vi.spyOn(catalogue, "toQueueItem").mockImplementation(async (...args) => {
					if (block) {
						block = false;
						entered();
						await gate;
					}
					return resolve(...args);
				});
				const advance = room.musicEngine.advance.bind(room.musicEngine);
				vi.spyOn(room.musicEngine, "advance").mockImplementation((...args) => {
					const task = advance(...args);
					nextEntered();
					return task;
				});
				const prev = previous(room, "back-two");
				await ready;
				const next =
					protocol === "legacy"
						? room.processUnauthorizedRequest(
								{ type: RoomRequestType.SkipRequest },
								auth,
							)
						: room.executePlaybackCommand(command(room, "queued-next", "next"), auth);
				const outcome =
					protocol === "legacy"
						? expect(next).rejects.toThrow("Music occurrence changed")
						: next;
				await nextReady;
				release();
				expect((await prev).status).toBe("applied");
				const a = room.music!.current!.playbackId;
				expect(a).not.toBe(b);
				const result = await outcome;
				if (protocol === "legacy") {
					expect(room.music!.current!.playbackId).toBe(a);
				} else {
					expect(result).toMatchObject({ code: "stale-occurrence" });
					expect(room.music!.current!.playbackId).toBe(a);
				}
			} finally {
				await f.connection.close();
			}
		},
	);

	it("new Previous IDs with the same cursor do not consume two history entries; changed payload conflicts", async () => {
		const f = await fixture();
		try {
			const { room } = f;
			await room.dequeueNext();
			await room.dequeueNext();
			const input = command(room, "one");
			const results = await Promise.all([
				room.executePlaybackCommand(input, auth),
				room.executePlaybackCommand({ ...input, requestId: "two" }, auth),
			]);
			expect(results.map(r => r.status).sort()).toEqual(["applied", "rejected"]);
			expect(room.musicState!.navigation!.past).toHaveLength(1);
			expect(
				(
					await room.executePlaybackCommand(
						{ ...input, sequence: input.sequence! + 1 },
						auth,
					)
				).code,
			).toBe("request-conflict");
		} finally {
			await f.connection.close();
		}
	});
});
