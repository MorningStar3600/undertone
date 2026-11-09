import { musicImports, type MusicImports } from "./imports.js";
import { getLogger } from "../logger.js";

/** Sequential, five-second cadence; stop aborts in-flight HTTP and awaits settlement. */
export function createImportWorker(imports: MusicImports = musicImports) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let active: Promise<void> | undefined;
	let controller: AbortController | undefined;
	let running = false;
	const tick = () => {
		const current = new AbortController();
		controller = current;
		active = (async () => {
			try {
				await imports.step(current.signal);
			} catch {
				getLogger("music/imports").error("Playlist import worker step failed.");
			} finally {
				if (running) {
					timer = setTimeout(tick, 5000);
					timer.unref();
				}
			}
		})();
	};
	return {
		start() {
			if (!running) {
				running = true;
				tick();
			}
		},
		async stop() {
			running = false;
			clearTimeout(timer);
			controller?.abort();
			await active;
		},
	};
}
