import { Mutex } from "@divine/synchronization";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { PlaybackJournal } from "./playback/journal.js";
import { PlaybackReceipts } from "./playback/receipts.js";
import { UndoSourceSchema } from "./playback/undo.js";
import type { PlaybackAuthorization } from "./playback/authorization.js";
import { z } from "zod";
import {
	PREVIOUS_RESTARTS_AFTER_SECONDS,
	PlaybackCommandSchema,
	type PlaybackCommand,
	type PlaybackCommandResult,
} from "ott-common/playback/transport.js";
import { PositionSecondsSchema, PlaybackRateSchema } from "ott-common/playback/index.js";
import type { MusicCatalogue } from "./music/catalogue.js";
import type { MusicRoomStore } from "./music/room-music-storage.js";
import { RoomMusic, musicIdentity } from "./music/room-music.js";
import { MusicRoomException } from "./music/room-music-storage.js";
import { MusicRoomActionSchema, type MusicRoomPublic } from "ott-common/models/music-room.js";
import type { MusicSchedulerState } from "ott-common/music/types.js";
import type { MusicRoomRequest } from "ott-common/models/messages.js";
import permissions, { type GrantMask, Grants } from "ott-common/permissions.js";
import { redisClient } from "./redisclient.js";
import { getLogger } from "./logger.js";
import type winston from "winston";
import type {
	AddRequest,
	ApplySettingsRequest,
	ChatRequest,
	JoinRequest,
	LeaveRequest,
	OrderRequest,
	PlaybackRequest,
	PromoteRequest,
	RemoveRequest,
	RoomRequest,
	RoomRequestBase,
	SeekRequest,
	ServerMessage,
	ServerMessageSync,
	SkipRequest,
	UndoRequest,
	UpdateUser,
	VoteRequest,
	PlayNowRequest,
	RoomRequestAuthorization,
	RoomRequestContext,
	ShuffleRequest,
	PlaybackSpeedRequest,
	KickRequest,
	UpdateQueueItemRequest,
} from "ott-common/models/messages.js";
import { RoomRequestType, isRoomRequestType } from "ott-common/models/messages.js";
import _ from "lodash";
import InfoExtract from "./infoextractor.js";
import usermanager from "./usermanager.js";
import {
	type ClientInfo,
	QueueMode,
	Visibility,
	type RoomOptions,
	type RoomUserInfo,
	Role,
	type ClientId,
	PlayerStatus,
	type RoomEventContext,
	type RoomSettings,
	type AuthToken,
	BehaviorOption,
} from "ott-common/models/types.js";
import type { User } from "./models/user.js";
import type { QueueItem, Video, VideoId } from "ott-common/models/video.js";
import dayjs, { type Dayjs } from "dayjs";
import type { PickFunctions } from "ott-common/typeutils.js";
import { replacer } from "ott-common/serialize.js";
import {
	ClientNotFoundInRoomException,
	ImpossiblePromotionException,
	VideoAlreadyQueuedException,
	VideoNotFoundException,
	UnsupportedSubtitleType,
} from "./exceptions.js";
import storage from "./storage.js";
import tokens, { type SessionInfo } from "./auth/tokens.js";
import { OttException, PermissionDeniedException } from "ott-common/exceptions.js";
import { fetchSegments } from "./sponsorblock.js";
import {
	ResponseError as SponsorblockResponseError,
	type Segment,
	type Category,
} from "sponsorblock-api";
import { VideoQueue } from "./videoqueue.js";
import { Counter } from "prom-client";
import roommanager from "./roommanager.js";
import { calculateCurrentPosition } from "ott-common/timestamp.js";
import type { RestoreQueueRequest } from "ott-common/models/messages.js";
import { type Result, countEligibleVoters, err, ok, voteSkipThreshold } from "ott-common";
import type { ClientManagerCommand } from "./clientmanager.js";
import { canKickUser } from "ott-common/userutils.js";
import { getSubtitleFormatFromUrl } from "ott-common/subtitles.js";
import { conf } from "./ott-config.js";
import { ALL_SKIP_CATEGORIES } from "ott-common/constants.js";

const PLAYBACK_AUTH_FAILURE = /membership|session changed|quorum changed/;
/** Played tracks of a regular queue shown to the room, most recent last. */
const PUBLIC_PLAYED_TRACKS = 10;

/**
 * Represents a User from the Room's perspective.
 */
export class RoomUser {
	id: ClientId;
	token: AuthToken;
	user_id?: number;
	unregisteredUsername = "";
	user: User | null;
	playerStatus: PlayerStatus = PlayerStatus.none;
	private infoRevision = 0;

	constructor(id: ClientId, token: AuthToken) {
		this.id = id;
		this.token = token;
		this.user = null;
	}

	public get isLoggedIn(): boolean {
		return !!this.user_id;
	}

	public get username(): string {
		if (this.isLoggedIn && this.user) {
			return this.user.username;
		} else {
			return this.unregisteredUsername;
		}
	}

	public async updateInfo(info: ClientInfo): Promise<void> {
		const revision =
			info.user_id || info.username !== undefined ? ++this.infoRevision : this.infoRevision;
		await this.applyInfo(info, revision);
	}
	private async applyInfo(info: ClientInfo, revision: number): Promise<boolean> {
		if (revision !== this.infoRevision) {
			return false;
		}
		if (info.status !== undefined) {
			this.playerStatus = info.status;
		}
		if (info.user_id) {
			const user = await usermanager.getUser({ id: info.user_id });
			if (revision === this.infoRevision) {
				// Publish account identity and its display record together. A tentative
				// identity must not hide the change from a superseding status refresh.
				this.user_id = info.user_id;
				this.user = user;
			}
		} else if (info.username !== undefined) {
			this.unregisteredUsername = info.username;
			this.user_id = undefined;
			this.user = null;
		}
		return revision === this.infoRevision;
	}
	public async updateSession(
		pending: SessionInfo | Promise<SessionInfo>,
		status?: PlayerStatus,
	): Promise<boolean> {
		// Reserve before session I/O as well as the account lookup: a newer logout wins.
		const revision = ++this.infoRevision;
		const session = await pending;
		return this.applyInfo(
			{
				id: this.id,
				...(session.isLoggedIn
					? { user_id: session.user_id }
					: { username: session.username ?? this.unregisteredUsername }),
				status,
			},
			revision,
		);
	}
}

/**
 * Things that Rooms need to remember, but can safely be forgotten when the room is unloaded.
 * This rule does not necessarily apply to inherited fields.
 */
export interface RoomState extends RoomOptions, RoomStateComputed {
	/** Server-only bounded legacy navigation stack, persisted with the room. */
	previousTracks: QueueItem[];
	previousAvailable: boolean;
	/** Public tail of `previousTracks`, oldest first; Music rooms publish `music.played`. */
	playedTracks: QueueItem[];
	music: MusicRoomPublic | null;
	musicState?: MusicSchedulerState;
	currentSource: QueueItem | null;
	queue: VideoQueue;
	isPlaying: boolean;
	playbackPosition: number;
	playbackSpeed: number;
	users: RoomUserInfo[];
	votes: Map<string, Set<ClientId>>;
	votesToSkip: Set<ClientId>;
	videoSegments: Segment[];
}

export type RoomStateFromRedis = Omit<RoomState, "userRoles" | "grants"> & {
	grants: [Role, GrantMask][];
	userRoles: [Role, number[]][];
};

export interface RoomStateComputed {
	hasOwner: boolean;
	voteCounts: Map<string, number>;
}

// Only these should be sent to clients, all others should be considered unsafe
export type RoomStateSyncable = Omit<
	RoomState,
	"owner" | "votes" | "userRoles" | "users" | "musicState" | "previousTracks"
>;

// Only these should be stored in redis
export type RoomStateStorable = Omit<
	RoomState,
	"hasOwner" | "votes" | "voteCounts" | "users" | "votesToSkip"
> & { _playbackStart: Dayjs | null };

const syncableProps: (keyof RoomStateSyncable)[] = [
	"previousAvailable",
	"playedTracks",
	"music",
	"name",
	"title",
	"description",
	"isTemporary",
	"visibility",
	"queueMode",
	"currentSource",
	"queue",
	"isPlaying",
	"playbackPosition",
	"playbackSpeed",
	"grants",
	"hasOwner",
	"voteCounts",
	"videoSegments",
	"autoSkipSegmentCategories",
	"prevQueue",
	"restoreQueueBehavior",
	"enableVoteSkip",
	"votesToSkip",
];

const storableProps: (keyof RoomStateStorable)[] = [
	"previousTracks",
	"musicState",
	"name",
	"title",
	"description",
	"isTemporary",
	"visibility",
	"queueMode",
	"currentSource",
	"queue",
	"isPlaying",
	"playbackPosition",
	"playbackSpeed",
	"grants",
	"userRoles",
	"owner",
	"_playbackStart",
	"videoSegments",
	"autoSkipSegmentCategories",
	"prevQueue",
	"restoreQueueBehavior",
	"enableVoteSkip",
];

/** Only these should be stored in persistent storage */
export type RoomStatePersistable = Omit<
	RoomState,
	| "isTemporary"
	| "currentSource"
	| "queue"
	| "isPlaying"
	| "playbackPosition"
	| "playbackSpeed"
	| "users"
	| "votes"
	| "videoSegments"
	| "hasOwner"
	| "voteCounts"
	| "votesToSkip"
	| "previousTracks"
	| "previousAvailable"
	| "playedTracks"
>;

