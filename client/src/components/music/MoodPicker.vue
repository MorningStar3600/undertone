<script setup lang="ts">
import { computed, onScopeDispose, ref, useId, watch } from "vue";
import {
	DEFAULT_MOODS,
	MOOD_ICON_KEYS,
	type Mood,
	type MoodIconKey,
} from "ott-common/models/music";
import { useMusic, useMusicPage, errorKind, type MusicError } from "@/composables/use-music";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { moodIcons } from "./mood-icons";
import MoodButton from "./MoodButton.vue";
import MusicFeedback from "./MusicFeedback.vue";
import MusicPagination from "./MusicPagination.vue";

const props = defineProps<{
	selectedIds: string[];
	selectionIncomplete?: boolean;
	disabled?: boolean;
}>();
const emit = defineEmits<{ select: [mood: Mood, active?: boolean]; busy: [busy: boolean] }>();
const music = useMusic();
const page = useMusicPage<Mood>(music, () => "/moods");
const { items, loading, error, offset, limit, total } = page;
const id = useId();
const query = ref("");
const name = ref("");
const iconKey = ref<MoodIconKey>("heart");
const creating = ref(false);
watch(creating, busy => emit("busy", busy), { flush: "sync" });
const createError = ref<MusicError | null>(null);
let creation = 0;
watch(
	music.version,
	() => {
		creation++;
		creating.value = false;
		createError.value = null;
		name.value = "";
	},
	{ flush: "sync" },
);
onScopeDispose(() => {
	creation++;
});
const filtered = computed(() =>
	items.value.filter(m =>
		m.name
			.normalize("NFKC")
			.toLowerCase()
			.includes(query.value.normalize("NFKC").trim().toLowerCase()),
	),
);
function select(mood: Mood) {
	if (props.disabled || creating.value || !music.authorized.value) {
		return;
	}
	if (props.selectionIncomplete && !props.selectedIds.includes(mood.id)) {
		return;
	}
	emit("select", mood);
}
async function create() {
	if (creating.value || props.disabled) {
		return;
	}
	const epoch = music.version.value;
	const current = ++creation;
	creating.value = true;
	createError.value = null;
	try {
		const { mood } = await music.request<{ mood: Mood }>("POST", "/moods", {
			name: name.value,
			iconKey: iconKey.value,
		});
		if (current !== creation) {
			return;
		}
		music.remember([mood]);
		name.value = "";
		emit("select", mood, true);
	} catch (failure) {
		if (epoch === music.version.value) {
			createError.value = errorKind(failure);
		}
	} finally {
		if (epoch === music.version.value) {
			creating.value = false;
		}
	}
}
</script>

<template>
	<section class="flex min-w-0 flex-col gap-4" :aria-label="$t('music.discover')">
		<p class="text-sm text-muted-foreground">{{ $t("music.defaults") }}</p>
		<p v-if="selectionIncomplete" class="text-sm text-muted-foreground">
			{{ $t("music.selection-incomplete") }}
		</p>
		<div class="flex flex-wrap gap-2">
			<MoodButton
				v-for="mood in DEFAULT_MOODS"
				:key="mood.id"
				:mood="mood"
				:active="selectedIds.includes(mood.id)"
				:unknown="selectionIncomplete && !selectedIds.includes(mood.id)"
				:disabled="disabled || creating || !music.authorized.value"
				@toggle="select(mood)"
			/>
		</div>
		<FieldGroup>
			<Field>
				<FieldLabel :for="`${id}-search`">{{ $t("music.search") }}</FieldLabel>
				<Input :id="`${id}-search`" v-model="query" type="search" />
				<FieldDescription>{{ $t("music.search-hint") }}</FieldDescription>
			</Field>
		</FieldGroup>
		<MusicFeedback :loading="loading" :error="error" retry @retry="page.retry" />
		<div class="flex flex-wrap gap-2">
			<MoodButton
				v-for="mood in filtered"
				:key="mood.id"
				:mood="mood"
				:active="selectedIds.includes(mood.id)"
				:unknown="selectionIncomplete && !selectedIds.includes(mood.id)"
				:disabled="disabled || creating || !music.authorized.value"
				@toggle="select(mood)"
			/>
		</div>
		<p v-if="!loading && !error && !filtered.length">{{ $t("music.no-moods") }}</p>
		<MusicPagination
			:offset="offset"
			:limit="limit"
			:total="total"
			:loading="loading"
			@page="page.load"
		/>
		<form class="flex flex-col gap-4" @submit.prevent="create">
			<FieldGroup>
				<Field>
					<FieldLabel :for="`${id}-name`">{{ $t("music.new-mood") }}</FieldLabel>
					<Input
						:id="`${id}-name`"
						v-model="name"
						required
						maxlength="128"
						:disabled="creating"
					/>
					<FieldDescription>{{ $t("music.name-hint") }}</FieldDescription>
				</Field>
				<Field>
					<FieldLabel :id="`${id}-icon`">{{ $t("music.icon") }}</FieldLabel>
					<ToggleGroup
						v-model="iconKey"
						type="single"
						:aria-labelledby="`${id}-icon`"
						:disabled="creating"
						class="flex-wrap"
						:spacing="2"
					>
						<ToggleGroupItem
							v-for="key in MOOD_ICON_KEYS"
							:key="key"
							:value="key"
							:aria-label="$t(`music.icons.${key}`)"
							class="size-11"
						>
							<component :is="moodIcons[key]" aria-hidden="true" />
						</ToggleGroupItem>
					</ToggleGroup>
				</Field>
			</FieldGroup>
			<MusicFeedback :loading="creating" :error="createError" />
			<Button
				type="submit"
				variant="outline"
				:disabled="
					creating || disabled || !music.authorized.value || !name.trim() || !iconKey
				"
				>{{ $t("music.create-select") }}</Button
			>
		</form>
	</section>
</template>
