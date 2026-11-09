<template>
	<Button
		ref="trigger"
		variant="ghost"
		size="icon-lg"
		:aria-label="label"
		:title="label"
		:aria-expanded="open"
		:aria-controls="id"
		@click="open = !open"
	>
		<Icon :icon="mdiDotsHorizontal" />
	</Button>
	<section
		v-show="open"
		:id="id"
		class="player-panel border bg-background shadow-lg"
		role="region"
		:aria-label="label"
		@keydown.esc.stop.prevent="close"
	>
		<div class="flex items-center justify-between gap-2">
			<h2 ref="heading" tabindex="-1" class="font-medium">{{ label }}</h2>
			<Button variant="ghost" size="icon-lg" :aria-label="$t('common.close')" @click="close">
				<Icon :icon="mdiClose" />
			</Button>
		</div>
		<slot />
	</section>
</template>

<script setup lang="ts">
import { nextTick, ref, useId, watch } from "vue";
import { mdiClose, mdiDotsHorizontal } from "@mdi/js";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

defineProps<{ label: string }>();
const open = defineModel<boolean>("open", { default: false });
const id = useId();
const heading = ref<HTMLElement>();
const trigger = ref<InstanceType<typeof Button>>();
watch(open, async value => {
	if (value) {
		await nextTick();
		heading.value?.focus();
	}
});
async function close() {
	open.value = false;
	await nextTick();
	trigger.value?.$el.focus();
}
</script>

<style scoped>
.player-panel {
	position: absolute;
	bottom: 100%;
	inset-inline: 0;
	max-height: max(
		0px,
		calc(var(--room-viewport-height, 100dvh) - var(--room-player-height, 160px) - 0.5rem)
	);
	overflow-y: auto;
	overscroll-behavior: contain;
	padding: 0.5rem 1rem;
}
@media (min-width: 768px) {
	.player-panel {
		inset-inline-start: auto;
		width: min(32rem, 100%);
	}
}
</style>