export class Room implements RoomState {
	private playbackLock = new Mutex();
	private playbackContext = new AsyncLocalStorage<{ active: boolean }>();
	private playbackReceipts = new PlaybackReceipts();
	private commandGuards = new WeakMap<RoomRequestContext, PlaybackAuthorization>();
	private commandClears = new WeakMap<RoomRequestContext, () => void>();
	private journal = new PlaybackJournal(message => {
		void this.publishPlayback(message);
	});
	private async publishPlayback(message: ServerMessage) {
		try {
			await this.publish(message);
		} catch (error) {
			this.log.error(`Playback publication failed: ${String(error)}`);
		}
	}
	private updatePending?: Promise<void>;
	private withPlaybackLock<T>(work: () => Promise<T>): Promise<T> {
		if (this.playbackContext.getStore()?.active) {
			return work();
		}
		return this.playbackLock.protect(async () => {
			const context = { active: true };
			try {
				return await this.playbackContext.run(context, work);
			} finally {
				context.active = false;
			}
		});
	}
	private recordPlayback(options: { load?: boolean; seek?: boolean } = {}) {
		this.markDirty("previousAvailable");
		this.markDirty("playedTracks");
		this.journal.commit(
			{
				currentSource: this.currentSource,
				positionSeconds: this.realPlaybackPosition,
				isPlaying: this.isPlaying,
				rate: this.playbackSpeed,
			},
			options,
		);
	}
	public playbackSnapshot(nonce: string) {
		return this.journal.snapshot(nonce);
	}
	public executePlaybackCommand(
		input: unknown,
		authorization: RoomRequestAuthorization,
	): Promise<PlaybackCommandResult> {
		const command = PlaybackCommandSchema.parse(input);
		const result = (code?: PlaybackCommandResult["code"]): PlaybackCommandResult => ({
			requestId: command.requestId,
			epoch: this.journal.epoch,
			sequence: this.journal.sequence,
			status: code ? "rejected" : "applied",
			...(code ? { code } : {}),
		});
		const user = authorization.clientId ? this.getUser(authorization.clientId) : undefined;
		try {
			authorization.assertCurrent?.();
		} catch {
			return Promise.resolve(result("unauthorized"));
		}
		if (!user || user.token !== authorization.token) {
			return Promise.resolve(result("unauthorized"));
		}
		const identity = musicIdentity(user),
			token = user.token;
		const fingerprint = createHash("sha256").update(token).digest("hex");
		const key = JSON.stringify([this.journal.epoch, fingerprint, identity, command.requestId]);
		return this.playbackReceipts.run(key, JSON.stringify(command), result, async () => {
			try {
				let clearedSequence: number | undefined;
				const authorize = Object.assign(
					async () => {
						authorization.assertCurrent?.();
						const session = await tokens.getSessionInfo(token);
						authorization.assertCurrent?.();
						if (
							this.getUser(user.id) !== user ||
							user.token !== token ||
							musicIdentity(user) !== identity ||
							musicIdentity({
								token,
								user_id: session.isLoggedIn ? session.user_id : undefined,
							}) !== identity
						) {
							throw new OttException("unauthorized");
						}
						if (command.epoch !== this.journal.epoch) {
							throw new OttException("stale-epoch");
						}
						// Music next has its own clear commit before asynchronous next-source resolution.
						const ownClear =
							command.command === "next" &&
							this.queueMode === QueueMode.Music &&
							this.journal.occurrenceId === null &&
							this.journal.sequence === clearedSequence;
						const occurrence =
							command.command === "previous"
								? (this.journal.occurrenceId ?? 0)
								: this.journal.occurrenceId;
						if (command.occurrenceId !== occurrence && !ownClear) {
							throw new OttException("stale-occurrence");
						}
						if (
							command.command === "previous" &&
							command.sequence !== this.journal.sequence
						) {
							throw new OttException("stale-occurrence");
						}
						this.grants.check(
							this.getRoleFromSession(session),
							this.playbackPermission(command),
						);
						if (command.command === "previous" && this.enableVoteSkip) {
							throw new OttException("unauthorized");
						}
					},
					{ assertCurrent: authorization.assertCurrent },
				);
				const execute = async () => {
					await authorize();
					const context = await this.deriveRequestContext(authorization);
					this.commandGuards.set(context, authorize);
					this.commandClears.set(context, () => {
						clearedSequence = this.journal.sequence;
					});
					await authorize();
					switch (command.command) {
						case "play":
						case "pause":
							await this.playback(
								{
									type: RoomRequestType.PlaybackRequest,
									state: command.command === "play",
								},
								context,
							);
							break;
						case "seek":
							await this.seek(
								{
									type: RoomRequestType.SeekRequest,
									value: command.positionSeconds,
								},
								context,
							);
							break;
						case "rate":
							await this.setPlaybackSpeed(
								{ type: RoomRequestType.PlaybackSpeedRequest, speed: command.rate },
								context,
							);
							break;
						case "next":
							await this.skip({ type: RoomRequestType.SkipRequest }, context);
							break;
						case "previous":
							// Like any player: past the first seconds, Previous restarts the
							// track. An explicit step count (picking a played track) always goes back.
							if (command.steps === undefined && this.previousRestarts) {
								await this.restartCurrent(context);
								break;
							}
							if (!this.previousAvailable) {
								return result("unavailable");
							}
							await this.previous(context, command.steps ?? 1);
							break;
					}
					return result();
				};
				return this.queueMode === QueueMode.Music
					? await execute()
					: await this.withPlaybackLock(execute);
			} catch (error) {
				const code = error instanceof OttException ? error.message : "failed";
				return result(
					code === "stale-epoch" || code === "stale-occurrence"
						? code
						: code.includes("occurrence changed")
							? "stale-occurrence"
							: error instanceof PermissionDeniedException ||
									code === "unauthorized" ||
									PLAYBACK_AUTH_FAILURE.test(code)
								? "unauthorized"
								: "failed",
				);
			}
		});
	}
	private legacyAuthorization(context: RoomRequestContext, permission: string) {
		const user = context.clientId ? this.getUser(context.clientId) : undefined;
		const identity = user ? musicIdentity(user) : undefined;
		const token = context.auth?.token;
		const occurrence = this.journal.occurrenceId;
		return Object.assign(
			async () => {
				context.auth?.assertCurrent?.();
				if (!token) {
					return;
				}
				const session = await tokens.getSessionInfo(token);
				context.auth?.assertCurrent?.();
				if (
					user &&
					(this.getUser(user.id) !== user ||
						user.token !== token ||
						musicIdentity(user) !== identity ||
						musicIdentity({
							token,
							user_id: session.isLoggedIn ? session.user_id : undefined,
						}) !== identity)
				) {
					throw new OttException("Playback membership or session changed");
				}
				if (occurrence !== this.journal.occurrenceId) {
					throw new OttException("Playback occurrence changed");
				}
				this.grants.check(this.getRoleFromSession(session), permission);
			},
			{ assertCurrent: context.auth?.assertCurrent },
		);
	}
	private playbackPermission(command: PlaybackCommand) {
		return command.command === "next" || command.command === "previous"
			? "playback.skip"
			: command.command === "seek"
				? "playback.seek"
				: command.command === "rate"
					? "playback.speed"
					: "playback.play-pause";
	}
	private _music?: RoomMusic;
	private restoredMusicState?: MusicSchedulerState;
	public get music(): MusicRoomPublic | null {
		if (this.queueMode !== QueueMode.Music) {
			return null;
		}
		const projection = this._music?.publicState;
		if (!projection) {
			return null;
		}
		projection.participants = projection.participants.map(person => {
			const users = this.realusers.filter(
				user => musicIdentity(user) === person.participantId,
			);
			return { ...person, name: users[0]?.username, clientIds: users.map(user => user.id) };
		});
		return projection;
	}
	public get musicState(): MusicSchedulerState | undefined {
		return this._music?.state ?? this.restoredMusicState;
	}
	public get musicEngine(): RoomMusic {
		if (!this._music) {
			this._music = new RoomMusic(
				this.name,
				() => this.realusers.map(musicIdentity),
				async value => {
					this.restoredMusicState = undefined;
					this.markDirty("music");
					const p = value.playback;
					const msg: ServerMessageSync = {
						action: "sync",
						music: this.music,
						queue: [],
						previousAvailable: this.previousAvailable,
					};
					if (!_.isEqual(this.currentSource, p.currentSource)) {
						this.currentSource = p.currentSource;
						this.videoSegments = [];
						msg.currentSource = this.currentSource;
					}
					if (this.isPlaying !== p.isPlaying) {
						this.isPlaying = p.isPlaying;
						msg.isPlaying = p.isPlaying;
					}
					const start = p.playbackStart ? dayjs(p.playbackStart) : null;
					if (
						this.playbackPosition !== p.playbackPosition ||
						this._playbackStart?.valueOf() !== start?.valueOf() ||
						msg.currentSource !== undefined
					) {
						this.playbackPosition = p.playbackPosition;
						this._playbackStart = start;
						msg.playbackPosition = this.realPlaybackPosition;
					}
					if (this.playbackSpeed !== p.playbackSpeed) {
						this.playbackSpeed = p.playbackSpeed;
						msg.playbackSpeed = p.playbackSpeed;
					}
					await this.publish(msg);
				},
				this.musicDependencies.catalogue,
				this.musicDependencies.store,
				this.restoredMusicState,
				() =>
					this.realusers.map(user => ({
						participantId: musicIdentity(user),
						name: this.getUserInfo(user.id).name,
					})),
				(value, seek) => {
					const p = value.playback;
					const now = Date.now();
					const position =
						p.playbackPosition +
						(p.isPlaying && p.playbackStart
							? (Math.max(0, now - Date.parse(p.playbackStart)) / 1000) *
								p.playbackSpeed
							: 0);
					return this.journal.stage(
						{
							currentSource: p.currentSource,
							positionSeconds: position,
							isPlaying: p.isPlaying,
							rate: p.playbackSpeed,
							playbackId: value.state.current?.playbackId,
						},
						{ seek },
						now,
					);
				},
			);
		}
		return this._music;
	}
	public async initializeMusic(): Promise<void> {
		if (this.queueMode === QueueMode.Music) {
			await this.musicEngine.initialize();
		}
	}
	public invalidateMusic(userId: number): void {
		this._music?.invalidate(userId);
	}
	private requireLegacyQueue(): void {
		if (this.queueMode === QueueMode.Music) {
			throw new MusicRoomException("Use occurrence-based music commands in Music mode");
		}
	}
	private requireMusicMode = (): void => {
		if (this.queueMode !== QueueMode.Music) {
			throw new MusicRoomException("Music mode changed during source resolution");
		}
	};
	/** Capture the connection, then check its live session/role at the commit boundary. */
	private musicPlaybackAuthorization(
		context: RoomRequestContext,
		permission?: string,
		authorizeRole?: (role: Role) => void,
	) {
		const user = context.clientId ? this.getUser(context.clientId) : undefined;
		if (!user) {
			throw new MusicRoomException("Join the room before controlling music playback");
		}
		const identity = musicIdentity(user),
			token = user.token;
		return Object.assign(
			async () => {
				context.auth?.assertCurrent?.();
				const session = await tokens.getSessionInfo(token);
				context.auth?.assertCurrent?.();
				this.requireMusicMode();
				if (
					this.getUser(user.id) !== user ||
					user.token !== token ||
					(context.auth && context.auth.token !== token) ||
					musicIdentity(user) !== identity ||
					musicIdentity({
						token,
						user_id: session.isLoggedIn ? session.user_id : undefined,
					}) !== identity
				) {
					throw new MusicRoomException("Music playback membership or session changed");
				}
				const role = session.isLoggedIn
					? this.getRoleFromSession(session)
					: Role.UnregisteredUser;
				if (permission) {
					this.grants.check(role, permission);
				}
				authorizeRole?.(role);
				await this.commandGuards.get(context)?.();
			},
			{ assertCurrent: context.auth?.assertCurrent },
		);
	}
	public async musicRequest(
		request: MusicRoomRequest,
		context: RoomRequestContext,
	): Promise<void> {
		try {
			await this.handleMusicRequest(request, context);
		} catch (error) {
			const correlationId = request.command?.correlationId;
			if (
				context.clientId &&
				typeof correlationId === "string" &&
				correlationId.length > 0 &&
				correlationId.length <= 256
			) {
				await this.command({
					type: "send",
					clientId: context.clientId,
					message: {
						action: "music-result",
						result: {
							correlationId,
							revision: this.music?.revision ?? 0,
							status: "rejected",
						},
					},
				});
			}
			if (error instanceof OttException) {
				throw error;
			}
			throw new MusicRoomException("Music room request failed");
		}
	}
	private async handleMusicRequest(
		request: MusicRoomRequest,
		context: RoomRequestContext,
	): Promise<void> {
		if (this.queueMode !== QueueMode.Music) {
			throw new MusicRoomException("Enable Music mode first");
		}
		const user = context.clientId ? this.getUser(context.clientId) : undefined;
		if (!user) {
			throw new MusicRoomException("Join the room before issuing music commands");
		}
		const action = MusicRoomActionSchema.parse(request.command);
		switch (action.action) {
			case "request":
			case "confirm":
				this.grants.check(context.role, "manage-queue.add");
				break;
			case "remove":
				this.grants.check(context.role, "manage-queue.remove");
				break;
			case "replan":
				this.grants.check(context.role, "manage-queue.order");
				break;
			case "settings":
				this.grants.check(context.role, "configure-room.other");
				break;
		}
		if (
			(action.action === "request" && action.intent === "next") ||
			(action.action === "confirm" &&
				this.musicState?.requests.find(r => r.requestId === action.requestId)?.intent ===
					"next")
		) {
			this.grants.check(context.role, "manage-queue.order");
		}
		const authorize = this.musicPlaybackAuthorization(context, undefined, role => {
			const perm =
				action.action === "request" || action.action === "confirm"
					? "manage-queue.add"
					: action.action === "remove"
						? "manage-queue.remove"
						: action.action === "replan"
							? "manage-queue.order"
							: action.action === "settings"
								? "configure-room.other"
								: undefined;
			if (perm) {
				this.grants.check(role, perm);
			}
			if (
				(action.action === "request" && action.intent === "next") ||
				(action.action === "confirm" &&
					this.musicState?.requests.find(r => r.requestId === action.requestId)
						?.intent === "next")
			) {
				this.grants.check(role, "manage-queue.order");
			}
		});
		const result = await this.musicEngine.execute(action, musicIdentity(user), authorize);
		await this.command({
			type: "send",
			clientId: user.id,
			message: { action: "music-result", result },
		});
	}

