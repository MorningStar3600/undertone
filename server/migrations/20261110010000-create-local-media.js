"use strict";
module.exports = {
	async up(q, S) {
		await q.sequelize.transaction(async transaction => {
			const required = type => ({ type, allowNull: false });
			const foreign = (type, model, key = "id") => ({
				...required(type),
				references: { model, key },
				onDelete: "CASCADE",
			});
			await q.createTable(
				"LocalMediaRoots",
				{
					id: { ...required(S.STRING(64)), primaryKey: true },
					ownerId: foreign(S.INTEGER, "Users"),
					binding: required(S.STRING(64)),
					status: required(S.STRING(16)),
					processed: required(S.INTEGER),
					available: required(S.INTEGER),
					completedAt: { type: S.DOUBLE, allowNull: true },
					scanToken: { type: S.UUID, allowNull: true },
					leaseUntil: required(S.DOUBLE),
				},
				{ transaction },
			);
			await q.createTable(
				"LocalMediaFiles",
				{
					id: { ...foreign(S.UUID, "TrackSources"), primaryKey: true },
					rootId: foreign(S.STRING(64), "LocalMediaRoots"),
					relativePath: required(S.TEXT),
					pathKey: required(S.STRING(64)),
					trackId: foreign(S.UUID, "Tracks"),
					mime: required(S.STRING(32)),
					device: required(S.STRING(32)),
					inode: required(S.STRING(32)),
					size: required(S.DOUBLE),
					modified: required(S.DOUBLE),
					seen: required(S.UUID),
				},
				{ transaction },
			);
			await q.addIndex("LocalMediaFiles", ["rootId", "pathKey"], {
				unique: true,
				transaction,
			});
			await q.addIndex("LocalMediaFiles", ["trackId"], { transaction });
		});
	},
	async down(q) {
		await q.sequelize.transaction(async transaction => {
			await q.dropTable("LocalMediaFiles", { transaction });
			await q.dropTable("LocalMediaRoots", { transaction });
		});
	},
};
