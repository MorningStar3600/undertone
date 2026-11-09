import { createRequire } from "node:module";
import { Sequelize } from "sequelize";
import { describe, expect, it, vi } from "vitest";

const migration = createRequire(import.meta.url)(
	"../../migrations/20261109220000-create-music-imports.js",
);
describe("playlist migration PostgreSQL static compatibility", () => {
	it("generates PostgreSQL up/down SQL with scalar timestamps, ownership FKs and unique provenance", async () => {
		// SQL generation only; query is replaced so no PostgreSQL connection is opened.
		const connection = new Sequelize({ dialect: "postgres", logging: false });
		const query = vi.spyOn(connection, "query").mockResolvedValue([] as never);
		const q = connection.getQueryInterface();
		const mockInterface = {
			sequelize: {
				transaction: async (action: (transaction: undefined) => Promise<void>) =>
					action(undefined),
			},
			createTable: q.createTable.bind(q),
			addIndex: q.addIndex.bind(q),
			dropTable: q.dropTable.bind(q),
		};
		try {
			await migration.up(mockInterface, Sequelize);
			const sql = query.mock.calls.map(call => String(call[0])).join("\n");
			expect(sql).toContain('CREATE TABLE IF NOT EXISTS "MusicImportSources"');
			expect(sql).toContain('"leaseUntil" DOUBLE PRECISION NOT NULL');
			expect(sql).toContain('REFERENCES "Users" ("id") ON DELETE CASCADE');
			expect(sql).toContain('PRIMARY KEY ("sourceId","trackId")');
			expect(sql).toContain("CREATE UNIQUE INDEX");
			await migration.down(mockInterface);
			expect(
				query.mock.calls.some(call =>
					String(call[0]).includes('DROP TABLE IF EXISTS "MusicImportSources"'),
				),
			).toBe(true);
		} finally {
			query.mockRestore();
			await connection.close();
		}
	});
});
