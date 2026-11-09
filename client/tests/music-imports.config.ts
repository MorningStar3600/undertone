import config from "../vite.config";

/** Scoped UI verification must never load account/development env files. */
export default { ...config, envDir: false };
