import { createHash, randomUUID } from "node:crypto";
import { opendir } from "node:fs/promises";
import path from "node:path";
import { Op, type Sequelize, type Transaction } from "sequelize";
import type { LocalMediaStatus } from "ott-common/models/local-media.js";
import { LOCAL_MEDIA_REFERENCE } from "ott-common/models/local-media.js";
import type { TrackSource } from "ott-common/models/music.js";
import type { Video } from "ott-common/models/video.js";
import { conf } from "../ott-config.js";
import * as db from "../models/index.js";
import { localMediaModels } from "../models/local-media.js";
import type { MusicModels } from "../models/music.js";
import { musicTransaction } from "./room-music-db.js";
import { LocalMediaRootsSchema, type LocalMediaRoot } from "./local-media-config.js";
import {
	AUDIO_MIMES,
	LocalMediaException,
	openLocalFile,
	probeLocalAudio,
	safeRelative,
	type LocalAudioMetadata,
} from "./local-media-files.js";
import { musicCatalogue, notifyCatalogueChanges } from "./catalogue.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const binding = (root: LocalMediaRoot) =>
	hash(JSON.stringify([root.ownerId, path.resolve(root.directory)]));
export const isLocalSource = (source: Pick<TrackSource, "service" | "providerId">) =>
	source.service === "direct" && LOCAL_MEDIA_REFERENCE.test(source.providerId);
const MAX_SCAN_MS = 30000;
const SCAN_LEASE_MS = 120000;

