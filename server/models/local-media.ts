import { DataTypes, type Model, type Sequelize } from "sequelize";
import type { LocalMediaRootStatus } from "ott-common/models/local-media.js";

export interface LocalMediaRootRow extends LocalMediaRootStatus {
	ownerId: number;
	binding: string;
	scanToken: string | null;
	leaseUntil: number;
}
export interface LocalMediaFile {
	id: string;
	rootId: string;
	/** Private, relative native path. Never included in a DTO. */
	relativePath: string;
	pathKey: string;
	trackId: string;
	mime: string;
	device: string;
	inode: string;
	size: number;
	modified: number;
	seen: string;
}
type Row<T extends object> = Model<T>;
export function localMediaModels(connection: Sequelize) {
	if (connection.models.LocalMediaRoot) {
		return {
			Root: connection.models.LocalMediaRoot as ReturnType<typeof defineModels>["Root"],
			File: connection.models.LocalMediaFile as ReturnType<typeof defineModels>["File"],
		};
	}
	return defineModels(connection);
}
function defineModels(connection: Sequelize) {
	const Root = connection.define<Row<LocalMediaRootRow>>(
		"LocalMediaRoot",
		{
			id: { type: DataTypes.STRING(64), primaryKey: true },
			ownerId: {
				type: DataTypes.INTEGER,
				allowNull: false,
				references: { model: "Users", key: "id" },
				onDelete: "CASCADE",
			},
			binding: { type: DataTypes.STRING(64), allowNull: false },
			status: { type: DataTypes.STRING(16), allowNull: false },
			processed: { type: DataTypes.INTEGER, allowNull: false },
			available: { type: DataTypes.INTEGER, allowNull: false },
			completedAt: { type: DataTypes.DOUBLE, allowNull: true },
			scanToken: { type: DataTypes.UUID, allowNull: true },
			leaseUntil: { type: DataTypes.DOUBLE, allowNull: false },
		},
		{ timestamps: false },
	);
	const File = connection.define<Row<LocalMediaFile>>(
		"LocalMediaFile",
		{
			id: {
				type: DataTypes.UUID,
				primaryKey: true,
				references: { model: "TrackSources", key: "id" },
				onDelete: "CASCADE",
			},
			rootId: {
				type: DataTypes.STRING(64),
				allowNull: false,
				references: { model: "LocalMediaRoots", key: "id" },
				onDelete: "CASCADE",
			},
			relativePath: { type: DataTypes.TEXT, allowNull: false },
			pathKey: { type: DataTypes.STRING(64), allowNull: false },
			trackId: {
				type: DataTypes.UUID,
				allowNull: false,
				references: { model: "Tracks", key: "id" },
				onDelete: "CASCADE",
			},
			mime: { type: DataTypes.STRING(32), allowNull: false },
			device: { type: DataTypes.STRING(32), allowNull: false },
			inode: { type: DataTypes.STRING(32), allowNull: false },
			size: { type: DataTypes.DOUBLE, allowNull: false },
			modified: { type: DataTypes.DOUBLE, allowNull: false },
			seen: { type: DataTypes.UUID, allowNull: false },
		},
		{ timestamps: false, indexes: [{ unique: true, fields: ["rootId", "pathKey"] }] },
	);
	return { Root, File };
}
