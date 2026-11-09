import { onScopeDispose, ref, shallowRef, watch } from "vue";
import type {
	MusicAdoption,
	MusicRecommendation,
	RecommendationPage,
} from "ott-common/models/music-recommendations";
import { errorKind, useMusic, type MusicError } from "./use-music";
import { MusicRequestError } from "@/util/music-api";

export function useMusicRecommendations(changed: () => void) {
	const music = useMusic();
	const moodIds = ref<string[]>([]);
	const items = shallowRef<MusicRecommendation[]>([]);
	const next = ref<string | null>(null);
	const selected = shallowRef<MusicRecommendation | null>(null);
	const confirmedIds = ref<string[]>([]);
	const loading = ref(false);
	const loaded = ref(false);
	const pending = ref(false);
	const error = ref<MusicError | null>(null);
	const adoptionError = ref<MusicError | null>(null);
	let sequence = 0;
	let disposed = false;
	let cursor: string | undefined;
	let query: AbortController | undefined;
	let command: AbortController | undefined;
	const reset = () => {
		sequence++;
		query?.abort();
		command?.abort();
		items.value = [];
		next.value = null;
		selected.value = null;
		confirmedIds.value = [];
		loading.value = false;
		loaded.value = false;
		pending.value = false;
		error.value = null;
		adoptionError.value = null;
		cursor = undefined;
	};
	watch(
		music.version,
		() => {
			moodIds.value = [];
			reset();
		},
		{ flush: "sync" }
	);
	watch(moodIds, reset, { flush: "sync" });
	onScopeDispose(() => {
		disposed = true;
		reset();
	});
	async function load(after?: string) {
		if (disposed || pending.value || !music.authorized.value) {
			return;
		}
		query?.abort();
		query = new AbortController();
		const current = ++sequence;
		cursor = after;
		loading.value = true;
		error.value = null;
		items.value = [];
		loaded.value = false;
		next.value = null;
		try {
			const page = await music.request<RecommendationPage>(
				"GET",
				"/recommendations",
				undefined,
				{
					moods: moodIds.value.join(","),
					limit: 20,
					...(after ? { after } : {}),
				},
				query
			);
			if (current !== sequence || disposed) {
				return;
			}
			items.value = page.items;
			next.value = page.next;
			loaded.value = true;
		} catch (failure) {
			if (current === sequence && !disposed) {
				error.value = errorKind(failure);
			}
		} finally {
			if (current === sequence && !disposed) {
				loading.value = false;
			}
		}
	}
	function choose(item: MusicRecommendation) {
		selected.value = item;
		confirmedIds.value = item.moods.map(m => m.id);
		adoptionError.value = null;
	}
	async function adopt() {
		const item = selected.value;
		if (!item || pending.value || disposed || !music.authorized.value) {
			return;
		}
		const current = sequence;
		command = new AbortController();
		pending.value = true;
		adoptionError.value = null;
		try {
			const { adoption } = await music.request<{ adoption: MusicAdoption }>(
				"POST",
				`/recommendations/${encodeURIComponent(item.id)}/adopt`,
				{ moodIds: [...confirmedIds.value] },
				undefined,
				command
			);
			if (current !== sequence || disposed) {
				return;
			}
			if (
				adoption.trackId !== item.track.id ||
				!adoption.inLibrary ||
				confirmedIds.value.some(id => !adoption.moodIds.includes(id))
			) {
				throw new MusicRequestError("request");
			}
			items.value = items.value.filter(row => row.track.id !== item.track.id);
			selected.value = null;
			changed();
		} catch (failure) {
			if (current === sequence && !disposed) {
				adoptionError.value = errorKind(failure);
			}
		} finally {
			if (current === sequence && !disposed) {
				pending.value = false;
			}
		}
	}
	return {
		music,
		moodIds,
		items,
		next,
		selected,
		confirmedIds,
		loading,
		loaded,
		pending,
		error,
		adoptionError,
		load,
		retry: () => load(cursor),
		choose,
		adopt,
	};
}
