import { randomUUID } from "node:crypto";
import { Op, QueryTypes, type Sequelize, type Transaction } from "sequelize";
import { z } from "zod";
import type { CatalogueChange, Mood } from "ott-common/models/music.js";
import type {
	MusicAdoption,
	MusicPublication,
	MusicRecommendation,
	RecommendationPage,
} from "ott-common/models/music-recommendations.js";
import * as db from "../models/index.js";
import type { MusicModels } from "../models/music.js";
import { musicRecommendationModels } from "../models/music-recommendations.js";
import {
	CatalogueException,
	MusicIdSchema,
	musicCatalogue,
	safeTrackTitle,
	type MusicCatalogue,
} from "./catalogue.js";
import { musicTransaction } from "./room-music-db.js";

const MoodIds = z
	.array(MusicIdSchema)
	.max(20)
	.refine(ids => new Set(ids).size === ids.length);
export const PublishMusicSchema = z
	.object({ moodIds: MoodIds.refine(ids => ids.length > 0) })
	.strict();
export const AdoptMusicSchema = z.object({ moodIds: MoodIds }).strict();
export const RecommendationQuerySchema = z
	.object({
		moods: z
			.string()
			.max(739)
			.default("")
			.transform(value => (value ? value.split(",") : []))
			.pipe(MoodIds),
		limit: z.coerce.number().int().min(1).max(50).default(20),
		after: MusicIdSchema.optional(),
	})
	.strict();
const unavailable = () => new CatalogueException(404, "Recommendation unavailable.");
const moodDto = (m: Mood): Mood => ({
	id: m.id,
	name: m.name,
	normalizedName: m.normalizedName,
	iconKey: m.iconKey,
});

