import type { PlaybackCommandResult } from "ott-common/playback/transport.js";

/** Room/epoch-local, bounded reservations. Pending entries are never evicted. */
export class PlaybackReceipts {
	private entries = new Map<
		string,
		{ payload: string; at: number; pending: boolean; result: Promise<PlaybackCommandResult> }
	>();
	run(
		key: string,
		payload: string,
		reject: (code: "capacity" | "request-conflict") => PlaybackCommandResult,
		execute: () => Promise<PlaybackCommandResult>,
	): Promise<PlaybackCommandResult> {
		const now = Date.now();
		for (const [key, value] of this.entries) {
			if (!value.pending && now - value.at >= 300_000) {
				this.entries.delete(key);
			}
		}
		const previous = this.entries.get(key);
		if (previous) {
			return previous.payload === payload
				? previous.result
				: Promise.resolve(reject("request-conflict"));
		}
		if (this.entries.size >= 512) {
			return Promise.resolve(reject("capacity"));
		}
		// Defer execution until AFTER installing the in-flight reservation, including auth I/O.
		let resolve!: (result: PlaybackCommandResult) => void;
		let rejectExecution!: (error: unknown) => void;
		const result = new Promise<PlaybackCommandResult>((_resolve, reject) => {
			resolve = _resolve;
			rejectExecution = reject;
		});
		const entry = { payload, at: now, pending: true, result };
		this.entries.set(key, entry);
		void (async () => {
			try {
				resolve(await execute());
			} catch (error) {
				rejectExecution(error);
			} finally {
				entry.pending = false;
			}
		})();
		return entry.result;
	}
}
