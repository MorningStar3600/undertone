/* eslint vitest/no-conditional-in-test: "off" */
import { afterEach, describe, expect, it, vi } from "vitest";
import { OttRoomConnectionMock, type LegacyPlaybackSync } from "@/plugins/connection";
import { createPlaybackSession } from "@/playback/playback-session";
import { createPlayerSurfaces, type CapturedPlayer } from "@/playback/player-surface";
import { useRoomApi } from "@/util/roomapi";
import type { PlaybackTimeline, PlaybackEvent } from "ott-common/playback/index.js";
import type { PlaybackAttachment } from "ott-common/playback/transport.js";

const capability = { action: "playback-capabilities", version: 1, recovery: "snapshot" } as const;
const media = { service: "adapter", id: "opaque" };
const item = { service: "youtube", id: "ordinary-public-id", length: 180 } as const;
function timeline(sequence = 1, occurrenceId = 1): PlaybackTimeline {
	return {
		version: 1,
		epoch: "epoch",
		baseline: {
			serverTimeMs: 1_000,
			sequence,
			lastEffectiveAtMs: 1_000,
			lastOccurrenceId: occurrenceId,
			state: { occurrenceId, media, positionSeconds: 12, isPlaying: false, rate: 1 },
		},
		events: [],
	};
}
const attachment = (sequence = 1, occurrenceId = 1): PlaybackAttachment => ({
	epoch: "epoch",
	sequence,
	occurrenceId,
	media,
	item,
});
const cleanups: (() => void)[] = [];
const flush = async () => {
	for (let i = 0; i < 20; i++) {
		await Promise.resolve();
	}
};
function setup(early = false, earlySync?: LegacyPlaybackSync) {
	vi.useFakeTimers();
	let time = 0;
	const connection = new OttRoomConnectionMock();
	if (earlySync) {
		connection.mockReceive(earlySync);
	}
	if (early) {
		connection.mockReceive(capability);
	}
	const surfaces = createPlayerSurfaces();
	const onState = vi.fn();
	const onLegacyState = vi.fn();
	const allowed = vi.fn(() => true);
	const session = createPlaybackSession({
		connection,
		now: () => time,
		createAdapter: surfaces.createAdapter,
		onState,
		onLegacyState,
		allowed,
	});
	cleanups.push(session.dispose);
	const api = useRoomApi(connection);
	function calibrate() {
		const probe = connection.sent.findLast(message => message.action === "clock-probe");
		if (probe?.action !== "clock-probe") {
			throw new Error("No probe");
		}
		connection.mockReceive({
			action: "clock-reply",
			generation: probe.generation,
			nonce: probe.nonce,
			serverReceiveMs: 1_000 + time,
			serverSendMs: 1_000 + time,
		});
	}
	function snapshot(value = timeline(), active: PlaybackAttachment | null = attachment()) {
		const subscribe = connection.sent.findLast(
			message => message.action === "playback-subscribe",
		);
		if (subscribe?.action !== "playback-subscribe") {
			throw new Error("No subscribe");
		}
		connection.mockReceive({
			action: "playback-snapshot",
			nonce: subscribe.nonce,
			timeline: value,
			attachment: active,
		});
	}
	function event(event: PlaybackEvent, active?: PlaybackAttachment) {
		connection.mockReceive({
			action: "playback-event",
			event,
			...(active ? { attachment: active } : {}),
		});
	}
	async function tick(ms = 250) {
		time += ms;
		await vi.advanceTimersByTimeAsync(ms);
		await flush();
	}
	function bind() {
		const binding = surfaces.surface.value;
		if (!binding) {
			throw new Error("Missing surface");
		}
		const player = {
			play: vi.fn(),
			pause: vi.fn(),
			getPosition: vi.fn(() => 12),
			setPosition: vi.fn(),
			setPlaybackRate: vi.fn(),
			setVolume: vi.fn(),
			getAvailablePlaybackRates: () => [1, 2],
			isCaptionsSupported: () => false,
			isQualitySupported: () => false,
			dispose: vi.fn(),
			activate: vi.fn(),
		} satisfies CapturedPlayer;
		binding.bind(player);
		binding.ready();
		return player;
	}
	return {
		connection,
		surfaces,
		onState,
		onLegacyState,
		session,
		api,
		allowed,
		calibrate,
		snapshot,
		event,
		tick,
		bind,
	};
}
// eslint-disable-next-line vitest/require-top-level-describe
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) {
		cleanup();
	}
	vi.useRealTimers();
});