	_name = "";
	_title = "";
	_description = "";
	_visibility: Visibility = Visibility.Unlisted;
	_queueMode: QueueMode = QueueMode.Manual;
	isTemporary = false;
	_owner: User | null = null;
	grants: Grants = new Grants();
	userRoles: Map<Role, Set<number>>;
	_autoSkipSegmentCategories = Array.from(ALL_SKIP_CATEGORIES);
	restoreQueueBehavior: BehaviorOption = BehaviorOption.Prompt;
	_enableVoteSkip: boolean = false;

	_currentSource: QueueItem | null = null;
	previousTracks: QueueItem[] = [];
	get playedTracks(): QueueItem[] {
		return this.queueMode === QueueMode.Music
			? []
			: this.previousTracks.slice(-PUBLIC_PLAYED_TRACKS);
	}
	get previousAvailable(): boolean {
		return (
			!this.enableVoteSkip &&
			(this.queueMode === QueueMode.Music
				? (this._music?.previousAvailable ?? false)
				: this.previousTracks.length > 0)
		);
	}
	queue: VideoQueue;
	_prevQueue: QueueItem[] | null = null;
	_isPlaying = false;
	_playbackPosition = 0;
	_playbackSpeed = 1;
	realusers: RoomUser[] = [];
	/**
	 * Map of videos in the format service + id to a set of client votes.
	 */
	votes: Map<string, Set<ClientId>> = new Map();
	_videoSegments: Segment[] = [];
	votesToSkip: Set<string> = new Set();
	private musicSkipLock = new Mutex();
	private musicSkipVotes = new Map<
		ClientId,
		{
			user: RoomUser;
			identity: string;
			token: AuthToken;
			role: Role;
			mask: GrantMask;
			playbackId: string;
		}
	>();

	_dirty: Set<keyof RoomStateSyncable> = new Set();
	log: winston.Logger;
	_playbackStart: Dayjs | null = null;
	_keepAlivePing: Dayjs;
	/**
	 * Used to defer grabbing sponsorblock segments to keep video dequeueing from blocking.
	 */
	wantSponsorBlock = false;
	dontSkipSegmentsUntil: number | null = null;
	loadEpoch: number = -1;

	constructor(
		options: Partial<
			RoomOptions &
				Pick<
					RoomState,
					| "musicState"
					| "previousTracks"
					| "currentSource"
					| "playbackPosition"
					| "playbackSpeed"
					| "isPlaying"
				>
		>,
		private readonly musicDependencies: {
			catalogue?: MusicCatalogue;
			store?: MusicRoomStore;
		} = {},
	) {
		this.log = getLogger(`room/${options.name}`);
		this.queue = new VideoQueue();
		this.userRoles = new Map([
			[Role.TrustedUser, new Set()],
			[Role.Moderator, new Set()],
			[Role.Administrator, new Set()],
		]);
		this.owner = null;
		this._keepAlivePing = dayjs();
		this.restoredMusicState = options.musicState;

		Object.assign(
			this,
			_.pick(
				options,
				"name",
				"title",
				"description",
				"visibility",
				"queueMode",
				"isTemporary",
				"owner",
				"currentSource",
				"previousTracks",
				"queue",
				"playbackPosition",
				"isPlaying",
				"playbackSpeed",
				"autoSkipSegmentCategories",
				"prevQueue",
				"restoreQueueBehavior",
				"enableVoteSkip",
				"votesToSkip",
			),
		);
		if (
			this.queueMode === QueueMode.Music ||
			this.restoreQueueBehavior === BehaviorOption.Never
		) {
			this.prevQueue = null;
		}
		if (Array.isArray(this.queue)) {
			this.queue = new VideoQueue(this.queue);
		}
		if (
			this.queue.length === 0 &&
			this.restoreQueueBehavior === BehaviorOption.Always &&
			this.prevQueue
		) {
			// unsafe enqueue to avoid event loop load
			// safe because we're in the constructor
			this.queue.items.push(...this.prevQueue);
			this.markDirty("queue");
			this.prevQueue = null;
		}
		if (options.grants instanceof Grants) {
			this.grants = options.grants;
		} else if (options.grants) {
			this.grants = new Grants(options.grants);
		}
		if (!(this.grants instanceof Grants)) {
			this.grants = new Grants(this.grants);
		} else if (this.grants instanceof Number) {
			this.grants = new Grants();
		}
		if (!this.grants) {
			this.grants = new Grants();
		}
		if (options.userRoles) {
			if (options.userRoles instanceof Map) {
				this.userRoles = options.userRoles;
			} else {
				this.log.warn("userRoles was not an instance of Map");
				for (let role = Role.TrustedUser; role <= Role.Administrator; role++) {
					if (options.userRoles[role]) {
						this.userRoles.set(role, new Set(options.userRoles[role]));
					}
				}
			}
		}
		// eslint-disable-next-line @typescript-eslint/ban-ts-comment
		// @ts-expect-error
		if (options._playbackStart) {
			// eslint-disable-next-line @typescript-eslint/ban-ts-comment
			// @ts-expect-error
			this._playbackStart = dayjs(options._playbackStart);
		}
		if (Array.isArray(this.votesToSkip)) {
			this.votesToSkip = new Set(this.votesToSkip);
		} else {
			this.votesToSkip = new Set();
		}

		this.queue.onDirty(() => this.markDirty("queue"));
		if (this.queueMode !== QueueMode.Music) {
			this.recordPlayback();
		}
	}

	public get name(): string {
		return this._name;
	}

	public set name(value: string) {
		this._name = value;
		this.markDirty("name");
	}

	public get title(): string {
		return this._title;
	}

	public set title(value: string) {
		this._title = value;
		this.markDirty("title");
	}

	public get description(): string {
		return this._description;
	}

	public set description(value: string) {
		this._description = value;
		this.markDirty("description");
	}

	public get visibility(): Visibility {
		return this._visibility;
	}

	public set visibility(value: Visibility) {
		this._visibility = value;
		this.markDirty("visibility");
	}

	public get queueMode(): QueueMode {
		return this._queueMode;
	}

	public set queueMode(value: QueueMode) {
		this.markDirty("previousAvailable");
		this.markDirty("playedTracks");
		this._queueMode = value;
		this.markDirty("queueMode");
	}

	public get autoSkipSegmentCategories(): Category[] {
		return this._autoSkipSegmentCategories;
	}

	public set autoSkipSegmentCategories(value: Category[]) {
		this._autoSkipSegmentCategories = value;
		this.markDirty("autoSkipSegmentCategories");
	}

	public get currentSource(): QueueItem | null {
		return this._currentSource;
	}

	public set currentSource(value: QueueItem | null) {
		this._currentSource = value;
		this.markDirty("currentSource");
	}

	public get isPlaying(): boolean {
		return this._isPlaying;
	}

	public set isPlaying(value: boolean) {
		this._isPlaying = value;
		this.markDirty("isPlaying");
	}

	public get playbackPosition(): number {
		return this._playbackPosition;
	}

	public set playbackPosition(value: number) {
		this._playbackPosition = value;
		this.markDirty("playbackPosition");
	}

	public get playbackSpeed(): number {
		return this._playbackSpeed;
	}

	public set playbackSpeed(value: number) {
		this._playbackSpeed = value;
		this.markDirty("playbackSpeed");
	}

	public get owner(): User | null {
		return this._owner;
	}

	public set owner(value: User | null) {
		this._owner = value;
		this.markDirty("hasOwner");
	}

	public get videoSegments(): Segment[] {
		return this._videoSegments;
	}

	public set videoSegments(value: Segment[]) {
		this._videoSegments = value;
		this.markDirty("videoSegments");
	}

	public get prevQueue(): QueueItem[] | null {
		return this._prevQueue;
	}

	public set prevQueue(value: QueueItem[] | null) {
		if (value === null && this._prevQueue === null) {
			return;
		}
		this._prevQueue = value;
		this.markDirty("prevQueue");
	}

	public get enableVoteSkip(): boolean {
		return this._enableVoteSkip;
	}

	public set enableVoteSkip(value: boolean) {
		this.markDirty("previousAvailable");
		this._enableVoteSkip = value;
		this.markDirty("enableVoteSkip");
	}

	get users(): RoomUserInfo[] {
		const infos: RoomUserInfo[] = [];
		for (const user of this.realusers) {
			const info: RoomUserInfo = {
				id: user.id,
				name: user.username,
				isLoggedIn: user.isLoggedIn,
				status: user.playerStatus,
				role: this.getRole(user),
			};
			infos.push(info);
		}
		return infos;
	}

	private markDirty(prop: keyof RoomStateSyncable): void {
		this._dirty.add(prop);
		this.throttledSync();
	}

	private cleanDirty() {
		this._dirty.clear();
		this.queue.clean();
	}

	private clearQueueItemTrim(queueItem: QueueItem): QueueItem {
		const { startAt: _startAt, endAt: _endAt, ...queueItemWithoutTrim } = queueItem;
		return queueItemWithoutTrim;
	}

	async dequeueNext(authorize?: PlaybackAuthorization) {
		if (this.queueMode !== QueueMode.Music && !this.playbackContext.getStore()?.active) {
			return this.withPlaybackLock(() => this.dequeueNext(authorize));
		}
		if (this.queueMode === QueueMode.Music) {
			await this.musicEngine.advance("finished", this.requireMusicMode);
			this.votesToSkip.clear();
			this.markDirty("votesToSkip");
			return;
		}
		await authorize?.();
		authorize?.assertCurrent?.();
		this.log.debug(`dequeuing next video. mode: ${this.queueMode}`);
		if (this.enableVoteSkip) {
			this.votesToSkip.clear();
			this.markDirty("votesToSkip");
		}

		if (this.currentSource !== null) {
			this.rememberPrevious(this.currentSource);
			counterSecondsWatched
				.labels({ service: this.currentSource.service })
				.inc(this.calcDurationFromPlaybackStart());
			if (this.queueMode === QueueMode.Dj) {
				this.log.debug(`queue in dj mode, restarting current item`);
				this.currentSource = this.clearQueueItemTrim(this.currentSource);
				this.playbackPosition = 0;
				this._playbackStart = dayjs();
				this.recordPlayback({ load: true });
				return;
			} else if (this.queueMode === QueueMode.Loop) {
				this.log.debug(`queue in loop mode, requeuing current item`);
				this.queue.items.push(this.clearQueueItemTrim(this.currentSource));
				this.queue.markDirty();
			}
		}
		if (this.queue.length > 0) {
			this.log.debug(`queue has items in it, dequeuing`);

			// Room serialization owns this synchronous queue/install/publication boundary.
			this.currentSource = this.queue.items.shift() ?? null;
			this.queue.markDirty();
			this.playbackPosition = this.currentSource?.startAt ?? 0;
			this._playbackStart = dayjs();
			if (this.videoSegments.length > 0) {
				this.videoSegments = [];
			}
		} else if (this.currentSource !== null) {
			this.log.debug(`queue is empty, but currentSource is not, clearing currentSource`);
			if (this.isPlaying) {
				this.isPlaying = false;
			}
			this.playbackPosition = 0;
			this._playbackStart = dayjs();
			this.currentSource = null;
		}

		if (
			conf.get("video.sponsorblock.enabled") &&
			this.autoSkipSegmentCategories.length > 0 &&
			this.currentSource
		) {
			this.wantSponsorBlock = true;
		}
		if (!this.currentSource && this.videoSegments.length > 0) {
			this.videoSegments = [];
		}
		this.playbackSpeed = 1;

		this.recordPlayback({ load: this.currentSource !== null });
		this.log.debug(`Dirty props: ${Array.from(this._dirty)}`);
	}

