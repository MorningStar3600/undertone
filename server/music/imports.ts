import { randomUUID } from "node:crypto";
import { Op, type Sequelize, type Transaction } from "sequelize";
import { z } from "zod";
import type { MusicImportJob, MusicImportSource } from "ott-common/models/music-imports.js";
import * as db from "../models/index.js";
import {
	musicImportModels,
	type ImportSourceRow,
	type ImportJobRow,
} from "../models/music-imports.js";
import {
	CatalogueException,
	MusicPaginationSchema,
	musicCatalogue,
	type MusicCatalogue,
} from "./catalogue.js";
import { musicTransaction } from "./room-music-db.js";
import InfoExtract from "../infoextractor.js";
import type { CollectionPage } from "../serviceadapter.js";

export const IMPORT_DAY = 24 * 60 * 60 * 1000;
export const IMPORT_LEASE = 60000;
const MAX_FAILURES = 5;
const MAX_PAGES = 10000;
const SHORT_LINK_PATH = /^\/[\w-]+$/;
const PlaylistId = z
	.string()
	.regex(/^[A-Za-z0-9_-]{2,256}$/)
	.refine(id => !["LL", "WL"].includes(id));
export const CreateImportSchema = z.union([
	z.object({ url: z.string().max(2048), daily: z.boolean().default(false) }).strict(),
	z
		.object({
			reference: z.object({ service: z.literal("youtube"), id: PlaylistId }).strict(),
			daily: z.boolean().default(false),
		})
		.strict(),
]);
export const ImportScheduleSchema = z.object({ daily: z.boolean() }).strict();

function playlistId(input: z.infer<typeof CreateImportSchema>): string {
	if ("reference" in input) {
		return input.reference.id;
	}
	try {
		const url = new URL(input.url);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.port ||
			![
				"youtube.com",
				"www.youtube.com",
				"m.youtube.com",
				"music.youtube.com",
				"youtu.be",
			].includes(url.hostname) ||
			!(
				url.pathname === "/playlist" ||
				url.pathname === "/watch" ||
				(url.hostname === "youtu.be" && SHORT_LINK_PATH.test(url.pathname))
			)
		) {
			throw new Error();
		}
		return PlaylistId.parse(url.searchParams.get("list"));
	} catch {
		throw new CatalogueException(400, "A YouTube playlist reference is required.");
	}
}
function jobDto(row: ImportJobRow): MusicImportJob {
	const {
		id,
		sourceId,
		status,
		pages,
		processed,
		added,
		existing,
		unavailable,
		failures,
		retryCount,
		error,
		createdAt,
		completedAt,
		nextAttemptAt,
	} = row;
	return {
		id,
		sourceId,
		status,
		pages,
		processed,
		added,
		existing,
		unavailable,
		failures,
		retryCount,
		error,
		createdAt,
		completedAt,
		nextAttemptAt,
	};
}
function sourceDto(row: ImportSourceRow, job?: ImportJobRow): MusicImportSource {
	const { id, service, daily, removed, nextRunAt, lastSuccessAt, lastCompletionAt } = row;
	return {
		id,
		service,
		daily,
		removed,
		nextRunAt,
		lastSuccessAt,
		lastCompletionAt,
		lastJob: job ? jobDto(job) : null,
	};
}
export type ImportPageProvider = (
	id: string,
	cursor: string | null,
	signal: AbortSignal,
) => Promise<CollectionPage>;
const provider: ImportPageProvider = async (id, cursor, signal) => {
	const adapter = InfoExtract.getServiceAdapter("youtube");
	if (!adapter.supportsCollectionPagination) {
		throw new Error("Unavailable adapter");
	}
	return adapter.fetchCollectionPage(id, cursor, signal);
};

/** All source/job transitions share a source row lock (IMMEDIATE transaction in SQLite).
 * A random fencing token and expiry are rechecked before any page writes. Network work is outside SQL. */
