import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createConnection } from "node:net";
import { Sequelize, type Transaction } from "sequelize";
import { discoverMigrations, targets } from "./music-fixture.js";
import { MusicDockerForwarder, publishedPort } from "./music-docker-forward.mjs";

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

describe("offline Docker transport safeguards (no Docker execution)", () => {
	it("rejects untrusted shell targets before verification or spawn", async () => {
		const verify = vi.fn();
		const transport = vi.fn();
		const forward = new MusicDockerForwarder({ verify, spawn: transport });
		await expect(forward.open("127.0.0.1; echo unsafe", "5432")).rejects.toThrow();
		await expect(forward.open("127.0.0.1", "5432; echo unsafe")).rejects.toThrow();
		expect(verify).not.toHaveBeenCalled();
		expect(transport).not.toHaveBeenCalled();
		expect(await forward.close()).toMatchObject({ listeners: 0, sockets: 0, children: 0 });
	});
	it("uses an existing loopback publication and falls back only when it is missing", () => {
		expect(publishedPort({ NetworkSettings: { Ports: {} } }, "5432/tcp")).toBeUndefined();
		expect(
			publishedPort({ NetworkSettings: { Ports: { "5432/tcp": null } } }, "5432/tcp"),
		).toBeUndefined();
		expect(
			publishedPort(
				{
					NetworkSettings: {
						Ports: {
							"5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "15432" }],
						},
					},
				},
				"5432/tcp",
			),
		).toBe("15432");
	});
	it.each([
		{ HostIp: "0.0.0.0", HostPort: "15432" },
		{ HostIp: "::", HostPort: "15432" },
		{ HostIp: "127.0.0.1", HostPort: "0" },
		{ HostIp: "127.0.0.1", HostPort: "65536" },
		{ HostIp: "127.0.0.1", HostPort: "15432;echo unsafe" },
	])("rejects unsafe published binding %j without fallback", binding => {
		expect(() =>
			publishedPort({ NetworkSettings: { Ports: { "5432/tcp": [binding] } } }, "5432/tcp"),
		).toThrow();
	});
	it.each(["success", "ownership-failure", "exec-failure"])(
		"closes real loopback listeners and owned child processes after %s",
		async mode => {
			const verify = vi.fn().mockResolvedValue(undefined);
			const transport = vi.fn(() =>
				spawn(
					process.execPath,
					[
						"-e",
						mode === "exec-failure"
							? "process.exit(42)"
							: 'process.stderr.write("music-forward-ready\\n"); process.stdin.pipe(process.stdout);',
					],
					{ windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
				),
			);
			const forward = new MusicDockerForwarder({ verify, spawn: transport, report: vi.fn() });
			const port = Number(await forward.open("127.0.0.1", "5432"));
			if (mode === "ownership-failure") {
				verify.mockRejectedValue(new Error("synthetic label mismatch"));
			}
			const socket = createConnection({ host: "127.0.0.1", port });
			socket.on("error", () => undefined);
			try {
				if (mode === "success") {
					const data = once(socket, "data");
					socket.write("real socket bytes");
					expect(String((await data)[0])).toBe("real socket bytes");
				} else {
					await once(socket, "close");
				}
			} finally {
				const audit = await forward.close();
				expect(audit).toMatchObject({
					ports: [port],
					listeners: 0,
					sockets: 0,
					children: 0,
				});
				for (const pid of audit.pids) {
					expect(() => process.kill(pid, 0)).toThrow();
				}
				expect(verify).toHaveBeenCalledTimes(2);
				expect(transport).toHaveBeenCalledTimes(mode === "ownership-failure" ? 0 : 1);
				const probe = createConnection({ host: "127.0.0.1", port });
				await expect(once(probe, "connect")).rejects.toMatchObject({
					code: "ECONNREFUSED",
				});
				probe.destroy();
			}
		},
	);
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