export class MusicRecommendations {
	constructor(
		private readonly connection: () => Sequelize = () => db.sequelize,
		private readonly catalogue: MusicCatalogue = musicCatalogue,
		private readonly models: () => MusicModels = () => db
	) {}
	private tables() {
		return musicRecommendationModels(this.connection());
	}
	/** Only canonical public-provider identities. URLs, local sources and future services fail closed. */
	private sourcePredicate(alias: string) {
		const identity =
			this.connection().getDialect() === "postgres"
				? `${alias}."providerId" ~ '^[A-Za-z0-9_-]{11}$'`
				: `length(${alias}."providerId") = 11 AND ${alias}."providerId" NOT GLOB '*[^A-Za-z0-9_-]*'`;
		return `${alias}."service" = 'youtube' AND ${alias}."availability" = 'available' AND ${identity}`;
	}
	private async eligible(trackId: string, userId: number, transaction: Transaction) {
		const m = this.models();
		const member = await m.UserLibraryTrack.findOne({
			where: { userId, trackId },
			transaction,
			lock: transaction.LOCK.SHARE,
		});
		const sources = await m.TrackSource.findAll({
			where: { trackId },
			transaction,
			lock: transaction.LOCK.SHARE,
		});
		return (
			!!member &&
			sources.some(row => {
				const s = row.get();
				return (
					s.service === "youtube" &&
					s.availability === "available" &&
					/^[A-Za-z0-9_-]{11}$/.test(s.providerId)
				);
			})
		);
	}
	private async offered(id: string, transaction: Transaction): Promise<Mood[]> {
		const p = await this.tables().Publication.findByPk(id, { transaction });
		if (!p) {
			return [];
		}
		const { userId, trackId } = p.get();
		// Lock the annotations before reading consent: a concurrent tag deletion must complete
		// either before this read (and cascade consent away), or after the adoption commits.
		const own = await this.models().UserTrackMood.findAll({
			where: { userId, trackId },
			transaction,
			lock: transaction.LOCK.SHARE,
		});
		const published = await this.tables().PublishedMood.findAll({
			where: { publicationId: id },
			transaction,
		});
		const ownIds = new Set(own.map(row => row.get().moodId));
		const ids = published.map(row => row.get().moodId).filter(id => ownIds.has(id));
		return (
			await this.models().Mood.findAll({
				where: { id: { [Op.in]: ids } },
				order: [["id", "ASC"]],
				transaction,
			})
		).map(row => moodDto(row.get()));
	}
	async publication(userId: number, trackId: string): Promise<MusicPublication> {
		MusicIdSchema.parse(trackId);
		return musicTransaction(this.connection(), async transaction => {
			const p = await this.tables().Publication.findOne({
				where: { userId, trackId, active: true },
				transaction,
			});
			return {
				eligible: await this.eligible(trackId, userId, transaction),
				moods: p ? await this.offered(p.get().id, transaction) : [],
			};
		});
	}
	async publish(userId: number, trackId: string, input: unknown): Promise<MusicPublication> {
		MusicIdSchema.parse(trackId);
		const { moodIds } = PublishMusicSchema.parse(input);
		await musicTransaction(this.connection(), async transaction => {
			// An existing account row serializes the first publication of an absent user/track pair.
			await this.connection().models.User.findByPk(userId, {
				transaction,
				lock: transaction.LOCK.UPDATE,
				rejectOnEmpty: true,
			});
			const { Publication, PublishedMood } = this.tables();
			const [p] = await Publication.findOrCreate({
				where: { userId, trackId },
				defaults: { id: randomUUID(), userId, trackId, active: false },
				transaction,
			});
			await p.reload({ transaction, lock: transaction.LOCK.UPDATE });
			if (!(await this.eligible(trackId, userId, transaction))) {
				throw unavailable();
			}
			const own = await this.models().UserTrackMood.findAll({
				where: { userId, trackId, moodId: { [Op.in]: moodIds } },
				transaction,
				lock: transaction.LOCK.SHARE,
			});
			if (own.length !== moodIds.length) {
				throw new CatalogueException(400, "Select only your own current annotations.");
			}
			await PublishedMood.destroy({ where: { publicationId: p.get().id }, transaction });
			await PublishedMood.bulkCreate(
				moodIds.map(moodId => ({ publicationId: p.get().id, userId, trackId, moodId })),
				{ transaction }
			);
			await p.update({ active: true }, { transaction });
		});
		return this.publication(userId, trackId);
	}
	async withdraw(userId: number, trackId: string): Promise<void> {
		MusicIdSchema.parse(trackId);
		await musicTransaction(this.connection(), async transaction => {
			await this.connection().models.User.findByPk(userId, {
				transaction,
				lock: transaction.LOCK.UPDATE,
				rejectOnEmpty: true,
			});
			const p = await this.tables().Publication.findOne({
				where: { userId, trackId },
				transaction,
				lock: transaction.LOCK.UPDATE,
			});
			if (!p) {
				return;
			}
			await p.update({ active: false }, { transaction });
			await this.tables().PublishedMood.destroy({
				where: { publicationId: p.get().id },
				transaction,
			});
		});
	}
	async discover(userId: number, input: unknown = {}): Promise<RecommendationPage> {
		const { moods, after, limit } = RecommendationQuerySchema.parse(input);
		return musicTransaction(
			this.connection(),
			async transaction => {
				const requested = moods
					.map(
						(_, i) =>
							`AND EXISTS (SELECT 1 FROM "MusicPublicationMoods" pm JOIN "UserTrackMoods" um ON um."userId" = pm."userId" AND um."trackId" = pm."trackId" AND um."moodId" = pm."moodId" WHERE pm."publicationId" = p."id" AND pm."moodId" = :m${i})`
					)
					.join(" ");
				const rows = await this.connection().query<{ trackId: string; id: string }>(
					`
				SELECT p."trackId", MIN(CAST(p."id" AS TEXT)) AS "id" FROM "MusicPublications" p
				WHERE p."active" = true AND p."userId" <> :userId
				AND EXISTS (SELECT 1 FROM "UserLibraryTracks" l WHERE l."userId" = p."userId" AND l."trackId" = p."trackId")
				AND NOT EXISTS (SELECT 1 FROM "UserLibraryTracks" l WHERE l."userId" = :userId AND l."trackId" = p."trackId")
				AND NOT EXISTS (SELECT 1 FROM "MusicRecommendationAdoptions" a WHERE a."userId" = :userId AND a."publicationId" = p."id")
				AND EXISTS (SELECT 1 FROM "TrackSources" s WHERE s."trackId" = p."trackId" AND ${this.sourcePredicate(
					"s"
				)})
				AND EXISTS (SELECT 1 FROM "MusicPublicationMoods" pm JOIN "UserTrackMoods" um ON um."userId" = pm."userId" AND um."trackId" = pm."trackId" AND um."moodId" = pm."moodId" WHERE pm."publicationId" = p."id")
				${requested} ${after ? 'AND p."trackId" > :after' : ""}
				GROUP BY p."trackId" ORDER BY p."trackId" ASC LIMIT :limit`,
					{
						type: QueryTypes.SELECT,
						transaction,
						replacements: {
							userId,
							after,
							limit: limit + 1,
							...Object.fromEntries(moods.map((id, i) => [`m${i}`, id])),
						},
					}
				);
				const items: MusicRecommendation[] = [];
				for (const row of rows.slice(0, limit)) {
					const track = (
						await this.models().Track.findByPk(row.trackId, {
							transaction,
							rejectOnEmpty: true,
						})
					).get();
					items.push({
						id: row.id,
						track: {
							id: track.id,
							title: safeTrackTitle(track.title),
							artists: track.artists.map(safeTrackTitle),
							styles: track.styles.map(safeTrackTitle),
							duration: track.duration,
						},
						moods: await this.offered(row.id, transaction),
					});
				}
				return { items, next: rows.length > limit ? items.at(-1)!.track.id : null };
			},
			true
		);
	}
	async adopt(userId: number, id: string, input: unknown): Promise<MusicAdoption> {
		MusicIdSchema.parse(id);
		const { moodIds } = AdoptMusicSchema.parse(input);
		const result = await musicTransaction(this.connection(), async transaction => {
			const m = this.models();
			const { Publication, Adoption } = this.tables();
			const p = await Publication.findByPk(id, {
				transaction,
				lock: transaction.LOCK.UPDATE,
			});
			// Unknown, private and revoked IDs share the same response, even on retries.
			if (!p || !p.get().active || p.get().userId === userId) {
				throw unavailable();
			}
			const { trackId, userId: publisher } = p.get();
			if (!(await this.eligible(trackId, publisher, transaction))) {
				throw unavailable();
			}
			const offered = await this.offered(id, transaction);
			if (!offered.length) {
				throw unavailable();
			}
			const where = { userId, trackId };
			const changes: CatalogueChange[] = [];
			const receipt = await Adoption.findOne({
				where: { userId, publicationId: id },
				transaction,
			});
			if (!receipt) {
				if (moodIds.some(id => !offered.some(m => m.id === id))) {
					throw new CatalogueException(400, "Select only currently offered moods.");
				}
				const [, created] = await m.UserLibraryTrack.findOrCreate({
					where,
					defaults: { ...where, importKind: "catalogue" },
					transaction,
				});
				if (!created) {
					throw new CatalogueException(409, "Track already in your library.");
				}
				changes.push({ kind: "library", ...where, action: "added" });
				for (const moodId of moodIds) {
					const [, added] = await m.UserTrackMood.findOrCreate({
						where: { ...where, moodId },
						defaults: { ...where, moodId },
						transaction,
					});
					if (added) {
						changes.push({ kind: "annotation", ...where, moodId, action: "added" });
					}
				}
				await Adoption.create({ userId, publicationId: id }, { transaction });
				await this.catalogue.invalidateLibraryAdoption(userId, transaction);
			}
			const inLibrary = !!(await m.UserLibraryTrack.findOne({ where, transaction }));
			const tags = await m.UserTrackMood.findAll({
				where,
				transaction,
				order: [["moodId", "ASC"]],
			});
			return {
				adoption: { trackId, inLibrary, moodIds: tags.map(row => row.get().moodId) },
				changes,
			};
		});
		await this.catalogue.notifyImported(result.changes);
		return result.adoption;
	}
}
export const musicRecommendations = new MusicRecommendations();
