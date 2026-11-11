/**
 * Undertone ambiences: twelve dark color families, each with its own animated background
 * motion and logo candidate. The ambience of the playing track is derived from its cover art,
 * so the room "takes the color" of what is playing.
 *
 * This module is the source of truth. The native desktop app keeps a Rust copy
 * (`desktop/src/ambience.rs`) that is checked against `common/tests/fixtures/ambience.json`.
 * When changing a palette or the matching rules, update both and regenerate the fixture
 * (see `common/tests/unit/ambience.spec.ts`).
 */

export const AMBIENCE_IDS = [
	"heure-bleue",
	"braise",
	"sous-bois",
	"lagune",
	"aurore",
	"brume",
	"grenat",
	"tabac",
	"jade",
	"amethyste",
	"cendre",
	"route-de-nuit",
] as const;

export type AmbienceId = (typeof AMBIENCE_IDS)[number];

/** Background motion families. Each one is a few pre-computed gradients moved by transform/opacity. */
export type AmbienceMotion =
	| "drift"
	| "rise"
	| "sway"
	| "ripple"
	| "orbit"
	| "breathe"
	| "curtain"
	| "pendulum"
	| "aurora"
	| "halo"
	| "call"
	| "sweep";

export interface AmbiencePalette {
	/** Background gradient, top then bottom. */
	background: readonly [string, string];
	/** Primary text. */
	ink: string;
	/** Secondary text. */
	inkSoft: string;
	/** Tertiary text and hints. */
	muted: string;
	/** Accent: play button, progress, logo. */
	accent: string;
	/** Text and icons drawn on the accent. */
	onAccent: string;
	/** Three translucent glows animated over the background. */
	glows: readonly [string, string, string];
}

export interface Ambience {
	id: AmbienceId;
	/** 1-based number, as shown in the design gallery. */
	number: number;
	motion: AmbienceMotion;
	palette: AmbiencePalette;
	/** Inner SVG markup of the logo, drawn on a 24×24 grid, stroked with currentColor. */
	logo: string;
	/** OKLCH hue anchor (degrees) used to match cover art, or null for neutral ambiences. */
	hue: number | null;
}

export const DEFAULT_AMBIENCE: AmbienceId = "heure-bleue";