	private rememberPrevious(item: QueueItem) {
		this.previousTracks = [...this.previousTracks.slice(-99), structuredClone(item)];
		this.markDirty("previousAvailable");
		this.markDirty("playedTracks");
	}

	/** Only the guarded, idempotent authoritative command can select server history. */
	/** Whether a plain Previous would restart the current track rather than go back. */
	get previousRestarts(): boolean {
		return (
			!!this.currentSource &&
			this.realPlaybackPosition - (this.currentSource.startAt ?? 0) >
				PREVIOUS_RESTARTS_AFTER_SECONDS
		);
	}

	/** Previous after the first seconds: back to the start of the current track. Previous is
	 * a skip-level command, so it needs the skip grant rather than the seek grant. */
	private async restartCurrent(context: RoomRequestContext): Promise<void> {
		const start = this.currentSource?.startAt ?? 0;
		const prevPosition = this.realPlaybackPosition;
		if (this.queueMode === QueueMode.Music) {
			await this.musicEngine.setPlayback(
				{ playbackPosition: start },
				this.musicPlaybackAuthorization(context, "playback.skip"),
			);
		} else {
			await this.commandGuards.get(context)!();
			context.auth?.assertCurrent?.();
			this.seekRaw(start);
		}
		await this.publishRoomEvent({ type: RoomRequestType.SeekRequest, value: start }, context, {
			prevPosition,
		});
	}

	private async previous(context: RoomRequestContext, steps = 1): Promise<void> {
		const guard = this.commandGuards.get(context)!;
		if (this.queueMode === QueueMode.Music) {
			await this.musicEngine.previous(
				this.musicPlaybackAuthorization(context, "playback.skip"),
				steps,
			);
			this.votesToSkip.clear();
			this.musicSkipVotes.clear();
			this.markDirty("votesToSkip");
			return;
		}
		await guard();
		const target = this.previousTracks.at(-steps);
		if (!target) {
			return;
		}
		const now = Date.now();
		const install = this.journal.stage(
			{
				currentSource: target,
				positionSeconds: target.startAt ?? 0,
				isPlaying: this.isPlaying,
				rate: 1,
			},
			{ load: true },
			now,
		);
		guard.assertCurrent?.();
		// Tracks played after the target come next again, in their order. DJ's Next repeats
		// the current track, so there is no return-to-queue promise for it.
		const rewound = this.previousTracks.splice(this.previousTracks.length - steps);
		const returning = rewound.slice(1).map(item => structuredClone(item));
		if (this.currentSource && this.queueMode !== QueueMode.Dj) {
			returning.push(structuredClone(this.currentSource));
		}
		if (returning.length > 0) {
			this.queue.items.unshift(...returning);
			this.queue.markDirty();
		}
		this.currentSource = structuredClone(target);
		this.playbackPosition = target.startAt ?? 0;
		this.playbackSpeed = 1;
		this._playbackStart = this.isPlaying ? dayjs(now) : null;
		this.videoSegments = [];
		this.wantSponsorBlock = true;
		this.votesToSkip.clear();
		this.markDirty("votesToSkip");
		this.markDirty("previousAvailable");
		this.markDirty("playedTracks");
		install();
	}

	/**
	 * Publish a message to the client manager. These messages get broadcasted to all the clients connected, and joined to this room.
	 * @param msg The message to publish.
	 */
	async publish(msg: ServerMessage): Promise<void> {
		roommanager.publish(this.name, msg);
	}

	/**
	 * Send a command to the ClientManager. This is used for things like kicking users, or sending a message to a specific client.
	 */
	async command(cmd: ClientManagerCommand): Promise<void> {
		roommanager.command(this.name, cmd);
	}

	async publishRoomEvent(
		request: RoomRequest,
		context: RoomRequestContext,
		additional?: RoomEventContext,
	): Promise<void> {
		if (context.clientId === undefined) {
			this.log.warn("context.clientId was undefined, not publishing event");
			return;
		}
		const user = this.getUserInfo(context.clientId);
		await this.publish({
			action: "event",
			request,
			user,
			additional: additional ?? {},
		});
	}

	isOwner(user: RoomUser): boolean {
		return !!user.user && !!this.owner && user.user.id === this.owner.id;
	}

	get hasOwner(): boolean {
		return !!this.owner;
	}

	getRole(user?: RoomUser): Role {
		if (!user) {
			return Role.UnregisteredUser;
		}
		if (this.isOwner(user)) {
			return Role.Owner;
		}
		if (user.user) {
			for (let i = Role.Administrator; i >= Role.TrustedUser; i--) {
				if (this.userRoles.get(i)?.has(user.user.id)) {
					return i;
				}
			}
		}
		if (user.isLoggedIn) {
			return Role.RegisteredUser;
		} else {
			return Role.UnregisteredUser;
		}
	}

	async getRoleFromToken(token: AuthToken): Promise<Role> {
		const session = await tokens.getSessionInfo(token);
		return this.getRoleFromSession(session);
	}

	getRoleFromSession(session: SessionInfo): Role {
		if (session && "user_id" in session) {
			if (this.owner && this.owner.id === session.user_id) {
				return Role.Owner;
			}
			for (let i = Role.Administrator; i >= Role.TrustedUser; i--) {
				if (this.userRoles.get(i)?.has(session.user_id)) {
					return i;
				}
			}
			return Role.RegisteredUser;
		} else {
			return Role.UnregisteredUser;
		}
	}

	getUser(client: ClientId): RoomUser | undefined {
		for (const user of this.realusers) {
			if (user.id === client) {
				return user;
			}
		}
	}

	getUserFromToken(token: AuthToken): RoomUser | undefined {
		for (const user of this.realusers) {
			if (user.token === token) {
				return user;
			}
		}
	}

	getUserInfo(client: ClientId): RoomUserInfo {
		for (const user of this.users) {
			if (user.id === client) {
				return user;
			}
		}
		throw new Error("Client not found");
	}

	async getUserInfoFromToken(
		token: AuthToken,
	): Promise<Pick<RoomUserInfo, "name" | "isLoggedIn">> {
		if (!token) {
			throw new Error("token is a required parameter.");
		}
		const session: SessionInfo = await tokens.getSessionInfo(token);
		if (!session) {
			this.log.error("Session info for auth token was not found.");
			throw new Error("Session info not found.");
		}
		if (session.isLoggedIn) {
			const user = await usermanager.getUser({ id: session.user_id });
			return {
				name: user.username,
				isLoggedIn: true,
			};
		} else {
			return {
				name: session.username,
				isLoggedIn: false,
			};
		}
	}

	getClientIdFromToken(token: AuthToken): Result<ClientId, ClientNotFoundInRoomException> {
		for (const user of this.realusers) {
			if (user.token === token) {
				return ok(user.id);
			}
		}
		return err(new ClientNotFoundInRoomException(this.name));
	}

	/** Get how much time (in seconds) has elapsed, in terms of where the playback head should be, since playback started. Returns 0 if the media is not playing. */
	calcDurationFromPlaybackStart(): number {
		if (this._playbackStart !== null) {
			return calculateCurrentPosition(this._playbackStart, dayjs(), 0, this.playbackSpeed);
		} else {
			return 0;
		}
	}

	get realPlaybackPosition(): number {
		if (this._playbackStart && this.isPlaying) {
			return this.playbackPosition + this.calcDurationFromPlaybackStart();
		} else {
			return this.playbackPosition;
		}
	}

	get voteCounts(): Map<string, number> {
		const counts = new Map();
		for (const [vid, votes] of this.votes.entries()) {
			counts.set(vid, votes.size);
		}
		return counts;
	}

	public update(): Promise<void> {
		if (this.updatePending) {
			return this.updatePending;
		}
		const work = () => this.updateOnce();
		this.updatePending = (async () => {
			try {
				await (this.queueMode === QueueMode.Music ? work() : this.withPlaybackLock(work));
			} finally {
				this.updatePending = undefined;
			}
		})();
		return this.updatePending;
	}
	private async updateOnce(): Promise<void> {
		if (this.queueMode === QueueMode.Music) {
			await this.musicEngine.refresh();
		}
		if (this.currentSource === undefined) {
			this.currentSource = null; // sanity check
		}

		if (
			(this.queueMode !== QueueMode.Music || !this.musicEngine.isAdvancing) &&
			((this.currentSource === null &&
				(this.queueMode === QueueMode.Music
					? (this.music?.queueTotal ?? 0) > 0
					: this.queue.length > 0)) ||
				(this.currentSource &&
					this.isPlaying &&
					(this.queueMode !== QueueMode.Music ||
						(this.currentSource.endAt ?? this.currentSource.length ?? 0) > 0) &&
					this.realPlaybackPosition >
						(this.currentSource.endAt ?? this.currentSource.length ?? 0)))
		) {
			if (
				this.currentSource &&
				this.isPlaying &&
				this.realPlaybackPosition >
					(this.currentSource.endAt ?? this.currentSource.length ?? 0)
			) {
				counterMediaWatched.labels({ service: this.currentSource.service }).inc();
			}
			await this.dequeueNext();
		}

		if (
			this.users.length > 0 &&
			this._keepAlivePing.add(conf.get("room.unload_after") * 0.5, "second").isBefore(dayjs())
		) {
			this._keepAlivePing = dayjs();
			await redisClient.expire(`room:${this.name}`, conf.get("room.expire_after"));
		}

		// sort queue according to queue mode
		if (this.queueMode === QueueMode.Vote) {
			await this.queue.orderBy(
				[
					video => {
						const votes = this.votes.get(video.service + video.id);
						return votes ? votes.size : 0;
					},
				],
				["desc"],
			);
		}

		if (conf.get("video.sponsorblock.enabled") && this.autoSkipSegmentCategories.length > 0) {
			if (this.wantSponsorBlock) {
				this.wantSponsorBlock = false; // Disable this before the request to avoid spamming the sponsorblock if the request takes too long.
				try {
					await this.fetchSponsorBlockSegments();
				} catch (e) {
					if (e instanceof SponsorblockResponseError) {
						if (e.status === 429) {
							this.log.error(`Request to sponsorblock was ratelimited. ${e.message}`);
						} else if (e.status === 404) {
							this.log.debug("No sponsorblock segments available for this video.");
						} else {
							this.log.error(
								`Failed to grab sponsorblock segments: ${e.name} ${e.status} ${e.message}`,
							);
						}
					} else {
						this.log.error(`Failed to grab sponsorblock segments`);
					}
				}
			}

			if (
				this.dontSkipSegmentsUntil &&
				this.realPlaybackPosition >= this.dontSkipSegmentsUntil
			) {
				this.dontSkipSegmentsUntil = null;
			}

			if (
				this.isPlaying &&
				this.videoSegments.length > 0 &&
				this.dontSkipSegmentsUntil === null
			) {
				const segment = this.getSegmentForTime(this.realPlaybackPosition);
				if (segment && this.autoSkipSegmentCategories.includes(segment.category)) {
					this.log.silly(`Segment ${segment.category} is now playing, skipping`);
					if (this.queueMode === QueueMode.Music) {
						await this.musicEngine.setPlayback({
							playbackPosition: segment.endTime,
							playbackStart: new Date().toISOString(),
						});
					} else {
						this.seekRaw(segment.endTime);
					}
					await this.publish({
						action: "eventcustom",
						text: `Skipped ${segment.category}`,
					});
				}
			}
		}
	}

