import express, { type Request, type RequestHandler } from "express";
import { ZodError, z } from "zod";
import { MusicIdSchema, MusicPaginationSchema, CatalogueException } from "../music/catalogue.js";
import { musicImports, type MusicImports, ImportScheduleSchema } from "../music/imports.js";
import { consumeRateLimitPoints } from "../rate-limit.js";

/** Mounted inside the account-authenticated music router; API keys alone cannot set req.user. */
export function buildMusicImportsRouter(imports: MusicImports = musicImports) {
	const router = express.Router();
	const route =
		(action: (req: Request, userId: number) => Promise<object>, points = 1): RequestHandler =>
		async (req, res) => {
			res.setHeader("Cache-Control", "private, no-store");
			if (!req.user || !Number.isSafeInteger(req.user.id) || req.user.id <= 0) {
				res.status(401).json({
					success: false,
					error: { name: "Unauthorized", message: "Not logged in." },
				});
				return;
			}
			try {
				if (!(await consumeRateLimitPoints(res, req.ip, points))) {
					return;
				}
				res.json({ success: true, ...(await action(req, req.user.id)) });
			} catch (error) {
				const status =
					error instanceof ZodError
						? 400
						: error instanceof CatalogueException
							? error.status
							: 500;
				res.status(status).json({
					success: false,
					error: {
						name: "ImportRequestError",
						message:
							status === 404
								? "Import source not found."
								: "Unable to complete playlist import request.",
					},
				});
			}
		};
	const id = (req: Request) => MusicIdSchema.parse(req.params.sourceId);
	const empty = (req: Request) => {
		z.object({})
			.strict()
			.parse(req.body ?? {});
		z.object({}).strict().parse(req.query);
	};
	router.get(
		"/sources",
		route(async (req, userId) => imports.sources(userId, req.query)),
	);
	router.post(
		"/sources",
		route(async (req, userId) => {
			z.object({}).strict().parse(req.query);
			return { source: await imports.create(userId, req.body) };
		}, 10),
	);
	router.get(
		"/sources/:sourceId/jobs",
		route(async (req, userId) =>
			imports.jobs(userId, id(req), MusicPaginationSchema.parse(req.query)),
		),
	);
	router.put(
		"/sources/:sourceId/schedule",
		route(async (req, userId) => {
			z.object({}).strict().parse(req.query);
			return {
				source: await imports.schedule(
					userId,
					id(req),
					ImportScheduleSchema.parse(req.body).daily,
				),
			};
		}, 10),
	);
	router.post(
		"/sources/:sourceId/run",
		route(async (req, userId) => {
			empty(req);
			return { job: await imports.run(userId, id(req)) };
		}, 10),
	);
	router.post(
		"/sources/:sourceId/cancel",
		route(async (req, userId) => {
			empty(req);
			return { source: await imports.cancel(userId, id(req)) };
		}, 10),
	);
	router.delete(
		"/sources/:sourceId",
		route(async (req, userId) => {
			empty(req);
			return { source: await imports.cancel(userId, id(req), true) };
		}, 10),
	);
	return router;
}
