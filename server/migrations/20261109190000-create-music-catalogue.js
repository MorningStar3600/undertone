"use strict";

/** Additive, transactional schema; intentionally never reads CachedVideos. */
module.exports = {
	async up(q, S) {
		await q.sequelize.transaction(async transaction => {
			const options = { transaction };
			const timestamps = () => ({
				createdAt: { type: S.DATE, allowNull: false },
				updatedAt: { type: S.DATE, allowNull: false },
			});
			const key = () => ({ type: S.UUID, primaryKey: true, allowNull: false });
			const foreignKey = (model, type = S.UUID) => ({
				type,
				primaryKey: true,
				allowNull: false,
				references: { model, key: "id" },
				onDelete: "CASCADE",
			});
			await q.createTable(
				"Tracks",
				{
					id: key(),
					title: { type: S.STRING(512), allowNull: false },
					artists: { type: S.JSON, allowNull: false },
					styles: { type: S.JSON, allowNull: false },
					duration: { type: S.DOUBLE, allowNull: true },
					artworkUrl: { type: S.TEXT, allowNull: true },
					...timestamps(),
				},
				options,
			);
			await q.createTable(
				"TrackSources",
				{
					id: key(),
					trackId: { ...foreignKey("Tracks"), primaryKey: false },
					service: { type: S.STRING(32), allowNull: false },
					providerId: { type: S.STRING(2048), allowNull: false },
					capabilities: { type: S.JSON, allowNull: false },
					availability: { type: S.STRING(16), allowNull: false },
					...timestamps(),
				},
				options,
			);
			await q.addIndex("TrackSources", ["service", "providerId"], {
				...options,
				unique: true,
				name: "track_source_provider",
			});
			await q.addIndex("TrackSources", ["trackId"], {
				...options,
				name: "track_source_track",
			});
			await q.createTable(
				"Moods",
				{
					id: key(),
					name: { type: S.STRING(64), allowNull: false },
					normalizedName: { type: S.STRING(64), allowNull: false, unique: true },
					iconKey: { type: S.STRING(32), allowNull: false },
					createdBy: {
						type: S.INTEGER,
						allowNull: true,
						references: { model: "Users", key: "id" },
						onDelete: "SET NULL",
					},
					...timestamps(),
				},
				options,
			);
			await q.createTable(
				"UserLibraryTracks",
				{
					userId: foreignKey("Users", S.INTEGER),
					trackId: foreignKey("Tracks"),
					importKind: { type: S.STRING(16), allowNull: false },
					...timestamps(),
				},
				options,
			);
			await q.createTable(
				"UserTrackMoods",
				{
					userId: foreignKey("Users", S.INTEGER),
					trackId: foreignKey("Tracks"),
					moodId: foreignKey("Moods"),
					...timestamps(),
				},
				options,
			);
			await q.addIndex("UserTrackMoods", ["userId", "moodId"], {
				...options,
				name: "user_track_mood_user_mood",
			});
			await q.addIndex("UserTrackMoods", ["trackId", "userId"], {
				...options,
				name: "user_track_mood_track_user",
			});
			await q.createTable(
				"UserFavoriteMoods",
				{
					userId: foreignKey("Users", S.INTEGER),
					moodId: foreignKey("Moods"),
					...timestamps(),
				},
				options,
			);
			const names = ["like", "focus", "energetic", "happy", "sad"];
			const icons = ["heart", "headphones", "bolt", "sun", "cloud-rain"];
			await q.bulkInsert(
				"Moods",
				names.map((name, i) => ({
					id: `00000000-0000-4000-8000-00000000000${i + 1}`,
					name,
					normalizedName: name,
					iconKey: icons[i],
					createdBy: null,
					createdAt: new Date(),
					updatedAt: new Date(),
				})),
				options,
			);
		});
	},
	async down(q) {
		await q.sequelize.transaction(async transaction => {
			for (const table of [
				"UserFavoriteMoods",
				"UserTrackMoods",
				"UserLibraryTracks",
				"Moods",
				"TrackSources",
				"Tracks",
			]) {
				await q.dropTable(table, { transaction });
			}
		});
	},
};
