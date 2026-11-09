import { Sequelize } from "sequelize";
import { describe, expect, it, vi } from "vitest";
import { recommendationMigration } from "./music-recommendations-fixture.js";
vi.mock("../../infoextractor.js", () => ({ default: {} }));
describe("recommendation migration PostgreSQL SQL generation only", () => {
	it("generates transactional schema with cascading own-annotation consent and unique publication/receipt keys", async () => {
		const connection = new Sequelize({ dialect: "postgres", logging: false });
		const query = vi.spyOn(connection, "query").mockResolvedValue([] as never);
		const q = connection.getQueryInterface();
		const mocked = {
			sequelize: {
				transaction: async (action: (transaction: undefined) => Promise<void>) =>
					action(undefined),
			},
			createTable: q.createTable.bind(q),
			addIndex: q.addIndex.bind(q),
			addConstraint: q.addConstraint.bind(q),
			dropTable: q.dropTable.bind(q),
		};
		try {
			await recommendationMigration.up(mocked, Sequelize);
			const sql = query.mock.calls.map(call => String(call[0])).join("\n");
			expect(sql).toContain('"active" BOOLEAN NOT NULL DEFAULT false');
			expect(sql).toContain(
				'FOREIGN KEY ("userId", "trackId", "moodId") REFERENCES "UserTrackMoods" ("userId", "trackId", "moodId") ON DELETE CASCADE'
			);
			expect(sql).toContain('PRIMARY KEY ("userId","publicationId")');
			expect(sql).toContain("CREATE UNIQUE INDEX");
			await recommendationMigration.down(mocked);
			expect(
				query.mock.calls.some(call =>
					String(call[0]).includes('DROP TABLE IF EXISTS "MusicPublications"')
				)
			).toBe(true);
		} finally {
			query.mockRestore();
			await connection.close();
		}
	});
});
