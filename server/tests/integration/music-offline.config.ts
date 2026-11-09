import { defineConfig } from "vitest/config";
import live from "./music-vitest.config.js";

export default defineConfig({
	...live,
	test: { ...live.test, include: ["tests/integration/music-*.offline.ts"] },
});
