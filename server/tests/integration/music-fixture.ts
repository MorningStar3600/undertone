import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Sequelize, QueryTypes } from "sequelize";
import { createMusicModels } from "../../models/music.js";
import { MusicCatalogue, type CatalogueResolver } from "../../music/catalogue.js";

const require = createRequire(import.meta.url);
const RUN_ID = /^[a-f0-9]{24}$/;
const PASSWORD = /^[a-f0-9]{48}$/;
const MIGRATION = /^\d+.*\.js$/;
export const migration = (name: string) => require(`../../migrations/${name}`);
export async function discoverMigrations() {
	const directory = fileURLToPath(new URL("../../migrations", import.meta.url));
	const files = new Map<string, string>();
	for (const name of await readdir(directory)) {
		if (MIGRATION.test(name)) {
			files.set(name, join(directory, name));
		}
	}
	// Optional read copies let a bounded test checkout verify parent migrations without
	// importing unrelated production changes. Canonical migrations always take precedence.
	const extra = process.env.TEST_MUSIC_EXTRA_MIGRATIONS_DIR;
	if (extra) {
		for (const name of await readdir(extra)) {
			if (MIGRATION.test(name) && !files.has(name)) {
				files.set(name, join(extra, name));
			}
		}
	}
	return [...files]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, path]) => ({ name, migration: require(path) }));
}
export const reference = (id: string) => ({ service: "youtube" as const, id });
export const entry = (id: string, title = "Same title") => ({
	reference: reference(id),
	video: {
		...reference(id),
		title,
		length: 180,
		thumbnail: "https://media.example/cover.jpg",
	},
});
export const page = (...entries: ReturnType<typeof entry>[]) => ({
	entries,
	unavailable: 0,
	nextCursor: null as string | null,
});

// Begin awaiting immediately so blocked operations cannot cause unhandled rejections.
export async function settle<T>(pending: Promise<T>) {
	try {
		return { value: await pending };
	} catch (error) {
		return { error };
	}
}
export async function captureError(pending: Promise<unknown>) {
	const result = await settle(pending);
	return result.error;
}

export function targets() {
	const runId = process.env.TEST_MUSIC_RUN_ID ?? "";
	if (process.env.NODE_ENV !== "test" || !RUN_ID.test(runId)) {
		throw new Error("Explicit NODE_ENV=test and TEST_MUSIC_RUN_ID (24 hex digits) required");
	}
	const database = new URL(process.env.TEST_DATABASE_URL ?? "missing:");
	const redis = new URL(process.env.TEST_REDIS_URL ?? "missing:");
	const owned = `ott_music_test_${runId}`;
	if (
		!["postgres:", "postgresql:"].includes(database.protocol) ||
		!["127.0.0.1", "localhost"].includes(database.hostname) ||
		database.pathname !== `/${owned}` ||
		database.username !== owned ||
		!PASSWORD.test(database.password) ||
		database.search ||
		database.hash ||
		!database.port ||
		redis.protocol !== "redis:" ||
		!["127.0.0.1", "localhost"].includes(redis.hostname) ||
		redis.username !== "default" ||
		redis.password !== database.password ||
		redis.pathname !== "/15" ||
		!redis.port ||
		redis.search ||
		redis.hash
	) {
		throw new Error(
			"Refusing targets without localhost, dedicated test database/role and authenticated Redis DB 15",
		);
	}
	return { runId, database: database.href, redis: redis.href, owned };
}

export async function createFixture() {
	const target = targets();
	const schema = `music_${target.runId}_${randomBytes(4).toString("hex")}`;
	const connect = (searchPath: string) =>
		new Sequelize(target.database, {
			dialect: "postgres",
			logging: false,
			pool: { max: 3, acquire: 10000 },
			dialectOptions: {
				application_name: schema,
				connectionTimeoutMillis: 5000,
				options: `-c search_path=${searchPath} -c lock_timeout=7000 -c statement_timeout=12000`,
			},
		});
	const admin = connect("pg_catalog");
	const connections: Sequelize[] = [];
	let created = false;
	const cleanup = async () => {
		await Promise.all(connections.map(connection => connection.close()));
		try {
			if (created) {
				const rows = await admin.query<{ owner: string; marker: string }>(
					"SELECT pg_get_userbyid(nspowner) AS owner, obj_description(oid, 'pg_namespace') AS marker FROM pg_namespace WHERE nspname = :schema",
					{ replacements: { schema }, type: QueryTypes.SELECT },
				);
				if (
					rows.length !== 1 ||
					rows[0].owner !== target.owned ||
					rows[0].marker !== target.runId
				) {
					throw new Error("Refusing teardown: schema ownership marker mismatch");
				}
				await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
			}
		} finally {
			await admin.close();
		}
	};
	try {
		const [identity] = await admin.query<{ db: string; role: string }>(
			"SELECT current_database() AS db, current_user AS role",
			{ type: QueryTypes.SELECT },
		);
		if (identity.db !== target.owned || identity.role !== target.owned) {
			throw new Error("Test database/role ownership mismatch");
		}
		await admin.query(`CREATE SCHEMA "${schema}"`);
		created = true;
		await admin.query(`COMMENT ON SCHEMA "${schema}" IS '${target.runId}'`);
		const peer = () => {
			const connection = connect(schema);
			connections.push(connection);
			const models = createMusicModels(connection);
			const resolver: CatalogueResolver = {
				async resolve(ref) {
					if ("url" in ref) {
						throw new Error("Only synthetic provider IDs in integration fixtures");
					}
					return { reference: ref, video: entry(ref.id).video };
				},
				async video(source) {
					return {
						...entry(source.providerId).video,
						src_url: "https://media.example/stream",
					};
				},
			};
			const catalogue = new MusicCatalogue(
				() => connection,
				() => models,
				resolver,
			);
			return { connection, models, catalogue, resolver };
		};
		const first = peer();
		const discovered = await discoverMigrations();
		for (const item of discovered) {
			await item.migration.up(first.connection.getQueryInterface(), Sequelize);
		}
		const migrations = discovered.map(item => item.name);
		await first.connection.query(
			`INSERT INTO "Users" (id, username, email, salt, hash, "createdAt", "updatedAt") SELECT i, 'synthetic-' || i, 'synthetic-' || i || '@example.invalid', '\\x01', '\\x02', NOW(), NOW() FROM generate_series(1, 4) AS i`,
		);
		return { ...first, peer, schema, migrations, cleanup };
	} catch (error) {
		await cleanup();
		throw error;
	}
}

/** Observe a real server-side lock wait; no sleeps standing in for concurrency. */
export async function waitForLock(observer: Sequelize, application: string) {
	const deadline = performance.now() + 4000;
	while (performance.now() < deadline) {
		const rows = await observer.query<{ count: string }>(
			"SELECT count(*) FROM pg_stat_activity WHERE application_name = :application AND wait_event_type = 'Lock'",
			{ replacements: { application }, type: QueryTypes.SELECT },
		);
		if (Number(rows[0].count) > 0) {
			return;
		}
		await delay(20);
	}
	throw new Error("Expected PostgreSQL lock wait was not observed within 4s");
}
