import { DataTypes as D, type Sequelize } from "sequelize";
import type { MusicRow } from "./music.js";

interface Publication {
	id: string;
	userId: number;
	trackId: string;
	active: boolean;
}
interface PublishedMood {
	publicationId: string;
	userId: number;
	trackId: string;
	moodId: string;
}
interface Adoption {
	userId: number;
	publicationId: string;
}
const cache = new WeakMap<Sequelize, ReturnType<typeof createModels>>();
export function musicRecommendationModels(connection: Sequelize) {
	let models = cache.get(connection);
	if (!models) {
		models = createModels(connection);
		cache.set(connection, models);
	}
	return models;
}
function createModels(connection: Sequelize) {
	const uuid = () => ({ type: D.UUID, primaryKey: true, allowNull: false });
	const Publication = connection.define<MusicRow<Publication>>(
		"MusicPublication",
		{
			id: uuid(),
			userId: { type: D.INTEGER, allowNull: false },
			trackId: { type: D.UUID, allowNull: false },
			active: { type: D.BOOLEAN, allowNull: false },
		},
		{ timestamps: false }
	);
	const PublishedMood = connection.define<MusicRow<PublishedMood>>(
		"MusicPublicationMood",
		{
			publicationId: uuid(),
			moodId: uuid(),
			userId: { type: D.INTEGER, allowNull: false },
			trackId: { type: D.UUID, allowNull: false },
		},
		{ timestamps: false }
	);
	const Adoption = connection.define<MusicRow<Adoption>>(
		"MusicRecommendationAdoption",
		{
			userId: { type: D.INTEGER, primaryKey: true, allowNull: false },
			publicationId: uuid(),
		},
		{ timestamps: false }
	);
	return { Publication, PublishedMood, Adoption };
}
