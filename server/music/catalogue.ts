import { musicTransaction } from "./room-music-db.js";
import { musicRoomModels } from "../models/music-room.js";
import { randomUUID, createHash } from "node:crypto";
import { Op, type Sequelize, type Transaction } from "sequelize";
import { z } from "zod";
import { ALL_VIDEO_SERVICES } from "ott-common/constants.js";
import { OttException } from "ott-common/exceptions.js";
import {
	MOOD_ICON_KEYS,
	type AddLibraryTrackRequest,
	type CatalogueChange,
	type LibraryTrack,
	type Mood,
	type MusicPage,
	type MusicQueueItem,
	type Track,
	type TrackSource,
} from "ott-common/models/music.js";
import type { QueueItemExtras, Video, VideoId } from "ott-common/models/video.js";
import * as db from "../models/index.js";
import type { MusicModels } from "../models/music.js";
import InfoExtract from "../infoextractor.js";
import { getLogger } from "../logger.js";

const log = getLogger("music/catalogue");
const WHITESPACE = /\s+/gu;
const URL_TITLE = /^\s*https?:\/\//i;
const CONTROL = /[\p{Cc}\p{Cf}]/u;
const OPAQUE_REFERENCE = /^[\p{L}\p{N}_:.-]+$/u;
const PLUTO_REFERENCE = /^(movies|series)\/[\w-]+(?:\/[\w-]+)?$/;
const LBRY_REFERENCE = /^lbry:\/\/[@\p{L}\p{N}_:./#%~-]+$/u;
const URL_SERVICES = new Set(["direct", "hls", "dash"]);
export const MusicIdSchema = z.string().uuid();
export const MusicPaginationSchema = z
	.object({
		limit: z.coerce.number().int().min(1).max(100).default(50),
		offset: z.coerce.number().int().min(0).max(10000).default(0),
	})
	.strict();
export const CreateMoodSchema = z
	.object({
		name: z
			.string()
			.max(256)
			.transform(value => value.normalize("NFKC").trim().replace(WHITESPACE, " "))
			.pipe(
				z
					.string()
					.min(1)
					.max(64)
					.refine(value => value.toLowerCase().length <= 64)
					.refine(value => !CONTROL.test(value)),
			),
		iconKey: z.enum(MOOD_ICON_KEYS),
	})
	.strict();

export class CatalogueException extends OttException {
	name = "CatalogueException";
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}

/** Only HTTP(S) URL syntax is accepted here; provider adapters retain their own access policies. */
export function validateMusicUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new CatalogueException(400, "Invalid media URL.");
	}
	if (
		!["https:", "http:"].includes(url.protocol) ||
		!url.hostname ||
		url.username ||
		url.password
	) {
		throw new CatalogueException(400, "A shared HTTP(S) media reference is required.");
	}
	return value;
}

export const MusicReferenceSchema = z
	.object({
		service: z.enum(ALL_VIDEO_SERVICES),
		id: z
			.string()
			.min(1)
			.max(2048)
			.refine(value => Buffer.byteLength(value, "utf8") <= 2048)
			.refine(value => !CONTROL.test(value)),
	})
	.strict()
	.superRefine((reference, ctx) => {
		try {
			if (URL_SERVICES.has(reference.service)) {
				validateMusicUrl(reference.id);
			} else if (reference.service === "odysee") {
				if (!LBRY_REFERENCE.test(reference.id)) {
					validateMusicUrl(reference.id);
				}
			} else if (reference.service === "pluto") {
				if (!PLUTO_REFERENCE.test(reference.id)) {
					throw new Error("Invalid Pluto reference");
				}
			} else if (!OPAQUE_REFERENCE.test(reference.id) || reference.id.startsWith("file:")) {
				throw new Error("Invalid provider reference");
			}
		} catch {
			ctx.addIssue({ code: "custom", message: "Invalid provider reference." });
		}
	});
export const AddLibraryTrackSchema = z.union([
	z.object({ reference: MusicReferenceSchema }).strict(),
	z
		.object({
			url: z
				.string()
				.min(1)
				.max(2048)
				.refine(value => {
					try {
						validateMusicUrl(value);
						return true;
					} catch {
						return false;
					}
				}),
		})
		.strict(),
	z.object({ trackId: MusicIdSchema }).strict(),
]);

export interface CatalogueResolver {
	/** Stable adapter identity is separate from the resolved Video, which can be a temporary alias. */
	resolve(reference: VideoId | { url: string }): Promise<{ reference: VideoId; video: Video }>;
	video(source: TrackSource): Promise<Video>;
}

