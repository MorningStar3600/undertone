<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useMusicRoom } from "@/composables/use-music-room";
import { useMusic, useMusicPage } from "@/composables/use-music";
import type { Mood } from "ott-common/models/music";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { moodIcons } from "./mood-icons";
import MoodPicker from "./MoodPicker.vue";
import MusicFeedback from "./MusicFeedback.vue";
const room = useMusicRoom()!;
const music = useMusic();
const include = ref<string[]>([]),
	exclude = ref<string[]>([]);
const content = ref<"keep" | "renew">("keep");
const picker = ref(false);
const vocabularyOpen = ref(false);
const vocabulary = useMusicPage<Mood>(music, () => (vocabularyOpen.value ? "/moods" : null));
watch(vocabulary.items, music.remember);
watch(
	[() => JSON.stringify(room.own.value), room.version],
	() => {
		include.value = [...(room.own.value?.includeMoodIds ?? [])];
		exclude.value = [...(room.own.value?.excludeMoodIds ?? [])];
		picker.value = false;
		vocabularyOpen.value = false;
	},
	{ immediate: true },
);
watch(
	[music.version, () => room.state.value?.current?.contributorMoods],
	([, moods]) => music.remember(moods ?? []),
	{ immediate: true },
);
const moods = computed(() => [...music.moods.values()]);
const disabled = computed(() => room.busy.value || !room.active.value || !room.own.value);
function toggle(id: string, exclusion = false, active?: boolean) {
	if (disabled.value) {
		return;
	}
	const target = exclusion ? exclude : include,
		other = exclusion ? include : exclude;
	const enable = active ?? !target.value.includes(id);
	if (enable && !target.value.includes(id)) {
		target.value = [...target.value, id];
	}
	if (!enable) {
		target.value = target.value.filter(m => m !== id);
	}
	if (enable) {
		other.value = other.value.filter(m => m !== id);
	}
}
function select(mood: Mood, active?: boolean) {
	music.remember([mood]);
	toggle(mood.id, false, active);
}
const dirty = computed(
	() =>
		JSON.stringify([include.value, exclude.value]) !==
		JSON.stringify([
			room.own.value?.includeMoodIds ?? [],
			room.own.value?.excludeMoodIds ?? [],
		]),
);
</script>