export const AMBIENCES: readonly Ambience[] = [
	{
		id: "heure-bleue",
		number: 1,
		motion: "drift",
		hue: 285,
		palette: {
			background: ["#0f1226", "#1c1529"],
			ink: "#f1ecf7",
			inkSoft: "#dbd4ec",
			muted: "#bdb7d3",
			accent: "#f2ae92",
			onAccent: "#2a1620",
			glows: ["rgba(124,98,206,0.5)", "rgba(232,140,128,0.3)", "rgba(70,96,200,0.42)"],
		},
		logo: '<path d="M2 12h20"/><path d="M5.5 12a6.5 6.5 0 0 1 13 0"/><path d="M7 14.2h10a5 5 0 0 1-10 0z" fill="currentColor" stroke="none"/>',
	},
	{
		id: "braise",
		number: 2,
		motion: "rise",
		hue: 44,
		palette: {
			background: ["#160d0a", "#2a1510"],
			ink: "#f7ede3",
			inkSoft: "#e8d6c6",
			muted: "#cdb7a6",
			accent: "#f0c27a",
			onAccent: "#2b1707",
			glows: ["rgba(214,90,46,0.45)", "rgba(240,160,70,0.3)", "rgba(170,50,34,0.45)"],
		},
		logo: '<path d="M7.5 17.5V8.5a4.5 4.5 0 0 1 9 0v9"/><path d="M7.5 18.6h9l4.3 3.4H3.2z" fill="currentColor" stroke="none"/>',
	},
	{
		id: "sous-bois",
		number: 3,
		motion: "sway",
		hue: 125,
		palette: {
			background: ["#0d130c", "#1a2214"],
			ink: "#eef1e4",
			inkSoft: "#d6dcc6",
			muted: "#b6bfa4",
			accent: "#dcc56c",
			onAccent: "#1e1c08",
			glows: ["rgba(170,196,96,0.32)", "rgba(232,212,124,0.26)", "rgba(64,118,62,0.45)"],
		},
		logo: '<path d="M12 11.2a1.75 1.75 0 0 1 3.5 0a3.5 3.5 0 0 1-7 0a5.25 5.25 0 0 1 10.5 0a7 7 0 0 1-14 0"/>',
	},
	{
		id: "lagune",
		number: 4,
		motion: "ripple",
		hue: 205,
		palette: {
			background: ["#071a1e", "#0d2a2e"],
			ink: "#e9f5f3",
			inkSoft: "#cde4e1",
			muted: "#a9c9c5",
			accent: "#ecd6a6",
			onAccent: "#1f1a0c",
			glows: ["rgba(92,196,196,0.42)", "rgba(236,214,166,0.24)", "rgba(30,110,130,0.5)"],
		},
		logo: '<path d="M12 2.8c2.7 3.5 4.3 5.9 4.3 8a4.3 4.3 0 0 1-8.6 0c0-2.1 1.6-4.5 4.3-8z" fill="currentColor" stroke="none"/><ellipse cx="12" cy="19.2" rx="8.5" ry="2.4"/>',
	},
	{
		id: "aurore",
		number: 5,
		motion: "orbit",
		hue: 350,
		palette: {
			background: ["#1a0b17", "#2b1024"],
			ink: "#f8ecf3",
			inkSoft: "#ebd2e0",
			muted: "#d0b0c2",
			accent: "#f6b4c8",
			onAccent: "#2d0f1d",
			glows: ["rgba(214,90,150,0.45)", "rgba(150,84,206,0.4)", "rgba(250,170,150,0.24)"],
		},
		logo: '<path d="M2.5 12c3.2-6.5 6.3-6.5 9.5 0s6.3 6.5 9.5 0"/><path d="M2.5 12c3.2 6.5 6.3 6.5 9.5 0s6.3-6.5 9.5 0"/>',
	},
	{
		id: "brume",
		number: 6,
		motion: "breathe",
		hue: null,
		palette: {
			background: ["#121315", "#1d1e21"],
			ink: "#f0efec",
			inkSoft: "#d9d8d3",
			muted: "#b8b7b1",
			accent: "#e6e2d6",
			onAccent: "#1b1b1a",
			glows: ["rgba(214,212,204,0.24)", "rgba(150,158,172,0.26)", "rgba(255,250,240,0.14)"],
		},
		logo: '<path d="M3.8 16a8.2 8.2 0 0 1 16.4 0"/><circle cx="12" cy="15.6" r="2.4" fill="currentColor" stroke="none"/>',
	},
	{
		id: "grenat",
		number: 7,
		motion: "curtain",
		hue: 22,
		palette: {
			background: ["#170609", "#2a0b12"],
			ink: "#f9eaec",
			inkSoft: "#ecd0d4",
			muted: "#d3acb2",
			accent: "#ff9f8c",
			onAccent: "#2c0a0c",
			glows: ["rgba(196,40,72,0.42)", "rgba(236,96,96,0.3)", "rgba(120,22,44,0.55)"],
		},
		logo: '<path d="M7 4.5v6.3a5 5 0 0 0 10 0M17 4.5v11.3"/><path d="M4.5 20.3c2.5-2.2 5-2.2 7.5 0s5 2.2 7.5 0"/>',
	},
	{
		id: "tabac",
		number: 8,
		motion: "pendulum",
		hue: 72,
		palette: {
			background: ["#15100a", "#241a0f"],
			ink: "#f6efe2",
			inkSoft: "#e6d9c2",
			muted: "#c9b99c",
			accent: "#eac35e",
			onAccent: "#261b04",
			glows: ["rgba(226,168,74,0.4)", "rgba(176,116,44,0.38)", "rgba(255,222,150,0.16)"],
		},
		logo: '<path d="M12 2.5v4.2"/><path d="M5.5 13a6.5 6.3 0 0 1 13 0z" fill="currentColor"/><path d="M12 16.2v4.3M7.6 15.6l-2.1 3.3M16.4 15.6l2.1 3.3"/>',
	},
	{
		id: "jade",
		number: 9,
		motion: "aurora",
		hue: 162,
		palette: {
			background: ["#081612", "#0f2620"],
			ink: "#eaf6f0",
			inkSoft: "#cfe6dc",
			muted: "#a8c8ba",
			accent: "#a8ead0",
			onAccent: "#08251a",
			glows: ["rgba(64,204,144,0.38)", "rgba(84,164,206,0.32)", "rgba(160,240,200,0.16)"],
		},
		logo: '<path d="M7.5 5.5a9.5 9.5 0 0 0 0 13M16.5 5.5a9.5 9.5 0 0 1 0 13"/><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/>',
	},
	{
		id: "amethyste",
		number: 10,
		motion: "halo",
		hue: 307,
		palette: {
			background: ["#120b1f", "#1f1235"],
			ink: "#f2ecfb",
			inkSoft: "#ddd3f0",
			muted: "#bfb3da",
			accent: "#d4bdff",
			onAccent: "#1e1033",
			glows: ["rgba(146,96,232,0.48)", "rgba(206,124,222,0.3)", "rgba(96,70,196,0.45)"],
		},
		logo: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="15" r="5.5"/><circle cx="12" cy="18.1" r="2.4" fill="currentColor" stroke="none"/>',
	},
	{
		id: "cendre",
		number: 11,
		motion: "call",
		hue: null,
		palette: {
			background: ["#171312", "#241e1c"],
			ink: "#f5eeea",
			inkSoft: "#e2d6d0",
			muted: "#c4b6ae",
			accent: "#e8b9a3",
			onAccent: "#2a1a12",
			glows: ["rgba(206,152,130,0.3)", "rgba(176,142,156,0.28)", "rgba(240,210,190,0.14)"],
		},
		logo: '<g fill="currentColor" stroke="none"><circle cx="12" cy="4.5" r="1.7"/><circle cx="18.1" cy="8" r="1.7"/><circle cx="18.1" cy="15" r="1.7"/><circle cx="5.9" cy="15" r="1.7"/><circle cx="5.9" cy="8" r="1.7"/><circle cx="12" cy="18.6" r="2.7"/></g>',
	},
	{
		id: "route-de-nuit",
		number: 12,
		motion: "sweep",
		hue: 258,
		palette: {
			background: ["#070d1a", "#0d1830"],
			ink: "#ecf1fa",
			inkSoft: "#d0dbef",
			muted: "#aab9d4",
			accent: "#ffcf7a",
			onAccent: "#24190a",
			glows: ["rgba(255,196,110,0.26)", "rgba(54,104,206,0.45)", "rgba(130,176,255,0.2)"],
		},
		logo: '<path d="M12 21.5v-7M12 14.5C12 11 7 10.7 7 7.2M12 14.5c0-3.5 5-3.8 5-7.3"/><circle cx="7" cy="5.3" r="2.3" fill="currentColor" stroke="none"/><circle cx="17" cy="5.3" r="2.3" fill="currentColor" stroke="none"/>',
	},
];

