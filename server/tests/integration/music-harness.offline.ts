import { afterEach, describe, expect, it, vi } from "vitest";
import { Sequelize, type Transaction } from "sequelize";
import { discoverMigrations, targets } from "./music-fixture.js";

const runId = "0123456789abcdef01234567";
const EVENT_INDEX = /CREATE UNIQUE INDEX .*"MusicRoomEvents" \("roomId", "entryId"\)/;
const SOURCE_INDEX = /CREATE UNIQUE INDEX .*"TrackSources" \("service", "providerId"\)/;
const password = "a".repeat(48);
const database = `postgres://ott_music_test_${runId}:${password}@127.0.0.1:15432/ott_music_test_${runId}`;
const redis = `redis://default:${password}@127.0.0.1:16379/15`;
function valid() {
	vi.stubEnv("NODE_ENV", "test");
	vi.stubEnv("TEST_MUSIC_RUN_ID", runId);
	vi.stubEnv("TEST_DATABASE_URL", database);
	vi.stubEnv("TEST_REDIS_URL", redis);
}
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("offline harness safeguards (no database execution)", () => {
	it("accepts explicit isolated local synthetic targets", () => {
		valid();
		expect(targets()).toMatchObject({ runId, owned: `ott_music_test_${runId}` });
	});
	it.each([
		["NODE_ENV", "development"],
		["TEST_MUSIC_RUN_ID", ""],
		["TEST_DATABASE_URL", ""],
		["TEST_REDIS_URL", ""],
		["TEST_DATABASE_URL", database.replace("127.0.0.1", "database.example")],
		["TEST_DATABASE_URL", database.replace(`/ott_music_test_${runId}`, "/development")],
		["TEST_DATABASE_URL", database.replace(`ott_music_test_${runId}:`, "postgres:")],
		["TEST_DATABASE_URL", `${database}?sslmode=require`],
		["TEST_REDIS_URL", redis.replace("/15", "/0")],
		["TEST_REDIS_URL", redis.replace("127.0.0.1", "redis.example")],
		["TEST_REDIS_URL", redis.replace(password, "other-credentials")],
	])("rejects a misconfigured %s target before connection", (key, value) => {
		valid();
		vi.stubEnv(key, value);
		expect(() => targets()).toThrow();
	});
	it("generates PostgreSQL SQL for every discovered music migration; this is not live execution", async () => {
		const connection = new Sequelize({ dialect: "postgres", logging: false });
		const sql: string[] = [];
		vi.spyOn(connection, "query").mockImplementation(async statement => {
			sql.push(String(statement));
			return [] as never;
		});
		// Only this offline check substitutes a transaction. The live suites use real transactions.
		vi.spyOn(connection, "transaction").mockImplementation((async (
			operation: (t: Transaction) => Promise<unknown>,
		) => operation({} as Transaction)) as typeof connection.transaction);
		try {
			const discovered = await discoverMigrations();
			const music = discovered.filter(item => item.name >= "20261109190000");
			console.log(
				`Offline SQL generation: ${music.length} music migrations, ${discovered.length} total discovered`,
			);
			for (const item of music) {
				await item.migration.up(connection.getQueryInterface(), Sequelize);
			}
			const generated = sql.join("\n");
			for (const table of [
				"Tracks",
				"TrackSources",
				"MusicRoomStates",
				"MusicRoomEvents",
				"MusicRoomScores",
				"MusicCatalogueVersions",
				"MusicImportSources",
				"MusicImportJobs",
				"MusicImportProvenance",
			]) {
				expect(generated).toContain(`CREATE TABLE IF NOT EXISTS "${table}"`);
			}
			expect(generated).toContain('REFERENCES "Users" ("id") ON DELETE CASCADE');
			expect(generated).toContain('REFERENCES "Tracks" ("id") ON DELETE CASCADE');
			expect(generated).toContain('"snapshot" JSON NOT NULL');
			expect(generated).toMatch(EVENT_INDEX);
			expect(generated).toMatch(SOURCE_INDEX);
			if (music.some(item => item.name.includes("local-media"))) {
				expect(generated).toContain('CREATE TABLE IF NOT EXISTS "LocalMediaFiles"');
				expect(generated).toContain('REFERENCES "TrackSources" ("id") ON DELETE CASCADE');
			}
			if (music.some(item => item.name.includes("music-recommendations"))) {
				expect(generated).toContain(
					'CREATE TABLE IF NOT EXISTS "MusicRecommendationAdoptions"',
				);
				expect(generated).toContain(
					'FOREIGN KEY ("userId", "trackId", "moodId") REFERENCES "UserTrackMoods" ("userId", "trackId", "moodId") ON DELETE CASCADE',
				);
			}
		} finally {
			await connection.close();
		}
	});
});
