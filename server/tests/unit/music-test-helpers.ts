import { createRequire } from "node:module";
import { Sequelize, DataTypes } from "sequelize";
import { vi } from "vitest";
import { createMusicModels } from "../../models/music.js";
import { MusicCatalogue, type CatalogueResolver } from "../../music/catalogue.js";

const require = createRequire(import.meta.url);
export const migration = require("../../migrations/20261109190000-create-music-catalogue.js");

export async function createCatalogueFixture(storage = ":memory:") {
	const connection = new Sequelize({ dialect: "sqlite", storage, logging: false });
	const User = connection.define("User", {
		id: { type: DataTypes.INTEGER, primaryKey: true },
	});
	await User.sync();
	await User.bulkCreate([{ id: 1 }, { id: 2 }]);
	const models = createMusicModels(connection);
	await migration.up(connection.getQueryInterface(), Sequelize);
	const resolver: CatalogueResolver = {
		resolve: vi.fn(async reference => {
			const identity =
				"url" in reference
					? {
							service: "youtube" as const,
							id: new URL(reference.url).searchParams.get("v")!,
						}
					: reference;
			return {
				reference: identity,
				video: {
					service: "youtube" as const,
					id: identity.id,
					title: "Same title",
					length: 180,
					thumbnail: "https://media.example/cover.jpg",
				},
			};
		}),
		video: vi.fn(async source => ({
			service: source.service,
			id: source.providerId,
			title: "Same title",
			length: 180,
			src_url: "https://media.example/stream",
			subtitleUrl: "https://media.example/default.vtt",
		})),
	};
	const catalogue = new MusicCatalogue(
		() => connection,
		() => models,
		resolver,
	);
	return { connection, models, catalogue, resolver, User };
}
