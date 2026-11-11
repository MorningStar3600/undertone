import {
	computed,
	onMounted,
	onUnmounted,
	ref,
	watch,
	type ComputedRef,
	type MaybeRefOrGetter,
	type Ref,
	toValue,
} from "vue";
import { DEFAULT_AMBIENCE, getAmbience, type Ambience, type AmbienceId } from "ott-common/ambience";
import { useStore } from "@/store";
import { ambienceForCover, coverUrl, knownAmbience } from "./cover-ambience";

/**
 * Ambience of whatever is playing in the room, derived from its cover. Keeps the previous
 * ambience while the next cover is sampled, so the room never flashes to the default.
 */
export function useRoomAmbience(): {
	ambience: ComputedRef<Ambience>;
	cover: ComputedRef<string | null>;
} {
	const store = useStore();
	const cover = computed(() => coverUrl(store.state.room.currentSource));
	const current = ref<AmbienceId>(knownAmbience(cover.value) ?? DEFAULT_AMBIENCE);
	let ticket = 0;
	watch(
		cover,
		async url => {
			const mine = ++ticket;
			const known = knownAmbience(url);
			if (known) {
				current.value = known;
				return;
			}
			const ambience = await ambienceForCover(url);
			if (mine === ticket) {
				current.value = ambience;
			}
		},
		{ immediate: true },
	);
	return { ambience: computed(() => getAmbience(current.value)), cover };
}

/** CSS custom properties carrying an ambience palette. */
export function ambienceVars(ambience: Ambience): Record<string, string> {
	const p = ambience.palette;
	return {
		"--ut-bg0": p.background[0],
		"--ut-bg1": p.background[1],
		"--ut-ink": p.ink,
		"--ut-ink2": p.inkSoft,
		"--ut-mu": p.muted,
		"--ut-acc": p.accent,
		"--ut-on": p.onAccent,
	};
}

function mediaQuery(query: string): Ref<boolean> {
	const matches = ref(false);
	let list: MediaQueryList | undefined;
	const update = () => {
		matches.value = !!list?.matches;
	};
	onMounted(() => {
		list = typeof window.matchMedia === "function" ? window.matchMedia(query) : undefined;
		update();
		list?.addEventListener?.("change", update);
	});
	onUnmounted(() => list?.removeEventListener?.("change", update));
	return matches;
}

/** Whether ambience backgrounds may move, from the user setting and the system preference. */
export function useAmbienceMotionAllowed(): ComputedRef<boolean> {
	const store = useStore();
	const reduced = mediaQuery("(prefers-reduced-motion: reduce)");
	return computed(() => {
		const preference = store.state.settings.ambienceMotion;
		if (preference === "on") {
			return true;
		}
		if (preference === "off") {
			return false;
		}
		return !reduced.value;
	});
}

/** Whether the system asks for reduced motion (shown next to the motion setting). */
export function useReducedMotion(): Ref<boolean> {
	return mediaQuery("(prefers-reduced-motion: reduce)");
}

/**
 * Runs an animation only while it can be seen: motion allowed, page visible, element on
 * screen, and any extra condition true. Off-screen is only trusted after the element was seen
 * once, so a frame that starts with no size does not freeze the scene forever.
 */
export function useVisibleMotion(
	element: Ref<HTMLElement | undefined | null>,
	extra: MaybeRefOrGetter<boolean> = true,
): ComputedRef<boolean> {
	const allowed = useAmbienceMotionAllowed();
	const pageVisible = ref(true);
	const onScreen = ref(true);
	let seen = false;
	let observer: IntersectionObserver | undefined;
	const onVisibility = () => {
		pageVisible.value = document.visibilityState !== "hidden";
	};
	onMounted(() => {
		onVisibility();
		document.addEventListener("visibilitychange", onVisibility);
		if (typeof IntersectionObserver === "function") {
			observer = new IntersectionObserver(entries => {
				const entry = entries[entries.length - 1];
				if (entry.isIntersecting) {
					seen = true;
					onScreen.value = true;
				} else if (seen) {
					onScreen.value = false;
				}
			});
			if (element.value) {
				observer.observe(element.value);
			}
		}
	});
	watch(
		element,
		(next, previous) => {
			if (previous) {
				observer?.unobserve(previous);
			}
			if (next) {
				observer?.observe(next);
			}
		},
		{ flush: "post" },
	);
	onUnmounted(() => {
		document.removeEventListener("visibilitychange", onVisibility);
		observer?.disconnect();
	});
	return computed(() => allowed.value && pageVisible.value && onScreen.value && toValue(extra));
}