describe("client playback subscription and captured provider integration", () => {
	it("keeps legacy requests on servers without capability after authenticated negotiation", async () => {
		const { api, connection, tick } = setup();
		connection.mockReceive({ action: "sync" });
		await tick(1_000);
		api.play();
		api.seek(3);
		api.skip();
		expect(connection.sent.map(message => message.action)).toEqual(["req", "req", "req"]);
	});
	it("caches capability before Room mounts, sends probe without sentAt and resolves only atomic attachment", async () => {
		const s = setup(true);
		expect(s.connection.sent.map(message => message.action)).toEqual([
			"playback-subscribe",
			"clock-probe",
		]);
		expect(s.connection.sent[1]).not.toHaveProperty("sentAtMs");
		s.calibrate();
		s.snapshot();
		await flush();
		expect(s.surfaces.surface.value?.source.value).toEqual(item);
		const player = s.bind();
		await flush();
		expect(player.play).not.toHaveBeenCalled();
		expect(player.setPosition).toHaveBeenCalledWith(12);
		expect(player.pause).toHaveBeenCalledOnce();
	});
	it("buffers events before snapshot and applies its contiguous suffix", async () => {
		const s = setup(true);
		s.calibrate();
		s.event({
			epoch: "epoch",
			sequence: 2,
			occurrenceId: 1,
			effectiveAtMs: 1_000,
			type: "seek",
			positionSeconds: 44,
		});
		s.snapshot();
		await flush();
		const player = s.bind();
		await flush();
		expect(player.setPosition).toHaveBeenCalledWith(44);
	});
	it("accepts an active attachment predating the snapshot cursor", async () => {
		const s = setup(true);
		s.calibrate();
		s.snapshot(timeline(4), attachment(1));
		await flush();
		expect(s.session.established).toBe(true);
		expect(s.surfaces.surface.value?.source.value?.id).toBe(item.id);
	});
	it.each(["missing", "wrong-media", "wrong-epoch", "wrong-occurrence"])(
		"fails closed on %s snapshot attachment",
		async kind => {
			const s = setup(true);
			s.calibrate();
			const active = attachment();
			if (kind === "wrong-media") {
				active.media = { ...media, id: "different" };
			}
			if (kind === "wrong-epoch") {
				active.epoch = "other";
			}
			if (kind === "wrong-occurrence") {
				active.occurrenceId = 2;
			}
			s.snapshot(timeline(), kind === "missing" ? null : active);
			await flush();
			expect(s.session.established).toBe(false);
			expect(s.surfaces.surface.value).toBeNull();
		},
	);
	it("source refresh remounts same occurrence; new occurrence restarts identical provider media", async () => {
		const s = setup(true);
		s.calibrate();
		s.snapshot();
		await flush();
		const first = s.bind();
		await flush();
		const refreshed = { ...media, id: "refreshed" };
		s.event(
			{
				epoch: "epoch",
				sequence: 2,
				occurrenceId: 1,
				effectiveAtMs: 1_000,
				type: "source",
				media: refreshed,
			},
			{ ...attachment(2), media: refreshed },
		);
		expect(first.dispose).toHaveBeenCalledOnce();
		await s.tick();
		const second = s.bind();
		await flush();
		s.event(
			{
				epoch: "epoch",
				sequence: 3,
				occurrenceId: 2,
				effectiveAtMs: 1_250,
				type: "load",
				media,
				positionSeconds: 0,
				isPlaying: false,
				rate: 1,
			},
			attachment(3, 2),
		);
		expect(second.dispose).toHaveBeenCalledOnce();
		await s.tick();
		const third = s.bind();
		await flush();
		expect(third.setPosition).toHaveBeenCalledWith(0);
	});
	it("gaps stop rendering and recover with a fresh nonce/backoff; older snapshots cannot roll back", async () => {
		const s = setup(true);
		s.calibrate();
		s.snapshot();
		await flush();
		const player = s.bind();
		await flush();
		s.event({
			epoch: "epoch",
			sequence: 3,
			occurrenceId: 1,
			effectiveAtMs: 1_000,
			type: "play",
		});
		expect(player.dispose).toHaveBeenCalledOnce();
		await s.tick(500);
		expect(s.connection.sent.filter(m => m.action === "playback-subscribe")).toHaveLength(2);
		s.snapshot(timeline(3));
		await flush();
		s.event({
			epoch: "epoch",
			sequence: 5,
			occurrenceId: 1,
			effectiveAtMs: 1_500,
			type: "play",
		});
		await s.tick(500);
		s.snapshot(timeline(1));
		expect(s.session.controller.getStatus().code).toBe("recovering");
	});
	it("reauth invalidates clock/results, requires fresh capability, and ignores old snapshot nonce", async () => {
		const s = setup(true);
		s.calibrate();
		s.snapshot();
		await flush();
		const player = s.bind();
		await flush();
		const oldSubscribe = s.connection.sent.find(m => m.action === "playback-subscribe")!;
		s.connection.mockLifecycle();
		expect(player.dispose).toHaveBeenCalledOnce();
		s.connection.mockReset();
		s.api.play();
		expect(s.connection.sent).toEqual([]);
		s.connection.mockReceive(capability);
		if (oldSubscribe.action === "playback-subscribe") {
			s.connection.mockReceive({
				action: "playback-snapshot",
				nonce: oldSubscribe.nonce,
				timeline: timeline(),
				attachment: attachment(),
			});
		}
		expect(s.surfaces.surface.value).toBeNull();
		s.snapshot();
		await flush();
		expect(s.surfaces.surface.value).toBeNull();
		s.calibrate();
		await s.tick();
		expect(s.surfaces.surface.value).not.toBeNull();
	});
	it("routes seek/rate/next with current epoch and occurrence, enforces grants and deduplicates skip", async () => {
		const s = setup(true);
		s.calibrate();
		s.snapshot();
		await flush();
		s.bind();
		await flush();
		s.connection.mockReset();
		s.api.seek(33);
		s.api.setPlaybackRate(2);
		s.api.skip();
		s.api.skip();
		const commands = s.connection.sent.filter(m => m.action === "playback-command");
		expect(commands).toHaveLength(3);
		expect(commands.map(m => m.command.command)).toEqual(["seek", "rate", "next"]);
		for (const message of commands) {
			expect(message.command).toMatchObject({ epoch: "epoch", occurrenceId: 1 });
		}
		expect(new Set(commands.map(m => m.command.requestId)).size).toBe(3);
		s.allowed.mockReturnValue(false);
		s.api.pause();
		expect(s.connection.sent).toHaveLength(3);
	});
	it("correlates results and recovers only for current pending stale commands", async () => {
		const s = setup(true);
		s.calibrate();
		s.snapshot();
		await flush();
		s.api.seek(5);
		s.connection.mockReceive({
			action: "playback-result",
			result: {
				requestId: "unknown",
				epoch: "old",
				sequence: 0,
				status: "rejected",
				code: "stale-epoch",
			},
		});
		expect(s.session.controller.getStatus().code).not.toBe("recovering");
		const command = s.connection.sent.findLast(m => m.action === "playback-command")!;
		if (command.action === "playback-command") {
			s.connection.mockReceive({
				action: "playback-result",
				result: {
					requestId: command.command.requestId,
					epoch: "old",
					sequence: 0,
					status: "rejected",
					code: "stale-epoch",
				},
			});
		}
		expect(s.session.controller.getStatus().code).toBe("recovering");
	});
	it("clear cancels a late position read, discards mapping, and cannot command old occurrence", async () => {
		const s = setup(true);
		s.calibrate();
		s.snapshot();
		await flush();
		const player = s.bind();
		await flush();
		let resolve!: (value: number) => void;
		player.getPosition.mockImplementation(
			() =>
				new Promise<number>(done => {
					resolve = done;
				}) as unknown as number,
		);
		await s.tick();
		s.event({
			epoch: "epoch",
			sequence: 2,
			occurrenceId: 1,
			effectiveAtMs: 1_250,
			type: "clear",
		});
		expect(player.dispose).toHaveBeenCalledOnce();
		await flush();
		s.connection.mockReset();
		s.api.play();
		s.api.seek(10);
		expect(s.connection.sent).toEqual([]);
		resolve?.(99);
		await flush();
		expect(s.surfaces.surface.value).toBeNull();
	});
	it("settles late readiness on dispose and removes all owned timers/listeners", async () => {
		const s = setup(true);
		s.calibrate();
		s.snapshot();
		await flush();
		const old = s.surfaces.surface.value!;
		s.session.dispose();
		await flush();
		await s.session.controller.whenIdle();
		const late = { dispose: vi.fn() } as unknown as CapturedPlayer;
		old.bind(late);
		old.ready();
		expect(late.dispose).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
		s.connection.mockReset();
		s.connection.mockReceive(capability);
		expect(s.connection.sent).toEqual([]);
	});
	it("rejects conflicting duplicate events even after local timeline compaction", async () => {
		const s = setup(true);
		s.calibrate();
		s.snapshot();
		await flush();
		s.bind();
		await flush();
		s.event({
			epoch: "epoch",
			sequence: 2,
			occurrenceId: 1,
			effectiveAtMs: 1000,
			type: "seek",
			positionSeconds: 33,
		});
		s.event({
			epoch: "epoch",
			sequence: 2,
			occurrenceId: 1,
			effectiveAtMs: 1000,
			type: "seek",
			positionSeconds: 99,
		});
		expect(s.session.controller.getStatus().code).toBe("recovering");
	});
	it("rejects missing atomic source attachment and event-only epoch changes", async () => {
		const s = setup(true);
		s.calibrate();
		s.snapshot();
		await flush();
		const player = s.bind();
		await flush();
		s.event({
			epoch: "epoch",
			sequence: 2,
			occurrenceId: 1,
			effectiveAtMs: 1000,
			type: "source",
			media: { service: "adapter", id: "other" },
		});
		expect(player.dispose).toHaveBeenCalledOnce();
		await s.tick(500);
		s.snapshot();
		await s.tick();
		s.bind();
		await flush();
		s.event({
			epoch: "different",
			sequence: 2,
			occurrenceId: 1,
			effectiveAtMs: 1000,
			type: "play",
		});
		expect(s.session.controller.getStatus().code).toBe("recovering");
	});
	it("keeps a healthy provider through clock refresh and a throttled timer gap", async () => {
		const s = setup(true);
		s.calibrate();
		s.snapshot();
		await flush();
		const player = s.bind();
		await flush();
		const surface = s.surfaces.surface.value;
		s.session.refreshClock();
		await s.tick(6_000);
		expect(player.dispose).not.toHaveBeenCalled();
		expect(s.surfaces.surface.value).toBe(surface);
		expect(s.session.controller.getStatus().code).toBe("paused");
	});
	it("resets on explicit provider refresh and waits for a fresh clock", async () => {
		const s = setup(true);
		s.calibrate();
		s.snapshot();
		await flush();
		const player = s.bind();
		await flush();
		s.session.resume();
		expect(player.dispose).toHaveBeenCalledOnce();
		expect(s.surfaces.surface.value).toBeNull();
		s.calibrate();
		await s.tick();
		expect(s.surfaces.surface.value).not.toBeNull();
	});
	it("bounds pre-snapshot buffering and invalidates the outstanding nonce after overflow", async () => {
		const s = setup(true);
		s.calibrate();
		for (let i = 0; i < 129; i++) {
			s.event({
				epoch: "epoch",
				sequence: 2,
				occurrenceId: 1,
				effectiveAtMs: 1000,
				type: "play",
			});
		}
		s.snapshot();
		expect(s.session.established).toBe(false);
		await s.tick(1000);
		s.snapshot(timeline(2));
		expect(s.session.established).toBe(true);
	});
	it("a source event with identical public media still replaces the captured instance", async () => {
		const s = setup(true);
		s.calibrate();
		s.snapshot();
		await flush();
		const first = s.bind();
		await flush();
		s.event(
			{
				epoch: "epoch",
				sequence: 2,
				occurrenceId: 1,
				effectiveAtMs: 1000,
				type: "source",
				media,
			},
			attachment(2),
		);
		expect(first.dispose).toHaveBeenCalledOnce();
		await s.tick();
		const second = s.bind();
		await flush();
		expect(second.setPosition).toHaveBeenCalledWith(12);
	});
	it("a pending old position result settles on abort without blocking the replacement pipeline", async () => {
		const s = setup(true);
		s.calibrate();
		s.snapshot();
		await flush();
		const old = s.bind();
		await flush();
		let settle!: (position: number) => void;
		old.getPosition.mockImplementation(
			() =>
				new Promise<number>(resolve => {
					settle = resolve;
				}) as unknown as number,
		);
		await s.tick();
		s.event(
			{
				epoch: "epoch",
				sequence: 2,
				occurrenceId: 2,
				effectiveAtMs: 1250,
				type: "load",
				media,
				positionSeconds: 0,
				isPlaying: false,
				rate: 1,
			},
			attachment(2, 2),
		);
		await s.tick();
		const replacement = s.bind();
		await flush();
		const seeks = replacement.setPosition.mock.calls.length;
		settle(999);
		await flush();
		expect(replacement.setPosition).toHaveBeenCalledTimes(seeks);
		expect(replacement.setPosition).toHaveBeenCalledWith(0);
	});
	it("parses full core snapshots and resolves the active attachment after historical source events", async () => {
		const s = setup(true);
		s.calibrate();
		const snapshot = timeline();
		snapshot.baseline = {
			serverTimeMs: 1000,
			sequence: 0,
			lastEffectiveAtMs: 1000,
			lastOccurrenceId: 0,
			state: null,
		};
		snapshot.events = [
			{
				type: "load",
				epoch: "epoch",
				sequence: 1,
				occurrenceId: 1,
				effectiveAtMs: 1000,
				media: { service: "adapter", id: "historical" },
				positionSeconds: 12,
				isPlaying: false,
				rate: 1,
			},
			{
				type: "source",
				epoch: "epoch",
				sequence: 2,
				occurrenceId: 1,
				effectiveAtMs: 1000,
				media,
			},
		];
		s.snapshot(snapshot, attachment(2));
		await flush();
		expect(s.surfaces.surface.value?.source.value).toEqual(item);
	});
	it("validates a conflicting buffered duplicate against snapshot-retained core events", async () => {
		const s = setup(true);
		s.calibrate();
		const snapshot = timeline();
		snapshot.events = [
			{
				type: "seek",
				epoch: "epoch",
				sequence: 2,
				occurrenceId: 1,
				effectiveAtMs: 1000,
				positionSeconds: 20,
			},
		];
		s.event({ ...snapshot.events[0], type: "seek", positionSeconds: 99 });
		s.snapshot(snapshot);
		expect(s.session.controller.getStatus().code).toBe("recovering");
	});
});

