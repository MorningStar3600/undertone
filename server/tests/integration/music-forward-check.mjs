import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { MusicDockerForwarder, TCP_PUMP } from "./music-docker-forward.mjs";

// Explicit opt-in; use the actual Linux image, not MSYS emulation of POSIX signals.
if (!process.argv.includes("--docker")) {
	throw new Error("Use --docker to run the isolated relay checks");
}
const windowsDocker = "C:/Program Files/Docker/Docker/resources/bin/docker.exe";
const docker = existsSync(windowsDocker) ? windowsDocker : "docker";
const env = Object.fromEntries(
	["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "COMSPEC", "PATHEXT"]
		.filter(key => process.env[key])
		.map(key => [key, process.env[key]]),
);
// No DB starts. Perl serves one loopback connection inside a network-less container.
const fixture = `set -e
perl -e '
use IO::Socket::INET;
my $server = IO::Socket::INET->new(LocalAddr => "127.0.0.1", LocalPort => 5432, Listen => 1) or die;
open(my $ready, ">", "/tmp/relay-ready") or die; close($ready);
my $client = $server->accept() or die;
$client->autoflush(1);
my $data = <$client>;
print $client $data;
if ($ARGV[0] eq "client") { while (<$client>) {} }
close($client);
' "$1" &
backend=$!
trap 'kill -KILL "$backend" 2>/dev/null || true; wait "$backend" 2>/dev/null || true' EXIT
for i in {1..100}; do test -f /tmp/relay-ready && break; sleep 0.02; done
test -f /tmp/relay-ready
bash -c "$2" -- 127.0.0.1 5432
wait "$backend"`;

for (const side of ["backend", "client"]) {
	test(`actual Linux TCP pump closes on ${side} EOF`, { timeout: 20000 }, async () => {
		const owner = randomBytes(12).toString("hex");
		const name = `ott-music-forward-${owner}`;
		let child;
		let client;
		const forward = new MusicDockerForwarder({
			verify: async () => undefined,
			spawn: () => {
				child = spawn(
					docker,
					[
						"run",
						"--rm",
						"--name",
						name,
						"--label",
						`ott.music.forward-probe=${owner}`,
						"--network",
						"none",
						"-i",
						"--entrypoint",
						"bash",
						"postgres:15-bullseye",
						"-c",
						fixture,
						"--",
						side,
						TCP_PUMP,
					],
					{ env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
				);
				return child;
			},
		});
		try {
			const port = Number(await forward.open("127.0.0.1", "5432"));
			client = createConnection({ host: "127.0.0.1", port });
			client.on("error", () => undefined);
			const received = [];
			client.on("data", data => received.push(data));
			const data = once(client, "data", { signal: AbortSignal.timeout(10000) });
			client.write("final server bytes\n");
			await data;
			if (side === "client") client.end();
			const deadline = Date.now() + 3000;
			while ((forward.children.size || forward.sockets.size) && Date.now() < deadline) {
				await delay(25);
			}
			assert.equal(forward.children.size, 0, "relay survives EOF before teardown");
			assert.equal(forward.sockets.size, 0);
			assert.equal(Buffer.concat(received).toString(), "final server bytes\n");
			assert.equal(child.exitCode, 0);
			assert.throws(() => process.kill(child.pid, 0));
		} finally {
			client?.destroy();
			// Remove only this test's exact name after checking its unique ownership label.
			const inspected = spawnSync(
				docker,
				["container", "ls", "-aq", "--filter", `name=^/${name}$`],
				{
					env,
					windowsHide: true,
					encoding: "utf8",
					timeout: 5000,
				},
			);
			assert.equal(inspected.status, 0, "container cleanup lookup failed");
			if (inspected.stdout.trim()) {
				const label = spawnSync(
					docker,
					[
						"inspect",
						"--format",
						'{{index .Config.Labels "ott.music.forward-probe"}}',
						name,
					],
					{
						env,
						windowsHide: true,
						encoding: "utf8",
						timeout: 5000,
					},
				);
				assert.equal(label.status, 0);
				assert.equal(label.stdout.trim(), owner);
				const removed = spawnSync(docker, ["rm", "-f", name], {
					env,
					windowsHide: true,
					timeout: 5000,
				});
				assert.equal(removed.status, 0);
			}
			const audit = await forward.close();
			assert.equal(audit.listeners, 0);
			assert.equal(audit.sockets, 0);
			assert.equal(audit.children, 0);
		}
	});
}
