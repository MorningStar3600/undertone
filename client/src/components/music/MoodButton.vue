<script setup lang="ts">
import type { Mood } from "ott-common/models/music";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { moodIcons } from "./mood-icons";

defineProps<{ mood: Mood; active: boolean; disabled?: boolean }>();
defineEmits<{ toggle: [] }>();
</script>

<template>
	<Tooltip>
		<TooltipTrigger as-child>
			<Button
				type="button"
				variant="outline"
				size="icon-lg"
				class="mood-button"
				:aria-label="mood.name"
				:aria-pressed="active"
				:disabled="disabled"
				:data-mood-id="mood.id"
				@click="$emit('toggle')"
			>
				<component :is="moodIcons[mood.iconKey]" aria-hidden="true" />
			</Button>
		</TooltipTrigger>
		<TooltipContent>{{ mood.name }}</TooltipContent>
	</Tooltip>
</template>

<style scoped>
.mood-button {
	--music-active: oklch(0.7 0.16 250);
}
.mood-button[aria-pressed="true"] {
	color: var(--music-active);
	border-color: var(--music-active);
	background: color-mix(in oklch, var(--music-active) 15%, var(--background));
}
</style>
