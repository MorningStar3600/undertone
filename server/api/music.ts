import express, { type Request, type Response, type RequestHandler } from "express";
import { ZodError, z } from "zod";
import { OttException } from "ott-common/exceptions.js";
import {
	AddLibraryTrackSchema,
	CatalogueException,
	CreateMoodSchema,
	MusicIdSchema,
	MusicPaginationSchema,
	musicCatalogue,
	type MusicCatalogue,
} from "../music/catalogue.js";
import { consumeRateLimitPoints } from "../rate-limit.js";
import { getLogger } from "../logger.js";

const log = getLogger("api/music");
const EmptyBodySchema = z.object({}).strict();

/** Mounted behind the existing OTT token/session middleware. No user IDs are accepted in input. */
export function buildMusicRouter(catalogue: MusicCatalogue = musicCatalogue): express.Router {
	const router = express.Router();
	router.use((req, res, next) => {
		res.setHeader("Cache-Control", "private, no-store");
		if (!req.user || !Number.isSafeInteger(req.user.id) || req.user.id <= 0) {
			res.status(401).json({
				success: false,
				error: { name: "Unauthorized", message: "Not logged in." },
			});
			return;
		}
		next();
	});

	const route =
		(handler: (req: Request, userId: number) => Promise<object>, points = 1): RequestHandler =>
		async (req, res) => {
			try {
				if (!(await consumeRateLimitPoints(res, req.ip, points))) {
					return;
				}
				const result = await handler(req, req.user!.id);
				res.json({ success: true, ...result });
			} catch (err) {
				respondError(res, err);
			}
		};
	const noBody = (req: Request) => EmptyBodySchema.parse(req.body ?? {});
	const trackId = (req: Request) => MusicIdSchema.parse(req.params.trackId);
	const moodId = (req: Request) => MusicIdSchema.parse(req.params.moodId);

	router.get(
		"/library",
		route(async (req, userId) => ({
			...(await catalogue.listLibrary(userId, MusicPaginationSchema.parse(req.query))),
		})),
	);
	router.post(
		"/library",
		route(
			async (req, userId) => ({
				track: await catalogue.addLibraryTrack(
					userId,
					AddLibraryTrackSchema.parse(req.body),
				),
			}),
			10,
		),
	);
	router.delete(
		"/library/:trackId",
		route(async (req, userId) => {
			noBody(req);
			MusicPaginationSchema.parse(req.query);
			await catalogue.removeLibraryTrack(userId, trackId(req));
			return {};
		}, 10),
	);
	router.get(
		"/moods",
		route(async req => ({
			...(await catalogue.listMoods(MusicPaginationSchema.parse(req.query))),
		})),
	);
	router.post(
		"/moods",
		route(
			async (req, userId) => ({
				mood: await catalogue.createMood(userId, CreateMoodSchema.parse(req.body)),
			}),
			10,
		),
	);
	router.get(
		"/tracks/:trackId/moods",
		route(async (req, userId) => ({
			...(await catalogue.listTrackMoods(
				userId,
				trackId(req),
				MusicPaginationSchema.parse(req.query),
			)),
		})),
	);
	for (const active of [true, false]) {
		const method = active ? "put" : "delete";
		router[method](
			"/tracks/:trackId/moods/:moodId",
			route(async (req, userId) => {
				noBody(req);
				MusicPaginationSchema.parse(req.query);
				await catalogue.setTrackMood(userId, trackId(req), moodId(req), active);
				return {};
			}, 10),
		);
		router[method](
			"/favorites/:moodId",
			route(async (req, userId) => {
				noBody(req);
				MusicPaginationSchema.parse(req.query);
				await catalogue.setFavorite(userId, moodId(req), active);
				return {};
			}, 10),
		);
	}
	router.get(
		"/favorites",
		route(async (req, userId) => ({
			...(await catalogue.listFavorites(userId, MusicPaginationSchema.parse(req.query))),
		})),
	);
	return router;
}

function respondError(res: Response, err: unknown): void {
	if (err instanceof ZodError) {
		res.status(400).json({
			success: false,
			error: { name: "ValidationError", message: "Invalid music request." },
		});
	} else if (err instanceof CatalogueException) {
		res.status(err.status).json({
			success: false,
			error: { name: err.name, message: err.message },
		});
	} else if (err instanceof OttException) {
		// Adapter errors may contain private paths/URLs. Do not forward provider messages.
		res.status(400).json({
			success: false,
			error: {
				name: "SourceResolutionError",
				message: "Unable to resolve this media reference.",
			},
		});
	} else {
		log.error("Music API operation failed.");
		res.status(500).json({
			success: false,
			error: { name: "Unknown", message: "Unable to complete music operation." },
		});
	}
}

export default buildMusicRouter();