const BY_ID = new Map<string, Ambience>(AMBIENCES.map(ambience => [ambience.id, ambience]));

export function isAmbienceId(value: unknown): value is AmbienceId {
	return typeof value === "string" && BY_ID.has(value);
}

export function getAmbience(id: AmbienceId | string | null | undefined): Ambience {
	return (id ? BY_ID.get(id) : undefined) ?? (BY_ID.get(DEFAULT_AMBIENCE) as Ambience);
}

/** Side of the square the cover is reduced to before matching. */
export const AMBIENCE_SAMPLE_SIZE = 32;

/** Matching thresholds. Mirrored in `desktop/src/ambience.rs`. */
export const AMBIENCE_RULES = {
	/** Pixels darker than this OKLab lightness are ignored (letterbox bars, deep shadows). */
	minLightness: 0.12,
	/** Pixels lighter than this are ignored (paper white, blown highlights). */
	maxLightness: 0.95,
	/** OKLab chroma from which a pixel counts as colored. */
	minChroma: 0.04,
	/** Below this share of colored pixels, the cover is treated as neutral. */
	minColorfulShare: 0.15,
	/** Mean chroma from which a neutral cover leans warm (Cendre) rather than cool (Brume). */
	warmNeutralChroma: 0.012,
	/** OKLCH hue range of a warm neutral, in degrees. */
	warmNeutralHue: [15, 110] as const,
} as const;

