import {
	computed,
	effectScope,
	onScopeDispose,
	reactive,
	ref,
	shallowRef,
	watch,
	type Ref,
	type ComputedRef,
} from "vue";
import type { Store } from "vuex";
import { useStore, type FullOTTStoreState } from "@/store";
import { DEFAULT_MOODS, type Mood, type MusicPage } from "ott-common/models/music";
import {
	musicRequest,
	MusicRequestError,
	MUSIC_PAGE_LIMIT,
	MUSIC_MAX_OFFSET,
} from "@/util/music-api";

export type MusicError = "request" | "auth" | "rate-limit";
const sessions = new WeakMap<Store<FullOTTStoreState>, ReturnType<typeof createSession>>();

function createSession(store: Store<FullOTTStoreState>) {
	const version = ref(0);
	const expired = ref(false);
	const authorized = computed(() => !!store.state.user && !expired.value);
	const controllers = new Set<AbortController>();
	const moods = reactive(new Map<string, Mood>(DEFAULT_MOODS.map(m => [m.id, m])));
	const remember = (items: Mood[]) => items.forEach(m => moods.set(m.id, m));
	const reset = () => {
		for (const controller of controllers) {
			controller.abort();
		}
		controllers.clear();
		moods.clear();
		remember([...DEFAULT_MOODS]);
		version.value++;
	};
	watch(
		() => store.state.user,
		() => {
			expired.value = false;
			reset();
		},
		{ flush: "sync" },
	);
	const unsubscribe = store.subscribe(mutation => {
		if (mutation.type === "users/SET_AUTH_TOKEN") {
			expired.value = false;
			reset();
		}
	});
	onScopeDispose(() => {
		unsubscribe();
		reset();
	});

	async function request<T>(
		...args: [
			method: Parameters<typeof musicRequest>[0],
			path: string,
			data?: Parameters<typeof musicRequest>[3],
			params?: Parameters<typeof musicRequest>[4],
			controller?: AbortController,
		]
	): Promise<T> {
		if (!authorized.value) {
			throw new MusicRequestError("auth");
		}
		const [method, path, data, params, controller = new AbortController()] = args;
		const epoch = version.value;
		controllers.add(controller);
		try {
			const result = await musicRequest<T>(method, path, controller.signal, data, params);
			if (version.value !== epoch || controller.signal.aborted) {
				throw new MusicRequestError("stale");
			}
			return result;
		} catch (error) {
			if (epoch !== version.value || controller.signal.aborted) {
				throw new MusicRequestError("stale");
			}
			const status = (error as { response?: { status: number } }).response?.status;
			if (status === 401 || status === 403) {
				expired.value = true;
				reset();
				throw new MusicRequestError("auth");
			}
			throw error instanceof MusicRequestError
				? error
				: new MusicRequestError(status === 429 ? "rate-limit" : "request");
		} finally {
			controllers.delete(controller);
		}
	}
	const session = { version, authorized, expired, moods, remember, request };
	const favorites = useMusicPage<Mood>(session, () => "/favorites", 100);
	watch(favorites.items, remember);
	const favoritePending = reactive(new Set<string>());
	const favoriteError = ref<MusicError | null>(null);
	watch(
		version,
		() => {
			favoritePending.clear();
			favoriteError.value = null;
		},
		{ flush: "sync" },
	);
	async function setFavorite(mood: Mood, active: boolean) {
		if (favoritePending.size > 0 || favorites.loading.value || favorites.error.value) {
			return;
		}
		favoritePending.add(mood.id);
		favoriteError.value = null;
		const epoch = version.value;
		try {
			await request(
				active ? "PUT" : "DELETE",
				`/favorites/${encodeURIComponent(mood.id)}`,
				{},
			);
			if (epoch !== version.value) {
				return;
			}
			remember([mood]);
			const hadMore = favorites.hasMore.value;
			const has = favorites.items.value.some(m => m.id === mood.id);
			if (has !== active) {
				favorites.items.value = active
					? [...favorites.items.value, mood]
					: favorites.items.value.filter(m => m.id !== mood.id);
				favorites.total.value += active ? 1 : -1;
			}
			if (hadMore) {
				await favorites.load(0);
			}
		} catch (error) {
			if (epoch === version.value) {
				favoriteError.value = errorKind(error);
			}
		} finally {
			if (epoch === version.value) {
				favoritePending.delete(mood.id);
			}
		}
	}
	return { ...session, favorites, favoritePending, favoriteError, setFavorite };
}

export interface MusicSession {
	version: Ref<number>;
	authorized: ComputedRef<boolean>;
	expired: Ref<boolean>;
	moods: Map<string, Mood>;
	remember: (items: Mood[]) => void;
	request<T>(
		method: Parameters<typeof musicRequest>[0],
		path: string,
		data?: Parameters<typeof musicRequest>[3],
		params?: Parameters<typeof musicRequest>[4],
		controller?: AbortController,
	): Promise<T>;
}

