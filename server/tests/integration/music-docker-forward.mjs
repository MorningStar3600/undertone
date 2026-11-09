import { createServer } from "node:net";

const PORT = /^\d+$/;
const HOST = /^(127\.0\.0\.1|ott-music-redis-[a-f0-9]{24})$/;

// Static program: host/port are positional arguments, never interpolated shell code.
// Both pumps die on EOF; removing the owned container also reaps remote execs.
export const TCP_PUMP = `set -e
exec 3<>"/dev/tcp/$1/$2"
printf 'music-forward-ready\\n' >&2
cat <&3 &
pump=$!
trap 'kill "$pump" 2>/dev/null || true; wait "$pump" 2>/dev/null || true' EXIT
trap 'exit 0' HUP INT TERM
cat >&3`;

/** Missing publication permits fallback; an unsafe publication must fail closed. */
export function publishedPort(metadata, service) {
	const bindings = metadata.NetworkSettings?.Ports?.[service];
	if (!bindings?.length) {
		return undefined;
	}
	if (
		bindings.length !== 1 ||
		bindings[0].HostIp !== "127.0.0.1" ||
		!PORT.test(bindings[0].HostPort) ||
		Number(bindings[0].HostPort) < 1 ||
		Number(bindings[0].HostPort) > 65535
	) {
		throw new Error("Expected one dynamically assigned localhost-only service port");
	}
	return bindings[0].HostPort;
}

async function bounded(pending, milliseconds, message) {
	let timer;
	try {
		return await Promise.race([
			pending,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), milliseconds);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** Raw TCP only. SQL/Redis clients, transactions and assertions remain unchanged. */
export class MusicDockerForwarder {
	servers = [];
	sockets = new Set();
	children = new Map();
	connecting = new Set();
	closed = false;

	constructor({ verify, spawn, report = console.error }) {
		this.verify = verify;
		this.spawn = spawn;
		this.report = report;
	}

	async open(host, port) {
		if (this.closed || !HOST.test(host) || !["5432", "6379"].includes(port)) {
			throw new Error("Invalid isolated forward target");
		}
		await this.verify();
		const server = createServer(socket => {
			if (this.closed || socket.remoteAddress !== "127.0.0.1" || this.sockets.size >= 64) {
				socket.destroy();
				return;
			}
			this.sockets.add(socket);
			socket.on("error", () => socket.destroy());
			socket.once("close", () => this.sockets.delete(socket));
			const pending = this.connect(socket, host, port);
			this.connecting.add(pending);
			void pending.finally(() => this.connecting.delete(pending));
		});
		this.servers.push(server);
		await bounded(
			new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", resolve);
			}),
			5000,
			"Local forwarding listener did not start within 5s",
		);
		return String(server.address().port);
	}

	async connect(socket, host, port) {
		try {
			// Recheck run labels immediately before every streamed docker exec.
			await this.verify();
			if (this.closed || socket.destroyed) {
				return;
			}
			const child = this.spawn(host, port);
			const exited = new Promise(resolve => child.once("close", resolve));
			this.children.set(child, exited);
			let readiness = "";
			const timer = setTimeout(() => {
				this.report("Isolated TCP forward did not connect within 10s");
				socket.destroy();
				child.kill();
			}, 10000);
			child.once("error", () => socket.destroy());
			child.stdin.on("error", () => socket.destroy());
			child.stdout.on("error", () => socket.destroy());
			child.stderr.on("data", data => {
				readiness = (readiness + data.toString()).slice(-128);
				if (readiness.includes("music-forward-ready\n")) {
					clearTimeout(timer);
				}
			});
			child.once("close", () => {
				clearTimeout(timer);
				this.children.delete(child);
				socket.destroy();
			});
			socket.once("close", () => child.stdin.end());
			socket.pipe(child.stdin);
			child.stdout.pipe(socket);
		} catch {
			// Never print docker arguments, stderr or credentials.
			this.report("Isolated TCP forward failed ownership verification or startup");
			socket.destroy();
		}
	}

	async close() {
		this.closed = true;
		const ports = this.servers.map(server => server.address()?.port).filter(Boolean);
		const pids = [...this.children.keys()].map(child => child.pid).filter(Boolean);
		const socketClosures = [...this.sockets].map(
			socket => new Promise(resolve => socket.once("close", resolve)),
		);
		const listeners = this.servers.map(
			server =>
				new Promise((resolve, reject) => {
					if (!server.listening) {
						return resolve();
					}
					server.close(error => (error ? reject(error) : resolve()));
				}),
		);
		for (const socket of this.sockets) {
			socket.destroy();
		}
		for (const child of this.children.keys()) {
			child.stdin.destroy();
			child.kill();
		}
		await bounded(
			Promise.all([
				...listeners,
				...socketClosures,
				...this.children.values(),
				...this.connecting,
			]),
			35000,
			"Local forwarding cleanup did not finish within 35s",
		);
		if (
			this.servers.some(server => server.listening) ||
			this.sockets.size ||
			this.children.size
		) {
			throw new Error("Local forwarding resources remain after cleanup");
		}
		return { ports, pids, listeners: 0, sockets: 0, children: 0 };
	}
}
