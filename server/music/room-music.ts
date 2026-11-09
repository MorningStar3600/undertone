import type { Mood, MusicQueueItem } from "ott-common/models/music.js";
import { createHash, randomUUID } from "node:crypto";
import { Mutex } from "@divine/synchronization";
import type {
	MusicCandidate,
	MusicJson,
	MusicQueueEntry,
	MusicSchedulerState,
	RoomMoodPreference,
} from "ott-common/music/types.js";
import type {
	MusicRoomAction,
	MusicRoomEntry,
	MusicRoomPlayback,
	MusicRoomPublic,
	MusicRoomRequestSummary,
	MusicRoomResult,
} from "ott-common/models/music-room.js";
import type { QueueItemExtras } from "ott-common/models/video.js";
import { musicCatalogue, type MusicCatalogue, MusicReferenceSchema } from "./catalogue.js";
import {
	createMusicScheduler,
	restoreMusicScheduler,
	transitionMusicScheduler,
	type MusicSchedulerCommand,
	type MusicSchedulerTransition,
} from "./music-scheduler.js";
import {
	SqlMusicRoomStore,
	MusicRoomException,
	type MusicRoomStore,
} from "./room-music-storage.js";
import type { DurableMusicRoom } from "../models/music-room.js";

export const musicIdentity = (user: { user_id?: number; token: string }): string =>
	user.user_id
		? `account:${user.user_id}`
		: `guest:${createHash("sha256").update(user.token).digest("hex")}`;
const accountId = (id: string): number | undefined =>
	id.startsWith("account:") ? Number(id.slice(8)) : undefined;
const entryDto = (entry: MusicQueueEntry): MusicRoomEntry => ({
	entryId: entry.entryId,
	trackId: entry.trackId,
	sourceId: entry.sourceId,
	contributorId: entry.contributorId,
	artists: [...entry.artistIds],
	origin: entry.origin,
	requestId: entry.requestId,
	title:
		typeof entry.mediaRef === "object" &&
		entry.mediaRef &&
		!Array.isArray(entry.mediaRef) &&
		typeof entry.mediaRef.title === "string"
			? entry.mediaRef.title
			: undefined,
});
const requestDto = (request: MusicSchedulerState["requests"][number]): MusicRoomRequestSummary => ({
	requestId: request.requestId,
	entryId: request.entryId,
	trackId: request.candidate.trackId,
	intent: request.intent,
	status: request.status,
	conflicts: structuredClone(request.offeredConflicts),
});
const json = (value: unknown): MusicJson => JSON.parse(JSON.stringify(value));
const reduce = (
	state: MusicSchedulerState,
	command: MusicSchedulerCommand,
): MusicSchedulerTransition =>
	transitionMusicScheduler(state, command, { expectedRevision: state.revision });

/** Owns the entire read/transition/SQL commit/publication boundary. Provider calls
 * are outside lock; a revision/head check makes a stale resolution harmless. */
