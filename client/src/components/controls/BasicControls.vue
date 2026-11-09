<template>
	<div class="flex items-center">
		<Tooltip v-if="!compact">
			<TooltipTrigger as-child>
				<Button
					variant="ghost"
					size="icon"
					class="media-control"
					:disabled="!canSeek"
					:aria-label="$t('room.rewind')"
					@click="seekDelta(-10)"
				>
					<Icon :icon="mdiChevronLeft" class="size-5" />
				</Button>
			</TooltipTrigger>
			<TooltipContent side="bottom">{{ $t("room.rewind") }}</TooltipContent>
		</Tooltip>
		<Tooltip>
			<TooltipTrigger as-child>
				<Button
					variant="ghost"
					size="icon"
					class="media-control"
					:disabled="!canPlay"
					:aria-label="$t(store.state.room.isPlaying ? 'common.pause' : 'common.play')"
					data-cy="playback-toggle"
					@click="togglePlayback()"
				>
					<Icon :icon="store.state.room.isPlaying ? mdiPause : mdiPlay" class="size-5" />
				</Button>
			</TooltipTrigger>
			<TooltipContent side="bottom">{{ $t("room.play-pause") }}</TooltipContent>
		</Tooltip>
		<Tooltip v-if="!compact">
			<TooltipTrigger as-child>
				<Button
					variant="ghost"
					size="icon"
					class="media-control"
					:disabled="!canSeek"
					:aria-label="$t('room.skip')"
					@click="seekDelta(10)"
				>
					<Icon :icon="mdiChevronRight" class="size-5" />
				</Button>
			</TooltipTrigger>
			<TooltipContent side="bottom">{{ $t("room.skip") }}</TooltipContent>
		</Tooltip>
		<Tooltip>
			<TooltipTrigger as-child>
				<Button
					variant="ghost"
					size="icon"
					class="media-control"
					:disabled="!canSkip"
					:aria-pressed="store.state.room.enableVoteSkip ? hasVotedToSkip : undefined"
					data-cy="playback-skip"
					:aria-label="
						store.state.room.enableVoteSkip
							? $t('room.next-video-vote')
							: $t('room.next-video')
					"
					@click="skip()"
				>
					<Icon :icon="mdiSkipForward" class="size-5" />
				</Button>
			</TooltipTrigger>
			<TooltipContent side="bottom">
				{{
					store.state.room.enableVoteSkip
						? $t("room.next-video-vote")
						: $t("room.next-video")
				}}
			</TooltipContent>
		</Tooltip>
	</div>
</template>

<script lang="ts" setup>
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { mdiChevronLeft, mdiPlay, mdiPause, mdiChevronRight, mdiSkipForward } from "@mdi/js";
import _ from "lodash";
import { computed, onMounted, onUnmounted, watch } from "vue";
import { useStore } from "@/store";
import { useConnection } from "@/plugins/connection";
import { useRoomApi } from "@/util/roomapi";
import { useGrants } from "../composables/grants";

const props = withDefaults(
	defineProps<{
		currentPosition?: number;
		compact?: boolean;
	}>(),
	{
		currentPosition: 0,
	},
);

const emit = defineEmits(["seek", "play", "pause", "skip"]);

const store = useStore();
const roomapi = useRoomApi(useConnection());
const granted = useGrants();
const canPlay = computed(
	() => !!store.state.room.currentSource?.id && granted("playback.play-pause"),
);
const canSkip = computed(() => !!store.state.room.currentSource?.id && granted("playback.skip"));
const canSeek = computed(
	() => !!store.state.room.currentSource?.length && granted("playback.seek"),
);
const hasVotedToSkip = computed(() => store.state.room.votesToSkip.has(store.state.users.you.id));

function setMediaAction(action: MediaSessionAction, handler: MediaSessionActionHandler | null) {
	try {
		navigator.mediaSession.setActionHandler(action, handler);
	} catch {
		// Browsers implement different subsets of Media Session actions.
	}
}

// Setup Media Session API handlers for the controls in PiP
onMounted(() => {
	if ("mediaSession" in navigator) {
		setMediaAction("play", () => {
			if (canPlay.value && !store.state.room.isPlaying) {
				roomapi.play();
			}
		});

		setMediaAction("pause", () => {
			if (canPlay.value && store.state.room.isPlaying) {
				roomapi.pause();
			}
		});

		setMediaAction("nexttrack", () => {
			if (canSkip.value) {
				skip();
			}
		});
		setMediaAction("seekto", details => {
			if (canSeek.value && Number.isFinite(details.seekTime)) {
				roomapi.seek(
					_.clamp(details.seekTime!, 0, store.state.room.currentSource?.length ?? 0),
				);
			}
		});
		setMediaAction("seekbackward", details => seekDelta(-(details.seekOffset ?? 10)));
		setMediaAction("seekforward", details => seekDelta(details.seekOffset ?? 10));
		watch(
			() => [store.state.room.currentSource, store.state.room.isPlaying] as const,
			([source, playing]) => {
				if (typeof MediaMetadata !== "undefined") {
					navigator.mediaSession.metadata = source
						? new MediaMetadata({
								title: source.title,
								artwork: source.thumbnail ? [{ src: source.thumbnail }] : [],
						  })
						: null;
				}
				navigator.mediaSession.playbackState = source
					? playing
						? "playing"
						: "paused"
					: "none";
			},
			{ immediate: true },
		);
	}
});

onUnmounted(() => {
	if ("mediaSession" in navigator) {
		for (const action of [
			"play",
			"pause",
			"nexttrack",
			"seekto",
			"seekbackward",
			"seekforward",
		] as const) {
			setMediaAction(action, null);
		}
		navigator.mediaSession.metadata = null;
		navigator.mediaSession.playbackState = "none";
	}
});

/** Send a message to play or pause the video, depending on the current state. */
function togglePlayback() {
	if (!canPlay.value) {
		return;
	}
	if (store.state.room.isPlaying) {
		roomapi.pause();
		emit("pause");
	} else {
		roomapi.play();
		emit("play");
	}
}

function seekDelta(delta: number) {
	if (!canSeek.value) {
		return;
	}
	roomapi.seek(
		_.clamp(props.currentPosition + delta, 0, store.state.room.currentSource?.length ?? 0),
	);
	emit("seek");
}

function skip() {
	if (!canSkip.value) {
		return;
	}
	roomapi.skip();
	emit("skip");
}
</script>

<style scoped>
.media-control {
	color: var(--foreground);
	width: 44px;
	height: 44px;
}
</style>
