<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef, watch } from "vue";
import type { Mood } from "ott-common/models/music";
import type { MusicPublication } from "ott-common/models/music-recommendations";
import { useMusic, useMusicPage, errorKind, type MusicError } from "@/composables/use-music";
import { Button } from "@/components/ui/button";
import MusicFeedback from "../MusicFeedback.vue";
import RecommendationMoods from "./RecommendationMoods.vue";

const props = defineProps<{ trackId: string }>();
const music = useMusic();
const own = useMusicPage<Mood>(
	music,
	() => `/tracks/${encodeURIComponent(props.trackId)}/moods`,
	100
);
const publication = shallowRef<MusicPublication | null>(null);
const selected = ref<string[]>([]);
const busy = ref(false);
const error = ref<MusicError | null>(null);
let generation = 0;
let controller: AbortController | undefined;
let disposed = false;
const path = () => `/recommendations/publications/${encodeURIComponent(props.trackId)}`;
const choices = computed(() => [
	...new Map(
		[...(publication.value?.moods ?? []), ...own.items.value].map(m => [m.id, m])
	).values(),
]);
async function refresh() {
	controller?.abort();
	controller = new AbortController();
	const current = ++generation;
	busy.value = true;
	error.value = null;
	publication.value = null;
	selected.value = [];
	try {
		const result = await music.request<{ publication: MusicPublication }>(
			"GET",
			path(),
			undefined,
			undefined,
			controller
		);
		if (disposed || current !== generation) {
			return;
		}
		publication.value = result.publication;
		selected.value = result.publication.moods.map(m => m.id);
	} catch (failure) {
		if (!disposed && current === generation) {
			error.value = errorKind(failure);
		}
	} finally {
		if (!disposed && current === generation) {
			busy.value = false;
		}
	}
}
watch(
	[music.version, () => props.trackId],
	() => {
		void refresh();
	},
	{ immediate: true, flush: "sync" }
);
onScopeDispose(() => {
	disposed = true;
	generation++;
	controller?.abort();
});
async function save(withdraw = false) {
	if (
		busy.value ||
		!publication.value ||
		(!withdraw && (!publication.value.eligible || !selected.value.length))
	) {
		return;
	}
	const current = generation;
	busy.value = true;
	error.value = null;
	controller = new AbortController();
	try {
		if (withdraw) {
			await music.request("DELETE", path(), {}, undefined, controller);
			if (disposed || current !== generation) {
				return;
			}
			publication.value = { ...publication.value, moods: [] };
			selected.value = [];
		} else {
			const result = await music.request<{ publication: MusicPublication }>(
				"PUT",
				path(),
				{ moodIds: [...selected.value] },
				undefined,
				controller
			);
			if (disposed || current !== generation) {
				return;
			}
			publication.value = result.publication;
			selected.value = result.publication.moods.map(m => m.id);
		}
	} catch (failure) {
		if (!disposed && current === generation) {
			error.value = errorKind(failure);
		}
	} finally {
		if (!disposed && current === generation) {
			busy.value = false;
		}
	}
}
</script>
<template>
	<section class="flex flex-col gap-4" :aria-label="$t('musicRecommendations.publish-title')">
		<h3>{{ $t("musicRecommendations.publish-title") }}</h3>
		<p class="text-sm text-muted-foreground">{{ $t("musicRecommendations.disclosure") }}</p>
		<MusicFeedback :loading="busy" :error="error" retry @retry="refresh" />
		<MusicFeedback
			:loading="own.loading.value"
			:error="own.error.value"
			retry
			@retry="own.retry"
		/>
		<p v-if="publication && !publication.eligible">
			{{ $t("musicRecommendations.ineligible") }}
		</p>
		<p v-if="!own.complete.value">{{ $t("musicRecommendations.partial") }}</p>
		<RecommendationMoods
			v-if="publication"
			v-model="selected"
			:moods="choices"
			:disabled="busy || !publication.eligible || own.loading.value || !!own.error.value"
			:label="$t('musicRecommendations.publish-moods')"
		/>
		<Button
			v-if="own.hasMore.value"
			variant="outline"
			:disabled="busy || own.loading.value"
			@click="own.loadMore"
			>{{ $t("music.more-tags") }}</Button
		>
		<div class="flex flex-wrap gap-2">
			<Button
				:disabled="
					busy ||
					!publication?.eligible ||
					!selected.length ||
					own.loading.value ||
					!!own.error.value
				"
				@click="save()"
				>{{ $t("musicRecommendations.publish") }}</Button
			>
			<Button
				variant="outline"
				:disabled="busy || !publication?.moods.length"
				@click="save(true)"
				>{{ $t("musicRecommendations.withdraw") }}</Button
			>
			<Button
				variant="ghost"
				:disabled="busy"
				@click="
					refresh();
					own.load(0);
				"
				>{{ $t("musicRecommendations.refresh") }}</Button
			>
		</div>
	</section>
</template>
