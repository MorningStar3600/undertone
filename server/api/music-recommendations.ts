import express, { type Request, type RequestHandler } from "express";
import { z, ZodError } from "zod";
import { CatalogueException, MusicIdSchema } from "../music/catalogue.js";
import { musicRecommendations, type MusicRecommendations } from "../music/recommendations.js";
import { consumeRateLimitPoints } from "../rate-limit.js";

const Empty = z.object({}).strict();
/** AuthTokenMiddleware resolves the session before /music; this router also fails closed alone. */
export function buildMusicRecommendationsRouter(
	service: MusicRecommendations = musicRecommendations
) {
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
		(
			handler: (req: Request, userId: number) => Promise<object>,
			write = false
		): RequestHandler =>
		async (req, res) => {
			try {
				if (!(await consumeRateLimitPoints(res, req.ip, write ? 10 : 1))) {
					return;
				}
				if (write) {
					Empty.parse(req.query);
				}
				res.json({ success: true, ...(await handler(req, req.user.id)) });
			} catch (error) {
				const status =
					error instanceof ZodError
						? 400
						: error instanceof CatalogueException
						? error.status
						: 500;
				// Do not forward ORM, provider, path or URL details.
				res.status(status).json({
					success: false,
					error: {
						name: "RecommendationError",
						message: "Unable to complete recommendation request.",
					},
				});
			}
		};
	router.get(
		"/",
		route(async (req, userId) => {
			Empty.parse(req.body ?? {});
			return service.discover(userId, req.query);
		})
	);
	const trackId = (req: Request) => MusicIdSchema.parse(req.params.trackId);
	router.get(
		"/publications/:trackId",
		route(async (req, userId) => {
			Empty.parse(req.query);
			Empty.parse(req.body ?? {});
			return { publication: await service.publication(userId, trackId(req)) };
		})
	);
	router.put(
		"/publications/:trackId",
		route(
			async (req, userId) => ({
				publication: await service.publish(userId, trackId(req), req.body),
			}),
			true
		)
	);
	router.delete(
		"/publications/:trackId",
		route(async (req, userId) => {
			Empty.parse(req.body ?? {});
			await service.withdraw(userId, trackId(req));
			return {};
		}, true)
	);
	router.post(
		"/:id/adopt",
		route(
			async (req, userId) => ({
				adoption: await service.adopt(userId, MusicIdSchema.parse(req.params.id), req.body),
			}),
			true
		)
	);
	return router;
}
