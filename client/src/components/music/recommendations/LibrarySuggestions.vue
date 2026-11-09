<script setup lang="ts">
import { ref } from "vue";
import type { Mood } from "ott-common/models/music";
import { useMusicRecommendations } from "@/composables/use-music-recommendations";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
	Dialog,
	DialogContent,
	DialogTitle,
	DialogDescription,
	DialogHeader,
	DialogFooter,
} from "@/components/ui/dialog";
import {
	Card,
	CardHeader,
	CardTitle,
	CardDescription,
	CardContent,
	CardFooter,
} from "@/components/ui/card";
import MoodPicker from "../MoodPicker.vue";
import MusicFeedback from "../MusicFeedback.vue";
import RecommendationMoods from "./RecommendationMoods.vue";
const emit = defineEmits<{ changed: [] }>();
const api = useMusicRecommendations(() => emit("changed"));
const {
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
} = api;
const pickerBusy = ref(false);
function toggle(mood: Mood) {
	moodIds.value = moodIds.value.includes(mood.id)
		? moodIds.value.filter(id => id !== mood.id)
		: [...moodIds.value, mood.id].slice(0, 20);
}
</script>
<template>
	<section class="flex min-w-0 flex-col gap-4" :aria-label="$t('musicRecommendations.title')">
		<p>{{ $t("musicRecommendations.discovery") }}</p>
		<p class="text-sm text-muted-foreground">
			{{ $t("musicRecommendations.empty-selection") }}
		</p>
		<MoodPicker
			:selected-ids="moodIds"
			:disabled="pending || loading"
			@select="toggle"
			@busy="pickerBusy = $event"
		/>
		<Button
			:disabled="loading || pending || pickerBusy || !api.music.authorized.value"
			@click="api.load()"
			>{{ $t("musicRecommendations.load") }}</Button
		>
		<MusicFeedback :loading="loading" :error="error" retry @retry="api.retry" />
		<p v-if="loaded && !items.length" role="status">{{ $t("musicRecommendations.empty") }}</p>
		<Card v-for="item in items" :key="item.track.id">
			<CardHeader
				><CardTitle>{{ item.track.title }}</CardTitle
				><CardDescription>{{
					$t("musicRecommendations.anonymous")
				}}</CardDescription></CardHeader
			>
			<CardContent class="flex flex-wrap gap-2"
				><Badge v-for="mood in item.moods" :key="mood.id" variant="secondary">{{
					mood.name
				}}</Badge></CardContent
			>
			<CardFooter
				><Button :disabled="pending || loading" @click="api.choose(item)">{{
					$t("musicRecommendations.review")
				}}</Button></CardFooter
			>
		</Card>
		<Button
			v-if="next"
			variant="outline"
			:disabled="loading || pending"
			@click="api.load(next!)"
			>{{ $t("musicRecommendations.next") }}</Button
		>
		<Dialog :open="!!selected" @update:open="!$event && !pending && (selected = null)">
			<DialogContent
				v-if="selected"
				@escape-key-down="pending && $event.preventDefault()"
				@pointer-down-outside="pending && $event.preventDefault()"
			>
				<DialogHeader
					><DialogTitle>{{ $t("musicRecommendations.confirm") }}</DialogTitle
					><DialogDescription>{{
						$t("musicRecommendations.confirm-hint")
					}}</DialogDescription></DialogHeader
				>
				<p>{{ selected.track.title }}</p>
				<RecommendationMoods
					v-model="confirmedIds"
					:moods="selected.moods"
					:disabled="pending"
					:label="$t('musicRecommendations.confirm-moods')"
				/>
				<MusicFeedback :loading="pending" :error="adoptionError" />
				<DialogFooter
					><Button variant="outline" :disabled="pending" @click="selected = null">{{
						$t("common.cancel")
					}}</Button
					><Button :disabled="pending" @click="api.adopt">{{
						$t("musicRecommendations.adopt")
					}}</Button></DialogFooter
				>
			</DialogContent>
		</Dialog>
	</section>
</template>
