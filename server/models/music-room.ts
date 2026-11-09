import { DataTypes, type Sequelize, type Model, type ModelStatic } from "sequelize";
import type { MusicSchedulerState, MusicPlaybackEvent } from "ott-common/music/types.js";
import type { MusicRoomPlayback } from "ott-common/models/music-room.js";
export interface DurableMusicRoom {
	state: MusicSchedulerState;
	playback: MusicRoomPlayback;
}
type Row<T extends object> = Model<T>;
export function musicRoomModels(connection: Sequelize) {
	const define = <T extends object>(
		name: string,
		attributes: Parameters<Sequelize["define"]>[1],
	) =>
		(connection.models[name] as ModelStatic<Row<T>>) ??
		connection.define<Row<T>>(
			name,
			attributes as import("sequelize").ModelAttributes<Row<T>, T>,
			{ timestamps: false },
		);
	const key = () => ({ type: DataTypes.STRING(256), primaryKey: true, allowNull: false });
	return {
		State: define<{ roomId: string; revision: number; snapshot: DurableMusicRoom }>(
			"MusicRoomState",
			{
				roomId: key(),
				revision: { type: DataTypes.INTEGER, allowNull: false },
				snapshot: { type: DataTypes.JSON, allowNull: false },
			},
		),
		Event: define<{
			roomId: string;
			playbackId: string;
			entryId: string;
			ordinal: number;
			event: MusicPlaybackEvent;
		}>("MusicRoomEvent", {
			roomId: key(),
			playbackId: key(),
			entryId: { type: DataTypes.STRING(512), allowNull: false },
			ordinal: { type: DataTypes.INTEGER, allowNull: false },
			event: { type: DataTypes.JSON, allowNull: false },
		}),
		Score: define<{
			roomId: string;
			contributorId: string;
			ordinal: number;
			base: number;
			plays: number;
		}>("MusicRoomScore", {
			roomId: key(),
			contributorId: key(),
			ordinal: { type: DataTypes.INTEGER, allowNull: false },
			base: { type: DataTypes.INTEGER, allowNull: false },
			plays: { type: DataTypes.INTEGER, allowNull: false },
		}),
		Version: define<{ userId: number; revision: number }>("MusicCatalogueVersion", {
			userId: { type: DataTypes.INTEGER, primaryKey: true, allowNull: false },
			revision: { type: DataTypes.INTEGER, allowNull: false },
		}),
	};
}
