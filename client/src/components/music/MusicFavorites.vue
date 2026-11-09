<script setup lang="ts">
import { ref } from "vue";
import type { Mood } from "ott-common/models/music";
import { useMusic } from "@/composables/use-music";
import { Button } from "@/components/ui/button";
import MoodButton from "./MoodButton.vue";
import MoodPicker from "./MoodPicker.vue";
import MusicFeedback from "./MusicFeedback.vue";

const music = useMusic();
const { items, loading, error, hasMore } = music.favorites;
const retryMood = ref<Mood | null>(null);
const retryActive = ref(false);
const pickerBusy = ref(false);
async function toggle(mood: Mood, active = !items.value.some(m => m.id === mood.id)) {
	retryMood.value = mood;
	retryActive.value = active;
	await music.setFavorite(mood, active);
}
</script>

<template>
	<section class="flex min-w-0 flex-col gap-5" :aria-label="$t('music.favorites')">
		<h2 class="font-display text-2xl">{{ $t("music.favorites") }}</h2>
		<p class="text-sm text-muted-foreground">{{ $t("music.favorites-hint") }}</p>
		<MusicFeedback :loading="loading" :error="error" retry @retry="music.favorites.retry" />
		<MusicFeedback
			:error="music.favoriteError.value"
			retry
			@retry="retryMood && toggle(retryMood, retryActive)"
		/>
		<p v-if="!loading && !error && !items.length">{{ $t("music.no-favorites") }}</p>
		<div class="flex flex-wrap gap-2">
			<MoodButton
				v-for="mood in items"
				:key="mood.id"
				:mood="mood"
				active
				:disabled="
					loading ||
					pickerBusy ||
					!!error ||
					music.favoritePending.size > 0 ||
					!music.authorized.value
				"
				@toggle="toggle(mood)"
			/>
		</div>
		<Button
			v-if="hasMore"
			type="button"
			variant="outline"
			:disabled="loading"
			@click="music.favorites.loadMore"
			>{{ $t("music.more-favorites") }}</Button
		>
		<MoodPicker
			:selected-ids="items.map(m => m.id)"
			:disabled="loading || !!error || music.favoritePending.size > 0"
			@select="toggle"
			@busy="pickerBusy = $event"
		/>
	</section>
</template>
