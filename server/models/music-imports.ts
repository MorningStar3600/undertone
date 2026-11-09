import { DataTypes as D, type Sequelize } from "sequelize";
import type { MusicImportJob, MusicImportSource } from "ott-common/models/music-imports.js";
import type { MusicRow } from "./music.js";

export type ImportSourceRow = Omit<MusicImportSource, "lastJob"> & {
	userId: number;
	providerId: string;
	activeJobId: string | null;
	lastJobId: string | null;
};
export type ImportJobRow = MusicImportJob & {
	userId: number;
	cursor: string | null;
	leaseToken: string | null;
	leaseUntil: number;
};
interface Provenance {
	sourceId: string;
	trackId: string;
	lastJobId: string;
}
const cache = new WeakMap<Sequelize, ReturnType<typeof createModels>>();
export function musicImportModels(connection: Sequelize) {
	let models = cache.get(connection);
	if (!models) {
		models = createModels(connection);
		cache.set(connection, models);
	}
	return models;
}
function createModels(connection: Sequelize) {
	const uuid = () => ({ type: D.UUID, primaryKey: true, allowNull: false });
	const millis = () => ({ type: D.DOUBLE, allowNull: false });
	const nullableTime = () => ({ type: D.DOUBLE, allowNull: true });
	const user = {
		type: D.INTEGER,
		allowNull: false,
		references: { model: "Users", key: "id" },
		onDelete: "CASCADE",
	};
	const Source = connection.define<MusicRow<ImportSourceRow>>(
		"MusicImportSource",
		{
			id: uuid(),
			userId: user,
			service: { type: D.STRING(32), allowNull: false },
			providerId: { type: D.STRING(256), allowNull: false },
			daily: { type: D.BOOLEAN, allowNull: false },
			removed: { type: D.BOOLEAN, allowNull: false },
			nextRunAt: nullableTime(),
			lastSuccessAt: nullableTime(),
			lastCompletionAt: nullableTime(),
			activeJobId: { type: D.UUID, allowNull: true },
			lastJobId: { type: D.UUID, allowNull: true },
		},
		{
			timestamps: false,
			indexes: [{ unique: true, fields: ["userId", "service", "providerId"] }],
		},
	);
	const Job = connection.define<MusicRow<ImportJobRow>>(
		"MusicImportJob",
		{
			id: uuid(),
			userId: user,
			sourceId: {
				type: D.UUID,
				allowNull: false,
				references: { model: "MusicImportSources", key: "id" },
				onDelete: "CASCADE",
			},
			status: { type: D.STRING(16), allowNull: false },
			cursor: { type: D.STRING(2048), allowNull: true },
			leaseToken: { type: D.UUID, allowNull: true },
			leaseUntil: millis(),
			nextAttemptAt: millis(),
			createdAt: millis(),
			completedAt: nullableTime(),
			pages: { type: D.INTEGER, allowNull: false },
			processed: { type: D.INTEGER, allowNull: false },
			added: { type: D.INTEGER, allowNull: false },
			existing: { type: D.INTEGER, allowNull: false },
			unavailable: { type: D.INTEGER, allowNull: false },
			failures: { type: D.INTEGER, allowNull: false },
			retryCount: { type: D.INTEGER, allowNull: false },
			error: { type: D.STRING(16), allowNull: true },
		},
		{
			timestamps: false,
			indexes: [
				{ fields: ["status", "nextAttemptAt", "leaseUntil"] },
				{ fields: ["userId", "sourceId", "createdAt"] },
			],
		},
	);
	const Provenance = connection.define<MusicRow<Provenance>>(
		"MusicImportProvenance",
		{
			sourceId: {
				...uuid(),
				references: { model: "MusicImportSources", key: "id" },
				onDelete: "CASCADE",
			},
			trackId: { ...uuid(), references: { model: "Tracks", key: "id" }, onDelete: "CASCADE" },
			lastJobId: {
				type: D.UUID,
				allowNull: false,
				references: { model: "MusicImportJobs", key: "id" },
				onDelete: "CASCADE",
			},
		},
		{ timestamps: false, tableName: "MusicImportProvenance" },
	);
	return { Source, Job, Provenance };
}