	throttledSync = _.debounce(this.sync, 50, { trailing: true });

	/**
	 * Serialize the room's state so that it can be stored in redis
	 */
	public serializeState(): string {
		const state: RoomStateStorable = _.pick(this, ...storableProps);

		return JSON.stringify(state, replacer);
	}

	public syncableState(): RoomStateSyncable {
		const sync = _.pick(this, syncableProps);
		sync.playbackPosition = this.realPlaybackPosition;
		if (this.queueMode === QueueMode.Music) {
			sync.queue = new VideoQueue();
			sync.prevQueue = null;
		}
		return sync;
	}

	public serializeSyncableState(): string {
		const state: RoomStateSyncable = this.syncableState();

		return JSON.stringify(state, replacer);
	}

	private async saveStateToRedis(): Promise<void> {
		this.log.debug("saving full state in redis");
		await redisClient.set(`room:${this.name}`, this.serializeState(), {
			EX: conf.get("room.expire_after"),
		});
	}

	saveStateToRedisDebounced = _.debounce(this.saveStateToRedis, 5000);

	private buildPreviousQueue(): QueueItem[] | null {
		const prevQueue = [...this.queue.items];
		if (this.currentSource) {
			prevQueue.unshift({
				...this.currentSource,
				startAt: this.realPlaybackPosition,
			});
		}
		return prevQueue.length > 0 ? prevQueue : null;
	}

	public async sync(): Promise<void> {
		if (this._dirty.size === 0) {
			return;
		}

		this.log.debug(`synchronizing dirty props: ${Array.from(this._dirty).toString()}`);

		let msg: ServerMessageSync = {
			action: "sync",
		};

		const dirtyProps = Array.from(this._dirty);
		const state: RoomStateSyncable = this.syncableState();
		const isAnyDirtyStorable =
			dirtyProps.includes("music") ||
			dirtyProps.some(prop => storableProps.includes(prop as any));

		msg = Object.assign(msg, _.pick(state, dirtyProps));
		if (isAnyDirtyStorable) {
			await this.saveStateToRedisDebounced();
		}
		if (!_.isEmpty(msg)) {
			this.log.debug("sending sync message");
			await this.publish(msg);
		}

		const settings: Partial<RoomStatePersistable> = _.pick(
			this,
			"name",
			"title",
			"description",
			"visibility",
			"queueMode",
			"autoSkipSegmentCategories",
			"grants",
			"userRoles",
			"owner",
		);
		if (
			this.queueMode !== QueueMode.Music &&
			!this.isTemporary &&
			(dirtyProps.includes("queue") || dirtyProps.includes("currentSource"))
		) {
			settings.prevQueue = this.buildPreviousQueue();
		} else if (dirtyProps.includes("prevQueue")) {
			settings.prevQueue = this.prevQueue;
		}
		if (!_.isEmpty(settings)) {
			await storage.updateRoom({
				...settings,
			});
		}

		this.cleanDirty();
	}

	public async syncUser(info: RoomUserInfo): Promise<void> {
		this.log.debug(`syncing user: ${info.name}`);
		await this.publish({
			action: "user",
			update: {
				kind: "update",
				value: info,
			},
		});
	}

	public async onBeforeUnload(): Promise<void> {
		await this.saveStateToRedisDebounced.flush();

		if (!this.isTemporary && this.queueMode !== QueueMode.Music) {
			await storage.updateRoom({
				name: this.name,
				prevQueue: this.buildPreviousQueue(),
			});
		}
	}

	/**
	 * If true, the room is stale, and should be unloaded.
	 */
	get isStale(): boolean {
		const staleTime = dayjs().diff(this._keepAlivePing, "seconds");
		return staleTime > conf.get("room.unload_after");
	}

	public isVideoInQueue(video: VideoId): boolean {
		if (
			this.currentSource &&
			this.currentSource.service === video.service &&
			this.currentSource.id === video.id
		) {
			return true;
		}
		return this.queue.contains(video);
	}

	/**
	 * Grabs video segments from Sponsorblock for the current video.
	 */
	async fetchSponsorBlockSegments(): Promise<void> {
		if (!this.currentSource || this.currentSource.service !== "youtube") {
			if (this.videoSegments.length > 0) {
				this.videoSegments = [];
			}
			return;
		}
		this.log.info(
			`fetching sponsorblock segments for ${this.currentSource.service}:${this.currentSource.id}`,
		);
		const occurrence = this.journal.occurrenceId;
		const segments = await fetchSegments(this.currentSource.id);
		if (occurrence === this.journal.occurrenceId) {
			this.videoSegments = segments;
		}
	}

	/** Updates playbackPosition according to the computed value, and resets _playbackStart */
	flushPlaybackPosition(): void {
		counterSecondsWatched
			.labels({ service: this.currentSource?.service })
			.inc(this.calcDurationFromPlaybackStart());
		this.playbackPosition = this.realPlaybackPosition;
		this._playbackStart = dayjs();
	}

	getSegmentForTime(time: number): Segment | undefined {
		for (const segment of this.videoSegments) {
			if (time >= segment.startTime && time <= segment.endTime) {
				return segment;
			}
		}
	}

	public async deriveRequestContext(
		authorization: RoomRequestAuthorization,
	): Promise<RoomRequestContext> {
		authorization.assertCurrent?.();
		if (authorization.clientId) {
			const user = this.getUser(authorization.clientId);
			if (user) {
				return {
					username: user.username,
					role: this.getRole(user),
					clientId: authorization.clientId,
					auth: authorization,
				};
			}
		}

		// the user is not in the room, but they may have a valid session

		const session = await tokens.getSessionInfo(authorization.token);
		if (!session) {
			throw new Error("Invalid token, unauthorized request");
		}

		let username: string;
		if (session.isLoggedIn) {
			const user = await usermanager.getUser({ id: session.user_id });
			username = user.username;
		} else {
			username = session.username;
		}
		authorization.assertCurrent?.();

		return {
			username,
			role: this.getRoleFromSession(session),
			clientId: authorization.clientId,
			auth: authorization,
		};
	}

	public async processUnauthorizedRequest(
		request: RoomRequest,
		authorization: RoomRequestAuthorization,
	): Promise<void> {
		if (!authorization.clientId) {
			const id = this.getClientIdFromToken(authorization.token);
			if (id.ok) {
				authorization.clientId = id.value;
			}
		}
		await this.processRequest(request, await this.deriveRequestContext(authorization));
	}

	/** Process the room request, but unsafely trust the client id of the room request */
	public async processRequestUnsafe(request: RoomRequest, clientid: ClientId): Promise<void> {
		const userInfo = this.getUserInfo(clientid);
		await this.processRequest(request, {
			username: userInfo.name,
			role: userInfo.role,
			clientId: clientid,
		});
	}