export class RoomMusic {
	private lock = new Mutex();
	private advanceLock = new Mutex();
	isAdvancing = false;
	private value?: DurableMusicRoom;
	private versions = "";
	private currentMoods: Mood[] = [];
	private nextVersionCheck = 0;
	private invalid = true;
	constructor(
		private roomId: string,
		private people: () => string[],
		private publish: (value: DurableMusicRoom, projection: MusicRoomPublic) => Promise<void>,
		private catalogue: MusicCatalogue = musicCatalogue,
		private store: MusicRoomStore = new SqlMusicRoomStore(),
		private redisSnapshot?: MusicSchedulerState,
	) {
		this.roomId = roomId.toLowerCase();
	}
	get state(): MusicSchedulerState | undefined {
		return this.value ? structuredClone(this.value.state) : undefined;
	}
	get publicState(): MusicRoomPublic | null {
		if (!this.value) {
			return null;
		}
		const s = this.value.state;
		return {
			revision: s.revision,
			planRevision: s.planRevision,
			queue: s.queue.slice(0, 10).map(entryDto),
			queueTotal: s.queue.length,
			current: s.current
				? {
						...entryDto(s.current.entry),
						playbackId: s.current.playbackId,
						started: s.current.started,
						contributorMoodIds: this.currentMoods.map(mood => mood.id),
						contributorMoods: structuredClone(this.currentMoods),
					}
				: null,
			participants: structuredClone(s.participants),
			settings: { ...s.settings },
		};
	}
	invalidate(userId: number) {
		if (this.versionAccounts().includes(userId)) {
			this.invalid = true;
		}
	}
	private async initializeLocked() {
		if (this.value) {
			return;
		}
		const saved = await this.store.load(this.roomId);
		if (saved) {
			this.currentMoods = await this.loadCurrentMoods(saved.state);
			this.value = saved;
			await this.publish(saved, this.publicState!);
			return;
		}
		const state = this.redisSnapshot
			? restoreMusicScheduler(this.redisSnapshot)
			: createMusicScheduler(this.roomId, randomUUID());
		if (state.roomId !== this.roomId) {
			throw new MusicRoomException("Music room snapshot identity mismatch");
		}
		const initial = {
			state,
			playback: {
				currentSource: null,
				isPlaying: false,
				playbackPosition: 0,
				playbackSpeed: 1,
				playbackStart: null,
			},
		};
		await this.store.save(initial, null);
		this.value = initial;
		await this.publish(initial, this.publicState!);
	}
	async initialize() {
		await this.lock.protect(() => this.initializeLocked());
	}
	private async loadCurrentMoods(state: MusicSchedulerState): Promise<Mood[]> {
		const current = state.current,
			account = current ? accountId(current.entry.contributorId) : undefined;
		if (!current || account === undefined) {
			return [];
		}
		const snapshot = await this.catalogue.roomSnapshot([], [current.entry.trackId], [account]);
		return snapshot.moods;
	}
	private versionAccounts(state = this.value?.state): number[] {
		return [
			...new Set(
				[
					...this.people(),
					...(state?.current ? [state.current.entry.contributorId] : []),
					...(state?.queue.map(entry => entry.contributorId) ?? []),
					...(state?.requests
						.filter(
							request =>
								request.status === "pending" || request.status === "admitted",
						)
						.map(request => request.candidate.contributorId) ?? []),
				]
					.map(accountId)
					.filter((id): id is number => id !== undefined),
			),
		];
	}
	private async commit(state: MusicSchedulerState, playback = this.value!.playback) {
		const next = { state, playback };
		const currentMoods = await this.loadCurrentMoods(state);
		try {
			await this.store.save(next, this.value!.state.revision);
		} catch (error) {
			this.invalid = true;
			throw error;
		}
		this.currentMoods = currentMoods;
		this.value = next;
		await this.publish(next, this.publicState!);
	}
	private async context(
		state: MusicSchedulerState,
		preferences?: RoomMoodPreference[],
	): Promise<MusicSchedulerState> {
		const ids = [...new Set(this.people())];
		const participants =
			preferences ??
			ids.map(
				participantId =>
					state.participants.find(p => p.participantId === participantId) ?? {
						participantId,
						includeMoodIds: [],
						excludeMoodIds: [],
					},
			);
		const accounts = participants
			.map(p => accountId(p.participantId))
			.filter((id): id is number => id !== undefined);
		const occurrences = [
			...state.queue,
			...state.requests
				.filter(r => r.status !== "consumed" && r.status !== "cancelled")
				.map(r => r.candidate),
		];
		const snapshot = await this.catalogue.roomSnapshot(
			accounts,
			[
				...occurrences.map(e => e.trackId),
				...(state.current ? [state.current.entry.trackId] : []),
			],
			this.versionAccounts(),
		);
		const candidate = (
			trackId: string,
			sourceId: string,
			contributorId: string,
			mediaRef?: MusicJson,
		): MusicCandidate => {
			const track = snapshot.tracks.find(t => t.id === trackId),
				source = snapshot.sources.find(s => s.id === sourceId && s.trackId === trackId);
			const tagsByUser: Record<string, string[]> = {};
			for (const tag of snapshot.tags.filter(t => t.trackId === trackId)) {
				const key = `account:${tag.userId}`;
				tagsByUser[key] ??= [];
				tagsByUser[key].push(tag.moodId);
			}
			return {
				trackId,
				sourceId,
				contributorId,
				artistIds: track?.artists ?? [],
				styleIds: track?.styles ?? [],
				tagsByUser,
				sourceUsable: !!source && source.availability !== "unavailable",
				mediaRef:
					mediaRef ??
					json({ service: source?.service, id: source?.providerId, title: track?.title }),
			};
		};
		const candidates = snapshot.links.flatMap(link => {
			const source = snapshot.sources.find(
				s => s.trackId === link.trackId && s.availability !== "unavailable",
			);
			return source ? [candidate(link.trackId, source.id, `account:${link.userId}`)] : [];
		});
		const occurrenceCandidates = occurrences.map(e =>
			candidate(e.trackId, e.sourceId, e.contributorId, e.mediaRef),
		);
		const result = reduce(state, {
			type: "context",
			participants,
			candidates,
			occurrenceCandidates,
			now: Date.now(),
		});
		const relevantAccounts = new Set(this.versionAccounts(result.state));
		this.versions = snapshot.versions
			.split(",")
			.filter(part => relevantAccounts.has(Number(part.split(":")[0])))
			.join(",");
		return result.state;
	}
	async refresh(force = false) {
		await this.lock.protect(async () => {
			await this.initializeLocked();
			const now = Date.now();
			if (!force && !this.invalid && now < this.nextVersionCheck) {
				return;
			}
			const accounts = this.versionAccounts();
			if (
				force ||
				this.invalid ||
				(await this.catalogue.roomVersions(accounts)) !== this.versions
			) {
				const state = await this.context(this.value!.state);
				await this.commit(state);
				this.invalid = false;
			}
			this.nextVersionCheck = now + 5000;
		});
	}
	async execute(
		action: MusicRoomAction,
		identity: string,
		authorize?: () => void,
	): Promise<MusicRoomResult> {
		// Resolve provider imports outside the room mutex. Authorization is performed by Room first.
		let resolved: Awaited<ReturnType<MusicCatalogue["resolveTrack"]>> | undefined;
		if (action.action === "request") {
			const reference = MusicReferenceSchema.parse(action.reference);
			resolved = await this.catalogue.resolveTrack(reference);
		}
		return this.lock.protect(async () => {
			await this.initializeLocked();
			if (!this.people().includes(identity)) {
				throw new MusicRoomException("Join the room before issuing music commands");
			}
			authorize?.();
			const initial = this.value!.state;
			const result = (status: string): MusicRoomResult => ({
				correlationId: action.correlationId,
				revision: this.value!.state.revision,
				status,
			});
			if (action.action === "queue" || action.action === "requests") {
				const own = initial.requests.filter(r => r.candidate.contributorId === identity);
				const items =
					action.action === "queue"
						? initial.queue
								.slice(action.offset, action.offset + action.limit)
								.map(entryDto)
						: own.slice(action.offset, action.offset + action.limit).map(requestDto);
				return {
					...result("applied"),
					page: {
						items,
						total: action.action === "queue" ? initial.queue.length : own.length,
						offset: action.offset,
						limit: action.limit,
					},
				};
			}
			if (action.expectedRevision !== initial.revision) {
				return result("revision-conflict");
			}
			const ownRequest =
				"requestId" in action
					? initial.requests.find(r => r.requestId === action.requestId)
					: undefined;
			if (ownRequest && ownRequest.candidate.contributorId !== identity) {
				throw new MusicRoomException("Music request belongs to another participant");
			}
			let state = await this.context(initial);
			const now = Date.now();
			let command: MusicSchedulerCommand;
			switch (action.action) {
				case "preferences": {
					const participants = state.participants.map(p =>
						p.participantId === identity
							? {
									participantId: identity,
									includeMoodIds: action.includeMoodIds,
									excludeMoodIds: action.excludeMoodIds,
								}
							: p,
					);
					state = await this.context(state, participants);
					command = { type: "replan", content: action.content, now };
					break;
				}
				case "settings":
					command = { type: "settings", settings: action.settings, now };
					break;
				case "replan":
					command = { type: "replan", content: action.content, now };
					break;
				case "request": {
					const { track, source } = resolved!;
					const snapshot = await this.catalogue.roomSnapshot(
						state.participants
							.map(p => accountId(p.participantId))
							.filter((id): id is number => id !== undefined),
						[track.id],
					);
					const tagsByUser: Record<string, string[]> = {};
					for (const tag of snapshot.tags.filter(t => t.trackId === track.id)) {
						const key = `account:${tag.userId}`;
						tagsByUser[key] ??= [];
						tagsByUser[key].push(tag.moodId);
					}
					command = {
						type: "request",
						requestId: action.requestId,
						intent: action.intent,
						now,
						candidate: {
							trackId: track.id,
							sourceId: source.id,
							contributorId: identity,
							artistIds: track.artists,
							styleIds: track.styles,
							tagsByUser,
							sourceUsable: source.availability !== "unavailable",
							mediaRef: json({
								service: source.service,
								id: source.providerId,
								title: track.title,
								...action.extras,
							}),
						},
					};
					break;
				}
				case "confirm": {
					const matches = (
						a: { participantId: string; moodId: string },
						b: { participantId: string; moodId: string },
					) => a.participantId === b.participantId && a.moodId === b.moodId;
					if (!ownRequest || ownRequest.candidate.trackId !== action.trackId) {
						return result("not-found");
					}
					if (
						action.conflicts.some(
							c =>
								![
									...ownRequest.offeredConflicts,
									...ownRequest.acceptedConflicts,
								].some(offered => matches(c, offered)),
						)
					) {
						return result("invalid-confirmation");
					}
					const refreshed = state.requests.find(r => r.requestId === action.requestId)!;
					// A vanished conflict needs no second prompt; newly appeared conflicts remain pending.
					const conflicts = action.conflicts.filter(c =>
						[...refreshed.offeredConflicts, ...refreshed.acceptedConflicts].some(
							offered => matches(c, offered),
						),
					);
					command = {
						type: "confirm",
						requestId: action.requestId,
						trackId: action.trackId,
						conflicts,
						now,
					};
					break;
				}
				case "cancel":
					command = { type: "cancel", requestId: action.requestId, now };
					break;
				case "remove":
					command = { type: "remove", entryId: action.entryId, now };
					break;
			}
			const transition = reduce(state, command);
			// Context refresh is itself meaningful and published even if the intention now conflicts.
			authorize?.();
			await this.commit(transition.state);
			this.invalid = false;
			const request =
				"requestId" in action
					? transition.state.requests.find(r => r.requestId === action.requestId)
					: undefined;
			return {
				...result(transition.status),
				request: request ? requestDto(request) : undefined,
			};
		});
	}
	private async resolveEntry(
		entry: MusicQueueEntry,
	): Promise<{ video: MusicQueueItem; candidate: MusicCandidate }> {
		const ref = (entry.mediaRef ?? {}) as QueueItemExtras,
			extras: QueueItemExtras = {};
		for (const key of ["startAt", "endAt", "subtitleUrl"] as const) {
			if (ref[key] !== undefined) {
				Object.assign(extras, { [key]: ref[key] });
			}
		}
		try {
			return {
				video: {
					...(await this.catalogue.toQueueItem(entry.trackId, entry.sourceId, extras)),
					entryId: entry.entryId,
					contributorId: entry.contributorId,
					origin: entry.origin,
				},
				candidate: entry,
			};
		} catch {
			// Only trusted equivalent catalogue sources of this already authorized track.
			// A source fallback keeps occurrence, request and playback identities unchanged.
			const snapshot = await this.catalogue.roomSnapshot([], [entry.trackId]);
			for (const source of snapshot.sources.filter(
				source =>
					source.trackId === entry.trackId &&
					source.id !== entry.sourceId &&
					source.availability !== "unavailable",
			)) {
				try {
					const video = await this.catalogue.toQueueItem(
						entry.trackId,
						source.id,
						extras,
					);
					const mediaRef =
						typeof entry.mediaRef === "object" &&
						entry.mediaRef &&
						!Array.isArray(entry.mediaRef)
							? entry.mediaRef
							: {};
					return {
						video: {
							...video,
							entryId: entry.entryId,
							contributorId: entry.contributorId,
							origin: entry.origin,
						},
						candidate: {
							...entry,
							sourceId: source.id,
							sourceUsable: true,
							mediaRef: {
								...mediaRef,
								service: source.service,
								id: source.providerId,
							},
						},
					};
				} catch {
					/* Try the next equivalent source without claiming another play. */
				}
			}
			throw new MusicRoomException("No usable music source");
		}
	}
	async setPlayback(patch: Partial<MusicRoomPlayback>) {
		await this.initialize();
		for (let attempt = 0; attempt < 5; attempt++) {
			const before = this.state!;
			const current =
				patch.isPlaying &&
				before.current &&
				(!before.current.started || !this.value!.playback.isPlaying)
					? before.current
					: undefined;
			let resolved: Awaited<ReturnType<RoomMusic["resolveEntry"]>> | undefined,
				failed = false;
			if (current) {
				try {
					resolved = await this.resolveEntry(current.entry);
				} catch {
					failed = true;
				}
			}
			const applied = await this.lock.protect(async () => {
				if (this.value!.state.revision !== before.revision) {
					return false;
				}
				let state = this.value!.state;
				let playback = { ...this.value!.playback, ...patch };
				if (current) {
					const snapshot = await this.catalogue.roomSnapshot([], [current.entry.trackId]);
					const source = snapshot.sources.find(
						source =>
							source.id === (resolved?.candidate.sourceId ?? current.entry.sourceId),
					);
					failed = failed || !source || source.availability === "unavailable";
					state = reduce(state, {
						type: "update-source",
						entryId: current.entry.entryId,
						candidate: {
							...(resolved?.candidate ?? current.entry),
							sourceUsable: !failed,
						},
						now: Date.now(),
					}).state;
					if (failed) {
						state = reduce(state, {
							type: "ended",
							playbackId: current.playbackId,
							reason: "error",
							now: Date.now(),
						}).state;
						state = { ...state, current: undefined };
						playback = {
							...playback,
							currentSource: null,
							isPlaying: false,
							playbackPosition: 0,
							playbackStart: null,
						};
					} else {
						if (!current.started) {
							state = reduce(state, {
								type: "started",
								playbackId: current.playbackId,
								now: Date.now(),
							}).state;
							state = reduce(state, { type: "replan", now: Date.now() }).state;
						}
						playback = { ...playback, currentSource: resolved!.video };
					}
				}
				if (state === this.value!.state) {
					state = { ...state, revision: state.revision + 1 };
				}
				await this.commit(state, playback);
				return true;
			});
			if (applied) {
				if (failed) {
					throw new MusicRoomException("Loaded music source is no longer available");
				}
				return;
			}
		}
		throw new MusicRoomException("Music playback changed during source resolution; retry");
	}
	async advance(reason: "finished" | "skipped" = "finished") {
		await this.advanceLock.protect(async () => {
			this.isAdvancing = true;
			try {
				await this.advanceLocked(reason);
			} finally {
				this.isAdvancing = false;
			}
		});
	}
	private async advanceLocked(reason: "finished" | "skipped") {
		await this.refresh();
		await this.lock.protect(async () => {
			const current = this.value!.state.current;
			if (!current) {
				return;
			}
			const ended = reduce(this.value!.state, {
				type: "ended",
				playbackId: current.playbackId,
				reason,
				now: Date.now(),
			}).state;
			await this.commit(
				{ ...ended, current: undefined },
				{
					...this.value!.playback,
					currentSource: null,
					playbackPosition: 0,
					playbackStart: null,
				},
			);
		});
		// Concurrent requests/starts can change the head while a provider is resolving.
		for (let attempt = 0; attempt < 5; attempt++) {
			const before = this.state!,
				head = before.queue[0];
			let resolved: Awaited<ReturnType<RoomMusic["resolveEntry"]>> | undefined,
				failed = false;
			if (head) {
				try {
					resolved = await this.resolveEntry(head);
				} catch {
					failed = true;
				}
			}
			const applied = await this.lock.protect(async () => {
				if (this.value!.state.revision !== before.revision) {
					return false;
				}
				const accounts = this.versionAccounts();
				if ((await this.catalogue.roomVersions(accounts)) !== this.versions) {
					await this.commit(await this.context(this.value!.state));
					return false;
				}
				let state = this.value!.state;
				if (head) {
					const playbackId = randomUUID();
					state = reduce(state, { type: "load-next", playbackId, now: Date.now() }).state;
					if (resolved || failed) {
						state = reduce(state, {
							type: "update-source",
							entryId: head.entryId,
							candidate: resolved?.candidate ?? { ...head, sourceUsable: false },
							now: Date.now(),
						}).state;
					}
					if (failed) {
						state = reduce(state, {
							type: "ended",
							playbackId,
							reason: "error",
							now: Date.now(),
						}).state;
					} else if (this.value!.playback.isPlaying) {
						state = reduce(state, {
							type: "started",
							playbackId,
							now: Date.now(),
						}).state;
						state = reduce(state, { type: "replan", now: Date.now() }).state;
					}
				} else {
					state = { ...state, current: undefined };
				}
				const playback = {
					...this.value!.playback,
					currentSource: failed ? null : (resolved?.video ?? null),
					playbackPosition: resolved?.video.startAt ?? 0,
					playbackSpeed: 1,
					playbackStart: new Date().toISOString(),
					isPlaying: !!resolved && !failed && this.value!.playback.isPlaying,
				};
				await this.commit(state, playback);
				return true;
			});
			if (applied) {
				return;
			}
		}
		throw new MusicRoomException("Music queue changed during source resolution; retry");
	}
}
