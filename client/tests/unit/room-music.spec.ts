import { describe, expect, it } from "vitest";
import { createStore } from "vuex";
import { OttRoomConnectionMock } from "@/plugins/connection";
import { useRoomApi } from "@/util/roomapi";
import { roomModule } from "@/stores/room";
import { RoomRequestType } from "ott-common/models/messages";
import type { MusicRoomAction, MusicRoomPublic } from "ott-common/models/music-room";

describe("Music Room client protocol", () => {
	it("sends music on the OTT connection and disposes its private response listener", () => {
		const connection = new OttRoomConnectionMock(),
			api = useRoomApi(connection);
		const command: MusicRoomAction = {
			action: "queue",
			correlationId: "page",
			expectedRevision: 12,
			offset: 20,
			limit: 10,
		};
		const results: string[] = [];
		const dispose = api.onMusicResult(result => results.push(result.correlationId));
		api.music(command);
		expect(connection.sent).toEqual([
			{ action: "req", request: { type: RoomRequestType.MusicRoomRequest, command } },
		]);
		connection.mockReceive({
			action: "music-result",
			result: {
				correlationId: "page",
				revision: 12,
				status: "applied",
				page: { items: [], total: 20, offset: 20, limit: 10 },
			},
		});
		expect(results).toEqual(["page"]);
		dispose();
		connection.mockReceive({
			action: "music-result",
			result: { correlationId: "ignored", revision: 13, status: "applied" },
		});
		expect(results).toEqual(["page"]);
	});
	it("updates and clears the public music projection through the existing sync store", async () => {
		const store = createStore({ modules: { room: roomModule } });
		const music: MusicRoomPublic = {
			revision: 13,
			planRevision: 13,
			queue: [],
			queueTotal: 14,
			current: null,
			participants: [],
			settings: {
				fairShare: true,
				removeDepartedEntries: true,
				autoAdmitOnJoin: true,
				recencyEpsilon: 0.02,
				recencyTau: 10,
				artistRepeatWeight: 0.1,
				styleRepeatWeight: 0.5,
			},
		};
		await store.dispatch("room/sync", { action: "sync", music });
		expect(store.state.room.music).toEqual(music);
		await store.dispatch("room/sync", { action: "sync", music: null });
		expect(store.state.room.music).toBeNull();
	});
});
