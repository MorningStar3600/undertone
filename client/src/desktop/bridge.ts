import { z } from "zod";
import {
	ClockProbeSchema,
	PlaybackCommandSchema,
	PlaybackSubscribeSchema,
} from "ott-common/playback/transport.js";
import type {
	ClientMessage,
	ServerMessage,
	ServerMessageActionType,
} from "ott-common/models/messages";
import type { OttRoomConnection } from "../plugins/connection";

const outbound = z.union([
	ClockProbeSchema,
	PlaybackSubscribeSchema,
	z.object({ action: z.literal("playback-command"), command: PlaybackCommandSchema }).strict(),
]);
export const isPlaybackOutbound = (value: unknown) => outbound.safeParse(value).success;
export const isPlaybackInbound = (value: unknown): value is ServerMessage =>
	typeof value === "object" &&
	value !== null &&
	"action" in value &&
	["playback-snapshot", "playback-event", "playback-result", "clock-reply"].includes(
		value.action as string,
	);

/** Deliberately no WebSocket, auth, localStorage, Vue runtime, or legacy sync channel. */
export function createDesktopConnection(send: (message: ClientMessage) => void) {
	const handlers = new Map<ServerMessageActionType, Set<(message: ServerMessage) => void>>();
	const proxy = {
		playbackCapability: true,
		send(message: ClientMessage) {
			if (!isPlaybackOutbound(message)) {
				throw new Error("Invalid desktop transport message");
			}
			send(message);
		},
		addMessageHandler(
			action: ServerMessageActionType,
			handler: (message: ServerMessage) => void,
		) {
			const set = handlers.get(action) ?? new Set();
			if (set.size >= 16) {
				throw new Error("Desktop listener capacity");
			}
			set.add(handler);
			handlers.set(action, set);
		},
		removeMessageHandler(
			action: ServerMessageActionType,
			handler: (message: ServerMessage) => void,
		) {
			handlers.get(action)?.delete(handler);
		},
	};
	return {
		// Only these three methods and cached capability are used by createPlaybackSession.
		connection: proxy as unknown as OttRoomConnection,
		receive(value: unknown) {
			if (!isPlaybackInbound(value)) {
				return;
			}
			for (const handler of [...(handlers.get(value.action) ?? [])]) {
				handler(value);
			}
		},
		dispose() {
			handlers.clear();
		},
	};
}
