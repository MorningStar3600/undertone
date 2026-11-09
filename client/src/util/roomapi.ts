import type { MusicRoomActionInput, MusicRoomResult } from "ott-common/models/music-room";
import type { OttRoomConnection } from "@/plugins/connection";
import { type ClientMessageNotify, RoomRequestType } from "ott-common/models/messages";
import type { ClientId, Role } from "ott-common/models/types";
import type { VideoId } from "ott-common/models/video";

export function useRoomApi(connection: OttRoomConnection) {
	return new RoomApi(connection);
}

class RoomApi {
	private connection: OttRoomConnection;

	constructor(connection: OttRoomConnection) {
		this.connection = connection;
	}

	/** One existing OTT connection for music commands and private results. Caller
	 * supplies correlationId/requestId (UUID recommended), and the latest sync revision. */
	music(command: MusicRoomActionInput) {
		this.connection.send({
			action: "req",
			request: { type: RoomRequestType.MusicRoomRequest, command },
		});
	}
	onMusicResult(listener: (result: MusicRoomResult) => void): () => void {
		const handler = (message: import("ott-common/models/messages").ServerMessage) => {
			if (message.action === "music-result") {
				listener(message.result);
			}
		};
		this.connection.addMessageHandler("music-result", handler);
		return () => this.connection.removeMessageHandler("music-result", handler);
	}
	/** Send a message to play the video. */
	play() {
		this.connection.send({
			action: "req",
			request: {
				type: RoomRequestType.PlaybackRequest,
				state: true,
			},
		});
	}

	/** Send a message to pause the video. */
	pause() {
		this.connection.send({
			action: "req",
			request: {
				type: RoomRequestType.PlaybackRequest,
				state: false,
			},
		});
	}

	/** Send a message to skip the current video. */
	skip() {
		this.connection.send({
			action: "req",
			request: {
				type: RoomRequestType.SkipRequest,
			},
		});
	}

	seek(position: number) {
		this.connection.send({
			action: "req",
			request: {
				type: RoomRequestType.SeekRequest,
				value: position,
			},
		});
	}

	/**
	 * Move the video from `fromIdx` to `toIdx` in the queue.
	 * */
	queueMove(fromIdx: number, toIdx: number) {
		this.connection.send({
			action: "req",
			request: {
				type: RoomRequestType.OrderRequest,
				fromIdx,
				toIdx,
			},
		});
	}

	async undoEvent(event) {
		throw new Error("Not yet implemented");
		// await API.post(`/room/${this.$route.params.roomId}/undo`, { data: { event } });
	}

	kickMe(reason?: number) {
		this.connection.send({
			action: "kickme",
			reason,
		});
	}

	promoteUser(clientId: ClientId, role: Role) {
		this.connection.send({
			action: "req",
			request: {
				type: RoomRequestType.PromoteRequest,
				targetClientId: clientId,
				role,
			},
		});
	}

	chat(text: string) {
		this.connection.send({
			action: "req",
			request: {
				type: RoomRequestType.ChatRequest,
				text,
			},
		});
	}

	playNow(video: VideoId) {
		this.connection.send({
			action: "req",
			request: {
				type: RoomRequestType.PlayNowRequest,
				video,
			},
		});
	}

	shuffle() {
		this.connection.send({
			action: "req",
			request: {
				type: RoomRequestType.ShuffleRequest,
			},
		});
	}

	setPlaybackRate(rate: number) {
		this.connection.send({
			action: "req",
			request: {
				type: RoomRequestType.PlaybackSpeedRequest,
				speed: rate,
			},
		});
	}

	restoreQueue(options?: { discard?: boolean }) {
		this.connection.send({
			action: "req",
			request: {
				type: RoomRequestType.RestoreQueueRequest,
				discard: options?.discard,
			},
		});
	}

	kickUser(clientId: ClientId) {
		this.connection.send({
			action: "req",
			request: {
				type: RoomRequestType.KickRequest,
				clientId: clientId,
			},
		});
	}

	notify(message: ClientMessageNotify["message"]) {
		this.connection.send({
			action: "notify",
			message,
		});
	}
}
