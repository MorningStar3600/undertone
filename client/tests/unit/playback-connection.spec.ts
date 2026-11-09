import { afterEach, describe, expect, it, vi } from "vitest";
import { OttRoomConnectionReal } from "@/plugins/connection";

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