const legacy: LegacyPlaybackSync = {
	action: "sync",
	currentSource: { service: "youtube", id: "legacy-new", length: 180 },
	isPlaying: true,
	playbackPosition: 3,
	playbackSpeed: 1,
};
function lastCommand(s: ReturnType<typeof setup>) {
	const message = s.connection.sent.findLast(m => m.action === "playback-command");
	if (message?.action !== "playback-command") {
		throw new Error("Missing command");
	}
	return message.command;
}

describe("generation-scoped capability negotiation", () => {
	it("buffers a full reconnect sync and merges partial playback fields before legacy projection", async () => {
		const s = setup(true);
		s.calibrate();
		s.snapshot();
		s.connection.mockLifecycle();
		s.connection.mockReset();
		s.connection.mockReceive(legacy);
		s.connection.mockReceive({ action: "sync", isPlaying: false, playbackPosition: 14 });
		await s.tick(999);
		s.api.play();
		expect(s.connection.sent).toEqual([]);
		expect(s.onLegacyState).not.toHaveBeenCalled();
		expect(s.session.established).toBe(false);
		expect(s.onState).toHaveBeenLastCalledWith(null, null, true);
		await s.tick(1);
		expect(s.onLegacyState).toHaveBeenCalledOnce();
		expect(s.onLegacyState).toHaveBeenCalledWith({
			...legacy,
			isPlaying: false,
			playbackPosition: 14,
		});
		expect(s.onState).toHaveBeenLastCalledWith(null, null, false);
		expect(s.session.ownsPlayback).toBe(false);
		s.api.play();
		s.api.seek(8);
		s.api.skip();
		expect(s.connection.sent.map(m => m.action)).toEqual(["req", "req", "req"]);
	});
	it("uses cached authenticated sync when Room mounts after the legacy server replied", async () => {
		const s = setup(false, legacy);
		await s.tick(1_000);
		expect(s.onLegacyState).toHaveBeenCalledWith(legacy);
		expect(s.session.ownsPlayback).toBe(false);
	});
	it("never falls back merely because disconnected, reauthenticated, or silent", async () => {
		const s = setup(true);
		s.calibrate();
		s.snapshot();
		s.connection.mockLifecycle();
		s.connection.mockReset();
		await s.tick(30_000);
		s.api.skip();
		expect(s.onLegacyState).not.toHaveBeenCalled();
		expect(s.session.ownsPlayback).toBe(true);
		expect(s.connection.sent).toEqual([]);
	});
	it("valid capability before the deadline cancels fallback and holds for a valid requested snapshot", async () => {
		const s = setup(false, legacy);
		await s.tick(999);
		s.connection.mockReceive(capability);
		await s.tick(20_000);
		expect(s.onLegacyState).not.toHaveBeenCalled();
		expect(s.session.established).toBe(false);
		expect(s.session.ownsPlayback).toBe(true);
		s.calibrate();
		s.snapshot();
		expect(s.session.established).toBe(true);
	});
	it("late capability detaches legacy authority and requires a new snapshot and clock", async () => {
		const s = setup(false, legacy);
		await s.tick(1_000);
		expect(s.session.ownsPlayback).toBe(false);
		s.connection.mockReceive(capability);
		expect(s.onState).toHaveBeenLastCalledWith(null, null, true);
		s.connection.mockReset();
		s.api.skip();
		expect(s.connection.sent).toEqual([]);
		// Re-advertising capability does not manufacture a second subscription.
		s.connection.mockReceive(capability);
		expect(s.connection.sent).toEqual([]);
		await s.tick(5_000);
		s.snapshot();
		expect(s.surfaces.surface.value).toBeNull();
		s.calibrate();
		await s.tick();
		expect(s.surfaces.surface.value?.source.value).toEqual(item);
	});
	it("malformed capability does not prevent bounded legacy negotiation", async () => {
		const s = setup(false, legacy);
		s.connection.mockReceive({ ...capability, extra: true } as unknown as typeof capability);
		expect(s.connection.playbackCapability).toBe(false);
		await s.tick(1_000);
		expect(s.session.ownsPlayback).toBe(false);
		expect(s.onLegacyState).toHaveBeenCalledWith(legacy);
	});
	it("does not downgrade a recovering modern generation to stale legacy sync", async () => {
		const s = setup(true);
		s.calibrate();
		s.snapshot();
		s.connection.mockReceive(legacy);
		s.event({
			epoch: "epoch",
			sequence: 3,
			occurrenceId: 1,
			effectiveAtMs: 1_000,
			type: "play",
		});
		await s.tick(20_000);
		expect(s.session.ownsPlayback).toBe(true);
		expect(s.onLegacyState).not.toHaveBeenCalled();
		expect(s.surfaces.surface.value).toBeNull();
	});
	it("cancels a pending fallback on repeated auth and never merges the prior generation", async () => {
		const s = setup(false, legacy);
		await s.tick(500);
		s.connection.mockLifecycle();
		await s.tick(1_000);
		expect(s.onLegacyState).not.toHaveBeenCalled();
		s.connection.mockReceive({ action: "sync", currentSource: null });
		await s.tick(500);
		s.connection.mockLifecycle();
		s.connection.mockReceive({ action: "sync", playbackPosition: 2 });
		await s.tick(999);
		expect(s.onLegacyState).not.toHaveBeenCalled();
		await s.tick(1);
		expect(s.onLegacyState).toHaveBeenCalledOnce();
		expect(s.onLegacyState).toHaveBeenCalledWith({
			action: "sync",
			playbackPosition: 2,
		});
	});
	it("cancels fallback and every listener on disposal", async () => {
		const s = setup(false, legacy);
		s.session.dispose();
		expect(vi.getTimerCount()).toBe(0);
		s.connection.mockReceive(legacy);
		s.connection.mockReceive(capability);
		await s.tick(2_000);
		expect(s.onLegacyState).not.toHaveBeenCalled();
		expect(s.connection.sent).toEqual([]);
	});
});

