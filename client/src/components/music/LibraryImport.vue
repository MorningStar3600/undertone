<script setup lang="ts">
import { ref, useId } from "vue";
import { ALL_VIDEO_SERVICES } from "ott-common/constants";
import type { AddLibraryTrackRequest } from "ott-common/models/music";
import type { VideoService } from "ott-common/models/video";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

defineProps<{ disabled: boolean }>();
const emit = defineEmits<{ import: [input: AddLibraryTrackRequest] }>();
const mode = ref("url");
const value = ref("");
const service = ref<VideoService>("youtube");
const id = useId();
function submit() {
	if (!value.value.trim()) {
		return;
	}
	emit(
		"import",
		mode.value === "url"
			? { url: value.value.trim() }
			: { reference: { service: service.value, id: value.value.trim() } },
	);
}
</script>

<template>
	<form class="flex min-w-0 flex-col gap-4" @submit.prevent="submit">
		<h2 class="font-display text-2xl">{{ $t("music.import") }}</h2>
		<ToggleGroup
			v-model="mode"
			type="single"
			:aria-label="$t('music.import-type')"
			:disabled="disabled"
		>
			<ToggleGroupItem value="url">{{ $t("music.url") }}</ToggleGroupItem>
			<ToggleGroupItem value="reference">{{ $t("music.reference") }}</ToggleGroupItem>
		</ToggleGroup>
		<FieldGroup>
			<Field v-if="mode === 'reference'">
				<FieldLabel :for="`${id}-service`">{{ $t("music.service") }}</FieldLabel>
				<Select v-model="service" :disabled="disabled">
					<SelectTrigger :id="`${id}-service`" class="w-full"
						><SelectValue
					/></SelectTrigger>
					<SelectContent
						><SelectGroup>
							<SelectItem
								v-for="source in ALL_VIDEO_SERVICES"
								:key="source"
								:value="source"
								>{{ $t(`music.services.${source}`) }}</SelectItem
							>
						</SelectGroup></SelectContent
					>
				</Select>
			</Field>
			<Field>
				<FieldLabel :for="`${id}-value`">{{
					$t(mode === "url" ? "music.url" : "music.reference")
				}}</FieldLabel>
				<Input
					:id="`${id}-value`"
					v-model="value"
					:type="mode === 'url' ? 'url' : 'text'"
					required
					maxlength="2048"
					:disabled="disabled"
					:aria-describedby="`${id}-hint`"
				/>
				<FieldDescription :id="`${id}-hint`">{{
					$t("music.import-hint")
				}}</FieldDescription>
			</Field>
		</FieldGroup>
		<Button type="submit" :disabled="disabled || !value.trim() || !mode">{{
			$t("music.import")
		}}</Button>
	</form>
</template>