export interface OkLab {
	l: number;
	a: number;
	b: number;
}

function toLinear(channel: number): number {
	const c = channel / 255;
	return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function srgbToOklab(r: number, g: number, b: number): OkLab {
	const lr = toLinear(r);
	const lg = toLinear(g);
	const lb = toLinear(b);
	const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
	const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
	const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
	return {
		l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	};
}

function hueDegrees(a: number, b: number): number {
	const h = (Math.atan2(b, a) * 180) / Math.PI;
	return h < 0 ? h + 360 : h;
}

function hueDistance(x: number, y: number): number {
	const d = Math.abs(x - y) % 360;
	return d > 180 ? 360 - d : d;
}

const CHROMATIC = AMBIENCES.filter(ambience => ambience.hue !== null);

/**
 * Picks the ambience closest to a cover, from RGBA pixels (4 bytes per pixel, as returned by
 * `CanvasRenderingContext2D.getImageData`). The cover should be reduced to about
 * {@link AMBIENCE_SAMPLE_SIZE}² pixels first.
 *
 * Colored pixels vote for the nearest hue anchor, weighted by their chroma, so a vivid
 * accent beats a large dull area. Covers with too little color fall back to a neutral
 * ambience, warm or cool.
 */
export function pickAmbienceFromPixels(rgba: ArrayLike<number>): AmbienceId {
	const rules = AMBIENCE_RULES;
	const votes = new Array<number>(CHROMATIC.length).fill(0);
	let kept = 0;
	let colorful = 0;
	let sumA = 0;
	let sumB = 0;

	for (let i = 0; i + 3 < rgba.length; i += 4) {
		if (rgba[i + 3] < 128) {
			continue;
		}
		const lab = srgbToOklab(rgba[i], rgba[i + 1], rgba[i + 2]);
		if (lab.l < rules.minLightness || lab.l > rules.maxLightness) {
			continue;
		}
		kept++;
		sumA += lab.a;
		sumB += lab.b;
		const chroma = Math.hypot(lab.a, lab.b);
		if (chroma < rules.minChroma) {
			continue;
		}
		colorful++;
		const hue = hueDegrees(lab.a, lab.b);
		let best = 0;
		let bestDistance = Infinity;
		CHROMATIC.forEach((ambience, index) => {
			const distance = hueDistance(hue, ambience.hue as number);
			if (distance < bestDistance) {
				bestDistance = distance;
				best = index;
			}
		});
		votes[best] += chroma;
	}

	if (kept === 0) {
		return "brume";
	}
	if (colorful / kept < rules.minColorfulShare) {
		const meanA = sumA / kept;
		const meanB = sumB / kept;
		const meanHue = hueDegrees(meanA, meanB);
		const warm =
			Math.hypot(meanA, meanB) >= rules.warmNeutralChroma &&
			meanHue >= rules.warmNeutralHue[0] &&
			meanHue <= rules.warmNeutralHue[1];
		return warm ? "cendre" : "brume";
	}

	let winner = 0;
	for (let i = 1; i < votes.length; i++) {
		if (votes[i] > votes[winner]) {
			winner = i;
		}
	}
	return CHROMATIC[winner].id;
}
