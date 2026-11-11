import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	AMBIENCE_IDS,
	AMBIENCE_RULES,
	AMBIENCES,
	DEFAULT_AMBIENCE,
	getAmbience,
	isAmbienceId,
	pickAmbienceFromPixels,
} from "../../ambience";

/**
 * The fixture is shared with the native desktop app (`desktop/src/ambience.rs`), which checks
 * its own palette and matching rules against it. If a palette or rule changes on purpose,
 * update the Rust copy and regenerate the vectors' expectations.
 */
const fixture = JSON.parse(
	readFileSync(fileURLToPath(new URL("../fixtures/ambience.json", import.meta.url)), "utf8"),
) as {
	rules: unknown;
	ambiences: unknown;
	vectors: { name: string; pixels: [string, number, number?][]; expected: string }[];
};

function rgba(runs: [string, number, number?][]): number[] {
	const out: number[] = [];
	for (const [hex, count, alpha] of runs) {
		const r = parseInt(hex.slice(1, 3), 16);
		const g = parseInt(hex.slice(3, 5), 16);
		const b = parseInt(hex.slice(5, 7), 16);
		for (let i = 0; i < count; i++) {
			out.push(r, g, b, alpha ?? 255);
		}
	}
	return out;
}

describe("ambiences", () => {
	it("defines twelve distinct ambiences in gallery order", () => {
		expect(AMBIENCES.map(ambience => ambience.id)).toEqual([...AMBIENCE_IDS]);
		expect(AMBIENCES.map(ambience => ambience.number)).toEqual(
			Array.from({ length: 12 }, (_, i) => i + 1),
		);
		expect(new Set(AMBIENCES.map(ambience => ambience.motion)).size).toBe(12);
		expect(new Set(AMBIENCES.map(ambience => ambience.logo)).size).toBe(12);
	});

	it("falls back to the default ambience for unknown ids", () => {
		expect(getAmbience("nope").id).toBe(DEFAULT_AMBIENCE);
		expect(getAmbience(null).id).toBe(DEFAULT_AMBIENCE);
		expect(getAmbience("jade").id).toBe("jade");
		expect(isAmbienceId("jade")).toBe(true);
		expect(isAmbienceId("JADE")).toBe(false);
	});

	it("matches the fixture shared with the desktop app", () => {
		expect(JSON.parse(JSON.stringify(AMBIENCES))).toEqual(fixture.ambiences);
		expect(JSON.parse(JSON.stringify(AMBIENCE_RULES))).toEqual(fixture.rules);
	});

	it.each(fixture.vectors.map(vector => [vector.name, vector] as const))(
		"picks the expected ambience for %s",
		(_, vector) => {
			expect(pickAmbienceFromPixels(rgba(vector.pixels))).toBe(vector.expected);
		},
	);

	it("maps common cover colors to the intended families", () => {
		const pick = (hex: string) => pickAmbienceFromPixels(rgba([[hex, 4]]));
		expect(pick("#d62828")).toBe("grenat");
		expect(pick("#f07f22")).toBe("braise");
		expect(pick("#6b4423")).toBe("tabac");
		expect(pick("#6f7a2c")).toBe("sous-bois");
		expect(pick("#6fd6a8")).toBe("jade");
		expect(pick("#138a8a")).toBe("lagune");
		expect(pick("#14244f")).toBe("route-de-nuit");
		expect(pick("#3f3a9e")).toBe("heure-bleue");
		expect(pick("#7b3fd1")).toBe("amethyste");
		expect(pick("#f07aa8")).toBe("aurore");
		expect(pick("#6f7682")).toBe("brume");
		expect(pick("#8a7f76")).toBe("cendre");
	});
});