	public async processRequest(request: RoomRequest, context: RoomRequestContext): Promise<void> {
		context.auth?.assertCurrent?.();
		if (
			this.queueMode !== QueueMode.Music &&
			!this.playbackContext.getStore()?.active &&
			![
				RoomRequestType.JoinRequest,
				RoomRequestType.LeaveRequest,
				RoomRequestType.UpdateUser,
			].includes(request.type)
		) {
			return this.withPlaybackLock(async () => {
				const live = context.auth ? await this.deriveRequestContext(context.auth) : context;
				await this.processRequest(request, live);
			});
		}
		if (!isRoomRequestType(request?.type)) {
			throw new OttException("Invalid room request type");
		}
		counterRoomRequests.labels({ type: RoomRequestType[request.type] }).inc();
		const permissions = new Map([
			[RoomRequestType.PlaybackRequest, "playback.play-pause"],
			[RoomRequestType.SkipRequest, "playback.skip"],
			[RoomRequestType.SeekRequest, "playback.seek"],
			[RoomRequestType.AddRequest, "manage-queue.add"],
			[RoomRequestType.UpdateQueueItemRequest, "manage-queue.edit"],
			[RoomRequestType.RemoveRequest, "manage-queue.remove"],
			[RoomRequestType.OrderRequest, "manage-queue.order"],
			[RoomRequestType.VoteRequest, "manage-queue.vote"],
			[RoomRequestType.ChatRequest, "chat"],
			[RoomRequestType.PlayNowRequest, "manage-queue.play-now"],
			[RoomRequestType.ShuffleRequest, "manage-queue.order"],
			[RoomRequestType.PlaybackSpeedRequest, "playback.speed"],
			[RoomRequestType.KickRequest, "manage-users.kick"],
		]);
		const permission = permissions.get(request.type);
		if (permission) {
			this.grants.check(context.role, permission);
		}

		this.log.debug(
			`processing request: ${request.type} for ${context.username} (client: ${context.clientId})`,
		);

		type RoomRequestHandlers = Omit<
			PickFunctions<Room, RoomRequestBase, RoomRequestContext>,
			"processRequest" | "publishRoomEvent"
		>;
		const handlers: Record<RoomRequestType, keyof RoomRequestHandlers | null> = {
			[RoomRequestType.JoinRequest]: "joinRoom",
			[RoomRequestType.LeaveRequest]: "leaveRoom",
			[RoomRequestType.PlaybackRequest]: "playback",
			[RoomRequestType.SkipRequest]: "skip",
			[RoomRequestType.SeekRequest]: "seek",
			[RoomRequestType.AddRequest]: "addToQueue",
			[RoomRequestType.UpdateQueueItemRequest]: "updateQueueItem",
			[RoomRequestType.RemoveRequest]: "removeFromQueue",
			[RoomRequestType.OrderRequest]: "reorderQueue",
			[RoomRequestType.VoteRequest]: "vote",
			[RoomRequestType.PromoteRequest]: "promoteUser",
			[RoomRequestType.UpdateUser]: "updateUser",
			[RoomRequestType.ChatRequest]: "chat",
			[RoomRequestType.UndoRequest]: "undo",
			[RoomRequestType.ApplySettingsRequest]: "applySettings",
			[RoomRequestType.PlayNowRequest]: "playNow",
			[RoomRequestType.ShuffleRequest]: "shuffle",
			[RoomRequestType.PlaybackSpeedRequest]: "setPlaybackSpeed",
			[RoomRequestType.RestoreQueueRequest]: "restoreQueue",
			[RoomRequestType.KickRequest]: "kickUser",
			[RoomRequestType.MusicRoomRequest]: "musicRequest",
		};

		const handler = handlers[request.type];
		if (handler) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			await this[handler](request as any, context);
		} else {
			this.log.error(`No room request handler: ${request.type}`);
		}
	}

	public getGrantsForUser(id: ClientId): GrantMask {
		const user = this.getUser(id);
		if (!user) {
			return 0;
		}
		return this.grants.getMask(this.getRole(user));
	}

	public async setGrants(grants: Grants): Promise<void> {
		this.grants.setAllGrants(grants);
		this.markDirty("grants");
	}

	public async play(): Promise<void> {
		if (this.queueMode !== QueueMode.Music && !this.playbackContext.getStore()?.active) {
			return this.withPlaybackLock(() => this.play());
		}
		if (this.queueMode === QueueMode.Music) {
			await this.musicEngine.setPlayback({ isPlaying: true }, this.requireMusicMode);
			return;
		}
		if (this.isPlaying) {
			this.log.silly("already playing");
			return;
		}
		this.log.debug("playback started");
		this.isPlaying = true;
		this._playbackStart = dayjs();
		this.recordPlayback();
	}

	public async pause(): Promise<void> {
		if (this.queueMode !== QueueMode.Music && !this.playbackContext.getStore()?.active) {
			return this.withPlaybackLock(() => this.pause());
		}
		if (this.queueMode === QueueMode.Music) {
			await this.musicEngine.setPlayback({ isPlaying: false }, this.requireMusicMode);
			return;
		}
		if (!this.isPlaying) {
			this.log.silly("already paused");
			return;
		}
		this.log.debug("playback paused");
		this.flushPlaybackPosition();
		this._playbackStart = null;
		this.isPlaying = false;
		this.recordPlayback();
	}

	/**
	 * Play or pause the video, depending on the desired state. Handles PlaybackRequest.
	 */
	public async playback(request: PlaybackRequest, context: RoomRequestContext): Promise<void> {
		if (this.queueMode !== QueueMode.Music && !this.playbackContext.getStore()?.active) {
			return this.withPlaybackLock(() => this.playback(request, context));
		}
		if (typeof request.state !== "boolean") {
			throw new OttException("Invalid playback state");
		}
		if (this.queueMode !== QueueMode.Music && context.auth) {
			await (
				this.commandGuards.get(context) ??
				this.legacyAuthorization(context, "playback.play-pause")
			)();
		}
		if (this.queueMode === QueueMode.Music) {
			await this.musicEngine.setPlayback(
				{ isPlaying: request.state },
				this.musicPlaybackAuthorization(context, "playback.play-pause"),
			);
		} else if (request.state) {
			context.auth?.assertCurrent?.();
			await this.play();
		} else {
			context.auth?.assertCurrent?.();
			await this.pause();
		}
		await this.publishRoomEvent(request, context);
	}

	/** Validate sessions in parallel, then inspect membership/roles synchronously after all I/O. */
	private async musicVoteQuorum(
		playbackId: string,
		authorize?: () => Promise<void>,
	): Promise<boolean> {
		const people = this.realusers.map(user => ({ user, token: user.token }));
		const sessions = await Promise.all(
			people.map(async ({ token }) => {
				try {
					return await tokens.getSessionInfo(token);
				} catch {
					return undefined;
				}
			}),
		);
		await authorize?.();
		this.requireMusicMode();
		// Invalid sessions cannot lower the threshold for the remaining voters.
		const eligible = countEligibleVoters(
			this.realusers.map(user => this.getUserInfo(user.id)),
			this.grants,
		);
		const valid = new Set<ClientId>();
		for (const [index, { user, token }] of people.entries()) {
			const session = sessions[index];
			if (!session || this.getUser(user.id) !== user || user.token !== token) {
				continue;
			}
			const identity = musicIdentity({
				token,
				user_id: session.isLoggedIn ? session.user_id : undefined,
			});
			const role = session.isLoggedIn
				? this.getRoleFromSession(session)
				: Role.UnregisteredUser;
			if (identity !== musicIdentity(user) || !this.grants.granted(role, "playback.skip")) {
				continue;
			}
			const vote = this.musicSkipVotes.get(user.id);
			if (
				vote &&
				this.votesToSkip.has(user.id) &&
				vote.user === user &&
				vote.token === token &&
				vote.identity === identity &&
				vote.role === role &&
				vote.mask === this.grants.getMask(role) &&
				vote.playbackId === playbackId
			) {
				valid.add(user.id);
			}
		}
		for (const id of this.votesToSkip) {
			if (!valid.has(id)) {
				this.votesToSkip.delete(id);
				this.musicSkipVotes.delete(id);
				this.markDirty("votesToSkip");
			}
		}
		return eligible > 0 && valid.size >= voteSkipThreshold(eligible);
	}
	private async skipMusic(request: SkipRequest, context: RoomRequestContext): Promise<void> {
		const playbackId = this.music?.current?.playbackId;
		const authorize = this.musicPlaybackAuthorization(context, "playback.skip");
		await this.musicSkipLock.protect(async () => {
			try {
				await authorize();
			} catch (error) {
				if (context.clientId && this.votesToSkip.delete(context.clientId)) {
					this.musicSkipVotes.delete(context.clientId);
					this.markDirty("votesToSkip");
				}
				throw error;
			}
			if (
				!this.currentSource ||
				!playbackId ||
				this.music?.current?.playbackId !== playbackId
			) {
				throw new MusicRoomException("Music occurrence changed during vote validation");
			}
			const user = this.getUser(context.clientId!)!;
			if (this.enableVoteSkip) {
				await this.musicVoteQuorum(playbackId);
				await authorize();
				if (this.music?.current?.playbackId !== playbackId) {
					throw new MusicRoomException("Music occurrence changed during vote validation");
				}
				if (this.votesToSkip.delete(user.id)) {
					this.musicSkipVotes.delete(user.id);
				} else {
					const role = this.getRole(user);
					this.musicSkipVotes.set(user.id, {
						user,
						identity: musicIdentity(user),
						token: user.token,
						role,
						mask: this.grants.getMask(role),
						playbackId,
					});
					this.votesToSkip.add(user.id);
				}
				this.markDirty("votesToSkip");
				if (!(await this.musicVoteQuorum(playbackId))) {
					return;
				}
			}
			const voting = this.enableVoteSkip;
			const guard = Object.assign(
				async () => {
					await authorize();
					if (
						voting &&
						(!this.enableVoteSkip ||
							!(await this.musicVoteQuorum(playbackId, authorize)))
					) {
						throw new MusicRoomException("Music skip quorum changed");
					}
				},
				{ assertCurrent: context.auth?.assertCurrent },
			);
			const current = this.currentSource,
				prevPosition = this.realPlaybackPosition;
			await this.musicEngine.advance("skipped", guard, this.commandClears.get(context));
			this.votesToSkip.clear();
			this.musicSkipVotes.clear();
			this.markDirty("votesToSkip");
			counterMediaSkipped.labels({ service: current.service }).inc();
			await this.publishRoomEvent(request, context, { video: current, prevPosition });
			this.videoSegments = [];
		});
	}
	public async skip(request: SkipRequest, context: RoomRequestContext): Promise<void> {
		if (this.queueMode !== QueueMode.Music && !this.playbackContext.getStore()?.active) {
			return this.withPlaybackLock(() => this.skip(request, context));
		}
		if (!this.currentSource) {
			return;
		}
		if (this.queueMode === QueueMode.Music) {
			await this.skipMusic(request, context);
			return;
		}
		if (context.auth) {
			await (
				this.commandGuards.get(context) ??
				this.legacyAuthorization(context, "playback.skip")
			)();
		}
		let shouldSkip = false;
		context.auth?.assertCurrent?.();
		if (this.enableVoteSkip) {
			if (context.clientId) {
				if (this.votesToSkip.has(context.clientId)) {
					this.log.debug(`removing vote to skip from ${context.clientId}`);
					this.votesToSkip.delete(context.clientId);
				} else {
					this.log.debug(`adding vote to skip from ${context.clientId}`);
					this.votesToSkip.add(context.clientId);
				}
				this.markDirty("votesToSkip");
			}

			const eligibleUsers = countEligibleVoters(
				this.realusers.map(u => this.getUserInfo(u.id)),
				this.grants,
			);
			if (this.votesToSkip.size >= voteSkipThreshold(eligibleUsers)) {
				this.log.debug("vote threshold met, skipping video");
				shouldSkip = true;
			}
		} else {
			shouldSkip = true;
		}

		if (shouldSkip) {
			const current = this.currentSource;
			const prevPosition = this.realPlaybackPosition;
			counterMediaSkipped.labels({ service: this.currentSource.service }).inc();
			await this.dequeueNext(
				this.commandGuards.get(context) ??
					this.legacyAuthorization(context, "playback.skip"),
			);
			await this.publishRoomEvent(request, context, { video: current, prevPosition });
			this.videoSegments = [];
		}
	}

	/**
	 * Seek to the specified position in the video. This does the bare minimum to maintain state and record metrics.
	 */
	private seekRaw(value: number): void {
		PositionSecondsSchema.parse(value);
		const now = Date.now();
		const install = this.journal.stage(
			{
				currentSource: this.currentSource,
				positionSeconds: value,
				isPlaying: this.isPlaying,
				rate: this.playbackSpeed,
			},
			{ seek: true },
			now,
		);
		counterSecondsWatched
			.labels({ service: this.currentSource?.service })
			.inc(this.calcDurationFromPlaybackStart());
		this.playbackPosition = value;
		this._playbackStart = dayjs(now);
		install();
	}

	/**
	 * Seek to the specified position in the video.
	 */
	public async seek(request: SeekRequest, context: RoomRequestContext): Promise<void> {
		if (this.queueMode !== QueueMode.Music && !this.playbackContext.getStore()?.active) {
			return this.withPlaybackLock(() => this.seek(request, context));
		}
		if (request.value === undefined || request.value === null) {
			this.log.error("seek value was undefined or null");
			return;
		}
		PositionSecondsSchema.parse(request.value);
		if (this.queueMode !== QueueMode.Music && context.auth) {
			await (
				this.commandGuards.get(context) ??
				this.legacyAuthorization(context, "playback.seek")
			)();
		}
		const prev = this.realPlaybackPosition;
		if (this.queueMode === QueueMode.Music) {
			await this.musicEngine.setPlayback(
				{
					playbackPosition: request.value,
				},
				this.musicPlaybackAuthorization(context, "playback.seek"),
			);
		} else {
			context.auth?.assertCurrent?.();
			this.seekRaw(request.value);
		}
		await this.publishRoomEvent(request, context, { prevPosition: prev });

		const segment = this.getSegmentForTime(this.playbackPosition);
		if (segment !== undefined) {
			this.dontSkipSegmentsUntil = segment.endTime;
		} else {
			this.dontSkipSegmentsUntil = null;
		}
	}

	/**
	 * Add the video to the queue. Should only be called after permissions have been checked.
	 * @param request
	 */
	public async addToQueue(request: AddRequest, context: RoomRequestContext): Promise<void> {
		this.requireLegacyQueue();
		if (request.url) {
			const adapter = InfoExtract.getServiceAdapterForURL(request.url);
			request.video = {} as VideoId;
			request.video.service = adapter.serviceId;
			request.video.id = adapter.getVideoId(request.url);
		}

		if (request.video) {
			if (this.isVideoInQueue(request.video)) {
				throw new VideoAlreadyQueuedException();
			}

			const video: Video = await InfoExtract.getVideoInfo(
				request.video.service,
				request.video.id,
			);
			if (video === undefined) {
				this.log.error("video was undefined, which is bad");
				throw new Error("video was undefined");
			}
			if (request.video.subtitleUrl) {
				if (getSubtitleFormatFromUrl(request.video.subtitleUrl) === null) {
					this.log.error("subtitle URL has an unsupported extension");
					throw new UnsupportedSubtitleType();
				}
				video.subtitleUrl = request.video.subtitleUrl;
			}
			this.requireLegacyQueue();
			await this.queue.enqueue(video);
			this.log.info(`Video added: ${JSON.stringify(request.video)}`);
			this.prevQueue = null;
			await this.publishRoomEvent(request, context, { video });
			counterMediaQueued.labels({ service: video.service }).inc();
		} else if (request.videos) {
			const { videos } = await InfoExtract.getManyVideoInfo(request.videos);

			for (let i = 0; i < videos.length; i++) {
				const video = videos[i];
				if (video === undefined) {
					this.log.error("video was undefined, which is bad");
					throw new Error("video was undefined");
				}
				if (this.isVideoInQueue(video)) {
					videos.splice(i--, 1);
				}
			}
			if (videos.length === 0) {
				throw new VideoAlreadyQueuedException();
			}

			this.requireLegacyQueue();
			await this.queue.enqueue(...videos);
			this.log.info(`added ${videos.length} videos`);
			await this.publishRoomEvent(request, context, { videos });
			for (const vid of videos) {
				counterMediaQueued.labels({ service: vid.service }).inc();
			}
		} else {
			this.log.error("Invalid parameters for AddRequest");
			return;
		}
	}

	public async updateQueueItem(
		request: UpdateQueueItemRequest,
		context: RoomRequestContext,
	): Promise<void> {
		this.requireLegacyQueue();
		if (
			request.update.subtitleUrl !== undefined &&
			getSubtitleFormatFromUrl(request.update.subtitleUrl) === null
		) {
			throw new UnsupportedSubtitleType();
		}
		await this.queue.update(request.video, request.update);
		this.log.info(`Queue item updated: ${JSON.stringify(request.video)}`);
		await this.publishRoomEvent(request, context);
	}

	public async removeFromQueue(
		request: RemoveRequest,
		context: RoomRequestContext,
	): Promise<void> {
		this.requireLegacyQueue();
		if (!this.queue.contains(request.video)) {
			throw new VideoNotFoundException();
		}
		// remove the item from the queue
		const [matchIdx, removed] = await this.queue.evict(request.video);
		this.log.info(`Video removed: ${JSON.stringify(removed)}`);
		await this.publishRoomEvent(request, context, { video: removed, queueIdx: matchIdx });
	}

	public async reorderQueue(request: OrderRequest, context: RoomRequestContext): Promise<void> {
		this.requireLegacyQueue();
		await this.queue.move(request.fromIdx, request.toIdx);
	}

	public async joinRoom(request: JoinRequest, context: RoomRequestContext): Promise<void> {
		if (!context.auth?.token) {
			this.log.error("Received a join request without an auth token");
			throw new Error("No auth token");
		}
		const user = new RoomUser(request.info.id, context.auth?.token);
		if (this.queueMode === QueueMode.Music) {
			if (request.info.id !== context.clientId) {
				throw new MusicRoomException("Connection identity mismatch");
			}
			await user.updateSession(
				tokens.getSessionInfo(context.auth.token),
				request.info.status,
			);
		} else {
			await user.updateInfo(request.info);
		}
		context.auth.assertCurrent?.();
		const existing = this.realusers.findIndex(person => person.id === user.id);
		if (existing !== -1) {
			// Identity lookups can await; retain the connection's latest local player report.
			user.playerStatus = request.info.status ?? this.realusers[existing].playerStatus;
			this.realusers[existing] = user;
		} else {
			this.realusers.push(user);
		}
		if (this.queueMode === QueueMode.Music) {
			await this.musicEngine.refresh(true);
		}
		context.auth.assertCurrent?.();
		if (existing !== -1) {
			await this.syncUser(this.getUserInfo(user.id));
			return;
		}
		this.log.info(`${user.username} joined the room`);
		await this.publishRoomEvent(request, context);
		// HACK: force the client to receive the correct playback position
		await this.publish({ action: "sync", playbackPosition: this.realPlaybackPosition });
		await this.syncUser(this.getUserInfo(user.id));
	}

	public async leaveRoom(request: LeaveRequest, context: RoomRequestContext): Promise<void> {
		if (context.clientId === undefined) {
			throw new Error("context.clientId was undefined");
		}
		const removed = this.getUserInfo(context.clientId);
		// We must publish the event before removing the user, otherwise publishing the event will fail because the user is gone.
		await this.publishRoomEvent(request, context, { user: removed });

		if (this.enableVoteSkip) {
			this.votesToSkip.delete(context.clientId);
			this.musicSkipVotes.delete(context.clientId);
			this.markDirty("votesToSkip");
		}

		if (this.queueMode === QueueMode.Vote) {
			this.log.debug(`removing votes for leaving client ${context.clientId}`);
			this.votes.forEach(value => {
				if (value.delete(removed.id)) {
					this.markDirty("voteCounts");
				}
			});
		}
		for (let i = 0; i < this.realusers.length; i++) {
			if (this.realusers[i].id === context.clientId) {
				this.realusers.splice(i--, 1);
				// sending the user update to remove the user is handled by clientmanager
				break;
			}
		}
		if (this.queueMode === QueueMode.Music) {
			await this.musicEngine.refresh(true);
		}
	}

	public async updateUser(request: UpdateUser, context: RoomRequestContext): Promise<void> {
		this.log.debug(`User was updated: ${request.info.id} ${JSON.stringify(request.info)}`);
		for (let i = 0; i < this.realusers.length; i++) {
			if (this.realusers[i].id === request.info.id) {
				if (this.queueMode === QueueMode.Music) {
					const person = this.realusers[i];
					const previousIdentity = musicIdentity(person),
						previousName = person.username;
					if (
						!(await person.updateSession(
							tokens.getSessionInfo(person.token),
							request.info.status,
						)) ||
						this.getUser(person.id) !== person
					) {
						return;
					}
					const identityChanged = previousIdentity !== musicIdentity(person);
					const vote = this.musicSkipVotes.get(person.id);
					const role = this.getRole(person);
					if (
						identityChanged ||
						(vote &&
							(vote.user !== person ||
								vote.token !== person.token ||
								vote.identity !== musicIdentity(person) ||
								vote.role !== role ||
								vote.mask !== this.grants.getMask(role) ||
								vote.playbackId !== this.music?.current?.playbackId))
					) {
						this.musicSkipVotes.delete(person.id);
						this.votesToSkip.delete(person.id);
						this.markDirty("votesToSkip");
					}
					if (identityChanged) {
						await this.musicEngine.refresh(true);
					} else if (previousName !== person.username) {
						this.markDirty("music");
					}
				} else {
					await this.realusers[i].updateInfo(request.info);
				}
				await this.syncUser(this.getUserInfo(this.realusers[i].id));
				break;
			}
		}
	}

	public async chat(request: ChatRequest, context: RoomRequestContext): Promise<void> {
		if (context.clientId === undefined) {
			throw new Error("context.clientId was undefined");
		}
		const user = this.getUserInfo(context.clientId);
		await this.publish({
			action: "chat",
			from: user,
			text: request.text,
			sentAt: Date.now(),
		});
	}

	public async undo(request: UndoRequest, context: RoomRequestContext): Promise<void> {
		if (this.queueMode !== QueueMode.Music && !this.playbackContext.getStore()?.active) {
			return this.withPlaybackLock(() => this.undo(request, context));
		}
		this.requireLegacyQueue();
		// FIXME: room event type definitions suck ass, and needs to be reworked
		// Validate all payload fields before any queue/anchor/dirty/publication side effect.
		const additional = request.event.additional;
		switch (request.event.request.type) {
			case RoomRequestType.SeekRequest:
				PositionSecondsSchema.parse(additional.prevPosition);
				break;
			case RoomRequestType.SkipRequest:
				UndoSourceSchema.parse(additional.video);
				PositionSecondsSchema.parse(additional.prevPosition);
				PlaybackRateSchema.parse(this.playbackSpeed);
				break;
			case RoomRequestType.AddRequest:
				UndoSourceSchema.parse(request.event.request.video);
				break;
			case RoomRequestType.RemoveRequest:
				UndoSourceSchema.parse(additional.video);
				z.number().int().min(0).max(this.queue.length).parse(additional.queueIdx);
				break;
		}
		if (context.auth) {
			const permission =
				request.event.request.type === RoomRequestType.SkipRequest
					? "playback.skip"
					: request.event.request.type === RoomRequestType.SeekRequest
						? "playback.seek"
						: "manage-queue.remove";
			await this.legacyAuthorization(context, permission)();
		}
		context.auth?.assertCurrent?.();
		switch (request.event.request.type) {
			case RoomRequestType.SeekRequest:
				if (request.event.additional.prevPosition !== undefined) {
					await this.processRequest(
						{
							type: request.event.request.type,
							value: request.event.additional.prevPosition,
						},
						context,
					);
				}
				break;
			case RoomRequestType.SkipRequest: {
				const source = structuredClone(additional.video!);
				const position = additional.prevPosition!;
				const now = Date.now();
				const install = this.journal.stage(
					{
						currentSource: source,
						positionSeconds: position,
						isPlaying: this.isPlaying,
						rate: this.playbackSpeed,
					},
					{ load: true },
					now,
				);
				if (this.currentSource) {
					this.queue.items.unshift(this.currentSource);
					this.queue.markDirty();
				}
				this.currentSource = source;
				this.playbackPosition = position;
				this._playbackStart = this.isPlaying ? dayjs(now) : null;
				install();
				break;
			}
			case RoomRequestType.AddRequest:
				if (this.queue.length > 0 && request.event.request.video) {
					const removeReq: RemoveRequest = {
						type: RoomRequestType.RemoveRequest,
						video: request.event.request.video,
					};
					await this.processRequest(removeReq, context);
				} else {
					const install = this.journal.stage({
						currentSource: null,
						positionSeconds: this.realPlaybackPosition,
						isPlaying: this.isPlaying,
						rate: this.playbackSpeed,
					});
					this.currentSource = null;
					install();
				}
				break;
			case RoomRequestType.RemoveRequest:
				if (
					request.event.additional.video &&
					request.event.additional.queueIdx !== undefined
				) {
					this.queue.insert(
						request.event.additional.video,
						request.event.additional.queueIdx,
					);
				}
				break;
			default:
				this.log.error(`Event ${request.event.request.type} is not undoable, ignoring`);
				break;
		}
	}

	public async vote(request: VoteRequest, context: RoomRequestContext): Promise<void> {
		this.requireLegacyQueue();
		if (!context.clientId) {
			throw new OttException("Can't vote if not connected to room.");
		}
		const key = request.video.service + request.video.id;
		if (this.votes.has(key)) {
			const votes = this.votes.get(key)!;
			if (request.add) {
				votes.add(context.clientId);
			} else {
				votes.delete(context.clientId);
			}
		} else {
			if (request.add) {
				this.votes.set(key, new Set([context.clientId]));
			}
			// TODO: throw exceptions for invalid votes instead of ignoring them
			// else {
			// 	throw new VoteNotFoundException();
			// }
		}
		this.markDirty("voteCounts");
	}

	public async promoteUser(request: PromoteRequest, context: RoomRequestContext): Promise<void> {
		const targetUser = this.getUser(request.targetClientId);
		if (!targetUser) {
			throw new OttException("Client not found.");
		}
		this.log.info(
			`${context.username} is attempting to promote ${targetUser.username} to role ${request.role}`,
		);

		let perm: string | undefined;
		switch (request.role) {
			case Role.Administrator:
				perm = "manage-users.promote-admin";
				break;
			case Role.Moderator:
				perm = "manage-users.promote-moderator";
				break;
			case Role.TrustedUser:
				perm = "manage-users.promote-trusted-user";
				break;
			default:
				break;
		}
		if (perm) {
			this.grants.check(context.role, perm);
		}
		const targetCurrentRole = this.getRole(targetUser);
		if (request.role < targetCurrentRole) {
			let demotePerm;
			switch (targetCurrentRole) {
				case Role.Administrator:
					demotePerm = "manage-users.demote-admin";
					break;
				case Role.Moderator:
					demotePerm = "manage-users.demote-moderator";
					break;
				case Role.TrustedUser:
					demotePerm = "manage-users.demote-trusted-user";
					break;
				default:
					this.log.error(`Can't demote ${permissions.ROLE_NAMES[targetCurrentRole]}`);
					throw new ImpossiblePromotionException();
			}
			this.grants.check(context.role, demotePerm);
		}

		if (targetCurrentRole === Role.UnregisteredUser) {
			throw new ImpossiblePromotionException();
		}
		if (targetUser.user_id !== undefined) {
			for (let i = Role.Administrator; i >= Role.TrustedUser; i--) {
				const set = this.userRoles.get(i);
				if (set) {
					if (set.has(targetUser.user_id)) {
						set.delete(targetUser.user_id);
					}
					this.userRoles[i] = Array.from(set);
				}
			}
			if (request.role >= Role.TrustedUser) {
				this.userRoles.get(request.role)?.add(targetUser.user_id);
			}
		}
		await this.syncUser(this.getUserInfo(targetUser.id));
		if (!this.isTemporary) {
			try {
				await storage.updateRoom(this);
			} catch (err: unknown) {
				if (err instanceof Error) {
					this.log.error(`Failed to update room: ${err.message} ${err.stack}`);
				} else {
					// eslint-disable-next-line @typescript-eslint/restrict-template-expressions
					this.log.error(
						`Failed to update room, and the error thrown was not Error: ${err}`,
					);
				}
			}
		}
	}

	public async applySettings(
		request: ApplySettingsRequest,
		context: RoomRequestContext,
	): Promise<void> {
		if (request.settings.queueMode === QueueMode.Music && this.queueMode !== QueueMode.Music) {
			// Legacy cached ClientInfo is not an authority for account libraries or ownership.
			for (const user of this.realusers) {
				await user.updateSession(tokens.getSessionInfo(user.token));
			}
			if (context.auth) {
				context = { ...context, role: await this.getRoleFromToken(context.auth.token) };
			} else if (context.clientId) {
				context = { ...context, role: this.getRole(this.getUser(context.clientId)) };
			}
		}
		const propsToPerms: Record<keyof Omit<RoomSettings, "grants">, string> = {
			title: "configure-room.set-title",
			description: "configure-room.set-description",
			visibility: "configure-room.set-visibility",
			queueMode: "configure-room.set-queue-mode",
			autoSkipSegmentCategories: "configure-room.other",
			restoreQueueBehavior: "configure-room.other",
			enableVoteSkip: "configure-room.other",
		};
		const roleToPerms: Record<Exclude<Role, Role.Owner | Role.Administrator>, string> = {
			[Role.UnregisteredUser]: "configure-room.set-permissions.for-all-unregistered-users",
			[Role.RegisteredUser]: "configure-room.set-permissions.for-all-registered-users",
			[Role.TrustedUser]: "configure-room.set-permissions.for-trusted-users",
			[Role.Moderator]: "configure-room.set-permissions.for-moderator",
		};

		// TODO: have clients only send properties that they actually intend to change.
		// For now, we'll determine what the request is trying to change here, and delete the identical fields from the request.
		for (const prop in request.settings) {
			if (Object.hasOwn(propsToPerms, prop)) {
				if (this[prop] === request.settings[prop]) {
					this.log.silly(`deleting ${prop} from request because it did not change`);
					delete request.settings[prop];
				}
			}
		}
		if (request.settings.grants) {
			for (const role of request.settings.grants.getRoles()) {
				if (Object.hasOwn(roleToPerms, role)) {
					if (request.settings.grants.getMask(role) === this.grants.getMask(role)) {
						this.log.silly(
							`deleting permissions for role ${role} from request because it did not change`,
						);
						request.settings.grants.deleteRole(role);
					}
				} else {
					this.log.silly(
						`deleting permissions for role ${role} from request because that role's permissions can't change`,
					);
					request.settings.grants.deleteRole(role);
				}
			}
			if (request.settings.grants.isEmpty) {
				this.log.silly(`deleting grants prop from request because it is empty`);
				delete request.settings.grants;
			}
		}

		// check permissions
		for (const prop in request.settings) {
			if (Object.hasOwn(propsToPerms, prop)) {
				this.grants.check(context.role, propsToPerms[prop]);
			}
		}

		if (request.settings.grants) {
			const newGrants = request.settings.grants;
			for (const role of newGrants.getRoles()) {
				if (Object.hasOwn(roleToPerms, role)) {
					this.grants.check(context.role, roleToPerms[role]);
				}
			}
		}

		let autoSkipSegmentCategoriesChanged = false;
		if (request.settings.autoSkipSegmentCategories) {
			const autoSkipSegmentCategoriesSet = new Set(
				request.settings.autoSkipSegmentCategories,
			);
			if (
				!_.isEqual(autoSkipSegmentCategoriesSet, new Set(this._autoSkipSegmentCategories))
			) {
				request.settings.autoSkipSegmentCategories = ALL_SKIP_CATEGORIES.filter(category =>
					autoSkipSegmentCategoriesSet.has(category),
				);
				autoSkipSegmentCategoriesChanged = true;
			}
		}

		if (
			request.settings.queueMode !== undefined &&
			request.settings.queueMode !== this.queueMode &&
			(this.queueMode === QueueMode.Music || request.settings.queueMode === QueueMode.Music)
		) {
			if (this.currentSource || this.queue.length || (this.music?.queueTotal ?? 0) > 0) {
				throw new MusicRoomException(
					"Music mode changes require an empty room queue and no current source; legacy entries need explicit adoption",
				);
			}
		}
		// Now that we've checked permissions, it's now safe to apply the settings.

		// apply the simple ones
		for (const prop in request.settings) {
			if (Object.hasOwn(propsToPerms, prop)) {
				this[prop] = request.settings[prop];
			}
		}

		if (this.queueMode === QueueMode.Music) {
			await this.initializeMusic();
			await this.musicEngine.refresh(true);
		}
		// special handling required for permissions
		if (request.settings.grants) {
			for (const role of request.settings.grants.getRoles()) {
				if (Object.hasOwn(roleToPerms, role)) {
					this.grants.setRoleGrants(role, request.settings.grants.getMask(role));
					this.markDirty("grants");
				}
			}
		}

		// go grab segments if being enabled while a video is playing
		if (
			autoSkipSegmentCategoriesChanged &&
			this.autoSkipSegmentCategories.length > 0 &&
			this.videoSegments.length === 0 &&
			this.currentSource
		) {
			this.wantSponsorBlock = true;
		}
	}

	/**
	 * Request that the room play a video immediately, pushing the current video to the queue. If the video is already in the queue, it will be removed from the queue and start playing. If the video is already playing, this will be ignored.
	 */
	public async playNow(request: PlayNowRequest, context: RoomRequestContext): Promise<void> {
		if (this.queueMode !== QueueMode.Music && !this.playbackContext.getStore()?.active) {
			return this.withPlaybackLock(() => this.playNow(request, context));
		}
		this.requireLegacyQueue();
		if (
			this.currentSource !== null &&
			this.currentSource.service === request.video.service &&
			this.currentSource.id === request.video.id
		) {
			// already playing, ignore
			return;
		}

		// First, we need to determine what permissions we need to check for this request.
		const authorize = this.legacyAuthorization(context, "manage-queue.play-now");
		const alreadyInQueue = this.isVideoInQueue(request.video); // So we don't need to calculate this again later.
		if (alreadyInQueue) {
			this.grants.check(context.role, "manage-queue.order");
		} else {
			this.grants.check(context.role, "manage-queue.add");
		}

		let videoToPlay: Video;
		if (alreadyInQueue) {
			videoToPlay = this.queue.items.find(
				item => item.service === request.video.service && item.id === request.video.id,
			)!;
		} else {
			videoToPlay = await InfoExtract.getVideoInfo(request.video.service, request.video.id);
		}
		this.requireLegacyQueue();
		await this.commandGuards.get(context)?.();
		if (context.auth) {
			await authorize();
			this.grants.check(
				await this.getRoleFromToken(context.auth.token),
				alreadyInQueue ? "manage-queue.order" : "manage-queue.add",
			);
			await authorize();
		}

		context.auth?.assertCurrent?.();
		if (request.video.subtitleUrl) {
			if (getSubtitleFormatFromUrl(request.video.subtitleUrl) === null) {
				this.log.error("subtitle URL has an unsupported extension");
				throw new UnsupportedSubtitleType();
			}
			videoToPlay.subtitleUrl = request.video.subtitleUrl;
		}
		if (alreadyInQueue) {
			this.queue.items.splice(this.queue.findIndex(request.video), 1);
		}
		if (this.currentSource) {
			this.rememberPrevious(this.currentSource);
			this.queue.items.unshift({ ...this.currentSource, startAt: this.realPlaybackPosition });
		}
		this.queue.markDirty();
		this.currentSource = videoToPlay;
		this.markDirty("queue");
		this.playbackPosition = 0;
		this._playbackStart = dayjs();
		this.videoSegments = [];
		if (this.autoSkipSegmentCategories.length > 0) {
			this.wantSponsorBlock = true;
		}
		this.recordPlayback({ load: true });
	}

	public async shuffle(request: ShuffleRequest, context: RoomRequestContext): Promise<void> {
		this.grants.check(context.role, "manage-queue.order");
		if (this.queueMode === QueueMode.Music) {
			await this.initializeMusic();
			const user = context.clientId ? this.getUser(context.clientId) : undefined;
			if (!user) {
				throw new MusicRoomException("Join the room before shuffling music");
			}
			await this.musicEngine.execute(
				{
					action: "replan",
					content: "keep",
					correlationId: "shuffle",
					expectedRevision: this.music!.revision,
				},
				musicIdentity(user),
				() => this.grants.check(this.getRole(user), "manage-queue.order"),
			);
			return;
		}
		await this.queue.shuffle();
	}

	public async setPlaybackSpeed(
		request: PlaybackSpeedRequest,
		context: RoomRequestContext,
	): Promise<void> {
		if (this.queueMode !== QueueMode.Music && !this.playbackContext.getStore()?.active) {
			return this.withPlaybackLock(() => this.setPlaybackSpeed(request, context));
		}
		PlaybackRateSchema.parse(request.speed);
		if (this.queueMode !== QueueMode.Music && context.auth) {
			await (
				this.commandGuards.get(context) ??
				this.legacyAuthorization(context, "playback.speed")
			)();
		}
		if (this.queueMode === QueueMode.Music) {
			await this.musicEngine.setPlayback(
				{
					playbackSpeed: request.speed,
				},
				this.musicPlaybackAuthorization(context, "playback.speed"),
			);
			return;
		}
		context.auth?.assertCurrent?.();
		this.flushPlaybackPosition();
		this.playbackSpeed = request.speed;
		this.recordPlayback();
	}

	public async restoreQueue(
		request: RestoreQueueRequest,
		_context: RoomRequestContext,
	): Promise<void> {
		this.requireLegacyQueue();
		if (this.prevQueue === null) {
			throw new Error("No previous queue to restore");
		}

		if (request.discard) {
			this.log.debug("Discarding previous queue");
			this.prevQueue = null;
			return;
		} else {
			await this.queue.enqueue(...this.prevQueue);
			this.prevQueue = null;
		}
	}

	public async kickUser(request: KickRequest, context: RoomRequestContext): Promise<void> {
		const user = this.getUser(request.clientId);
		if (!user) {
			throw new ClientNotFoundInRoomException(this.name);
		}
		if (canKickUser(context.role, this.getRole(user))) {
			this.log.info(`${context.username} is kicking ${user.username}`);
			this.command({ type: "kick", clientId: request.clientId });
		} else {
			this.log.warn(
				`${context.username} tried to kick ${user.username} but failed the role check`,
			);
		}
	}
}

const counterSecondsWatched = new Counter({
	name: "ott_media_seconds_played",
	help: "The number of seconds that media has played. Does not account for how many users were in the room.",
	labelNames: ["service"],
});

const counterMediaQueued = new Counter({
	name: "ott_media_queued",
	help: "The number of items that have been added to queues.",
	labelNames: ["service"],
});

const counterMediaSkipped = new Counter({
	name: "ott_media_skipped",
	help: "The number of items that have been manually skipped by users.",
	labelNames: ["service"],
});

const counterMediaWatched = new Counter({
	name: "ott_media_watched",
	help: "The number of items that have been watched to completion.",
	labelNames: ["service"],
});

const counterRoomRequests = new Counter({
	name: "ott_room_requests_received",
	help: "The number of room requests that have been received",
	labelNames: ["type"],
});