<template>
	<section
		class="music-filters flex min-w-0 flex-col gap-4 p-4"
		:aria-label="$t('musicRoom.filters')"
		data-cy="music-filters"
	>
		<h2>{{ $t("musicRoom.filters") }}</h2>
		<p class="text-sm text-muted-foreground">{{ $t("musicRoom.filter-hint") }}</p>
		<p class="text-sm text-muted-foreground">{{ $t("musicRoom.exclusion-hint") }}</p>
		<div class="flex flex-wrap gap-3">
			<div
				v-for="mood in moods"
				:key="mood.id"
				class="flex min-w-0 max-w-full flex-col gap-1"
			>
				<Button
					:variant="include.includes(mood.id) ? 'default' : 'outline'"
					:disabled="disabled"
					:aria-pressed="include.includes(mood.id)"
					:aria-label="$t('musicRoom.include-mood', { name: mood.name })"
					:data-include-mood="mood.id"
					@click="toggle(mood.id)"
					@contextmenu.prevent="toggle(mood.id, true)"
					><component
						:is="moodIcons[mood.iconKey]"
						data-icon="inline-start"
						aria-hidden="true"
					/>{{ mood.name }}</Button
				>
				<Button
					:variant="exclude.includes(mood.id) ? 'destructive' : 'outline'"
					:disabled="disabled"
					:aria-pressed="exclude.includes(mood.id)"
					:aria-label="$t('musicRoom.exclude-mood', { name: mood.name })"
					:data-exclude-mood="mood.id"
					@click="toggle(mood.id, true)"
					>{{ $t("musicRoom.exclude") }}</Button
				>
			</div>
		</div>
		<div
			v-for="id in [...include, ...exclude].filter(id => !music.moods.has(id))"
			:key="id"
			class="flex flex-wrap items-center gap-2"
		>
			<span
				>{{ $t("music.unknown-mood") }} ({{
					include.includes(id) ? $t("musicRoom.include") : $t("musicRoom.exclude")
				}})</span
			><Button
				variant="outline"
				:disabled="disabled"
				@click="toggle(id, exclude.includes(id), false)"
				>{{ $t("common.remove") }}</Button
			>
		</div>
		<template v-if="music.authorized.value">
			<Button
				variant="outline"
				:aria-expanded="vocabularyOpen"
				@click="vocabularyOpen = !vocabularyOpen"
				>{{ $t("musicRoom.browse-moods") }}</Button
			>
			<div v-if="vocabularyOpen" class="flex flex-col gap-2">
				<MusicFeedback
					:loading="vocabulary.loading.value"
					:error="vocabulary.error.value"
					retry
					@retry="vocabulary.retry"
				/>
				<Button
					v-if="vocabulary.hasMore.value"
					variant="outline"
					:disabled="vocabulary.loading.value"
					@click="vocabulary.loadMore"
					>{{ $t("musicRoom.more-moods") }}</Button
				>
			</div>
		</template>
		<Button
			v-if="music.authorized.value"
			variant="outline"
			:aria-expanded="picker"
			@click="picker = !picker"
			>{{ $t("music.discover") }}</Button
		>
		<MoodPicker
			v-if="picker && music.authorized.value"
			:selected-ids="include"
			:disabled="disabled"
			@select="select"
		/>
		<p v-if="!music.authorized.value" class="text-sm text-muted-foreground">
			{{ $t("musicRoom.guest-vocabulary") }}
		</p>
		<FieldGroup>
			<Field
				><FieldLabel>{{ $t("musicRoom.content-change") }}</FieldLabel
				><ToggleGroup
					v-model="content"
					class="flex-wrap"
					type="single"
					:disabled="disabled"
					:aria-label="$t('musicRoom.content-change')"
					><ToggleGroupItem value="keep">{{ $t("musicRoom.keep") }}</ToggleGroupItem
					><ToggleGroupItem value="renew">{{
						$t("musicRoom.renew")
					}}</ToggleGroupItem></ToggleGroup
				><FieldDescription>{{ $t("musicRoom.content-hint") }}</FieldDescription></Field
			>
		</FieldGroup>
		<Button
			:disabled="disabled || !dirty || !content"
			data-cy="music-apply-filters"
			@click="
				room.run({
					action: 'preferences',
					includeMoodIds: [...include],
					excludeMoodIds: [...exclude],
					content,
				})
			"
			>{{ $t("musicRoom.apply-filters") }}</Button
		>
		<div
			v-for="participant in room.state.value?.participants"
			:key="participant.participantId"
			class="flex flex-col gap-1"
		>
			<h3>{{ participant.name || $t("musicRoom.unknown-participant") }}</h3>
			<p class="text-sm">
				{{ $t("musicRoom.include") }}:
				{{
					participant.includeMoodIds
						.map(id => music.moods.get(id)?.name || $t("music.unknown-mood"))
						.join(", ") || $t("musicRoom.neutral")
				}}
			</p>
			<p class="text-sm">
				{{ $t("musicRoom.exclude") }}:
				{{
					participant.excludeMoodIds
						.map(id => music.moods.get(id)?.name || $t("music.unknown-mood"))
						.join(", ") || $t("musicRoom.none")
				}}
			</p>
		</div>
	</section>
</template>

<style scoped>
.music-filters {
	overflow-wrap: anywhere;
}
.music-filters :deep(button) {
	min-height: 44px;
	max-width: 100%;
	white-space: normal;
	overflow-wrap: anywhere;
}
</style>
