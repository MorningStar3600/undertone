import type { Request } from "express";
import { QueueMode, Role, Visibility } from "ott-common/models/types.js";
import tokens from "../auth/tokens.js";
import { rooms } from "../roommanager.js";
import { conf } from "../ott-config.js";
import { musicIdentity } from "./room-music.js";

/** Never loads a room from Redis to infer authority. Balancer clusters fail closed.
 * Cookie/session auth is checked on every GET/HEAD, including owner-only playback.
 * An occurrence explicitly contributed by the storage owner shares only its current source. */
export async function authorizeLocalMedia(
	req: Request,
	sourceId: string,
	ownerId: number,
): Promise<boolean> {
	if (conf.get("balancing.enabled") || !req.token) {
		return false;
	}
	try {
		const session = await tokens.getSessionInfo(req.token);
		if (session.isLoggedIn && session.user_id === ownerId) {
			return true;
		}
		const room = rooms.find(
			room => room.name.toLowerCase() === String(req.query.room ?? "").toLowerCase(),
		);
		if (!room || room.queueMode !== QueueMode.Music) {
			return false;
		}
		const user = room.getUserFromToken(req.token),
			current = room.music?.current;
		const role = room.getRoleFromSession(session);
		return (
			!!user &&
			musicIdentity(user) ===
				musicIdentity({
					token: req.token,
					user_id: session.isLoggedIn ? session.user_id : undefined,
				}) &&
			!!current &&
			current.sourceId === sourceId &&
			current.contributorId === `account:${ownerId}` &&
			room.currentSource?.sourceId === sourceId &&
			room.currentSource?.entryId === current.entryId &&
			(room.visibility !== Visibility.Private || role >= Role.TrustedUser) &&
			room.grants.granted(role, "playback.play-pause")
		);
	} catch {
		return false;
	}
}