const defaultResolver: CatalogueResolver = {
	async resolve(reference) {
		if ("url" in reference) {
			validateMusicUrl(reference.url);
			const adapter = InfoExtract.getServiceAdapterForURL(reference.url);
			if (adapter.isCollectionURL(reference.url)) {
				throw new CatalogueException(400, "Import one media reference at a time.");
			}
			const identity = { service: adapter.serviceId, id: adapter.getVideoId(reference.url) };
			MusicReferenceSchema.parse(identity);
			return {
				reference: identity,
				video: await InfoExtract.getVideoInfo(identity.service, identity.id),
			};
		}
		return {
			reference,
			video: await InfoExtract.getVideoInfo(reference.service, reference.id),
		};
	},
	async video(source) {
		return InfoExtract.getVideoInfo(source.service, source.providerId);
	},
};

type Listener = (change: CatalogueChange) => void | Promise<void>;
const listeners = new Set<Listener>();
/** Fires only after committed, actual library/annotation changes; favorites never invalidate rooms. */
export function subscribeCatalogueChanges(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
async function notify(change: CatalogueChange): Promise<void> {
	for (const listener of listeners) {
		try {
			await listener(change);
		} catch {
			log.error("Catalogue invalidation listener failed.");
		}
	}
}

/** Stable per provider reference, never inferred from a title or artist. */
function referenceId(kind: "track" | "source", reference: VideoId): string {
	const hex = createHash("sha256")
		.update(JSON.stringify([kind, reference.service, reference.id]))
		.digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export class MusicCatalogue {
	constructor(
		private readonly connection: () => Sequelize = () => db.sequelize,
		private readonly models: () => MusicModels = () => db,
		private readonly resolver: CatalogueResolver = defaultResolver,
	) {}

	private async write<T>(operation: (transaction: Transaction) => Promise<T>): Promise<T> {
		// SQLite permits a single writer. DB uniqueness also arbitrates between server processes.
		return musicTransaction(this.connection(), operation);
	}

	/** Trusted Room-only batch read. Caller supplies authenticated present account IDs;
	 * results contain private tags and provider references and MUST NOT be synchronized. */
	async roomSnapshot(
		userIds: number[],
		occurrenceTrackIds: string[] = [],
		annotationUserIds = userIds,
	) {
		const models = this.models();
		return musicTransaction(
			this.connection(),
			async transaction => {
				const links = await models.UserLibraryTrack.findAll({
					where: { userId: { [Op.in]: userIds } },
					transaction,
				});
				const ids = [
					...new Set([...links.map(row => row.get().trackId), ...occurrenceTrackIds]),
				];
				const tracks: Track[] = [],
					sources: TrackSource[] = [],
					tags: { userId: number; trackId: string; moodId: string }[] = [];
				// Bounded bind batches work in both SQLite and PostgreSQL, even for large libraries.
				for (let offset = 0; offset < ids.length; offset += 400) {
					const trackId = { [Op.in]: ids.slice(offset, offset + 400) };
					tracks.push(
						...(
							await models.Track.findAll({ where: { id: trackId }, transaction })
						).map(row => trackDto(row.get({ plain: true }))),
					);
					sources.push(
						...(
							await models.TrackSource.findAll({ where: { trackId }, transaction })
						).map(row => row.get({ plain: true })),
					);
					tags.push(
						...(
							await models.UserTrackMood.findAll({
								where: { trackId, userId: { [Op.in]: annotationUserIds } },
								transaction,
							})
						).map(row => row.get({ plain: true })),
					);
				}
				const versions = await this.roomVersions(annotationUserIds, transaction);
				const moods = (
					await models.Mood.findAll({
						where: { id: { [Op.in]: [...new Set(tags.map(tag => tag.moodId))] } },
						transaction,
					})
				).map(row => moodDto(row.get({ plain: true })));
				return {
					links: links.map(row => row.get({ plain: true })),
					tracks,
					sources,
					tags,
					moods,
					versions,
				};
			},
			true,
		);
	}
	async roomVersions(userIds: number[], transaction?: Transaction): Promise<string> {
		const rows = await musicRoomModels(this.connection()).Version.findAll({
			where: { userId: { [Op.in]: userIds } },
			transaction,
		});
		return userIds
			.slice()
			.sort((a, b) => a - b)
			.map(id => id + ":" + (rows.find(row => row.get().userId === id)?.get().revision ?? 0))
			.join(",");
	}
	private async invalidateRoomUser(userId: number, transaction: Transaction) {
		const model = musicRoomModels(this.connection()).Version;
		await model.findOrCreate({
			where: { userId },
			defaults: { userId, revision: 0 },
			transaction,
		});
		await model.increment("revision", { where: { userId }, transaction });
	}
	async getTrack(trackId: string): Promise<Track> {
		MusicIdSchema.parse(trackId);
		const row = await this.models().Track.findByPk(trackId);
		if (!row) {
			throw new CatalogueException(404, "Track not found.");
		}
		return trackDto(row.get({ plain: true }));
	}

	/** Trusted server import, also usable for manual room requests without adding a library link. */
	async resolveTrack(
		reference: VideoId | { url: string },
	): Promise<{ track: Track; source: TrackSource }> {
		if ("url" in reference) {
			AddLibraryTrackSchema.parse(reference);
		} else {
			MusicReferenceSchema.parse(reference);
		}
		// Slow provider work must stay outside transactions and room transition locks.
		const { reference: identity, video } = await this.resolver.resolve(reference);
		MusicReferenceSchema.parse(identity);
		return this.write(transaction => this.storeResolved(identity, video, transaction));
	}

	private async storeResolved(identity: VideoId, video: Video, transaction: Transaction) {
		const models = this.models();
		const existing = await models.TrackSource.findOne({
			where: { service: identity.service, providerId: identity.id },
			transaction,
		});
		if (existing) {
			const source = existing.get({ plain: true });
			const track = await models.Track.findByPk(source.trackId, {
				transaction,
				rejectOnEmpty: true,
			});
			return { track: trackDto(track.get({ plain: true })), source };
		}
		const trackId = referenceId("track", identity);
		const [track] = await models.Track.findOrCreate({
			where: { id: trackId },
			defaults: {
				id: trackId,
				title: safeTrackTitle(video.title),
				artists: [],
				styles: [],
				duration:
					video.length !== undefined && Number.isFinite(video.length) && video.length >= 0
						? video.length
						: null,
				artworkUrl: safeArtwork(video.thumbnail),
			},
			transaction,
		});
		const [source] = await models.TrackSource.findOrCreate({
			where: { service: identity.service, providerId: identity.id },
			defaults: {
				id: referenceId("source", identity),
				trackId,
				service: identity.service,
				providerId: identity.id,
				capabilities: {
					seek:
						video.length !== undefined &&
						Number.isFinite(video.length) &&
						video.length > 0,
					backgroundPlayback: "unknown",
				},
				availability: "available",
			},
			transaction,
		});
		return {
			track: trackDto(track.get({ plain: true })),
			source: source.get({ plain: true }),
		};
	}

	/** Trusted bounded provider page; caller owns the lease and shared music transaction. */
	async importReferences(
		userId: number,
		entries: { reference: VideoId; video: Video }[],
		transaction: Transaction,
	) {
		const added: string[] = [];
		const trackIds: string[] = [];
		const changedTracks = new Set<string>();
		for (const { reference, video } of entries) {
			MusicReferenceSchema.parse(reference);
			const { track, source } = await this.storeResolved(reference, video, transaction);
			trackIds.push(track.id);
			const metadata = {
				title: safeTrackTitle(video.title),
				artworkUrl: safeArtwork(video.thumbnail),
				duration:
					Number.isFinite(video.length) && video.length! >= 0
						? video.length!
						: track.duration,
			};
			if (
				metadata.title !== track.title ||
				metadata.artworkUrl !== track.artworkUrl ||
				metadata.duration !== track.duration ||
				source.availability !== "available"
			) {
				changedTracks.add(track.id);
			}
			await this.models().Track.update(metadata, { where: { id: track.id }, transaction });
			await this.models().TrackSource.update(
				{ availability: "available" },
				{ where: { id: source.id }, transaction },
			);
			const [, created] = await this.models().UserLibraryTrack.findOrCreate({
				where: { userId, trackId: track.id },
				defaults: { userId, trackId: track.id, importKind: "reference" },
				transaction,
			});
			if (created) {
				added.push(track.id);
			}
		}
		const changes = new Map<string, CatalogueChange>();
		for (const trackId of added) {
			changes.set(`${userId}:${trackId}`, {
				kind: "library",
				userId,
				trackId,
				action: "added",
			});
		}
		if (changedTracks.size) {
			const owners = await this.models().UserLibraryTrack.findAll({
				attributes: ["userId", "trackId"],
				where: { trackId: { [Op.in]: [...changedTracks] } },
				transaction,
			});
			for (const owner of owners) {
				const { userId: affectedUserId, trackId } = owner.get();
				const key = `${affectedUserId}:${trackId}`;
				if (!changes.has(key)) {
					changes.set(key, {
						kind: "metadata",
						userId: affectedUserId,
						trackId,
						action: "updated",
					});
				}
			}
		}
		// Capture recipients and versions in the same transaction as the shared metadata.
		for (const affectedUserId of [
			...new Set([...changes.values()].map(change => change.userId)),
		].sort((a, b) => a - b)) {
			await this.invalidateRoomUser(affectedUserId, transaction);
		}
		return { added, trackIds, changes: [...changes.values()] };
	}
	async notifyImported(changes: CatalogueChange[]) {
		for (const change of changes) {
			await notify(change);
		}
	}

	async addLibraryTrack(userId: number, input: AddLibraryTrackRequest): Promise<Track> {
		const parsed = AddLibraryTrackSchema.parse(input);
		const track =
			"trackId" in parsed
				? await this.getTrack(parsed.trackId)
				: (await this.resolveTrack("reference" in parsed ? parsed.reference : parsed))
						.track;
		const created = await this.write(async transaction => {
			const [, created] = await this.models().UserLibraryTrack.findOrCreate({
				where: { userId, trackId: track.id },
				defaults: {
					userId,
					trackId: track.id,
					importKind: "trackId" in parsed ? "catalogue" : "reference",
				},
				transaction,
			});
			if (created) {
				await this.invalidateRoomUser(userId, transaction);
			}
			return created;
		});
		if (created) {
			await notify({ kind: "library", userId, trackId: track.id, action: "added" });
		}
		return track;
	}

	async removeLibraryTrack(userId: number, trackId: string): Promise<void> {
		MusicIdSchema.parse(trackId);
		const count = await this.write(async transaction => {
			const count = await this.models().UserLibraryTrack.destroy({
				where: { userId, trackId },
				transaction,
			});
			if (count) {
				await this.invalidateRoomUser(userId, transaction);
			}
			return count;
		});
		if (count) {
			await notify({ kind: "library", userId, trackId, action: "removed" });
		}
	}

	async listLibrary(userId: number, pagination: unknown = {}): Promise<MusicPage<LibraryTrack>> {
		const page = MusicPaginationSchema.parse(pagination);
		const models = this.models();
		const { rows, count } = await models.UserLibraryTrack.findAndCountAll({
			where: { userId },
			order: [
				["createdAt", "ASC"],
				["trackId", "ASC"],
			],
			...page,
		});
		const ids = rows.map(row => row.get().trackId);
		const tracks = await models.Track.findAll({ where: { id: { [Op.in]: ids } } });
		const sources = await models.TrackSource.findAll({ where: { trackId: { [Op.in]: ids } } });
		return {
			...page,
			total: count,
			items: rows.map(row => ({
				track: trackDto(
					tracks
						.find(track => track.get().id === row.get().trackId)!
						.get({ plain: true }),
				),
				sources: sources
					.filter(source => source.get().trackId === row.get().trackId)
					.map(source => {
						const { id, trackId, service, availability, capabilities } = source.get({
							plain: true,
						});
						return { id, trackId, service, availability, capabilities };
					}),
				addedAt: row.createdAt.toISOString(),
				importKind: row.get().importKind,
			})),
		};
	}

	async listMoods(pagination: unknown = {}): Promise<MusicPage<Mood>> {
		const page = MusicPaginationSchema.parse(pagination);
		const { rows, count } = await this.models().Mood.findAndCountAll({
			...page,
			order: [["normalizedName", "ASC"]],
		});
		return { ...page, total: count, items: rows.map(row => moodDto(row.get({ plain: true }))) };
	}

	async createMood(userId: number, input: unknown): Promise<Mood> {
		const parsed = CreateMoodSchema.parse(input);
		const normalizedName = parsed.name.toLowerCase();
		return this.write(async transaction => {
			const [row] = await this.models().Mood.findOrCreate({
				where: { normalizedName },
				defaults: { ...parsed, normalizedName, id: randomUUID(), createdBy: userId },
				transaction,
			});
			// Existing shared moods cannot be renamed or have their icon changed by creation.
			return moodDto(row.get({ plain: true }));
		});
	}

	async listTrackMoods(
		userId: number,
		trackId: string,
		pagination: unknown = {},
	): Promise<MusicPage<Mood>> {
		await this.getTrack(trackId);
		return this.listPersonalMoods(userId, pagination, trackId);
	}
	async listFavorites(userId: number, pagination: unknown = {}): Promise<MusicPage<Mood>> {
		return this.listPersonalMoods(userId, pagination);
	}
	private async listPersonalMoods(
		userId: number,
		pagination: unknown,
		trackId?: string,
	): Promise<MusicPage<Mood>> {
		const page = MusicPaginationSchema.parse(pagination);
		const options = { ...page, order: [["moodId", "ASC"]] as [string, string][] };
		const { rows, count } = trackId
			? await this.models().UserTrackMood.findAndCountAll({
					where: { userId, trackId },
					...options,
				})
			: await this.models().UserFavoriteMood.findAndCountAll({
					where: { userId },
					...options,
				});
		const ids = rows.map(row => row.get().moodId);
		const moods = await this.models().Mood.findAll({ where: { id: { [Op.in]: ids } } });
		return {
			...page,
			total: count,
			items: ids.map(id =>
				moodDto(moods.find(row => row.get().id === id)!.get({ plain: true })),
			),
		};
	}

	async setTrackMood(
		userId: number,
		trackId: string,
		moodId: string,
		active: boolean,
	): Promise<void> {
		await this.getTrack(trackId);
		MusicIdSchema.parse(moodId);
		const changed = await this.write(async transaction => {
			await this.requireMood(moodId, transaction);
			const where = { userId, trackId, moodId };
			if (!active) {
				const count = await this.models().UserTrackMood.destroy({ where, transaction });
				if (count) {
					await this.invalidateRoomUser(userId, transaction);
				}
				return !!count;
			}
			const [, created] = await this.models().UserTrackMood.findOrCreate({
				where,
				defaults: where,
				transaction,
			});
			if (created) {
				await this.invalidateRoomUser(userId, transaction);
			}
			return created;
		});
		if (changed) {
			await notify({
				kind: "annotation",
				userId,
				trackId,
				moodId,
				action: active ? "added" : "removed",
			});
		}
	}

	async setFavorite(userId: number, moodId: string, active: boolean): Promise<void> {
		MusicIdSchema.parse(moodId);
		await this.write(async transaction => {
			await this.requireMood(moodId, transaction);
			const where = { userId, moodId };
			if (active) {
				await this.models().UserFavoriteMood.findOrCreate({
					where,
					defaults: where,
					transaction,
				});
			} else {
				await this.models().UserFavoriteMood.destroy({ where, transaction });
			}
		});
	}
	private async requireMood(moodId: string, transaction: Transaction): Promise<void> {
		if (!(await this.models().Mood.findByPk(moodId, { transaction }))) {
			throw new CatalogueException(404, "Mood not found.");
		}
	}

	/** Caller must authorize library/room access before resolving sensitive provider URLs. */
	async toQueueItem(
		trackId: string,
		sourceId: string,
		extras: QueueItemExtras = {},
	): Promise<MusicQueueItem> {
		await this.getTrack(trackId);
		MusicIdSchema.parse(sourceId);
		const row = await this.models().TrackSource.findOne({ where: { id: sourceId, trackId } });
		if (!row || row.get("availability") === "unavailable") {
			throw new CatalogueException(404, "Playable source not found.");
		}
		const source = row.get({ plain: true });
		const video = await this.resolver.video(source);
		return { ...video, title: safeTrackTitle(video.title), ...extras, trackId, sourceId };
	}
}

function trackDto(track: Track): Track {
	return {
		id: track.id,
		title: safeTrackTitle(track.title),
		artists: track.artists,
		styles: track.styles,
		duration: track.duration,
		artworkUrl: track.artworkUrl,
	};
}
/** Adapters can use a signed playback URL as their fallback title. It is not public metadata.
 * Also sanitize old/truncated URL titles until the cleanup migration has run. */
function safeTrackTitle(title?: string): string {
	return !title || URL_TITLE.test(title) ? "Untitled track" : title.slice(0, 512);
}
function moodDto(mood: Mood): Mood {
	return {
		id: mood.id,
		name: mood.name,
		normalizedName: mood.normalizedName,
		iconKey: mood.iconKey,
	};
}
function safeArtwork(value?: string): string | null {
	if (!value) {
		return null;
	}
	try {
		return validateMusicUrl(value);
	} catch {
		return null;
	}
}

export const musicCatalogue = new MusicCatalogue();