/** One private cache per Vuex store, disposed when the last music consumer unmounts. */
export function useMusic() {
	const store = useStore();
	let entry = sessions.get(store);
	if (!entry) {
		const scope = effectScope(true);
		entry = scope.run(() => createSession(store))!;
		Object.assign(entry, { scope, consumers: 0 });
		sessions.set(store, entry);
	}
	const shared = entry as typeof entry & {
		scope: ReturnType<typeof effectScope>;
		consumers: number;
	};
	shared.consumers++;
	onScopeDispose(() => {
		if (--shared.consumers === 0) {
			shared.scope.stop();
			sessions.delete(store);
		}
	});
	return entry;
}

export function errorKind(error: unknown): MusicError | null {
	return error instanceof MusicRequestError && error.kind !== "stale" ? error.kind : null;
}

/** Explicit pages only; append is used solely by the visible "load more" controls. */
export function useMusicPage<T>(
	session: MusicSession,
	path: () => string | null,
	pageSize = MUSIC_PAGE_LIMIT,
) {
	const items = shallowRef<T[]>([]);
	const total = ref(0);
	const offset = ref(0);
	const limit = ref(pageSize);
	const loading = ref(false);
	const error = ref<MusicError | null>(null);
	let controller: AbortController | undefined;
	let sequence = 0;
	let retryOffset = 0;
	let retryAppend = false;
	let disposed = false;
	async function load(nextOffset = offset.value, append = false) {
		const url = path();
		if (
			disposed ||
			!url ||
			!session.authorized.value ||
			nextOffset < 0 ||
			nextOffset > MUSIC_MAX_OFFSET
		) {
			return;
		}
		controller?.abort();
		controller = new AbortController();
		const current = ++sequence;
		const epoch = session.version.value;
		retryOffset = nextOffset;
		retryAppend = append;
		loading.value = true;
		error.value = null;
		if (!append) {
			items.value = [];
		}
		try {
			const page = await session.request<MusicPage<T>>(
				"GET",
				url,
				undefined,
				{ limit: pageSize, offset: nextOffset },
				controller,
			);
			if (current !== sequence || epoch !== session.version.value) {
				return;
			}
			items.value = append ? [...items.value, ...page.items] : page.items;
			total.value = page.total;
			offset.value = page.offset;
			limit.value = page.limit;
		} catch (failure) {
			if (current === sequence && epoch === session.version.value) {
				error.value = errorKind(failure);
			}
		} finally {
			if (current === sequence && epoch === session.version.value) {
				loading.value = false;
			}
		}
	}
	watch(
		[session.version, path],
		() => {
			controller?.abort();
			sequence++;
			items.value = [];
			total.value = 0;
			offset.value = 0;
			loading.value = false;
			error.value = null;
			void load(0);
		},
		{ immediate: true, flush: "sync" },
	);
	onScopeDispose(() => {
		disposed = true;
		controller?.abort();
		sequence++;
	});
	const nextOffset = computed(() => offset.value + limit.value);
	const hasMore = computed(
		() => nextOffset.value < total.value && nextOffset.value <= MUSIC_MAX_OFFSET,
	);
	return {
		items,
		total,
		offset,
		limit,
		loading,
		error,
		hasMore,
		load,
		retry: () => load(retryOffset, retryAppend),
		loadMore: () => load(nextOffset.value, true),
	};
}

/** Annotations are track-scoped. Mutations commit only after success, so failures need no rollback. */
export function useMusicAnnotations(trackId: Ref<string | null>) {
	const music = useMusic();
	const page = useMusicPage<Mood>(
		music,
		() => (trackId.value ? `/tracks/${encodeURIComponent(trackId.value)}/moods` : null),
		100,
	);
	watch(page.items, music.remember);
	const pending = reactive(new Set<string>());
	const error = ref<MusicError | null>(null);
	let sequence = 0;
	onScopeDispose(() => {
		sequence++;
	});
	watch(
		[music.version, trackId],
		() => {
			sequence++;
			pending.clear();
			error.value = null;
		},
		{ flush: "sync" },
	);
	async function setTag(mood: Mood, active: boolean) {
		const track = trackId.value;
		if (!track || pending.size > 0 || page.loading.value || page.error.value) {
			return;
		}
		const current = sequence;
		pending.add(mood.id);
		error.value = null;
		try {
			await music.request(
				active ? "PUT" : "DELETE",
				`/tracks/${encodeURIComponent(track)}/moods/${encodeURIComponent(mood.id)}`,
				{},
			);
			if (current !== sequence) {
				return;
			}
			music.remember([mood]);
			const hadMore = page.hasMore.value;
			const has = page.items.value.some(m => m.id === mood.id);
			if (has !== active) {
				page.items.value = active
					? [...page.items.value, mood]
					: page.items.value.filter(m => m.id !== mood.id);
				page.total.value += active ? 1 : -1;
			}
			if (hadMore) {
				await page.load(0);
			}
		} catch (failure) {
			if (current === sequence) {
				error.value = errorKind(failure);
			}
		} finally {
			if (current === sequence) {
				pending.delete(mood.id);
			}
		}
	}
	return { music, page, pending, error, setTag };
}
