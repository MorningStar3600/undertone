import { createRequire } from "node:module";
import { Sequelize } from "sequelize";
import { createCatalogueFixture } from "./music-test-helpers.js";
import { MusicRecommendations } from "../../music/recommendations.js";
import { musicRecommendationModels } from "../../models/music-recommendations.js";
export const recommendationMigration = createRequire(import.meta.url)(
	"../../migrations/20261110020000-create-music-recommendations.js"
);
export async function createRecommendationFixture(storage = ":memory:") {
	const f = await createCatalogueFixture(storage);
	await f.User.create({ id: 3 });
	await recommendationMigration.up(f.connection.getQueryInterface(), Sequelize);
	const service = new MusicRecommendations(
		() => f.connection,
		f.catalogue,
		() => f.models
	);
	return { ...f, service, recommendations: musicRecommendationModels(f.connection) };
}