describe("pending-only next intentions", () => {
	it("routes Previous through the authoritative cursor, dedupes pending navigation and never falls back to undo", async () => {
		const s = setup(true);
		s.calibrate();
		s.snapshot();
		s.connection.mockReset();
		s.api.previous();
		const first = lastCommand(s);
		expect(first).toMatchObject({ command: "previous", epoch: "epoch", occurrenceId: 1 });
		s.api.previous();
		s.api.skip();
		expect(s.connection.sent).toHaveLength(1);
		s.connection.mockReceive({
			action: "playback-result",
			result: {
				requestId: first.requestId,
				epoch: "epoch",
				sequence: 1,
				status: "rejected",
				code: "unavailable",
			},
		});
		s.api.previous();
		expect(lastCommand(s).requestId).not.toBe(first.requestId);
		s.allowed.mockReturnValue(false);
		s.connection.mockReset();
		s.api.previous();
		expect(s.connection.sent).toEqual([]);
		const legacy = setup(false);
		await legacy.tick(1_000);
		legacy.connection.mockReset();
		legacy.api.previous();
		expect(legacy.connection.sent).toEqual([]);
	});
	it("sends one guarded Previous from an exhausted timeline without seeking a provider", async () => {
		const s = setup(true);
		s.calibrate();
		const empty = timeline(2);
		empty.baseline.state = null;
		s.snapshot(empty, null);
		s.connection.mockReset();
		s.api.previous();
		s.api.previous();
		expect(lastCommand(s)).toMatchObject({ command: "previous", occurrenceId: 0 });
		expect(s.connection.sent).toHaveLength(1);
		expect(s.surfaces.surface.value).toBeNull();
	});
	it("never lets a prior occurrence's result release a new pending next", async () => {
		const s = setup(true);
		s.calibrate();
		s.snapshot();
		s.api.skip();
		const first = lastCommand(s);
		s.event(
			{
				type: "load",
				epoch: "epoch",
				sequence: 2,
				occurrenceId: 2,
				effectiveAtMs: 1_000,
				media,
				positionSeconds: 0,
				isPlaying: false,
				rate: 1,
			},
			attachment(2, 2),
		);
		s.api.skip();
		const second = lastCommand(s);
		expect(second.occurrenceId).toBe(2);
		s.connection.mockReceive({
			action: "playback-result",
			result: {
				requestId: first.requestId,
				epoch: "epoch",
				sequence: 2,
				status: "rejected",
				code: "stale-occurrence",
			},
		});
		s.api.skip();
		expect(lastCommand(s)).toEqual(second);
		expect(s.connection.sent.filter(m => m.action === "playback-command")).toHaveLength(2);
		expect(s.session.controller.getStatus().code).not.toBe("recovering");
	});
	it.each(["applied", "rejected"] as const)(
		"releases a correlated %s next so deliberate actions get fresh IDs",
		async status => {
			const s = setup(true);
			s.calibrate();
			s.snapshot();
			s.api.skip();
			const first = lastCommand(s);
			s.api.skip();
			expect(s.connection.sent.filter(m => m.action === "playback-command")).toHaveLength(1);
			s.connection.mockReceive({
				action: "playback-result",
				result: { requestId: first.requestId, epoch: "epoch", sequence: 1, status },
			});
			s.api.skip();
			const second = lastCommand(s);
			expect(second.requestId).not.toBe(first.requestId);
			// A late duplicate result must not release the newer pending action.
			s.connection.mockReceive({
				action: "playback-result",
				result: { requestId: first.requestId, epoch: "epoch", sequence: 1, status },
			});
			s.api.skip();
			expect(s.connection.sent.filter(m => m.action === "playback-command")).toHaveLength(2);
		},
	);
	it("expires pending next, recovers, and permits a deliberate retry without automatic command replay", async () => {
		const s = setup(true);
		s.calibrate();
		s.snapshot();
		s.api.skip();
		const first = lastCommand(s);
		await s.tick(16_000);
		expect(s.connection.sent.filter(m => m.action === "playback-command")).toHaveLength(1);
		s.calibrate();
		s.snapshot();
		await s.tick();
		s.bind();
		await flush();
		s.api.skip();
		expect(lastCommand(s).requestId).not.toBe(first.requestId);
		s.connection.mockReceive({
			action: "playback-result",
			result: { requestId: first.requestId, epoch: "epoch", sequence: 1, status: "applied" },
		});
		s.api.skip();
		expect(s.connection.sent.filter(m => m.action === "playback-command")).toHaveLength(2);
	});
	it("clears pending next during recovery and scopes replacement actions by generation and occurrence", async () => {
		const s = setup(true);
		s.calibrate();
		s.snapshot();
		s.api.skip();
		const first = lastCommand(s);
		s.event({
			epoch: "epoch",
			sequence: 3,
			occurrenceId: 1,
			effectiveAtMs: 1_000,
			type: "play",
		});
		await s.tick(500);
		s.snapshot();
		await s.tick();
		s.bind();
		await flush();
		s.api.skip();
		expect(lastCommand(s).requestId).not.toBe(first.requestId);
		s.connection.mockLifecycle();
		s.connection.mockReceive(capability);
		s.calibrate();
		s.snapshot(timeline(2, 2), attachment(2, 2));
		s.api.skip();
		const latest = lastCommand(s);
		expect(latest.occurrenceId).toBe(2);
		s.connection.mockReceive({
			action: "playback-result",
			result: {
				requestId: first.requestId,
				epoch: "old",
				sequence: 1,
				status: "rejected",
				code: "stale-epoch",
			},
		});
		s.api.skip();
		expect(lastCommand(s)).toEqual(latest);
		expect(s.session.controller.getStatus().code).not.toBe("recovering");
	});
});
