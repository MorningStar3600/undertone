import { z } from "zod";
import { createPlaybackSession, type PlaybackSession } from "../playback/playback-session";
import { createDesktopConnection } from "./bridge";
import { createYoutubeAdapter } from "./youtube-adapter";

declare global {
	interface Window {
		ipc: { postMessage(message: string): void };
		undertone: typeof host;
	}
}

const intention = z.discriminatedUnion("command", [
	z.object({ command: z.enum(["play", "pause", "next", "previous"]) }).strict(),
	z
		.object({
			command: z.literal("seek"),
			positionSeconds: z.number().finite().min(0).max(1e9),
		})
		.strict(),
]);
const post = (message: unknown) => window.ipc.postMessage(JSON.stringify(message));
let sentCommands = 0;
const proxy = createDesktopConnection(message => {
	if (message.action === "playback-command") {
		sentCommands++;
	}
	post({ kind: "send", message });
});
let session: PlaybackSession | undefined;
let volume = 0;
let adapter: ReturnType<typeof createYoutubeAdapter> | undefined;
let lastState = "";
let available = false;
const root = document.getElementById("player")!;
const host = {
	start() {
		if (session) {
			return;
		}
		session = createPlaybackSession({
			connection: proxy.connection,
			now: () => performance.now(),
			allowed: () => true, // The authenticated server enforces room permissions.
			createAdapter(context) {
				adapter = createYoutubeAdapter(context, root, () => volume);
				return adapter;
			},
			onState(state, item) {
				available = !!state && !!item && !!session?.established;
				const message = JSON.stringify({
					kind: "state",
					position: Math.max(0, Math.floor(state?.positionSeconds ?? 0)),
					duration: Math.max(0, Math.min(1e9, item?.length ?? 0)),
					playing: state?.isPlaying ?? false,
					available,
				});
				if (message !== lastState) {
					lastState = message;
					window.ipc.postMessage(message);
				}
			},
			onStatus({ code }) {
				if (
					["waiting-snapshot", "waiting-clock", "recovering", "disposed"].includes(code)
				) {
					available = false;
				}
				post({ kind: "status", code });
			},
		});
	},
	receive(message: unknown) {
		proxy.receive(message);
	},
	command(value: unknown) {
		const parsed = intention.safeParse(value);
		if (!parsed.success || !available || !session?.established) {
			post({ kind: "status", code: "commandUnavailable" });
			return;
		}
		const before = sentCommands;
		session.command(parsed.data);
		if (sentCommands === before) {
			post({ kind: "status", code: "commandUnavailable" });
		}
	},
	setVolume(value: number) {
		if (!Number.isFinite(value)) {
			return;
		}
		volume = Math.min(100, Math.max(0, value));
		adapter?.setVolume();
	},
	dispose() {
		session?.dispose();
		session = undefined;
		proxy.dispose();
		adapter = undefined;
		available = false;
		root.replaceChildren();
	},
};
window.undertone = host;
window.addEventListener("pagehide", host.dispose);
document.addEventListener("visibilitychange", () => {
	if (!document.hidden) {
		session?.refreshClock();
	}
});
post({ kind: "ready" });
