// Build-time only. No Node runtime, development server, Vite config, or env loading.
import { build } from "esbuild";
import { mkdir, copyFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "desktop/generated");
await mkdir(output, { recursive: true });
const result = await build({
	absWorkingDir: root,
	entryPoints: ["client/src/desktop/host.ts"],
	outfile: path.join(output, "player.js"),
	bundle: true,
	format: "iife",
	platform: "browser",
	target: "es2022",
	minify: true,
	metafile: true,
	alias: { "ott-common": path.join(root, "common") },
	logLevel: "info",
});
// Fail closed if this small host accidentally grows into the Vue app or a second transport.
const forbiddenImport = /[/\\](vue|vuex|vue-router|axios)[/\\]|plugins[/\\]connection\.ts|\.vue$/;
const forbidden = Object.keys(result.metafile.inputs).filter(input => forbiddenImport.test(input));
if (forbidden.length) {
	throw new Error(`Unexpected desktop runtime imports: ${forbidden.join(", ")}`);
}
await copyFile(path.join(root, "client/src/desktop/index.html"), path.join(output, "index.html"));
await writeFile(path.join(output, "meta.json"), JSON.stringify(result.metafile, null, 2));
