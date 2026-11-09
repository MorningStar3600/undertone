<template>
	<div class="flex min-w-0 items-center gap-1">
		<Button
			variant="ghost"
			size="icon-lg"
			class="media-control"
			:aria-label="$t(volume.isMuted.value ? 'room.unmute-volume' : 'room.mute-volume')"
			:title="$t(volume.isMuted.value ? 'room.unmute-volume' : 'room.mute-volume')"
			:aria-pressed="volume.isMuted.value"
			@click="toggleMute"
		>
			<Icon :icon="volumeIcon" />
		</Button>
		<div class="volume">
			<input
				type="range"
				class="min-h-11 w-full cursor-pointer accent-primary focus-visible:outline-2 focus-visible:outline-ring"
				:value="volume.volume.value"
				min="0"
				max="100"
				step="1"
				data-cy="volume-slider"
				:aria-label="$t('room.personal-volume')"
				@input="changed(Number(($event.target as HTMLInputElement).value))"
			/>
		</div>
	</div>
</template>

<script lang="ts" setup>
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { computed, nextTick } from "vue";
import { useVolume } from "../composables";
import { mdiVolumeHigh, mdiVolumeMedium, mdiVolumeLow, mdiVolumeOff } from "@mdi/js";

const emit = defineEmits(["update:volume"]);

const volume = useVolume();
const volumeIcon = computed(() => {
	const volumeLevel = volume.volume.value;
	if (volume.isMuted.value || volumeLevel === 0) {
		return mdiVolumeOff;
	}

	if (volumeLevel >= 66) {
		return mdiVolumeHigh;
	} else if (volumeLevel >= 33) {
		return mdiVolumeMedium;
	} else {
		return mdiVolumeLow;
	}
});

async function changed(value: number) {
	// useVolume restores the previous value when unmuting. Let that restoration
	// finish before applying the user's new level.
	if (volume.isMuted.value && value > 0) {
		volume.isMuted.value = false;
		await nextTick();
	}
	emit("update:volume", value);
	volume.volume.value = value;
}

function toggleMute() {
	volume.isMuted.value = !volume.isMuted.value;
}
</script>

<style scoped>
.media-control {
	color: var(--foreground);
}

.volume {
	flex: 1;
	min-width: 44px;
	max-width: 150px;
}
</style>
