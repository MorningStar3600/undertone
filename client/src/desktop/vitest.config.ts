import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
	resolve: {
		alias: { "ott-common": fileURLToPath(new URL("../../../common", import.meta.url)) },
	},
	test: {
		environment: "jsdom",
		include: ["client/src/desktop/tests/*.spec.ts"],
		poolOptions: { threads: { singleThread: true } },
	},
});
