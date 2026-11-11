// Undertone modification: corresponding-source links, 2026-11-09.
// Replaced by Vite at build time.
declare const __COMMIT_HASH__: string;

const repositoryUrl = "https://github.com/MorningStar3600/undertone";
const sourceRef = /^[a-f0-9]{7,40}$/i.test(__COMMIT_HASH__) ? __COMMIT_HASH__ : "master";

// Set at build time when the exact corresponding source is hosted elsewhere.
export const sourceCodeUrl =
	import.meta.env.VITE_SOURCE_CODE_URL || `${repositoryUrl}/tree/${sourceRef}`;
export const licenseUrl = `${repositoryUrl}/blob/${sourceRef}/LICENSE`;
export const issuesUrl = `${repositoryUrl}/issues/new`;
