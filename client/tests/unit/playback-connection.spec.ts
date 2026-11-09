import { afterEach, describe, expect, it, vi } from "vitest";
import { OttRoomConnectionReal } from "@/plugins/connection";
import { createPlaybackSession } from "@/playback/playback-session";
import { createPlayerSurfaces } from "@/playback/player-surface";

class Socket {
	static instances: Socket[] = [];
	listeners = new Map<string, ((event: unknown) => void)[]>();
	send = vi.fn();
	close = vi.fn();
	constructor(_url: string) {
		Socket.instances.push(this);
	}
	addEventListener(type: string, listener: (event: unknown) => void) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}
	emit(type: string, value: unknown = {}) {
		for (const listener of this.listeners.get(type) ?? []) {
			listener(value);
		}
	}
}
// eslint-disable-next-line vitest/require-top-level-describe
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
	Socket.instances = [];
});
describe("socket generation ownership", () => {
	it("ignores old-socket auth evidence and merges only the new socket's sync before fallback", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("WebSocket", Socket);
		const connection = new OttRoomConnectionReal();
		const onLegacyState = vi.fn();
		const session = createPlaybackSession({
			connection,
			now: () => Date.now(),
			onState: vi.fn(),
			onLegacyState,
			allowed: () => true,
			createAdapter: createPlayerSurfaces().createAdapter,
		});
		connection.connect("first");
		const first = Socket.instances[0];
		first.emit("open");
		const legacy = {
			action: "sync",
			currentSource: { service: "youtube", id: "old" },
			isPlaying: true,
			playbackPosition: 3,
			playbackSpeed: 1,
		};
		first.emit("message", { data: JSON.stringify(legacy) });
		await vi.advanceTimersByTimeAsync(500);
		connection.reconnect();
		const second = Socket.instances[1];
		second.emit("open");
		first.emit("message", { data: JSON.stringify(legacy) });
		await vi.advanceTimersByTimeAsync(1_500);
		expect(connection.playbackSync).toBeUndefined();
		expect(onLegacyState).not.toHaveBeenCalled();
		second.emit("message", {
			data: JSON.stringify({ ...legacy, currentSource: { service: "youtube", id: "fresh" } }),
		});
		second.emit("message", {
			data: JSON.stringify({ action: "sync", playbackPosition: 9, isPlaying: false }),
		});
		await vi.advanceTimersByTimeAsync(1_000);
		expect(onLegacyState).toHaveBeenCalledOnce();
		expect(onLegacyState).toHaveBeenCalledWith({
			...legacy,
			currentSource: { service: "youtube", id: "fresh" },
			playbackPosition: 9,
			isPlaying: false,
		});
		connection.disconnect();
		session.dispose();
		expect(connection.playbackSync).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("cancels fallback and clears auth evidence on repeated same-token auth and disconnect", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("WebSocket", Socket);
		const connection = new OttRoomConnectionReal();
		connection.connect("room");
		const socket = Socket.instances[0];
		socket.emit("open");
		socket.emit("message", { data: JSON.stringify({ action: "sync", currentSource: null }) });
		const onLegacyState = vi.fn();
		const session = createPlaybackSession({
			connection,
			now: () => Date.now(),
			onState: vi.fn(),
			onLegacyState,
			allowed: () => true,
			createAdapter: createPlayerSurfaces().createAdapter,
		});
		await vi.advanceTimersByTimeAsync(500);
		connection.send({ action: "auth", token: "same-token" });
		expect(connection.playbackSync).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(onLegacyState).not.toHaveBeenCalled();
		socket.emit("message", { data: JSON.stringify({ action: "sync", currentSource: null }) });
		connection.send({ action: "auth", token: "same-token" });
		await vi.advanceTimersByTimeAsync(1_000);
		expect(onLegacyState).not.toHaveBeenCalled();
		socket.emit("message", { data: JSON.stringify({ action: "sync", currentSource: null }) });
		connection.disconnect();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(onLegacyState).not.toHaveBeenCalled();
		session.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("ignores stale open/close/message/error after replacement and resets capability on same-token reauth", () => {
		vi.useFakeTimers();
		vi.stubGlobal("WebSocket", Socket);
		const connection = new OttRoomConnectionReal();
		const lifecycle = vi.fn();
		connection.onLifecycle(lifecycle);
		const received = vi.fn();
		connection.addMessageHandler("playback-capabilities", received);
		connection.connect("room");
		const first = Socket.instances[0];
		first.emit("open");
		first.emit("message", {
			data: JSON.stringify({
				action: "playback-capabilities",
				version: 1,
				recovery: "snapshot",
			}),
		});
		expect(connection.playbackCapability).toBe(true);
		connection.send({ action: "auth", token: "same-token" });
		expect(connection.playbackCapability).toBe(false);
		connection.reconnect();
		const second = Socket.instances[1];
		second.emit("open");
		const count = received.mock.calls.length;
		first.emit("open");
		first.emit("close", { code: 4001 });
		first.emit("message", {
			data: JSON.stringify({
				action: "playback-capabilities",
				version: 1,
				recovery: "snapshot",
			}),
		});
		first.emit("error");
		expect(received).toHaveBeenCalledTimes(count);
		expect(connection.connected.value).toBe(true);
		expect(connection.kickReason.value).toBeNull();
		expect(connection.playbackCapability).toBe(false);
		expect(first.send).toHaveBeenCalledTimes(2);
		expect(second.send).toHaveBeenCalledOnce();
		connection.disconnect();
		second.emit("close", { code: 1000 });
		expect(vi.getTimerCount()).toBe(0);
		expect(lifecycle).toHaveBeenCalled();
	});
});
