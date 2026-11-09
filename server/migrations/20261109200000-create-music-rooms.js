"use strict";
module.exports = {
	async up(q, S) {
		await q.sequelize.transaction(async transaction => {
			const key = () => ({ type: S.STRING(256), primaryKey: true, allowNull: false });
			await q.createTable(
				"MusicRoomStates",
				{
					roomId: key(),
					revision: { type: S.INTEGER, allowNull: false },
					snapshot: { type: S.JSON, allowNull: false },
				},
				{ transaction },
			);
			await q.createTable(
				"MusicRoomEvents",
				{
					roomId: key(),
					playbackId: key(),
					entryId: { type: S.STRING(512), allowNull: false },
					ordinal: { type: S.INTEGER, allowNull: false },
					event: { type: S.JSON, allowNull: false },
				},
				{ transaction },
			);
			await q.addIndex("MusicRoomEvents", ["roomId", "entryId"], {
				unique: true,
				transaction,
			});
			await q.createTable(
				"MusicRoomScores",
				{
					roomId: key(),
					contributorId: key(),
					ordinal: { type: S.INTEGER, allowNull: false },
					base: { type: S.INTEGER, allowNull: false },
					plays: { type: S.INTEGER, allowNull: false },
				},
				{ transaction },
			);
			await q.createTable(
				"MusicCatalogueVersions",
				{
					userId: { type: S.INTEGER, primaryKey: true, allowNull: false },
					revision: { type: S.INTEGER, allowNull: false },
				},
				{ transaction },
			);
		});
	},
	async down(q) {
		await q.sequelize.transaction(async transaction => {
			for (const table of [
				"MusicCatalogueVersions",
				"MusicRoomScores",
				"MusicRoomEvents",
				"MusicRoomStates",
			]) {
				await q.dropTable(table, { transaction });
			}
		});
	},
};
