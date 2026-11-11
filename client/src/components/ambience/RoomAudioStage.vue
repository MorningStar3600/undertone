<template>
	<div class="ut-stage" data-cy="room-audio-view">
		<div class="ut-stage-cover">
			<img
				v-if="cover && !failed"
				:src="cover"
				alt=""
				decoding="async"
				@error="failed = true"
			/>
			<span v-else class="ut-stage-empty"
				><UndertoneLogo :ambience="ambience.id" :size="56"
			/></span>
		</div>
		<div class="ut-stage-text">
			<p class="ut-stage-mood">{{ $t(`ambience.names.${ambience.id}`) }}</p>
			<h2 class="ut-stage-title">
				{{ store.state.room.currentSource?.title || $t("room.media-mode.audio-title") }}
			</h2>
			<p class="ut-stage-hint">{{ $t("room.media-mode.audio-description") }}</p>
		</div>
	</div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { useStore } from "@/store";
import { useRoomAmbience } from "@/ambience/use-ambience";
import UndertoneLogo from "./UndertoneLogo.vue";

/** Audio mode: the cover and the mood, still. The only moving sky is the page's own. */
const store = useStore();
const { ambience, cover } = useRoomAmbience();
const failed = ref(false);
watch(cover, () => {
	failed.value = false;
});
</script>

<style scoped>
/* Sized from the media row it sits in (audio mode gives it 240px to 40vh): it never spills. */
.ut-stage {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: clamp(14px, 3vw, 40px);
	height: 100%;
	min-height: 0;
	overflow: hidden;
	padding: clamp(12px, 3vw, 40px);
}
.ut-stage-cover {
	flex: none;
	width: min(clamp(96px, 26vh, 280px), 34vw);
	aspect-ratio: 1;
	overflow: hidden;
	border-radius: clamp(14px, 2vw, 22px);
	background: var(--ut-glass, rgb(255 255 255 / 0.06));
	box-shadow: 0 30px 60px -30px var(--ut-shadow, rgb(0 0 0 / 0.8));
	outline: 1px solid color-mix(in srgb, var(--foreground) 12%, transparent);
	outline-offset: -1px;
}
.ut-stage-cover img {
	width: 100%;
	height: 100%;
	object-fit: cover;
}
.ut-stage-empty {
	display: grid;
	place-items: center;
	width: 100%;
	height: 100%;
	color: var(--primary);
}
.ut-stage-text {
	min-width: 0;
	max-width: 28rem;
}
.ut-stage-mood {
	font: italic 400 clamp(16px, 2.4vw, 24px) / 1.1 var(--ut-f-voice, Georgia, serif);
	color: var(--muted-foreground);
}
.ut-stage-title {
	margin-top: 8px;
	font: 300 clamp(20px, 4vw, 44px) / 1.05 var(--ut-f-display, system-ui, sans-serif);
	letter-spacing: -0.03em;
	text-transform: none;
	overflow-wrap: anywhere;
	display: -webkit-box;
	-webkit-line-clamp: 3;
	-webkit-box-orient: vertical;
	overflow: hidden;
}
.ut-stage-hint {
	margin-top: 10px;
	font-size: 13px;
	color: var(--muted-foreground);
}
@media (max-width: 520px) {
	.ut-stage-hint {
		display: none;
	}
}
</style>
