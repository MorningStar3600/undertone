"use strict";
module.exports = {
	async up(q, S) {
		await q.sequelize.transaction(async transaction => {
			const key = (model, type = S.UUID) => ({
				type,
				allowNull: false,
				references: { model, key: "id" },
				onDelete: "CASCADE",
			});
			await q.createTable(
				"MusicPublications",
				{
					id: { type: S.UUID, primaryKey: true, allowNull: false },
					userId: key("Users", S.INTEGER),
					trackId: key("Tracks"),
					active: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
				},
				{ transaction }
			);
			await q.addIndex("MusicPublications", ["userId", "trackId"], {
				unique: true,
				transaction,
			});
			await q.addIndex("MusicPublications", ["trackId", "active"], { transaction });
			await q.createTable(
				"MusicPublicationMoods",
				{
					publicationId: { ...key("MusicPublications"), primaryKey: true },
					moodId: { ...key("Moods"), primaryKey: true },
					userId: key("Users", S.INTEGER),
					trackId: key("Tracks"),
				},
				{ transaction }
			);
			// Removal of an own annotation also removes its explicit publication consent.
			// Re-adding that tag does not silently publish it again.
			await q.addConstraint("MusicPublicationMoods", {
				fields: ["userId", "trackId", "moodId"],
				type: "foreign key",
				name: "publication_own_annotation",
				references: { table: "UserTrackMoods", fields: ["userId", "trackId", "moodId"] },
				onDelete: "CASCADE",
				transaction,
			});
			await q.createTable(
				"MusicRecommendationAdoptions",
				{
					userId: { ...key("Users", S.INTEGER), primaryKey: true },
					publicationId: { ...key("MusicPublications"), primaryKey: true },
				},
				{ transaction }
			);
		});
	},
	async down(q) {
		await q.sequelize.transaction(async transaction => {
			for (const table of [
				"MusicRecommendationAdoptions",
				"MusicPublicationMoods",
				"MusicPublications",
			]) {
				await q.dropTable(table, { transaction });
			}
		});
	},
};
