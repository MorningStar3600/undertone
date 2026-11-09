import { Mutex } from "@divine/synchronization";
import { Transaction, type Sequelize } from "sequelize";
import { setTimeout as delay } from "node:timers/promises";
import type { Database } from "sqlite3";

/** Sequelize 6's pool destroy does not close SQLite transaction connections on failed COMMIT. */
async function cleanFailedSqliteCommit(sequelize: Sequelize, connection: Database): Promise<void> {
	if ((connection as Database & { filename: string }).filename === ":memory:") {
		// Closing the shared in-memory connection would discard the entire database.
		await new Promise<void>((resolve, reject) => {
			connection.run("ROLLBACK", error => (error ? reject(error) : resolve()));
		});
		return;
	}
	// Closing rolls back outstanding writes and releases the lock before the next attempt.
	await new Promise<void>((resolve, reject) => {
		connection.close(error => (error ? reject(error) : resolve()));
	});
	const manager = sequelize.connectionManager as typeof sequelize.connectionManager & {
		connections: Record<string, Database>;
	};
	for (const [key, cached] of Object.entries(manager.connections)) {
		if (cached === connection) {
			delete manager.connections[key];
		}
	}
}

// One transaction queue per SQLite connection covers both catalogue and Rooms.
// Writers acquire IMMEDIATE across processes and retry the entire rolled-back
// transaction, preserving the catalogue fix from 4507e5b5.
const locks = new WeakMap<Sequelize, Mutex>();
export async function musicTransaction<T>(
	connection: Sequelize,
	operation: (transaction: Transaction) => Promise<T>,
	consistentRead = false,
	queueTimeout?: number,
): Promise<T> {
	let lock = locks.get(connection);
	if (!lock) {
		lock = new Mutex();
		locks.set(connection, lock);
	}
	if (!(await lock.lock(queueTimeout))) {
		throw new Error("Music transaction queue timeout");
	}
	try {
		if (connection.getDialect() !== "sqlite") {
			return await (consistentRead
				? connection.transaction(
						{ isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
						operation,
					)
				: connection.transaction(operation));
		}
		for (let attempt = 0; ; attempt++) {
			let committing: Database | undefined;
			try {
				return await connection.transaction(
					{
						type: consistentRead
							? Transaction.TYPES.DEFERRED
							: Transaction.TYPES.IMMEDIATE,
					},
					async transaction => {
						const result = await operation(transaction);
						committing = (transaction as Transaction & { connection: Database })
							.connection;
						return result;
					},
				);
			} catch (error) {
				if (committing) {
					await cleanFailedSqliteCommit(connection, committing);
				}
				const code = (error as { original?: { code?: string } }).original?.code;
				if (attempt >= 3 || !["SQLITE_BUSY", "SQLITE_LOCKED"].includes(code ?? "")) {
					throw error;
				}
				await delay(25 * 2 ** attempt);
			}
		}
	} finally {
		lock.unlock();
	}
}
