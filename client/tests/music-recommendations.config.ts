import config from "./music-imports.config";

/** Reuse the env-free personal UI config; keep all scratch output inside the checkout. */
export default { ...config, cacheDir: "../node_modules/.cache/recommendations-client" };
