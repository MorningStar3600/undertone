<script setup lang="ts">
import { computed, ref, toRef, watch } from "vue";
import { Plus } from "@lucide/vue";
import type { Mood } from "ott-common/models/music";
import { useMusicAnnotations } from "@/composables/use-music";
import { Button } from "@/components/ui/button";
import MoodButton from "./MoodButton.vue";
import MoodPicker from "./MoodPicker.vue";
import MusicFeedback from "./MusicFeedback.vue";

/**
 * Future dock contract: trackId is the stable catalogue track UUID, never a provider ID.
 * contributorMoodIds comes from targeted room sync; no private contributor endpoint is queried.
 * Optional contributorMoods supplies public vocabulary metadata for IDs not yet discovered.
 * Blue/aria-pressed always describes the authenticated viewer's tags only.
 * In Library, contributorMoodIds=[]: personal tags and favorites form the complementary group.
 */
const props = defineProps<{
	trackId: string;
	contributorMoodIds: string[];
	contributorMoods?: Mood[];
}>();
const { music, page, pending, error, setTag } = useMusicAnnotations(toRef(props, "trackId"));
const { items, loading, error: loadError, hasMore } = page;
const pickerOpen = ref(false);
const pickerBusy = ref(false);
const retryMood = ref<Mood | null>(null);
const retryActive = ref(false);
watch(
	[music.version, () => props.trackId],
	() => {
		pickerOpen.value = false;
		pickerBusy.value = false;
		retryMood.value = null;
	},
	{ flush: "sync" },
);
watch([music.version, () => props.contributorMoods], ([, moods]) => music.remember(moods ?? []), {
	immediate: true,
});
const viewerIds = computed(() => items.value.map(m => m.id));
const priorityIds = computed(() => [...new Set(props.contributorMoodIds)]);
const complement = computed(() => {
	const priority = new Set(priorityIds.value);
	return [
		...new Map(
			[...items.value, ...music.favorites.items.value]
				.filter(m => !priority.has(m.id))
				.map(m => [m.id, m]),
		).values(),
	];
});
const disabled = computed(
	() => loading.value || !!loadError.value || pickerBusy.value || !music.authorized.value,
);
async function toggle(mood: Mood, active?: boolean) {
	if (active === undefined) {
		if (!viewerIds.value.includes(mood.id) && !page.complete.value) {
			return;
		}
		active = !viewerIds.value.includes(mood.id);
	}
	retryMood.value = mood;
	retryActive.value = active;
	await setTag(mood, active);
}
</script>

<template>
	<section class="flex min-w-0 flex-col gap-4" :aria-label="$t('music.track-moods')">
		<MusicFeedback :loading="loading" :error="loadError" retry @retry="page.retry" />
		<MusicFeedback :error="error" retry @retry="retryMood && toggle(retryMood, retryActive)" />
		<p v-if="!music.authorized.value">{{ $t("music.sign-in") }}</p>
		<p v-else-if="!page.complete.value" class="text-sm text-muted-foreground">
			{{ $t("music.selection-incomplete") }}
		</p>
		<div
			v-if="priorityIds.length"
			role="group"
			:aria-label="$t('music.contributor-moods')"
			class="flex flex-wrap gap-2"
		>
			<div v-for="moodId in priorityIds" :key="moodId">
				<MoodButton
					v-if="music.moods.get(moodId)"
					:mood="music.moods.get(moodId)!"
					:active="viewerIds.includes(moodId)"
					:unknown="!page.complete.value && !viewerIds.includes(moodId)"
					:disabled="disabled || pending.size > 0"
					@toggle="toggle(music.moods.get(moodId)!)"
				/>
				<span v-else class="text-sm text-muted-foreground">{{
					$t("music.unknown-mood")
				}}</span>
			</div>
		</div>
		<div role="group" :aria-label="$t('music.personal-moods')" class="flex flex-wrap gap-2">
			<MoodButton
				v-for="mood in complement"
				:key="mood.id"
				:mood="mood"
				:active="viewerIds.includes(mood.id)"
				:unknown="!page.complete.value && !viewerIds.includes(mood.id)"
				:disabled="disabled || pending.size > 0"
				@toggle="toggle(mood)"
			/>
		</div>
		<MusicFeedback
			:loading="music.favorites.loading.value"
			:error="music.favorites.error.value"
			retry
			@retry="music.favorites.retry"
		/>
		<Button
			v-if="music.favorites.hasMore.value"
			type="button"
			variant="outline"
			:disabled="music.favorites.loading.value"
			@click="music.favorites.loadMore"
			>{{ $t("music.more-favorites") }}</Button
		>
		<Button
			v-if="hasMore"
			type="button"
			variant="outline"
			:disabled="loading"
			@click="page.loadMore"
			>{{ $t("music.more-tags") }}</Button
		>
		<Button
			type="button"
			variant="outline"
			:aria-expanded="pickerOpen"
			:disabled="!music.authorized.value"
			@click="
				pickerOpen = !pickerOpen;
				pickerBusy = false;
			"
		>
			<Plus data-icon="inline-start" aria-hidden="true" />{{ $t("music.discover") }}
		</Button>
		<MoodPicker
			v-if="pickerOpen"
			:key="trackId"
			:selected-ids="viewerIds"
			:selection-incomplete="!page.complete.value"
			:disabled="disabled || pending.size > 0"
			@select="toggle"
			@busy="pickerBusy = $event"
		/>
	</section>
</template>
