import { describe, expect, it, vi, afterEach } from "vitest";
import { createDesktopConnection, isPlaybackOutbound } from "../bridge";
import { createPlaybackSession } from "../../playback/playback-session";

afterEach(() => {
	vi.useRealTimers();
});
describe("desktop timeline transport", () => {
	it("uses the existing snapshot/clock/controller and sends native intentions as timeline commands", async () => {
		vi.useFakeTimers();
		const send = vi.fn();
		const proxy = createDesktopConnection(send);
		const adapter = {
			ready: vi.fn(),
			load: vi.fn(),
			getPosition: () => 12,
			seek: vi.fn(),
			supportsRate: () => true,
			setRate: vi.fn(),
			play: vi.fn(),
			pause: vi.fn(),
			dispose: vi.fn(),
		};
		const createAdapter = vi.fn(() => adapter);
		const session = createPlaybackSession({
			connection: proxy.connection,
			now: () => 0,
			createAdapter,
			onState: vi.fn(),
			allowed: () => true,
		});
		const subscribe = send.mock.calls.find(
			([message]) => message.action === "playback-subscribe",
		)![0];
		const probe = send.mock.calls.find(([message]) => message.action === "clock-probe")![0];
		const snapshot = {
			action: "playback-snapshot",
			nonce: "desktop-1",
			timeline: {
				version: 1,
				epoch: "fixture",
				baseline: {
					sequence: 1,
					serverTimeMs: 1000,
					lastEffectiveAtMs: 1000,
					lastOccurrenceId: 1,
					state: {
						occurrenceId: 1,
						media: { service: "adapter", id: "mapping" },
						positionSeconds: 12,
						isPlaying: false,
						rate: 1,
					},
				},
				events: [],
			},
			attachment: {
				epoch: "fixture",
				sequence: 1,
				occurrenceId: 1,
				media: { service: "adapter", id: "mapping" },
				item: { service: "youtube", id: "abcdefghijk", length: 120 },
			},
		};
		proxy.receive(snapshot); // Native discovery nonce never establishes JS authority.
		expect(session.established).toBe(false);
		proxy.receive({ ...snapshot, nonce: subscribe.nonce });
		proxy.receive({
			action: "clock-reply",
			nonce: probe.nonce,
			generation: probe.generation,
			serverReceiveMs: 1000,
			serverSendMs: 1000,
		});
		await vi.advanceTimersByTimeAsync(250);
		await session.controller.whenIdle();
		expect(createAdapter).toHaveBeenCalledOnce();
		expect(adapter.load).toHaveBeenCalledWith(
			snapshot.attachment.item,
			expect.any(AbortSignal),
		);
		expect(adapter.seek).toHaveBeenCalledWith(12, expect.any(AbortSignal));
		expect(adapter.pause).toHaveBeenCalled();
		session.command({ command: "seek", positionSeconds: 0 });
		expect(send).toHaveBeenLastCalledWith({
			action: "playback-command",
			command: {
				command: "seek",
				positionSeconds: 0,
				epoch: "fixture",
				occurrenceId: 1,
				requestId: expect.any(String),
			},
		});
		session.dispose();
		proxy.receive({
			action: "playback-event",
			event: {
				type: "play",
				epoch: "fixture",
				sequence: 2,
				occurrenceId: 1,
				effectiveAtMs: 1000,
			},
		});
		expect(adapter.dispose).toHaveBeenCalledOnce();
		expect(adapter.play).not.toHaveBeenCalled();
		proxy.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("starts with cached modern capability and requests its own fresh snapshot without legacy sync", () => {
		vi.useFakeTimers();
		const send = vi.fn();
		const proxy = createDesktopConnection(send);
		const adapter = vi.fn();
		const session = createPlaybackSession({
			connection: proxy.connection,
			now: () => performance.now(),
			createAdapter: adapter,
			onState: vi.fn(),
			allowed: () => true,
		});
		expect(send.mock.calls[0][0]).toMatchObject({ action: "playback-subscribe", version: 1 });
		expect(send.mock.calls[0][0].nonce.startsWith("desktop-")).toBe(false);
		proxy.receive({ action: "sync", currentSource: { service: "youtube", id: "abcdefghijk" } });
		vi.advanceTimersByTime(1500);
		expect(session.ownsPlayback).toBe(true);
		expect(adapter).not.toHaveBeenCalled();
		session.dispose();
		proxy.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("rejects auth, numeric requests, extra command fields and untrusted inbound channels", () => {
		const send = vi.fn();
		const proxy = createDesktopConnection(send);
		const listener = vi.fn();
		proxy.connection.addMessageHandler("sync", listener);
		proxy.receive({ action: "sync", isPlaying: true });
		expect(listener).not.toHaveBeenCalled();
		for (const value of [
			{ action: "auth", token: "fixture" },
			{ action: "req", request: 1 },
			{
				action: "playback-command",
				command: {
					command: "play",
					epoch: "e",
					occurrenceId: 1,
					requestId: "a",
					actor: "someone",
				},
			},
		]) {
			expect(isPlaybackOutbound(value)).toBe(false);
		}
		proxy.dispose();
	});
});
