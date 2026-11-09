import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import { QueueMode, Role, Visibility } from "ott-common/models/types.js";
import { authorizeLocalMedia } from "../../music/local-media-access.js";
import tokens, { type SessionInfo } from "../../auth/tokens.js";
import { rooms } from "../../roommanager.js";
import { conf } from "../../ott-config.js";

vi.mock("../../auth/tokens.js", () => ({ default: { getSessionInfo: vi.fn() } }));
vi.mock("../../roommanager.js", () => ({ rooms: [] }));
vi.mock("../../infoextractor.js", () => ({ default: {} }));
describe("local media live authorization", () => {
	let session: SessionInfo, member: { token: string; user_id?: number } | undefined;
	let current: { sourceId: string; entryId: string; contributorId: string };
	let role: Role, permission: boolean, visibility: Visibility;
	const req = () =>
		({ token: "private-client-session", query: { room: "fixture" } }) as unknown as Request;
	beforeEach(() => {
		conf.set("balancing.enabled", false);
		session = { isLoggedIn: true, user_id: 2 };
		member = { token: "private-client-session", user_id: 2 };
		current = { sourceId: "source", entryId: "occurrence", contributorId: "account:1" };
		role = Role.RegisteredUser;
		permission = true;
		visibility = Visibility.Public;
		vi.mocked(tokens.getSessionInfo).mockImplementation(async () => session);
		rooms.splice(0, rooms.length, {
			name: "fixture",
			queueMode: QueueMode.Music,
			getUserFromToken: (token: string) => (member?.token === token ? member : undefined),
			getRoleFromSession: () => role,
			get music() {
				return { current };
			},
			get currentSource() {
				return { sourceId: current.sourceId, entryId: current.entryId };
			},
			get visibility() {
				return visibility;
			},
			grants: { granted: () => permission },
		} as never);
	});
	it("allows owner outside rooms, but checks session again after logout/expiration", async () => {
		session = { isLoggedIn: true, user_id: 1 };
		expect(await authorizeLocalMedia({ ...req(), query: {} } as Request, "anything", 1)).toBe(
			true,
		);
		session = { isLoggedIn: false, username: "Guest" };
		expect(await authorizeLocalMedia(req(), "source", 1)).toBe(false);
		vi.mocked(tokens.getSessionInfo).mockRejectedValue(new Error("expired"));
		expect(await authorizeLocalMedia(req(), "source", 1)).toBe(false);
	});
	it("requires current source, owner contribution, room membership and current role/grants", async () => {
		expect(await authorizeLocalMedia(req(), "source", 1)).toBe(true);
		expect(await authorizeLocalMedia(req(), "other", 1)).toBe(false);
		current.contributorId = "account:2";
		expect(await authorizeLocalMedia(req(), "source", 1)).toBe(false);
		current.contributorId = "account:1";
		permission = false;
		expect(await authorizeLocalMedia(req(), "source", 1)).toBe(false);
		permission = true;
		visibility = Visibility.Private;
		expect(await authorizeLocalMedia(req(), "source", 1)).toBe(false);
		role = Role.TrustedUser;
		expect(await authorizeLocalMedia(req(), "source", 1)).toBe(true);
		member = undefined;
		expect(await authorizeLocalMedia(req(), "source", 1)).toBe(false);
	});
	it("supports a live guest session only while actively joined; identity switches revoke old membership", async () => {
		session = { isLoggedIn: false, username: "Guest" };
		member = { token: req().token! };
		expect(await authorizeLocalMedia(req(), "source", 1)).toBe(true);
		session = { isLoggedIn: true, user_id: 3 };
		expect(await authorizeLocalMedia(req(), "source", 1)).toBe(false);
	});
	it("denies outsiders and balancer requests without loading Redis room snapshots", async () => {
		expect(
			await authorizeLocalMedia({ ...req(), token: "outsider" } as Request, "source", 1),
		).toBe(false);
		conf.set("balancing.enabled", true);
		session = { isLoggedIn: true, user_id: 1 };
		expect(await authorizeLocalMedia(req(), "source", 1)).toBe(false);
		conf.set("balancing.enabled", false);
	});
});
