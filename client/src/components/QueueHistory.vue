<template>
	<ol v-if="played.length || current" class="queue-history" data-cy="queue-history">
		<li v-for="(track, index) in played" :key="track.key" class="min-w-0">
			<button
				type="button"
				class="queue-played"
				:disabled="!canGoBack"
				:aria-label="$t('musicRoom.play-again', { title: track.title || untitled })"
				:title="$t('musicRoom.play-again-hint')"
				data-cy="queue-play-again"
				@click="goBack(index)"
			>
				<span class="queue-thumb">
					<img v-if="track.cover" :src="track.cover" alt="" loading="lazy" />
				</span>
				<span class="queue-text">
					<b>{{ track.title || untitled }}</b>
					<small v-if="track.detail">{{ track.detail }}</small>
				</span>
				<RotateCcw class="queue-again" aria-hidden="true" />
			</button>
		</li>
		<li
			v-if="current"
			class="queue-now"
			aria-current="true"
			:data-playing="playing"
			data-cy="queue-now-playing"
		>
			<span class="queue-now-cover">
				<img v-if="current.cover" :src="current.cover" alt="" />
			</span>
			<span class="queue-now-text">
				<span class="queue-now-label">
					<span class="queue-bars" aria-hidden="true"><i /><i /><i /></span>
					{{ $t(playing ? "musicRoom.now-playing" : "musicRoom.now-paused") }}
				</span>
				<b class="queue-now-title">{{ current.title || untitled }}</b>
				<small v-if="current.detail">{{ current.detail }}</small>
			</span>
		</li>
	</ol>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { RotateCcw } from "@lucide/vue";
import { useGrants } from "@/components/composables/grants";
import { useConnection } from "@/plugins/connection";
import { useRoomApi } from "@/util/roomapi";
import { useStore } from "@/store";

export interface QueueHistoryTrack {
	key: string;
	title?: string;
	detail?: string;
	cover?: string | null;
}

/**
 * The room's past and present above its queue: played tracks (oldest first), then the one
 * playing now. A played track can be brought back for the whole room in one step.
 */
const props = defineProps<{
	played: QueueHistoryTrack[];
	current: QueueHistoryTrack | null;
	/** Going back is unavailable for another reason (e.g. the music room is offline). */
	disabled?: boolean;
}>();

const { t } = useI18n();
const store = useStore();
const granted = useGrants();
const roomapi = useRoomApi(useConnection());
const untitled = computed(() => t("musicRoom.untitled"));
const playing = computed(() => store.state.room.isPlaying);
// Going back is a shared "previous": the same grant, and never a way around vote-skip.
const canGoBack = computed(
	() => !props.disabled && granted("playback.skip") && !store.state.room.enableVoteSkip,
);
function goBack(index: number) {
	roomapi.previous(props.played.length - index);
}
</script>

<style scoped>
.queue-history {
	display: flex;
	flex-direction: column;
	gap: 2px;
	margin: 0;
	padding: 0;
	list-style: none;
}

/* Played tracks read as the past: small, quiet, and a click brings one back. */
.queue-played {
	display: flex;
	align-items: center;
	gap: 0.7rem;
	width: 100%;
	min-width: 0;
	padding: 0.3rem 0.5rem;
	border-radius: 10px;
	text-align: left;
	color: var(--muted-foreground);
	opacity: 0.78;
	cursor: pointer;
	transition: background-color 0.15s, opacity 0.15s;
}
.queue-played:hover:not(:disabled),
.queue-played:focus-visible {
	background: color-mix(in srgb, var(--foreground) 7%, transparent);
	color: var(--foreground);
	opacity: 1;
}
.queue-played:disabled {
	cursor: default;
}
.queue-thumb {
	display: block;
	flex: none;
	width: 2.25rem;
	height: 2.25rem;
	overflow: hidden;
	border-radius: 8px;
	background: color-mix(in srgb, var(--foreground) 8%, transparent);
}
.queue-thumb img,
.queue-now-cover img {
	width: 100%;
	height: 100%;
	object-fit: cover;
}
.queue-text {
	display: flex;
	min-width: 0;
	flex: 1;
	flex-direction: column;
}
.queue-text b,
.queue-text small {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.queue-text b {
	font-weight: 500;
	font-size: 0.9rem;
}
.queue-text small {
	font-size: 0.78rem;
}
.queue-again {
	width: 1rem;
	height: 1rem;
	flex: none;
	opacity: 0;
	transition: opacity 0.15s;
}
.queue-played:hover:not(:disabled) .queue-again,
.queue-played:focus-visible .queue-again {
	opacity: 1;
}

/* The present: a warm wash of the accent, a real cover, the title in the display face. */
.queue-now {
	display: grid;
	grid-template-columns: 4rem minmax(0, 1fr);
	align-items: center;
	gap: 0.9rem;
	margin: 6px 0 2px;
	padding: 0.6rem 0.9rem 0.6rem 0.6rem;
	border-radius: 16px;
	background: linear-gradient(
		100deg,
		color-mix(in srgb, var(--primary) 17%, transparent),
		color-mix(in srgb, var(--primary) 5%, transparent) 55%,
		transparent
	);
	box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary) 22%, transparent);
}
.queue-now-cover {
	display: block;
	width: 4rem;
	height: 4rem;
	overflow: hidden;
	border-radius: 12px;
	background: color-mix(in srgb, var(--foreground) 10%, transparent);
	box-shadow: 0 12px 24px -14px rgb(0 0 0 / 0.8);
}
.queue-now-text {
	display: flex;
	min-width: 0;
	flex-direction: column;
	gap: 2px;
}
.queue-now-label {
	display: inline-flex;
	align-items: center;
	gap: 0.45rem;
	font: italic 400 0.9rem/1.2 var(--ut-f-voice, Georgia, serif);
	color: var(--primary);
}
.queue-now-title {
	font: 300 1.1rem/1.2 var(--ut-f-display, system-ui, sans-serif);
	letter-spacing: -0.01em;
	color: var(--foreground);
	overflow-wrap: anywhere;
	display: -webkit-box;
	-webkit-line-clamp: 2;
	-webkit-box-orient: vertical;
	overflow: hidden;
}
.queue-now-text small {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-size: 0.8rem;
	color: var(--muted-foreground);
}

/* Three soft bars that breathe while the room plays and rest when it pauses. */
.queue-bars {
	display: inline-flex;
	align-items: flex-end;
	gap: 2px;
	height: 0.8rem;
}
.queue-bars i {
	display: block;
	width: 3px;
	height: 100%;
	border-radius: 2px;
	background: currentColor;
	transform-origin: 50% 100%;
	transform: scaleY(0.35);
	animation: queue-bar 1.1s ease-in-out infinite alternate;
	animation-play-state: paused;
}
.queue-bars i:nth-child(2) {
	animation-delay: -0.4s;
}
.queue-bars i:nth-child(3) {
	animation-delay: -0.8s;
}
.queue-now[data-playing="true"] .queue-bars i {
	animation-play-state: running;
}
@keyframes queue-bar {
	from {
		transform: scaleY(0.3);
	}
	to {
		transform: scaleY(1);
	}
}
@media (prefers-reduced-motion: reduce) {
	.queue-bars i {
		animation: none;
	}
}
</style>
