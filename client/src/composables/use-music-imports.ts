import { onScopeDispose, ref, watch } from "vue";
import type {
	CreateMusicImportSource,
	MusicImportJob,
	MusicImportSource,
} from "ott-common/models/music-imports";
import { errorKind, useMusic, useMusicPage, type MusicError } from "./use-music";

export function useMusicImports(changed: () => void) {
	const music = useMusic();
	const selected = ref<string | null>(null);
	const sources = useMusicPage<MusicImportSource>(music, () => "/imports/sources");
	const jobs = useMusicPage<MusicImportJob>(music, () =>
		selected.value ? `/imports/sources/${encodeURIComponent(selected.value)}/jobs` : null,
	);
	const pending = ref(false);
	const error = ref<MusicError | null>(null);
	let controller: AbortController | undefined;
	let disposed = false;
	watch(
		music.version,
		() => {
			selected.value = null;
			pending.value = false;
			error.value = null;
			controller?.abort();
		},
		{ flush: "sync" },
	);
	onScopeDispose(() => {
		disposed = true;
		controller?.abort();
	});
	async function command(
		method: "POST" | "PUT" | "DELETE",
		path: string,
		data: CreateMusicImportSource | { daily: boolean } | Record<string, never>,
	) {
		if (pending.value || !music.authorized.value) {
			return;
		}
		const epoch = music.version.value;
		controller = new AbortController();
		pending.value = true;
		error.value = null;
		try {
			await music.request(method, `/imports${path}`, data, undefined, controller);
			if (disposed || epoch !== music.version.value) {
				return;
			}
			await sources.load();
			if (disposed || epoch !== music.version.value) {
				return;
			}
			if (selected.value) {
				await jobs.load(0);
			}
			if (!disposed && epoch === music.version.value) {
				changed();
			}
		} catch (failure) {
			if (!disposed && epoch === music.version.value) {
				error.value = errorKind(failure);
			}
		} finally {
			if (!disposed && epoch === music.version.value) {
				pending.value = false;
			}
		}
	}
	const sourcePath = (id: string) => `/sources/${encodeURIComponent(id)}`;
	return {
		music,
		sources,
		jobs,
		selected,
		pending,
		error,
		create: (input: CreateMusicImportSource) => command("POST", "/sources", input),
		run: (id: string) => command("POST", `${sourcePath(id)}/run`, {}),
		schedule: (id: string, daily: boolean) =>
			command("PUT", `${sourcePath(id)}/schedule`, { daily }),
		cancel: (id: string) => command("POST", `${sourcePath(id)}/cancel`, {}),
		remove: (id: string) => command("DELETE", sourcePath(id), {}),
		async refresh() {
			const epoch = music.version.value;
			await sources.load();
			if (disposed || epoch !== music.version.value) {
				return;
			}
			if (selected.value) {
				await jobs.load();
			}
			if (!disposed && epoch === music.version.value) {
				changed();
			}
		},
	};
}