export class MusicImports {
	constructor(
		private readonly connection: () => Sequelize = () => db.sequelize,
		private readonly catalogue: MusicCatalogue = musicCatalogue,
		private readonly fetchPage: ImportPageProvider = provider,
		private readonly now: () => number = Date.now,
	) {}
	private get models() {
		return musicImportModels(this.connection());
	}
	private write<T>(action: (transaction: Transaction) => Promise<T>) {
		return musicTransaction(this.connection(), action);
	}
	private async source(userId: number, id: string, transaction?: Transaction) {
		const row = await this.models.Source.findOne({
			where: { id, userId },
			transaction,
			...(transaction ? { lock: transaction.LOCK.UPDATE } : {}),
		});
		if (!row) {
			throw new CatalogueException(404, "Import source not found.");
		}
		return row;
	}
	async create(userId: number, value: unknown) {
		const input = CreateImportSchema.parse(value);
		const providerId = playlistId(input);
		const id = await this.write(async transaction => {
			const [row] = await this.models.Source.findOrCreate({
				where: { userId, service: "youtube", providerId },
				defaults: {
					id: randomUUID(),
					userId,
					service: "youtube",
					providerId,
					daily: input.daily,
					removed: false,
					nextRunAt: input.daily ? this.now() : null,
					lastSuccessAt: null,
					lastCompletionAt: null,
					activeJobId: null,
					lastJobId: null,
				},
				transaction,
			});
			// Re-registering a removed reference restores it; repeating registration is otherwise a no-op.
			if (row.get().removed) {
				await row.update(
					{
						removed: false,
						daily: input.daily,
						nextRunAt: input.daily ? this.now() : null,
					},
					{ transaction },
				);
			}
			return row.get().id;
		});
		return this.getSource(userId, id);
	}
	async getSource(userId: number, id: string) {
		const source = (await this.source(userId, id)).get();
		const job = source.lastJobId
			? await this.models.Job.findOne({ where: { id: source.lastJobId, userId } })
			: null;
		return sourceDto(source, job?.get());
	}
	async sources(userId: number, pagination: unknown) {
		const page = MusicPaginationSchema.parse(pagination);
		const { rows, count } = await this.models.Source.findAndCountAll({
			where: { userId },
			...page,
			order: [["id", "ASC"]],
		});
		const jobs = await this.models.Job.findAll({
			where: {
				userId,
				id: {
					[Op.in]: rows.flatMap(row =>
						row.get().lastJobId ? [row.get().lastJobId!] : [],
					),
				},
			},
		});
		return {
			...page,
			total: count,
			items: rows.map(row =>
				sourceDto(row.get(), jobs.find(job => job.get().id === row.get().lastJobId)?.get()),
			),
		};
	}
	async jobs(userId: number, sourceId: string, pagination: unknown) {
		await this.source(userId, sourceId);
		const page = MusicPaginationSchema.parse(pagination);
		const { rows, count } = await this.models.Job.findAndCountAll({
			where: { userId, sourceId },
			...page,
			order: [
				["createdAt", "DESC"],
				["id", "DESC"],
			],
		});
		return { ...page, total: count, items: rows.map(row => jobDto(row.get())) };
	}
	async schedule(userId: number, id: string, daily: boolean) {
		await this.write(async transaction => {
			const row = await this.source(userId, id, transaction);
			if (row.get().removed) {
				throw new CatalogueException(409, "Register this source again first.");
			}
			await row.update(
				{
					daily,
					nextRunAt: daily
						? Math.max(this.now(), (row.get().lastSuccessAt ?? this.now()) + IMPORT_DAY)
						: null,
				},
				{ transaction },
			);
		});
		return this.getSource(userId, id);
	}
	private async enqueue(
		source: ImportSourceRow,
		transaction: Transaction,
	): Promise<ImportJobRow> {
		if (source.activeJobId) {
			const row = await this.models.Job.findByPk(source.activeJobId, { transaction });
			if (row && ["queued", "running", "failed"].includes(row.get().status)) {
				if (row.get().status === "failed") {
					await row.update(
						{
							status: "queued",
							retryCount: 0,
							error: null,
							completedAt: null,
							nextAttemptAt: this.now(),
						},
						{ transaction },
					);
				}
				return row.get();
			}
		}
		const job = await this.models.Job.create(
			{
				id: randomUUID(),
				sourceId: source.id,
				userId: source.userId,
				status: "queued",
				cursor: null,
				leaseToken: null,
				leaseUntil: 0,
				nextAttemptAt: this.now(),
				createdAt: this.now(),
				completedAt: null,
				pages: 0,
				processed: 0,
				added: 0,
				existing: 0,
				unavailable: 0,
				failures: 0,
				retryCount: 0,
				error: null,
			},
			{ transaction },
		);
		await this.models.Source.update(
			{ activeJobId: job.get().id, lastJobId: job.get().id, nextRunAt: null },
			{ where: { id: source.id }, transaction },
		);
		return job.get();
	}
	async run(userId: number, id: string) {
		return jobDto(
			await this.write(async transaction => {
				const source = (await this.source(userId, id, transaction)).get();
				if (source.removed) {
					throw new CatalogueException(409, "Register this source again first.");
				}
				return this.enqueue(source, transaction);
			}),
		);
	}
	async cancel(userId: number, id: string, remove = false) {
		await this.write(async transaction => {
			const row = await this.source(userId, id, transaction);
			const source = row.get();
			if (source.activeJobId) {
				await this.models.Job.update(
					{
						status: "cancelled",
						completedAt: this.now(),
						leaseToken: null,
						leaseUntil: 0,
					},
					{ where: { id: source.activeJobId, userId }, transaction },
				);
			}
			await row.update(
				{
					activeJobId: null,
					...(source.activeJobId ? { lastCompletionAt: this.now() } : {}),
					...(remove
						? { removed: true, daily: false, nextRunAt: null }
						: { nextRunAt: source.daily ? this.now() + IMPORT_DAY : null }),
				},
				{ transaction },
			);
		});
		return this.getSource(userId, id);
	}
	private async claim() {
		return this.write(async transaction => {
			// One scheduled source per tick; source lock serializes enqueue across processes.
			const due = await this.models.Source.findOne({
				where: {
					daily: true,
					removed: false,
					activeJobId: null,
					nextRunAt: { [Op.lte]: this.now() },
				},
				order: [["nextRunAt", "ASC"]],
				transaction,
			});
			if (due) {
				const current = (
					await this.source(due.get().userId, due.get().id, transaction)
				).get();
				if (
					current.daily &&
					!current.removed &&
					!current.activeJobId &&
					current.nextRunAt !== null &&
					current.nextRunAt <= this.now()
				) {
					await this.enqueue(current, transaction);
				}
			}
			const candidate = await this.models.Job.findOne({
				where: {
					status: { [Op.in]: ["queued", "running"] },
					nextAttemptAt: { [Op.lte]: this.now() },
					leaseUntil: { [Op.lte]: this.now() },
				},
				order: [
					["nextAttemptAt", "ASC"],
					["id", "ASC"],
				],
				transaction,
			});
			if (!candidate) {
				return null;
			}
			const source = (
				await this.source(candidate.get().userId, candidate.get().sourceId, transaction)
			).get();
			const row = await this.models.Job.findByPk(candidate.get().id, { transaction });
			if (
				!row ||
				source.removed ||
				source.activeJobId !== row.get().id ||
				!["queued", "running"].includes(row.get().status) ||
				row.get().leaseUntil > this.now() ||
				row.get().nextAttemptAt > this.now()
			) {
				return null;
			}
			await row.update(
				{
					status: "running",
					leaseToken: randomUUID(),
					leaseUntil: this.now() + IMPORT_LEASE,
				},
				{ transaction },
			);
			return { source, job: row.get() };
		});
	}
	/** One bounded page; injectable clock/provider. Callers may run multiple independent processes. */
	async step(signal = new AbortController().signal): Promise<boolean> {
		if (signal.aborted) {
			return false;
		}
		const claimed = await this.claim();
		if (!claimed) {
			return false;
		}
		const { source, job } = claimed;
		let page: CollectionPage;
		try {
			page = await this.fetchPage(source.providerId, job.cursor, signal);
			if (
				page.entries.length > 50 ||
				!Number.isInteger(page.unavailable) ||
				page.unavailable < 0 ||
				page.entries.length + page.unavailable > 50 ||
				(page.nextCursor !== null &&
					(!page.nextCursor ||
						page.nextCursor.length > 2048 ||
						page.nextCursor === job.cursor))
			) {
				throw new Error("Invalid page");
			}
		} catch {
			// No raw provider error is logged or persisted. Shutdown leaves its lease for recovery.
			if (!signal.aborted) {
				await this.fail(source, job);
			}
			return true;
		}
		if (signal.aborted) {
			return true;
		}
		let imported: string[];
		try {
			imported = await this.write(async transaction => {
				const current = await this.source(source.userId, source.id, transaction);
				const row = await this.models.Job.findByPk(job.id, { transaction });
				if (
					current.get().activeJobId !== job.id ||
					!row ||
					row.get().leaseToken !== job.leaseToken ||
					row.get().leaseUntil <= this.now() ||
					row.get().status !== "running"
				) {
					return [];
				}
				const result = await this.catalogue.importReferences(
					source.userId,
					page.entries,
					transaction,
				);
				for (const trackId of new Set(result.trackIds)) {
					await this.models.Provenance.upsert(
						{ sourceId: source.id, trackId, lastJobId: job.id },
						{ transaction },
					);
				}
				const unavailable = job.unavailable + page.unavailable;
				const limited = job.pages + 1 >= MAX_PAGES && page.nextCursor !== null;
				const done = page.nextCursor === null || limited;
				const status = limited
					? "failed"
					: done
						? unavailable
							? "partial"
							: "succeeded"
						: "queued";
				await row.update(
					{
						cursor: page.nextCursor,
						pages: job.pages + 1,
						processed: job.processed + page.entries.length + page.unavailable,
						added: job.added + result.added.length,
						existing: job.existing + page.entries.length - result.added.length,
						unavailable,
						status,
						retryCount: 0,
						error: limited ? "page-limit" : unavailable ? "unavailable" : null,
						completedAt: done ? this.now() : null,
						leaseToken: null,
						leaseUntil: 0,
						nextAttemptAt: this.now() + 5000,
					},
					{ transaction },
				);
				if (done) {
					await current.update(
						{
							activeJobId: limited ? job.id : null,
							lastCompletionAt: this.now(),
							...(status === "succeeded" ? { lastSuccessAt: this.now() } : {}),
							nextRunAt:
								!limited && current.get().daily ? this.now() + IMPORT_DAY : null,
						},
						{ transaction },
					);
				}
				return result.trackIds;
			});
		} catch {
			// A rolled-back page keeps its cursor. Persist bounded storage retries if SQL is available.
			if (!signal.aborted) {
				await this.fail(source, job, "storage");
			}
			return true;
		}
		await this.catalogue.notifyImported(source.userId, imported);
		return true;
	}
	private async fail(
		source: ImportSourceRow,
		job: ImportJobRow,
		error: "provider" | "storage" = "provider",
	) {
		await this.write(async transaction => {
			const current = await this.source(source.userId, source.id, transaction);
			const row = await this.models.Job.findByPk(job.id, { transaction });
			if (
				!row ||
				current.get().activeJobId !== job.id ||
				row.get().leaseToken !== job.leaseToken ||
				row.get().leaseUntil <= this.now() ||
				row.get().status !== "running"
			) {
				return;
			}
			const retryCount = job.retryCount + 1;
			const exhausted = retryCount >= MAX_FAILURES;
			await row.update(
				{
					status: exhausted ? "failed" : "queued",
					error,
					failures: job.failures + 1,
					retryCount,
					nextAttemptAt: this.now() + Math.min(3600000, 30000 * 2 ** (retryCount - 1)),
					completedAt: exhausted ? this.now() : null,
					leaseToken: null,
					leaseUntil: 0,
				},
				{ transaction },
			);
			if (exhausted) {
				await current.update(
					{ lastCompletionAt: this.now(), nextRunAt: null },
					{ transaction },
				);
			}
		});
	}
}
export const musicImports = new MusicImports();
