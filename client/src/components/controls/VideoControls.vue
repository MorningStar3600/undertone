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
			<Popover v-if="musicCurrent" v-model:open="moodsOpen">
				<PopoverTrigger as-child
					><Button
						variant="ghost"
						size="icon-lg"
						:aria-label="$t('music.track-moods')"
						data-cy="player-moods"
						><Music2 aria-hidden="true" /></Button
				></PopoverTrigger>
				<PopoverContent
					side="top"
					align="end"
					:avoid-collisions="false"
					class="player-moods-panel flex flex-col gap-4"
					data-cy="player-moods-panel"
				>
					<h2>{{ $t("music.track-moods") }}</h2>
					<p class="text-sm text-muted-foreground">{{ $t("musicRoom.tags-hint") }}</p>
					<TrackMoods
						:track-id="musicCurrent.trackId"
						:contributor-mood-ids="musicCurrent.contributorMoodIds"
						:contributor-moods="musicCurrent.contributorMoods"
					/>
					<MusicFavorites v-if="store.state.user" />
				</PopoverContent>
			</Popover>
			<PlayerPanel v-model:open="moreOpen" :label="$t('room.more-player-controls')">
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
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Music2 } from "@lucide/vue";
import TrackMoods from "@/components/music/TrackMoods.vue";
import MusicFavorites from "@/components/music/MusicFavorites.vue";

defineProps<{ sliderPosition: number; truePosition: number }>();
const store = useStore();
const source = computed(() => store.state.room.currentSource);
const musicCurrent = computed(() => store.state.room.music?.current);
const panel = ref<"moods" | "more" | null>(null);
const moodsOpen = computed({
	get: () => panel.value === "moods",
	set: value => {
		if (value) {
			panel.value = "moods";
		} else if (panel.value === "moods") {
			panel.value = null;
		}
	},
});
const moreOpen = computed({
	get: () => panel.value === "more",
	set: value => {
		if (value) {
			panel.value = "more";
		} else if (panel.value === "more") {
			panel.value = null;
		}
	},
});
watch([() => store.state.room.name, () => store.state.user], () => {
	panel.value = null;
});
watch(musicCurrent, current => {
	if (!current && panel.value === "moods") {
		panel.value = null;
	}
});
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
.player-moods-panel {
	width: min(32rem, calc(100vw - 1rem));
	max-height: max(
		0px,
		calc(var(--room-viewport-height, 100dvh) - var(--room-player-height, 160px) - 1rem)
	);
	overflow-y: auto;
	overscroll-behavior: contain;
}
@media (max-width: 379px) {
	.player-actions {
		grid-column: 1 / -1;
		justify-content: flex-end;
	}
	.player-volume {
		grid-column: 2 / -1;
	}
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
