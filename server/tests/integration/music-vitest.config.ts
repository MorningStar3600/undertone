import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Deliberately separate from the unit config (which replaces the Redis module).
export default defineConfig({
	root: fileURLToPath(new URL("../..", import.meta.url)),
	// This intentionally nonexistent directory prevents Vite loading application .env files.
	envDir: fileURLToPath(new URL("./music-empty-env", import.meta.url)),
	test: {
		include: ["tests/integration/music-*.integration.ts"],
		setupFiles: ["tests/integration/music-setup.ts"],
		pool: "forks",
		poolOptions: { forks: { singleFork: true } },
		fileParallelism: false,
		testTimeout: 20000,
		hookTimeout: 30000,
	},
});
