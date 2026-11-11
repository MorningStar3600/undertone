<template>
	<!-- eslint-disable-next-line vue/no-v-html -- trusted, static markup from common/ambience -->
	<svg
		class="ut-logo"
		viewBox="0 0 24 24"
		:width="size"
		:height="size"
		aria-hidden="true"
		focusable="false"
		v-html="logo"
	/>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { getAmbience, type AmbienceId } from "ott-common/ambience";

/**
 * Undertone's mark is logo 01, "Horizon": a sun just under the line, the tone beneath. Every
 * ambience keeps its own candidate in common/ambience; set this to null to let the logo follow
 * the ambience again.
 */
const PINNED_LOGO: AmbienceId | null = "heure-bleue";

const props = withDefaults(defineProps<{ ambience: AmbienceId; size?: number }>(), { size: 22 });
const logo = computed(() => getAmbience(PINNED_LOGO ?? props.ambience).logo);
</script>

<style scoped>
.ut-logo {
	display: block;
	flex: none;
	fill: none;
	stroke: currentColor;
	stroke-width: 2;
	stroke-linecap: round;
	stroke-linejoin: round;
	overflow: visible;
}
</style>
