import { musicTransaction } from "./room-music-db.js";
import type { Sequelize } from "sequelize";
import * as db from "../models/index.js";
import { musicRoomModels, type DurableMusicRoom } from "../models/music-room.js";
import { restoreMusicScheduler, serializeMusicScheduler } from "./music-scheduler.js";
import { OttException } from "ott-common/exceptions.js";
export class MusicRoomException extends OttException {
	name = "MusicRoomException";
}
export interface MusicRoomStore {
	load(roomId: string): Promise<DurableMusicRoom | null>;
	save(value: DurableMusicRoom, expectedRevision: number | null): Promise<void>;
}
// All rooms share one SQLite writer queue. SQL CAS also arbitrates overlapping monolith ownership.
export class SqlMusicRoomStore implements MusicRoomStore {
	constructor(private connection: () => Sequelize = () => db.sequelize) {}
	async load(roomId: string): Promise<DurableMusicRoom | null> {
		const connection = this.connection();
		return musicTransaction(connection, async transaction => {
			const models = musicRoomModels(connection);
			const row = await models.State.findByPk(roomId, {
				transaction,
				lock: transaction.LOCK.UPDATE,
			});
			if (!row) {
				if (
					(await models.Event.count({ where: { roomId }, transaction })) ||
					(await models.Score.count({ where: { roomId }, transaction }))
				) {
					throw new MusicRoomException(
						"Durable music state missing; refusing to reset contribution history",
					);
				}
				return null;
			}
			const snapshot = row.get().snapshot;
			const [events, scores] = await Promise.all([
				models.Event.findAll({
					where: { roomId },
					transaction,
					order: [["ordinal", "ASC"]],
				}),
				models.Score.findAll({
					where: { roomId },
					transaction,
					order: [["ordinal", "ASC"]],
				}),
			]);
			// SQL rows are the durable source of historical truth; the room snapshot holds
			// pending requests, consumed IDs, plan and playback. Redis may disappear entirely.
			const state = restoreMusicScheduler({
				...snapshot.state,
				history: {
					...snapshot.state.history,
					scores: scores.map(row => ({
						contributorId: row.get().contributorId,
						base: row.get().base,
						plays: row.get().plays,
					})),
					events: events.map(row => row.get().event),
				},
			});
			if (row.get().revision !== state.revision) {
				throw new MusicRoomException("Inconsistent durable music revision");
			}
			return { ...snapshot, state };
		});
	}
	async save(value: DurableMusicRoom, expectedRevision: number | null): Promise<void> {
		const connection = this.connection();
		const snapshot = { ...value, state: serializeMusicScheduler(value.state) };
		await musicTransaction(connection, async transaction => {
			const models = musicRoomModels(connection),
				roomId = value.state.roomId;
			if (expectedRevision === null) {
				await models.State.create(
					{ roomId, revision: value.state.revision, snapshot },
					{ transaction },
				);
			} else {
				const [count] = await models.State.update(
					{ revision: value.state.revision, snapshot },
					{ where: { roomId, revision: expectedRevision }, transaction },
				);
				if (count !== 1) {
					throw new MusicRoomException(
						"Music room ownership/revision conflict; reload room",
					);
				}
			}
			for (const [ordinal, event] of value.state.history.events.entries()) {
				// End/source updates replace the same playback row, never create another start.
				await models.Event.upsert(
					{
						roomId,
						playbackId: event.playbackId,
						entryId: event.entry.entryId,
						ordinal,
						event,
					},
					{ transaction },
				);
			}
			for (const [ordinal, score] of value.state.history.scores.entries()) {
				await models.Score.upsert({ roomId, ...score, ordinal }, { transaction });
			}
		});
	}
}
