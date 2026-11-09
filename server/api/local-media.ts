import express, { type Request } from "express";
import { pipeline } from "node:stream/promises";
import { z, ZodError } from "zod";
import { localMediaLibrary, type LocalMediaLibrary } from "../music/local-media.js";
import { LocalMediaException } from "../music/local-media-files.js";
import { authorizeLocalMedia } from "../music/local-media-access.js";
import { consumeRateLimitPoints } from "../rate-limit.js";
const BYTE_RANGE = /^bytes=(\d*)-(\d*)$/;
const ROOT_ID = /^[a-zA-Z0-9_-]{1,64}$/;

/** Single-range only: invalid, excessive and multipart requests receive 416. */
export function mediaRange(
	header: string | undefined,
	size: number,
): { start: number; end: number } | null {
	if (header === undefined) {
		return null;
	}
	if (header.length > 100 || !BYTE_RANGE.test(header) || size === 0) {
		throw new LocalMediaException(416);
	}
	const [, first, last] = BYTE_RANGE.exec(header)!;
	let start = first ? Number(first) : 0,
		end = last ? Number(last) : size - 1;
	if (!first) {
		if (!last || !Number.isSafeInteger(end) || end <= 0) {
			throw new LocalMediaException(416);
		}
		start = Math.max(0, size - end);
		end = size - 1;
	}
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		start < 0 ||
		start >= size ||
		end < start
	) {
		throw new LocalMediaException(416);
	}
	return { start, end: Math.min(end, size - 1) };
}
export function buildLocalMediaRouter(
	library: LocalMediaLibrary = localMediaLibrary,
	authorize: (
		req: Request,
		sourceId: string,
		ownerId: number,
	) => Promise<boolean> = authorizeLocalMedia,
) {
	const router = express.Router();
	router.use((_req, res, next) => {
		res.set({
			"Cache-Control": "private, no-store",
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff",
			"Cross-Origin-Resource-Policy": "same-origin",
		});
		next();
	});
	router.get("/status", async (req, res) => {
		if (!req.user) {
			res.sendStatus(401);
			return;
		}
		try {
			z.object({}).strict().parse(req.query);
			if (!(await consumeRateLimitPoints(res, req.ip, 1))) {
				return;
			}
			res.json({ success: true, ...(await library.status(req.user.id)) });
		} catch {
			res.status(400).json({ success: false });
		}
	});
	router.post("/roots/:rootId/scan", async (req, res) => {
		if (!req.user) {
			res.sendStatus(401);
			return;
		}
		try {
			z.object({})
				.strict()
				.parse(req.body ?? {});
			z.object({}).strict().parse(req.query);
			const id = z.string().regex(ROOT_ID).parse(req.params.rootId);
			if (!(await consumeRateLimitPoints(res, req.ip, 50))) {
				return;
			}
			await library.scan(req.user.id, id);
			res.json({ success: true, ...(await library.status(req.user.id)) });
		} catch (error) {
			res.status(
				error instanceof ZodError
					? 400
					: error instanceof LocalMediaException
						? error.status
						: 500,
			).json({
				success: false,
				error: { name: "LocalMediaError", message: "Unable to scan local media." },
			});
		}
	});
	router.get("/:sourceId", async (req, res) => {
		let opened: Awaited<ReturnType<LocalMediaLibrary["open"]>> | undefined;
		try {
			const id = z.string().uuid().parse(req.params.sourceId);
			z.object({ room: z.string().min(1).max(256).optional() })
				.strict()
				.parse(req.query);
			if (!(await consumeRateLimitPoints(res, req.ip, 1))) {
				return;
			}
			opened = await library.open(id);
			// Last await before publishing bytes rechecks logout, leave and role changes.
			if (!(await authorize(req, id, opened.ownerId))) {
				throw new LocalMediaException();
			}
			const size = opened.info.size;
			let range: ReturnType<typeof mediaRange>;
			try {
				range = mediaRange(req.headers.range, size);
			} catch {
				res.set("Content-Range", `bytes */${size}`);
				throw new LocalMediaException(416);
			}
			res.set({
				"Accept-Ranges": "bytes",
				"Content-Type": opened.file.mime,
				"Content-Length": String(range ? range.end - range.start + 1 : size),
			});
			if (range) {
				res.status(206).set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
			}
			if (req.method === "HEAD" || size === 0) {
				res.end();
				return;
			}
			const stream = opened.handle.createReadStream({
				start: range?.start ?? 0,
				end: range?.end ?? size - 1,
				autoClose: false,
			});
			// pipeline destroys the stream on response close/abort. finally closes its descriptor.
			await pipeline(stream, res);
		} catch (error) {
			if (!res.headersSent && !res.destroyed) {
				res.status(
					error instanceof LocalMediaException && error.status === 416 ? 416 : 404,
				).end();
			}
		} finally {
			await opened?.handle.close().catch(() => {
				/* pipeline may already have closed it on abort */
			});
		}
	});
	return router;
}
