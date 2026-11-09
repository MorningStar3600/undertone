"use strict";
module.exports = {
	async up(q, S) {
		await q.sequelize.transaction(async transaction => {
			const uuid = () => ({ type: S.UUID, primaryKey: true, allowNull: false });
			const time = () => ({ type: S.DOUBLE, allowNull: false });
			const nullableTime = () => ({ type: S.DOUBLE, allowNull: true });
			const user = () => ({
				type: S.INTEGER,
				allowNull: false,
				references: { model: "Users", key: "id" },
				onDelete: "CASCADE",
			});
			await q.createTable(
				"MusicImportSources",
				{
					id: uuid(),
					userId: user(),
					service: { type: S.STRING(32), allowNull: false },
					providerId: { type: S.STRING(256), allowNull: false },
					daily: { type: S.BOOLEAN, allowNull: false },
					removed: { type: S.BOOLEAN, allowNull: false },
					nextRunAt: nullableTime(),
					lastSuccessAt: nullableTime(),
					lastCompletionAt: nullableTime(),
					activeJobId: { type: S.UUID, allowNull: true },
					lastJobId: { type: S.UUID, allowNull: true },
				},
				{ transaction },
			);
			await q.addIndex("MusicImportSources", ["userId", "service", "providerId"], {
				unique: true,
				transaction,
			});
			await q.addIndex("MusicImportSources", ["daily", "removed", "nextRunAt"], {
				transaction,
			});
			await q.createTable(
				"MusicImportJobs",
				{
					id: uuid(),
					userId: user(),
					sourceId: {
						type: S.UUID,
						allowNull: false,
						references: { model: "MusicImportSources", key: "id" },
						onDelete: "CASCADE",
					},
					status: { type: S.STRING(16), allowNull: false },
					cursor: { type: S.STRING(2048), allowNull: true },
					leaseToken: { type: S.UUID, allowNull: true },
					leaseUntil: time(),
					nextAttemptAt: time(),
					createdAt: time(),
					completedAt: nullableTime(),
					pages: { type: S.INTEGER, allowNull: false },
					processed: { type: S.INTEGER, allowNull: false },
					added: { type: S.INTEGER, allowNull: false },
					existing: { type: S.INTEGER, allowNull: false },
					unavailable: { type: S.INTEGER, allowNull: false },
					failures: { type: S.INTEGER, allowNull: false },
					retryCount: { type: S.INTEGER, allowNull: false },
					error: { type: S.STRING(16), allowNull: true },
				},
				{ transaction },
			);
			await q.addIndex("MusicImportJobs", ["status", "nextAttemptAt", "leaseUntil"], {
				transaction,
			});
			await q.addIndex("MusicImportJobs", ["userId", "sourceId", "createdAt"], {
				transaction,
			});
			await q.createTable(
				"MusicImportProvenance",
				{
					sourceId: {
						...uuid(),
						references: { model: "MusicImportSources", key: "id" },
						onDelete: "CASCADE",
					},
					trackId: {
						...uuid(),
						references: { model: "Tracks", key: "id" },
						onDelete: "CASCADE",
					},
					lastJobId: {
						type: S.UUID,
						allowNull: false,
						references: { model: "MusicImportJobs", key: "id" },
						onDelete: "CASCADE",
					},
				},
				{ transaction },
			);
		});
	},
	async down(q) {
		await q.sequelize.transaction(async transaction => {
			for (const table of [
				"MusicImportProvenance",
				"MusicImportJobs",
				"MusicImportSources",
			]) {
				await q.dropTable(table, { transaction });
			}
		});
	},
};
