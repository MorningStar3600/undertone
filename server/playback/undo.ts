import { z } from "zod";
import { ALL_VIDEO_SERVICES } from "ott-common/constants.js";
import { PositionSecondsSchema } from "ott-common/playback/index.js";

const reference = z.object({ service: z.enum(ALL_VIDEO_SERVICES), id: z.string().min(1) });
/** Validate the entire untrusted undo source before staging playback or touching the queue. */
export const UndoSourceSchema = reference
	.extend({
		title: z.string().optional(),
		description: z.string().optional(),
		length: PositionSecondsSchema.optional(),
		thumbnail: z.string().optional(),
		mime: z.string().optional(),
		highlight: z.literal(true).optional(),
		hls_url: z.string().optional(),
		dash_url: z.string().optional(),
		src_url: z.string().optional(),
		subtitleUrl: z.string().optional(),
		startAt: PositionSecondsSchema.optional(),
		endAt: PositionSecondsSchema.optional(),
		originalReference: reference.optional(),
		trackId: z.string().optional(),
		sourceId: z.string().optional(),
		entryId: z.string().optional(),
		contributorId: z.string().optional(),
		origin: z.enum(["automatic", "manual", "recommendation"]).optional(),
	})
	.passthrough();
