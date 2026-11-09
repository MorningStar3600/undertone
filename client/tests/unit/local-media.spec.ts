import { describe, expect, it } from "vitest";
import { directPlaybackUrl } from "@/util/local-media";

describe("private local playback URL resolution", () => {
	const id = "10000000-0000-4000-8000-000000000001";
	it("maps the shared opaque identity to a per-browser cookie-authenticated route without secrets", () => {
		expect(
			directPlaybackUrl({ service: "direct", id: `local:${id}` }, "my room", "/undertone"),
		).toBe(`/undertone/api/local-media/${id}?room=my%20room`);
		expect(directPlaybackUrl({ service: "direct", id: `local:${id}` }, "")).toBe(
			`/api/local-media/${id}`,
		);
	});
	it("preserves historic provider/temporary playable URL behavior", () => {
		expect(
			directPlaybackUrl(
				{ service: "direct", id: "original", src_url: "https://media.example/temporary" },
				"room",
			),
		).toBe("https://media.example/temporary");
		expect(directPlaybackUrl({ service: "youtube", id: "youtube-id" }, "room")).toBe(
			"youtube-id",
		);
		expect(directPlaybackUrl(null, "room")).toBe("");
	});
});
