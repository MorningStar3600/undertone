<script setup lang="ts">
import { computed, ref, useId, watch } from "vue";
import type { QueueItem, VideoId } from "ott-common/models/video";
import { useMusicRoom } from "@/composables/use-music-room";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
const props = defineProps<{ item: QueueItem; reference?: VideoId }>();
const room = useMusicRoom();
const id = useId();
const startAt = ref<number | string>(props.item.startAt ?? "");
const endAt = ref<number | string>(props.item.endAt ?? "");
const subtitle = ref(props.item.subtitleUrl ?? "");
watch(
	() => props.item,
	item => {
		startAt.value = item.startAt ?? "";
		endAt.value = item.endAt ?? "";
		subtitle.value = item.subtitleUrl ?? "";
	},
);
const valid = computed(() => {
	const start = startAt.value === "" ? undefined : Number(startAt.value),
		end = endAt.value === "" ? undefined : Number(endAt.value);
	if (start !== undefined && (!Number.isFinite(start) || start < 0)) {
		return false;
	}
	if (end !== undefined && (!Number.isFinite(end) || end <= (start ?? 0))) {
		return false;
	}
	if (subtitle.value) {
		try {
			const url = new URL(subtitle.value);
			if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
				return false;
			}
		} catch {
			return false;
		}
	}
	return true;
});
function can(intent: "mix" | "next") {
	return (
		!!room &&
		!!props.reference &&
		valid.value &&
		!room.busy.value &&
		room.can({ action: "request", requestId: "preview", reference: props.reference, intent })
	);
}
function add(intent: "mix" | "next") {
	if (!can(intent) || !props.reference) {
		return;
	}
	void room!.request(
		props.reference,
		{
			startAt: startAt.value === "" ? undefined : Number(startAt.value),
			endAt: endAt.value === "" ? undefined : Number(endAt.value),
			subtitleUrl: subtitle.value || undefined,
		},
		intent,
	);
}
</script>

<template>
	<article
		class="flex min-w-0 flex-col gap-4 border-b py-4 [&_button]:min-h-11 [&_button]:max-w-full [&_button]:whitespace-normal"
		data-cy="music-preview"
	>
		<h3 class="break-words">{{ item.title || $t("musicRoom.untitled") }}</h3>
		<p>{{ item.service }}</p>
		<p v-if="!reference" role="status">{{ $t("musicRoom.reference-unavailable") }}</p>
		<FieldGroup>
			<Field
				><FieldLabel :for="`${id}-start`">{{ $t("musicRoom.start-at") }}</FieldLabel
				><Input :id="`${id}-start`" v-model="startAt" type="number" min="0" step="any"
			/></Field>
			<Field
				><FieldLabel :for="`${id}-end`">{{ $t("musicRoom.end-at") }}</FieldLabel
				><Input :id="`${id}-end`" v-model="endAt" type="number" min="0" step="any"
			/></Field>
			<Field
				><FieldLabel :for="`${id}-subtitle`">{{
					$t("video-queue-item.edit.subtitle-url")
				}}</FieldLabel
				><Input :id="`${id}-subtitle`" v-model="subtitle" type="url" maxlength="2048"
			/></Field>
		</FieldGroup>
		<p v-if="!valid" role="alert">{{ $t("musicRoom.invalid-extras") }}</p>
		<div class="flex flex-wrap gap-2">
			<Button :disabled="!can('mix')" data-cy="music-add-mix" @click="add('mix')">{{
				$t("musicRoom.intent.mix")
			}}</Button
			><Button
				variant="outline"
				:disabled="!can('next')"
				data-cy="music-add-next"
				@click="add('next')"
				>{{ $t("musicRoom.intent.next") }}</Button
			>
		</div>
		<p class="text-sm text-muted-foreground">{{ $t("musicRoom.next-hint") }}</p>
	</article>
</template>
