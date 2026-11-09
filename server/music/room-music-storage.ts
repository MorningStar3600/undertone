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
	save(
		value: DurableMusicRoom,
		expectedRevision: number | null,
		hooks?: MusicRoomCommitHooks,
	): Promise<void>;
}
export interface MusicRoomCommitHooks {
	/** Runs on every transaction attempt, after acquisition and again after staged SQL writes. */
	authorize?: () => void | Promise<void>;
	/** Synchronous, retryable timeline derivation after SQL waits and authorization. No I/O. */
	finalize?: () => DurableMusicRoom;
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
	async save(
		value: DurableMusicRoom,
		expectedRevision: number | null,
		hooks?: MusicRoomCommitHooks,
	): Promise<void> {
		const connection = this.connection();
		const snapshot = { ...value, state: serializeMusicScheduler(value.state) };
		await musicTransaction(
			connection,
			async transaction => {
				// PostgreSQL row/CAS waits are bounded too; SQLite already bounds lock retries.
				if (connection.getDialect() === "postgres") {
					await connection.query("SET LOCAL lock_timeout = '5s'", { transaction });
					await connection.query("SET LOCAL statement_timeout = '10s'", { transaction });
				}
				await hooks?.authorize?.();
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
				// CAS and normalized writes may have waited on another PostgreSQL writer.
				// Everything above remains reversible. This is the authorization/intent
				// linearization point; reject here to roll back snapshot, events and scores.
				await hooks?.authorize?.();
				if (hooks?.finalize) {
					const final = hooks.finalize();
					// Finalization may retime a reducer result, never remove/rekey rows
					// already staged above (which would leave orphan normalized history).
					const historyKeys = (state: DurableMusicRoom["state"]) =>
						JSON.stringify([
							state.history.events.map(event => [
								event.playbackId,
								event.entry.entryId,
							]),
							state.history.scores.map(score => score.contributorId),
						]);
					if (
						final.state.roomId !== roomId ||
						final.state.revision !== value.state.revision ||
						historyKeys(final.state) !== historyKeys(value.state)
					) {
						throw new MusicRoomException(
							"Music commit finalization changed identity/revision/history keys",
						);
					}
					const snapshot = { ...final, state: serializeMusicScheduler(final.state) };
					await models.State.update({ snapshot }, { where: { roomId }, transaction });
					for (const [ordinal, event] of final.state.history.events.entries()) {
						if (
							JSON.stringify(event) !==
							JSON.stringify(value.state.history.events[ordinal])
						) {
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
					}
					for (const [ordinal, score] of final.state.history.scores.entries()) {
						if (
							JSON.stringify(score) !==
							JSON.stringify(value.state.history.scores[ordinal])
						) {
							await models.Score.upsert(
								{ roomId, ...score, ordinal },
								{ transaction },
							);
						}
					}
				}
			},
			false,
			10_000,
		);
	}
}
