import path from "node:path";
import { z } from "zod";

export const LocalMediaRootsSchema = z
	.array(
		z
			.object({
				id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
				directory: z
					.string()
					.min(1)
					.max(4096)
					.refine(
						value =>
							path.isAbsolute(value) &&
							!value.includes("\0") &&
							!value.startsWith("\\\\") &&
							!value.startsWith("//"),
					),
				ownerId: z.number().int().positive().safe(),
			})
			.strict(),
	)
	.max(16)
	.refine(roots => new Set(roots.map(root => root.id)).size === roots.length);
export type LocalMediaRoot = z.infer<typeof LocalMediaRootsSchema>[number];

export function validateLocalMediaRoots(value: unknown): void {
	if (!LocalMediaRootsSchema.safeParse(value).success) {
		// Convict errors otherwise include the submitted private directory.
		throw new Error("Invalid local media roots configuration.");
	}
}