export class LocalMediaLibrary {
	constructor(
		private connection: () => Sequelize = () => db.sequelize,
		private music: () => MusicModels = () => db,
		private config: () => LocalMediaRoot[] = () =>
			LocalMediaRootsSchema.parse(conf.get("local_media.roots")),
		private disabled: () => boolean = () => conf.get("balancing.enabled"),
		private probe = probeLocalAudio,
		private changed: (
			ids: string[],
			transaction: Transaction,
		) => ReturnType<typeof musicCatalogue.invalidateTracks> = (ids, transaction) =>
			musicCatalogue.invalidateTracks(ids, transaction),
	) {}
	private roots() {
		return this.disabled() ? [] : this.config();
	}
	private configured(id: string, ownerId?: number) {
		const root = this.roots().find(
			root => root.id === id && (ownerId === undefined || root.ownerId === ownerId),
		);
		if (!root) {
			throw new LocalMediaException();
		}
		return root;
	}
	private get models() {
		return localMediaModels(this.connection());
	}
	async status(ownerId: number): Promise<LocalMediaStatus> {
		const roots: LocalMediaStatus["roots"] = [];
		for (const configured of this.roots().filter(root => root.ownerId === ownerId)) {
			const stored = await this.models.Root.findByPk(configured.id);
			const row = stored?.get({ plain: true });
			const valid = row?.binding === binding(configured);
			roots.push({
				id: configured.id,
				status: valid
					? row.status === "scanning" && row.leaseUntil < Date.now()
						? ("failed" as const)
						: row.status
					: ("idle" as const),
				processed: valid ? row.processed : 0,
				available: valid ? row.available : 0,
				completedAt: valid ? row.completedAt : null,
			});
		}
		return { enabled: !this.disabled(), reason: this.disabled() ? "balancer" : null, roots };
	}
	/** Bounded manual job; durable lease prevents overlapping scans/processes. No startup filesystem scan. */
	async scan(ownerId: number, rootId: string): Promise<void> {
		const root = this.configured(rootId, ownerId),
			token = randomUUID(),
			started = Date.now();
		await musicTransaction(this.connection(), async transaction => {
			const [row] = await this.models.Root.findOrCreate({
				where: { id: rootId },
				defaults: {
					id: rootId,
					ownerId,
					binding: binding(root),
					status: "idle",
					processed: 0,
					available: 0,
					completedAt: null,
					scanToken: null,
					leaseUntil: 0,
				},
				transaction,
			});
			await row.reload({ transaction, lock: transaction.LOCK.UPDATE });
			if (row.get().binding !== binding(root) || row.get().leaseUntil > started) {
				throw new LocalMediaException(409);
			}
			await row.update(
				{
					status: "scanning",
					processed: 0,
					scanToken: token,
					leaseUntil: started + SCAN_LEASE_MS,
				},
				{ transaction },
			);
		});
		// Scan failures never perform a sweep. Atomic publication includes catalogue and provenance.
		const files: {
			relative: string;
			mime: string;
			info: Awaited<ReturnType<typeof openLocalFile>>["info"];
			metadata: LocalAudioMetadata;
		}[] = [];
		let complete = true,
			entries = 0;
		try {
			const walk = async (relative: string, depth: number): Promise<void> => {
				if (depth > 8 || Date.now() - started > MAX_SCAN_MS) {
					throw new LocalMediaException();
				}
				// Every descendant directory is checked before traversal; no symlink following.
				const dir = await opendir(path.join(root.directory, relative));
				for await (const entry of dir) {
					if (
						++entries > 10000 ||
						files.length >= 2000 ||
						Date.now() - started > MAX_SCAN_MS
					) {
						throw new LocalMediaException();
					}
					const child = path.join(relative, entry.name);
					if (!safeRelative(child) || entry.isSymbolicLink()) {
						complete = false;
						continue;
					}
					if (entry.isDirectory()) {
						await this.checkDirectory(root.directory, child);
						await walk(child, depth + 1);
					} else if (entry.isFile() && AUDIO_MIMES[path.extname(child).toLowerCase()]) {
						const { handle, info } = await openLocalFile(root.directory, child);
						try {
							files.push({
								relative: child,
								mime: AUDIO_MIMES[path.extname(child).toLowerCase()],
								info,
								metadata: await this.probe(handle),
							});
						} finally {
							await handle.close();
						}
						if (files.length % 25 === 0) {
							await this.models.Root.update(
								{ processed: files.length },
								{ where: { id: rootId, scanToken: token } },
							);
						}
					}
				}
			};
			await this.checkDirectory(root.directory, "");
			await walk("", 0);
		} catch {
			complete = false;
		}
		try {
			const changes = await musicTransaction(this.connection(), async transaction => {
				const row = await this.models.Root.findByPk(rootId, {
					transaction,
					lock: transaction.LOCK.UPDATE,
					rejectOnEmpty: true,
				});
				if (row.get().scanToken !== token || row.get().leaseUntil < Date.now()) {
					throw new LocalMediaException(409);
				}
				const changed = new Set<string>();
				for (const file of files) {
					const key = hash(
						process.platform === "win32" ? file.relative.toLowerCase() : file.relative,
					);
					const existing = await this.models.File.findOne({
						where: { rootId, pathKey: key },
						transaction,
					});
					const sourceId = existing?.get().id ?? randomUUID(),
						trackId = existing?.get().trackId ?? randomUUID();
					const priorTrack = await this.music().Track.findByPk(trackId, { transaction });
					const priorSource = await this.music().TrackSource.findByPk(sourceId, {
						transaction,
					});
					const metadata = { ...file.metadata, styles: [], artworkUrl: null };
					if (!priorTrack) {
						await this.music().Track.create(
							{ id: trackId, ...metadata },
							{ transaction },
						);
						await this.music().TrackSource.create(
							{
								id: sourceId,
								trackId,
								service: "direct",
								providerId: `local:${sourceId}`,
								availability: "available",
								capabilities: { seek: true, backgroundPlayback: "unknown" },
							},
							{ transaction },
						);
					} else {
						if (
							JSON.stringify([
								priorTrack.get().title,
								priorTrack.get().artists,
								priorTrack.get().duration,
							]) !==
								JSON.stringify([
									metadata.title,
									metadata.artists,
									metadata.duration,
								]) ||
							priorSource?.get().availability !== "available"
						) {
							changed.add(trackId);
							await priorTrack.update(file.metadata, { transaction });
							await this.music().TrackSource.update(
								{ availability: "available" },
								{ where: { id: sourceId }, transaction },
							);
						}
					}
					const [, added] = await this.music().UserLibraryTrack.findOrCreate({
						where: { userId: ownerId, trackId },
						defaults: { userId: ownerId, trackId, importKind: "local" },
						transaction,
					});
					if (added) {
						changed.add(trackId);
					}
					const record = {
						id: sourceId,
						rootId,
						relativePath: file.relative,
						pathKey: key,
						trackId,
						mime: file.mime,
						device: String(file.info.dev),
						inode: String(file.info.ino),
						size: file.info.size,
						modified: file.info.mtimeMs,
						seen: token,
					};
					if (existing) {
						await existing.update(record, { transaction, logging: false });
					} else {
						await this.models.File.create(record, { transaction, logging: false });
					}
				}
				if (complete) {
					const missing = await this.models.File.findAll({
						where: { rootId, seen: { [Op.ne]: token } },
						transaction,
					});
					for (const file of missing) {
						const [count] = await this.music().TrackSource.update(
							{ availability: "unavailable" },
							{
								where: {
									id: file.get().id,
									availability: { [Op.ne]: "unavailable" },
								},
								transaction,
							},
						);
						if (count) {
							changed.add(file.get().trackId);
						}
					}
				}
				await row.update(
					{
						status: complete ? "complete" : files.length ? "partial" : "failed",
						processed: files.length,
						available: files.length,
						completedAt: Date.now(),
						scanToken: null,
						leaseUntil: 0,
					},
					{ transaction },
				);
				return this.changed([...changed], transaction);
			});
			await notifyCatalogueChanges(changes);
		} catch {
			await this.models.Root.update(
				{ status: "failed", scanToken: null, leaseUntil: 0, completedAt: Date.now() },
				{ where: { id: rootId, scanToken: token } },
			);
			throw new LocalMediaException(500);
		}
	}
	private async checkDirectory(directory: string, relative: string) {
		const { lstat, realpath } = await import("node:fs/promises");
		let current = path.resolve(directory);
		for (const part of ["", ...relative.split(path.sep).filter(Boolean)]) {
			current = path.join(current, part);
			if (
				!(await lstat(current)).isDirectory() ||
				(await lstat(current)).isSymbolicLink() ||
				(await realpath(current)) !== current
			) {
				throw new LocalMediaException();
			}
		}
	}
	async sourceOwners(sources: TrackSource[]): Promise<Map<string, number>> {
		const owners = new Map<string, number>();
		if (this.disabled()) {
			return owners;
		}
		const ids = sources.filter(isLocalSource).map(source => source.id);
		if (!ids.length) {
			return owners;
		}
		const roots = new Map<string, number>();
		for (const root of this.roots()) {
			const stored = await this.models.Root.findByPk(root.id);
			if (stored?.get().binding === binding(root)) {
				roots.set(root.id, root.ownerId);
			}
		}
		for (let offset = 0; offset < ids.length; offset += 400) {
			const files = await this.models.File.findAll({
				where: { id: { [Op.in]: ids.slice(offset, offset + 400) } },
			});
			for (const file of files) {
				const owner = roots.get(file.get().rootId);
				if (owner !== undefined) {
					owners.set(file.get().id, owner);
				}
			}
		}
		return owners;
	}
	async sourceAllowed(source: TrackSource, contributorId: string): Promise<boolean> {
		return (
			!isLocalSource(source) ||
			contributorId === `account:${(await this.sourceOwners([source])).get(source.id)}`
		);
	}
	async open(sourceId: string) {
		if (this.disabled()) {
			throw new LocalMediaException();
		}
		const row = await this.models.File.findByPk(sourceId),
			file = row?.get();
		if (!file || !Object.values(AUDIO_MIMES).includes(file.mime)) {
			throw new LocalMediaException();
		}
		const root = this.configured(file.rootId),
			stored = await this.models.Root.findByPk(root.id);
		const source = await this.music().TrackSource.findByPk(sourceId);
		if (stored?.get().binding !== binding(root) || source?.get().availability !== "available") {
			throw new LocalMediaException();
		}
		const opened = await openLocalFile(root.directory, file.relativePath);
		if (
			String(opened.info.dev) !== file.device ||
			String(opened.info.ino) !== file.inode ||
			opened.info.size !== file.size ||
			opened.info.mtimeMs !== file.modified
		) {
			await opened.handle.close();
			throw new LocalMediaException();
		}
		return { ...opened, file, ownerId: root.ownerId };
	}
	async video(source: TrackSource): Promise<Video> {
		const opened = await this.open(source.id);
		await opened.handle.close();
		const track = await this.music().Track.findByPk(source.trackId, { rejectOnEmpty: true });
		return {
			service: "direct",
			id: `local:${source.id}`,
			title: track.get().title,
			length: track.get().duration ?? undefined,
			mime: opened.file.mime,
		};
	}
}
export const localMediaLibrary = new LocalMediaLibrary();
