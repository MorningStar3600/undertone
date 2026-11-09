import { resolve } from "node:path";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

/** No application Vite config, env files, credentials, or provider network access. */
export default {
	envDir: false,
	define: { __COMMIT_HASH__: JSON.stringify("playback-test") },
	plugins: [vue(), tailwindcss()],
	resolve: {
		alias: {
			"@": resolve("client/src"),
			"ott-common/playback/index.js": resolve("common/playback/index.ts"),
			"ott-common/playback/transport.js": resolve("common/playback/transport.ts"),
		},
	},
	test: { environment: "jsdom", cache: false, poolOptions: { threads: { singleThread: true } } },
};
