<template>
	<div class="video-controls" role="region" :aria-label="$t('room.player-controls')">
		<div class="player-metadata flex min-w-0 items-center gap-2">
			<img
				v-if="source?.thumbnail && !thumbnailFailed"
				:src="source.thumbnail"
				alt=""
				class="size-11 shrink-0 rounded-sm object-cover"
				@error="thumbnailFailed = true"
			/>
			<div class="min-w-0">
				<p class="truncate text-sm" :title="source?.title" data-cy="current-title">
					{{ source?.title || $t("room-list.nothing-playing") }}
				</p>
				<p v-if="source" class="truncate text-xs text-muted-foreground">
					{{ source.service }}
				</p>
			</div>
		</div>
		<BasicControls compact class="player-transport" :current-position="truePosition" />
		<VolumeControl class="player-volume" />
		<div class="player-actions flex items-center">
			<!-- Track-mood controls can use PlayerPanel in this slot. Its content opens
			     above the dock without replacing the source player or transport. -->
			<slot name="panels" />
			<PlayerPanel :label="$t('room.more-player-controls')">
				<div class="flex flex-wrap items-center gap-2">
					<ClosedCaptionsSwitcher />
					<PlaybackRateSwitcher />
					<VideoSettings />
					<PictureInPictureButton />
					<LayoutSwitcher />
				</div>
				<VoteSkip />
			</PlayerPanel>
		</div>
		<div class="player-progress flex min-w-0 items-center gap-3">
			<div class="min-w-0 flex-1">
				<VideoProgressSlider :current-position="sliderPosition" />
			</div>
			<TimestampDisplay :current-position="truePosition" data-cy="timestamp-display" />
		</div>
	</div>
</template>

<script lang="ts" setup>
import { computed, ref, watch } from "vue";
import { useStore } from "@/store";
import VoteSkip from "@/components/VoteSkip.vue";
import BasicControls from "./BasicControls.vue";
import ClosedCaptionsSwitcher from "./ClosedCaptionsSwitcher.vue";
import LayoutSwitcher from "./LayoutSwitcher.vue";
import TimestampDisplay from "./TimestampDisplay.vue";
import VideoProgressSlider from "./VideoProgressSlider.vue";
import VolumeControl from "./VolumeControl.vue";
import PlaybackRateSwitcher from "./PlaybackRateSwitcher.vue";
import VideoSettings from "./VideoSettings.vue";
import PictureInPictureButton from "./PictureInPictureButton.vue";
import PlayerPanel from "./PlayerPanel.vue";

defineProps<{ sliderPosition: number; truePosition: number }>();
const store = useStore();
const source = computed(() => store.state.room.currentSource);
const thumbnailFailed = ref(false);
watch(
	() => source.value?.thumbnail,
	() => {
		thumbnailFailed.value = false;
	},
);
</script>

<style scoped>
.video-controls {
	/* At 320px, transport and panel buttons retain 44px targets; metadata truncates. */
	position: relative;
	display: grid;
	grid-template-columns: auto minmax(0, 1fr) auto;
	gap: 0.25rem 0.5rem;
	padding: 0.5rem;
	min-width: 0;
}
.player-metadata,
.player-progress {
	grid-column: 1 / -1;
}
.player-volume {
	min-width: 0;
}
@media (min-width: 768px) {
	.video-controls {
		grid-template-columns: minmax(0, 1fr) auto minmax(140px, 220px) auto;
		padding-inline: 1rem;
		column-gap: 1rem;
	}
	.player-metadata {
		grid-column: auto;
	}
}
</style>
