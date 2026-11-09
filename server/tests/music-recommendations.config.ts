import config from "../vitest.config.js";

/** Isolated recommendation tests never load environment files. */
export default {
	...config,
	envDir: false,
	cacheDir: "../node_modules/.cache/recommendations-server",
};
