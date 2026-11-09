import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve, relative, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const LINES = /\r?\n/;
const LOCAL_PORT = /^127\.0\.0\.1:(\d+)$/;
const POSTGRES_IMAGE = /^postgres:15(?:[.-].*)?$/;
const REDIS_IMAGE = /^redis:7(?:[.-].*)?$/;

async function main() {
	const exec = promisify(execFile);
	const root = fileURLToPath(new URL("../../..", import.meta.url));
	const cache = join(root, "node_modules/.cache");
	const dockerMode = process.argv.includes("--docker");
	const offline = process.argv.includes("--offline");
	const collectOnly = process.argv.includes("--collect-only");
	const runId = dockerMode ? randomBytes(12).toString("hex") : process.env.TEST_MUSIC_RUN_ID;
	// Do not inherit application/provider credentials, Docker contexts, or normal DB configuration.
	const env = Object.fromEntries(
		["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "COMSPEC", "PATHEXT"]
			.filter(key => process.env[key])
			.map(key => [key, process.env[key]]),
	);
	Object.assign(env, { NODE_ENV: "test", LOG_LEVEL: "error", TEST_MUSIC_RUN_ID: runId });
	if (process.env.TEST_MUSIC_EXTRA_MIGRATIONS_DIR) {
		env.TEST_MUSIC_EXTRA_MIGRATIONS_DIR = resolve(process.env.TEST_MUSIC_EXTRA_MIGRATIONS_DIR);
	}
	let directory;
	let network;
	const containers = [];
	let interrupted = false;
	let child;
	let syntheticPassword;
	const safeError = error =>
		String(error.message)
			.replace(/(?:postgres(?:ql)?|redis):\/\/[^\s]+/g, "[test-service URL]")
			.split(syntheticPassword ?? "__unused_test_password__")
			.join("[synthetic password]");
	const dockerBin =
		process.env.TEST_DOCKER_BIN ??
		(process.platform === "win32"
			? "C:/Program Files/Docker/Docker/resources/bin/docker.exe"
			: "docker");
	const label = "org.opentogethertube.music-test";
	const docker = async (...args) =>
		(
			await exec(dockerBin, ["--config", join(directory, "docker-config"), ...args], {
				env,
				timeout: 30000,
				windowsHide: true,
			})
		).stdout.trim();
	async function ready(name, args) {
		const deadline = Date.now() + 60000;
		while (Date.now() < deadline && !interrupted) {
			try {
				await docker("exec", name, ...args);
				return;
			} catch {
				await delay(500);
			}
		}
		throw new Error(`Isolated service ${name} did not become ready within 60s`);
	}
	async function image(candidates, fallback) {
		const available = (
			await docker("image", "ls", "--format", "{{.Repository}}:{{.Tag}}")
		).split(LINES);
		const found = available.find(value => candidates.test(value));
		if (found) {
			return found;
		}
		console.log(`Pulling authorized test dependency ${fallback}`);
		// Image downloads can take longer than ordinary CLI calls.
		await exec(dockerBin, ["--config", join(directory, "docker-config"), "pull", fallback], {
			env,
			timeout: 300000,
			windowsHide: true,
		});
		return fallback;
	}
	async function cleanup() {
		if (!dockerMode || !directory) {
			return;
		}
		const failures = [];
		for (const name of containers.reverse()) {
			try {
				const present = await docker(
					"container",
					"ls",
					"--all",
					"--filter",
					`name=^/${name}$`,
					"--format",
					"{{.Names}}",
				);
				if (!present) {
					continue;
				}
				const marker = await docker(
					"inspect",
					"--format",
					`{{index .Config.Labels "${label}"}}`,
					name,
				);
				if (marker !== runId) {
					throw new Error(`Ownership mismatch for ${name}`);
				}
				await docker("rm", "--force", "--volumes", name);
			} catch (error) {
				failures.push(safeError(error));
			}
		}
		if (network) {
			try {
				const present = await docker(
					"network",
					"ls",
					"--filter",
					`name=^${network}$`,
					"--format",
					"{{.Name}}",
				);
				if (present) {
					const marker = await docker(
						"network",
						"inspect",
						"--format",
						`{{index .Labels "${label}"}}`,
						network,
					);
					if (marker !== runId) {
						throw new Error("Network ownership mismatch");
					}
					await docker("network", "rm", network);
				}
			} catch (error) {
				failures.push(safeError(error));
			}
		}
		const path = resolve(directory);
		const within = relative(resolve(cache), path);
		if (failures.length === 0 && within && !within.startsWith("..") && !isAbsolute(within)) {
			await rm(path, { recursive: true, force: true });
		}
		if (failures.length) {
			throw new Error(
				`Cleanup requires attention; configuration retained at ${directory}: ${failures.join("; ")}`,
			);
		}
		console.log(
			"Cleanup complete for this run's resources and temporary Docker configuration.",
		);
	}
	for (const signal of ["SIGINT", "SIGTERM"]) {
		process.on(signal, () => {
			interrupted = true;
			child?.kill(signal);
		});
	}
	try {
		if ([dockerMode, offline, collectOnly].filter(Boolean).length > 1) {
			throw new Error("Choose only one of --docker, --offline or --collect-only");
		}
		if (dockerMode) {
			await mkdir(cache, { recursive: true });
			directory = await mkdtemp(join(cache, "music-services-"));
			await mkdir(join(directory, "docker-config"));
			console.log(`Isolated music integration run ${runId}`);
			console.log(
				`Docker engine: ${await docker("version", "--format", "{{.Server.Version}}")}`,
			);
			// Inventory first. Never use the repository compose file or existing volumes.
			const postgres = await image(POSTGRES_IMAGE, "postgres:15-bullseye");
			const redis = await image(REDIS_IMAGE, "redis:7-alpine");
			console.log(`Service images: ${postgres}, ${redis}`);
			network = `ott-music-${runId}`;
			await docker(
				"network",
				"create",
				"--internal",
				"--label",
				`${label}=${runId}`,
				network,
			);
			const user = `ott_music_test_${runId}`;
			const password = randomBytes(24).toString("hex");
			syntheticPassword = password;
			const pgName = `ott-music-pg-${runId}`,
				redisName = `ott-music-redis-${runId}`;
			// Record names before creation, including containers left behind by failed starts.
			containers.push(pgName);
			await docker(
				"run",
				"--detach",
				"--name",
				pgName,
				"--label",
				`${label}=${runId}`,
				"--network",
				network,
				"--publish",
				"127.0.0.1::5432",
				"--tmpfs",
				"/var/lib/postgresql/data",
				"-e",
				`POSTGRES_USER=${user}`,
				"-e",
				`POSTGRES_DB=${user}`,
				"-e",
				`POSTGRES_PASSWORD=${password}`,
				postgres,
			);
			containers.push(redisName);
			await docker(
				"run",
				"--detach",
				"--name",
				redisName,
				"--label",
				`${label}=${runId}`,
				"--network",
				network,
				"--publish",
				"127.0.0.1::6379",
				"--tmpfs",
				"/data",
				redis,
				"redis-server",
				"--save",
				"",
				"--appendonly",
				"no",
				"--requirepass",
				password,
			);
			await ready(pgName, ["pg_isready", "-U", user, "-d", user]);
			await ready(redisName, ["redis-cli", "-a", password, "PING"]);
			const port = async (name, value) =>
				(await docker("port", name, value)).match(LOCAL_PORT)?.[1];
			const pgPort = await port(pgName, "5432/tcp"),
				redisPort = await port(redisName, "6379/tcp");
			if (!pgPort || !redisPort) {
				throw new Error("Expected dynamically assigned localhost-only service ports");
			}
			env.TEST_DATABASE_URL = `postgres://${user}:${password}@127.0.0.1:${pgPort}/${user}`;
			env.TEST_REDIS_URL = `redis://default:${password}@127.0.0.1:${redisPort}/15`;
		} else if (!offline && !collectOnly) {
			for (const key of ["TEST_DATABASE_URL", "TEST_REDIS_URL"]) {
				env[key] = process.env[key];
			}
			if (!runId || !env.TEST_DATABASE_URL || !env.TEST_REDIS_URL) {
				throw new Error(
					"Use --docker, or explicitly provide TEST_MUSIC_RUN_ID, TEST_DATABASE_URL and TEST_REDIS_URL (see music-README.md)",
				);
			}
		}
		const vitest = join(root, "node_modules/vitest/vitest.mjs");
		if (!existsSync(vitest)) {
			throw new Error("Install the worktree's own cached dependencies first");
		}
		const code = await new Promise((resolve, reject) => {
			child = spawn(
				process.execPath,
				[
					vitest,
					"run",
					"--config",
					`server/tests/integration/music-${offline ? "offline" : "vitest"}.config.ts`,
					...(collectOnly ? ["--testNamePattern", "^__music_collection_only__$"] : []),
					...process.argv
						.slice(2)
						.filter(arg => !["--docker", "--offline", "--collect-only"].includes(arg)),
				],
				{ cwd: root, env, stdio: "inherit", windowsHide: true },
			);
			child.on("error", reject);
			child.on("exit", code => resolve(code ?? 1));
		});
		process.exitCode = code;
	} catch (error) {
		// Synthetic service credentials are never included in logs.
		console.error(safeError(error));
		process.exitCode = 1;
	} finally {
		try {
			await cleanup();
		} catch (error) {
			console.error(error.message);
			process.exitCode = 1;
		}
	}
}

main();
