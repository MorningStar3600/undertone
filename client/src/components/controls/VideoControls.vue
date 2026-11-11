<template>
	<div
		class="ut-widget ut-palette"
		role="region"
		:aria-label="$t('room.player-controls')"
		:data-collapsed="collapsed"
		:data-docked="docked"
		:data-ambience="ambience.id"
		:style="vars"
	>
		<AmbienceSky :ambience="ambience.id" />
		<div class="w-grid">
			<header class="w-head">
				<span class="w-lockup" role="img" :aria-label="$t('player-widget.brand')">
					<UndertoneLogo :ambience="ambience.id" :size="collapsed ? 20 : 22" />
					<span class="w-wordmark" aria-hidden="true">undertone</span>
				</span>
				<span class="w-tools">
					<button
						v-if="moveBy && !docked"
						type="button"
						class="w-round w-move"
						data-no-drag
						:aria-label="$t('player-widget.move')"
						:title="$t('player-widget.move-hint')"
						@keydown="onMoveKey"
					>
						<GripHorizontal class="w-ic" aria-hidden="true" />
					</button>
					<button
						v-if="musicCurrent"
						ref="moodsTrigger"
						type="button"
						class="w-round"
						:aria-label="$t('music.track-moods')"
						:title="$t('music.track-moods')"
						:aria-expanded="panel === 'moods'"
						:aria-controls="moodsId"
						data-cy="player-moods"
						@click="toggle('moods')"
					>
						<Music2 class="w-ic" aria-hidden="true" />
					</button>
					<button
						ref="moreTrigger"
						type="button"
						class="w-round"
						:aria-label="$t('room.more-player-controls')"
						:title="$t('room.more-player-controls')"
						:aria-expanded="panel === 'more'"
						:aria-controls="moreId"
						@click="toggle('more')"
					>
						<Ellipsis class="w-ic" aria-hidden="true" />
					</button>
					<button
						v-if="toggleCollapsed && !docked"
						type="button"
						class="w-round w-fold"
						:aria-label="$t(collapsed ? 'player-widget.unfold' : 'player-widget.fold')"
						:title="$t(collapsed ? 'player-widget.unfold' : 'player-widget.fold')"
						:aria-expanded="!collapsed"
						data-cy="player-fold"
						@click="toggleCollapsed()"
					>
						<ChevronUp v-if="collapsed" class="w-ic" aria-hidden="true" />
						<ChevronDown v-else class="w-ic" aria-hidden="true" />
					</button>
				</span>
			</header>

			<p class="w-room">
				<span class="truncate">{{ roomLine }}</span>
				<span v-if="avatars.length" class="w-avatars" aria-hidden="true">
					<i
						v-for="person in avatars"
						:key="person.id"
						:style="{ background: person.color }"
						>{{ person.initial }}</i
					>
				</span>
			</p>

			<p class="w-mood" data-cy="player-ambience">
				<span>{{ $t(`ambience.names.${ambience.id}`) }}</span>
				<small>{{ $t("player-widget.ambience-number", { number: ambienceNumber }) }}</small>
			</p>

			<div class="w-hero">
				<span class="w-cover">
					<img
						v-if="cover && !coverFailed"
						:src="cover"
						alt=""
						decoding="async"
						@error="coverFailed = true"
					/>
					<span v-else class="w-cover-empty"
						><UndertoneLogo :ambience="ambience.id" :size="28"
					/></span>
				</span>
				<div class="w-meta">
					<h2
						class="w-title"
						:data-long="(title?.length ?? 0) > 22"
						:title="source?.title"
						data-cy="current-title"
					>
						{{ title || $t("room-list.nothing-playing") }}
					</h2>
					<p v-if="subtitle" class="w-artist">{{ subtitle }}</p>
					<p v-if="broughtBy" class="w-by">
						{{ $t("player-widget.brought-by", { name: broughtBy }) }}
					</p>
				</div>
			</div>

			<div class="w-body">
				<div class="w-prog">
					<VideoProgressSlider :current-position="sliderPosition" />
				</div>
				<div class="w-tp">
					<VolumeControl class="w-vol" />
					<BasicControls compact class="w-transport" :current-position="truePosition" />
					<TimestampDisplay
						class="w-time"
						:current-position="truePosition"
						data-cy="timestamp-display"
					/>
				</div>

				<section
					v-if="musicCurrent"
					v-show="panel === 'moods'"
					:id="moodsId"
					class="w-panel"
					role="region"
					:aria-label="$t('music.track-moods')"
					data-cy="player-moods-panel"
					@keydown.esc.stop.prevent="close"
				>
					<div class="w-panel-head">
						<h2 ref="moodsHeading" tabindex="-1">{{ $t("music.track-moods") }}</h2>
						<span class="w-hint">{{ $t("player-widget.only-you") }}</span>
					</div>
					<p class="w-hint">{{ $t("musicRoom.tags-hint") }}</p>
					<TrackMoods
						:track-id="musicCurrent.trackId"
						:contributor-mood-ids="musicCurrent.contributorMoodIds"
						:contributor-moods="musicCurrent.contributorMoods"
					/>
					<MusicFavorites v-if="store.state.user" />
				</section>

				<section
					v-show="panel === 'more'"
					:id="moreId"
					class="w-panel"
					role="region"
					:aria-label="$t('room.more-player-controls')"
					@keydown.esc.stop.prevent="close"
				>
					<div class="w-panel-head">
						<h2 ref="moreHeading" tabindex="-1">
							{{ $t("room.more-player-controls") }}
						</h2>
					</div>
					<div class="flex flex-wrap items-center gap-2">
						<slot name="panels" />
						<ClosedCaptionsSwitcher />
						<PlaybackRateSwitcher />
						<VideoSettings />
						<PictureInPictureButton />
						<LayoutSwitcher />
					</div>
					<VoteSkip />
					<div
						class="w-motion"
						role="group"
						:aria-label="$t('player-widget.motion.label')"
					>
						<span class="w-hint">{{ $t("player-widget.motion.label") }}</span>
						<span class="w-seg">
							<button
								v-for="option in MOTION_OPTIONS"
								:key="option"
								type="button"
								:aria-pressed="motionPreference === option"
								@click="setMotion(option)"
							>
								{{ $t(`player-widget.motion.${option}`) }}
							</button>
						</span>
						<span v-if="reducedMotion" class="w-hint">{{
							$t("player-widget.motion.system-reduced")
						}}</span>
					</div>
				</section>

				<section
					v-if="upNext.length"
					class="w-next"
					:aria-label="$t('player-widget.up-next')"
				>
					<div class="w-panel-head">
						<h3>{{ $t("player-widget.up-next") }}</h3>
						<span class="w-hint">{{ $t("player-widget.in-room-queue") }}</span>
					</div>
					<ul>
						<li v-for="item in upNext" :key="item.key">
							<span class="w-thumb">
								<img v-if="item.cover" :src="item.cover" alt="" loading="lazy" />
							</span>
							<span class="w-next-text">
								<b>{{ item.title || $t("player-widget.untitled") }}</b>
								<small v-if="item.detail">{{ item.detail }}</small>
							</span>
						</li>
					</ul>
				</section>
			</div>

			<p class="w-foot" aria-live="polite">{{ footer }}</p>
			<div class="w-hair" aria-hidden="true">
				<i :style="{ transform: `scaleX(${progress})` }" />
			</div>
		</div>
	</div>
</template>

<script lang="ts" setup>
import { computed, nextTick, ref, useId, watch } from "vue";
import { ChevronDown, ChevronUp, Ellipsis, GripHorizontal, Music2 } from "@lucide/vue";
import { useStore } from "@/store";
import VoteSkip from "@/components/VoteSkip.vue";
import AmbienceSky from "@/components/ambience/AmbienceSky.vue";
import UndertoneLogo from "@/components/ambience/UndertoneLogo.vue";
import TrackMoods from "@/components/music/TrackMoods.vue";
import MusicFavorites from "@/components/music/MusicFavorites.vue";
import { useMusicRoom } from "@/composables/use-music-room";
import { coverUrl } from "@/ambience/cover-ambience";
import { ambienceVars, useReducedMotion, useRoomAmbience } from "@/ambience/use-ambience";
import type { AmbienceMotionPreference } from "@/stores/settings";
import { useI18n } from "vue-i18n";
import BasicControls from "./BasicControls.vue";
import ClosedCaptionsSwitcher from "./ClosedCaptionsSwitcher.vue";
import LayoutSwitcher from "./LayoutSwitcher.vue";
import TimestampDisplay from "./TimestampDisplay.vue";
import VideoProgressSlider from "./VideoProgressSlider.vue";
import VolumeControl from "./VolumeControl.vue";
import PlaybackRateSwitcher from "./PlaybackRateSwitcher.vue";
import VideoSettings from "./VideoSettings.vue";
import PictureInPictureButton from "./PictureInPictureButton.vue";

/** Moves the floating player by a pixel offset. */
type MoveBy = (dx: number, dy: number) => void;

const props = withDefaults(
	defineProps<{
		sliderPosition: number;
		truePosition: number;
		collapsed?: boolean;
		docked?: boolean;
		toggleCollapsed?: () => void;
		moveBy?: MoveBy;
		resetPosition?: () => void;
	}>(),
	{
		collapsed: false,
		docked: false,
		toggleCollapsed: undefined,
		moveBy: undefined,
		resetPosition: undefined,
	},
);

const MOTION_OPTIONS: AmbienceMotionPreference[] = ["auto", "on", "off"];

const store = useStore();
const { t } = useI18n();
const musicRoom = useMusicRoom();
const { ambience, cover } = useRoomAmbience();
const vars = computed(() => ambienceVars(ambience.value));
const ambienceNumber = computed(() => String(ambience.value.number).padStart(2, "0"));
const reducedMotion = useReducedMotion();
const motionPreference = computed(() => store.state.settings.ambienceMotion ?? "auto");
function setMotion(option: AmbienceMotionPreference) {
	store.commit("settings/UPDATE", { ambienceMotion: option });
}

const source = computed(() => store.state.room.currentSource);
const musicCurrent = computed(() => store.state.room.music?.current);

const title = computed(() => source.value?.title || musicCurrent.value?.title || "");
const SERVICE_NAMES: Record<string, string> = {
	youtube: "YouTube",
	vimeo: "Vimeo",
	googledrive: "Google Drive",
	peertube: "PeerTube",
	pluto: "Pluto TV",
	direct: "",
	hls: "",
	dash: "",
};
const subtitle = computed(() => {
	const artists = musicCurrent.value?.artists?.filter(Boolean) ?? [];
	if (artists.length) {
		return artists.join(", ");
	}
	const service = source.value?.service;
	return service ? SERVICE_NAMES[service] ?? service : "";
});

function participantName(id: string | undefined): string | undefined {
	if (!id || !musicRoom) {
		return undefined;
	}
	return (
		musicRoom.state.value?.participants.find(p => p.participantId === id)?.name ??
		musicRoom.participantNames.get(id)
	);
}
const broughtBy = computed(() => {
	const id = musicCurrent.value?.contributorId ?? source.value?.contributorId;
	const name = participantName(id);
	if (name) {
		return name;
	}
	return id ? store.state.users.users.get(id)?.name : undefined;
});

const roomTitle = computed(() =>
	store.state.room.title !== ""
		? store.state.room.title
		: store.state.room.isTemporary
		? t("room.title-temp")
		: store.state.room.name,
);
const listeners = computed(() => store.state.users.users.size);
const roomLine = computed(() =>
	[
		roomTitle.value,
		listeners.value > 0
			? t("player-widget.together", { count: listeners.value }, listeners.value)
			: "",
	]
		.filter(Boolean)
		.join(" · "),
);
function hue(text: string): number {
	let h = 0;
	for (let i = 0; i < text.length; i++) {
		h = (h * 31 + text.charCodeAt(i)) % 360;
	}
	return h;
}
const avatars = computed(() =>
	Array.from(store.state.users.users.values())
		.slice(0, 4)
		.map(user => ({
			id: user.id,
			initial: (user.name || "?").trim().charAt(0).toUpperCase() || "?",
			color: `oklch(0.84 0.07 ${hue(user.id)})`,
		})),
);

const upNext = computed(() => {
	const music = store.state.room.music;
	if (music) {
		return (music.queue ?? []).slice(0, 2).map(entry => ({
			key: entry.entryId,
			title: entry.title,
			cover: entry.artworkUrl ?? null,
			detail: [
				(entry.artists ?? []).filter(Boolean).join(", "),
				participantName(entry.contributorId),
			]
				.filter(Boolean)
				.join(" · "),
		}));
	}
	return (store.state.room.queue ?? []).slice(0, 2).map((item, index) => ({
		key: `${item.service}:${item.id}:${index}`,
		title: item.title,
		cover: coverUrl(item),
		detail: SERVICE_NAMES[item.service] ?? item.service,
	}));
});

const progress = computed(() => {
	const length = source.value?.length;
	return length && length > 0 ? Math.min(1, Math.max(0, props.truePosition / length)) : 0;
});
const footer = computed(() => {
	const name = t(`ambience.names.${ambience.value.id}`);
	if (!source.value) {
		return name;
	}
	return `${name} · ${t(
		store.state.room.isPlaying ? "player-widget.synced" : "player-widget.paused-for-room",
	)}`;
});

const coverFailed = ref(false);
watch(cover, () => {
	coverFailed.value = false;
});

/* Secondary panels: one at a time, inline in the widget so they follow it anywhere. */
const panel = ref<"moods" | "more" | null>(null);
const moodsId = useId();
const moreId = useId();
const moodsTrigger = ref<HTMLButtonElement>();
const moreTrigger = ref<HTMLButtonElement>();
const moodsHeading = ref<HTMLElement>();
const moreHeading = ref<HTMLElement>();
async function toggle(which: "moods" | "more") {
	panel.value = panel.value === which ? null : which;
	if (panel.value) {
		if (props.collapsed) {
			props.toggleCollapsed?.();
		}
		await nextTick();
		(panel.value === "moods" ? moodsHeading : moreHeading).value?.focus();
	}
}
async function close() {
	const was = panel.value;
	panel.value = null;
	await nextTick();
	(was === "moods" ? moodsTrigger : moreTrigger).value?.focus();
}
watch([() => store.state.room.name, () => store.state.user], () => {
	panel.value = null;
});
watch(musicCurrent, current => {
	if (!current && panel.value === "moods") {
		panel.value = null;
	}
});
watch(
	() => props.collapsed,
	collapsed => {
		if (collapsed) {
			panel.value = null;
		}
	},
);

function onMoveKey(event: KeyboardEvent) {
	const step = event.shiftKey ? 64 : 16;
	const moves: Record<string, [number, number]> = {
		ArrowLeft: [-step, 0],
		ArrowRight: [step, 0],
		ArrowUp: [0, -step],
		ArrowDown: [0, step],
	};
	if (moves[event.key]) {
		event.preventDefault();
		props.moveBy?.(...moves[event.key]);
	} else if (event.key === "Home") {
		event.preventDefault();
		props.resetPosition?.();
	}
}
</script>

<style scoped>
/* The widget is always a dark surface in its ambience, whatever the page theme. Local shadcn
 * tokens make the reused controls (slider, buttons, inputs) speak the same palette. */
.ut-widget {
	--primary: var(--ut-acc);
	--primary-foreground: var(--ut-on);
	--foreground: var(--ut-ink);
	--muted-foreground: var(--ut-mu);
	--border: var(--ut-line);
	--input: var(--ut-line);
	--ring: var(--ut-ink);
	--accent: var(--ut-tint);
	--accent-foreground: var(--ut-ink);
	--signal: var(--ut-ink2);
	--background: color-mix(in srgb, var(--ut-bg0) 92%, var(--ut-ink));
	--popover: color-mix(in srgb, var(--ut-bg1) 94%, var(--ut-ink));
	--popover-foreground: var(--ut-ink);
	--card: color-mix(in srgb, var(--ut-ink) 6%, transparent);
	--card-foreground: var(--ut-ink);
	--secondary: var(--ut-glass);
	--secondary-foreground: var(--ut-ink);
	--muted: var(--ut-glass);
	position: relative;
	isolation: isolate;
	overflow: hidden;
	color: var(--ut-ink);
	color-scheme: dark;
	font-family: var(--ut-f-text);
	font-size: 13px;
	line-height: 1.4;
	background: linear-gradient(170deg, var(--ut-bg0), var(--ut-bg1));
	border: 1px solid var(--ut-line);
	border-radius: 22px;
	box-shadow: 0 26px 50px -26px var(--ut-shadow), 0 2px 10px -4px rgb(0 0 0 / 0.4);
	-webkit-font-smoothing: antialiased;
}
.ut-widget[data-docked="true"] {
	border-radius: 0;
	border-inline: 0;
	border-bottom: 0;
}
.w-grid {
	position: relative;
	z-index: 1;
}
.ut-widget :focus-visible {
	outline: 2px solid var(--ut-ink);
	outline-offset: 2px;
}
.w-ic {
	width: 17px;
	height: 17px;
}

/* Header: brand left, window-ish tools right (Windows convention). */
.w-head {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 12px 12px 0 16px;
	cursor: grab;
}
.w-lockup {
	display: inline-flex;
	align-items: center;
	gap: 7px;
	color: var(--ut-ink);
	font: 350 15.5px/1 var(--ut-f-display);
	letter-spacing: 0.01em;
}
.w-lockup :deep(.ut-logo) {
	color: var(--ut-acc);
}
.w-tools {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	margin-left: auto;
}
.w-round {
	display: inline-grid;
	place-items: center;
	width: 32px;
	height: 32px;
	flex: none;
	border-radius: 50%;
	border: 1px solid var(--ut-line);
	background: var(--ut-glassx);
	color: var(--ut-ink);
	cursor: pointer;
	transition: background-color 0.18s, transform 0.08s;
}
.w-round[aria-expanded="true"]:not(.w-fold) {
	background: var(--ut-ink);
	color: var(--ut-bg0);
	border-color: transparent;
}
.w-move {
	cursor: grab;
}
.w-round:active {
	transform: scale(0.95);
}
@media (hover: hover) {
	.w-round:hover:not([aria-expanded="true"]) {
		background: var(--ut-glass);
	}
}

.w-room {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 14px 20px 0;
	font-size: 12px;
	color: var(--ut-ink2);
	min-width: 0;
}
.w-avatars {
	display: inline-flex;
	margin-left: auto;
}
.w-avatars i {
	display: inline-grid;
	place-items: center;
	width: 18px;
	height: 18px;
	border-radius: 50%;
	font: 600 9.5px/1 var(--ut-f-text);
	font-style: normal;
	color: #1b1630;
	box-shadow: 0 0 0 1.5px var(--ut-bg0);
}
.w-avatars i + i {
	margin-left: -5px;
}

/* The ambience name sits in the free "sky": that's where the mood is read. */
.w-mood {
	min-height: 64px;
	display: flex;
	align-items: flex-end;
	gap: 8px;
	padding: 0 20px 10px;
	font: italic 400 19px/1.1 var(--ut-f-voice);
	color: var(--ut-ink2);
}
.w-mood small {
	white-space: nowrap;
	font: 400 11.5px/1 var(--ut-f-text);
	color: var(--ut-mu);
}

/* A small cover keeps the animated background visible behind the whole widget. */
.w-hero {
	display: grid;
	grid-template-columns: 88px minmax(0, 1fr);
	gap: 16px;
	align-items: end;
	padding: 0 20px;
}
.w-cover {
	display: block;
	width: 88px;
	aspect-ratio: 1;
	overflow: hidden;
	border-radius: 14px;
	background: var(--ut-glass);
	box-shadow: 0 16px 30px -14px var(--ut-shadow);
	outline: 1px solid var(--ut-line);
	outline-offset: -1px;
}
.w-cover img {
	display: block;
	width: 100%;
	height: 100%;
	object-fit: cover;
}
.w-cover-empty {
	display: grid;
	place-items: center;
	width: 100%;
	height: 100%;
	color: var(--ut-acc);
	background: radial-gradient(80% 70% at 30% 20%, var(--ut-tint), transparent);
}
.w-meta {
	min-width: 0;
}
.w-title {
	font: 300 28px/1.06 var(--ut-f-display);
	letter-spacing: -0.03em;
	text-transform: none;
	overflow-wrap: anywhere;
	display: -webkit-box;
	-webkit-line-clamp: 3;
	-webkit-box-orient: vertical;
	overflow: hidden;
	margin: 0;
}
.w-title[data-long="true"] {
	font-size: 21px;
	font-weight: 350;
	letter-spacing: -0.02em;
}
.w-artist {
	margin-top: 3px;
	font: 400 14.5px/1.3 var(--ut-f-display);
	color: var(--ut-ink2);
}
.w-by {
	margin-top: 5px;
	font: italic 400 14px/1.3 var(--ut-f-voice);
	color: var(--ut-ink2);
}

.w-body {
	padding: 14px 20px 0;
}
.w-prog {
	min-width: 0;
}
.w-tp {
	display: grid;
	grid-template-columns: 1fr auto 1fr;
	align-items: center;
	margin-top: 2px;
}
.w-vol {
	min-width: 0;
}
.w-vol :deep(.volume) {
	width: 64px;
}
.w-vol :deep(input[type="range"]) {
	accent-color: var(--ut-ink2);
}
.w-time {
	justify-self: end;
	color: var(--ut-mu);
	font-family: var(--ut-f-text);
	font-size: 12px;
}
.w-transport {
	gap: 6px;
}
.w-transport :deep(.media-control) {
	color: var(--ut-ink2);
	border-radius: 50%;
}
/* The one big target: play/pause in the accent. */
.w-transport :deep([data-cy="playback-toggle"]) {
	width: 52px;
	height: 52px;
	background: var(--ut-acc);
	color: var(--ut-on);
}
.w-transport :deep([data-cy="playback-toggle"] svg) {
	width: 24px;
	height: 24px;
}
@media (hover: hover) {
	.w-transport :deep([data-cy="playback-toggle"]:hover:not(:disabled)) {
		background: var(--ut-acc);
		box-shadow: 0 0 0 5px var(--ut-tint);
	}
}

.w-panel,
.w-next {
	margin-top: 14px;
}
.w-panel {
	display: grid;
	gap: 10px;
	max-height: min(42vh, 340px);
	overflow-y: auto;
	overscroll-behavior: contain;
	padding: 12px;
	border-radius: 14px;
	background: var(--ut-glassx);
	border: 1px solid var(--ut-line);
}
.w-panel-head {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: 10px;
}
.w-panel-head :is(h2, h3) {
	margin: 0;
	font: 600 12.5px/1.3 var(--ut-f-text);
	letter-spacing: 0;
	text-transform: none;
	color: var(--ut-ink);
}
.w-hint {
	font-size: 11.5px;
	color: var(--ut-mu);
}
.w-motion {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 6px 10px;
}
.w-seg {
	display: inline-flex;
	border: 1px solid var(--ut-line);
	border-radius: 99px;
	overflow: hidden;
}
.w-seg button {
	padding: 4px 11px;
	color: var(--ut-ink2);
	cursor: pointer;
}
.w-seg button + button {
	border-left: 1px solid var(--ut-line);
}
.w-seg button[aria-pressed="true"] {
	background: var(--ut-tint);
	color: var(--ut-ink);
	font-weight: 600;
}
.w-next ul {
	margin: 8px 0 0;
	padding: 0;
	list-style: none;
}
.w-next li {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 6px 0;
}
.w-next li + li {
	border-top: 1px solid var(--ut-line);
}
.w-thumb {
	display: block;
	width: 34px;
	height: 34px;
	flex: none;
	overflow: hidden;
	border-radius: 8px;
	background: linear-gradient(160deg, var(--ut-tint), transparent);
}
.w-thumb img {
	width: 100%;
	height: 100%;
	object-fit: cover;
}
.w-next-text {
	min-width: 0;
	flex: 1;
}
.w-next-text b,
.w-next-text small {
	display: block;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.w-next-text b {
	font-weight: 500;
	font-size: 13.5px;
}
.w-next-text small {
	font-size: 12px;
	color: var(--ut-mu);
}
.w-foot {
	padding: 12px 20px 13px;
	text-align: center;
	font-size: 11.5px;
	color: var(--ut-mu);
}
.w-hair {
	display: none;
}

/* ---------------------------------------------------------------------------
 *  Folded: one row (logo, cover, title, transport, unfold) and a hairline progress.
 *  The same transport stays mounted; wrappers dissolve into a single grid row.
 * ------------------------------------------------------------------------ */
.ut-widget[data-collapsed="true"] .w-grid {
	display: grid;
	grid-template-columns: auto auto minmax(0, 1fr) auto auto;
	align-items: center;
	gap: 10px;
	padding: 10px 12px 12px;
}
.ut-widget[data-collapsed="true"] :is(.w-head, .w-hero, .w-body, .w-tp) {
	display: contents;
}
.ut-widget[data-collapsed="true"]
	:is(
		.w-room,
		.w-mood,
		.w-prog,
		.w-vol,
		.w-time,
		.w-panel,
		.w-next,
		.w-foot,
		.w-wordmark,
		.w-by
	) {
	display: none;
}
.ut-widget[data-collapsed="true"] .w-tools > :not(.w-fold) {
	display: none;
}
.ut-widget[data-collapsed="true"] .w-lockup {
	order: 1;
}
.ut-widget[data-collapsed="true"] .w-cover {
	order: 2;
	width: 44px;
	border-radius: 10px;
}
.ut-widget[data-collapsed="true"] .w-meta {
	order: 3;
}
.ut-widget[data-collapsed="true"] .w-title {
	font: 400 16px/1.2 var(--ut-f-display);
	letter-spacing: -0.01em;
	-webkit-line-clamp: 1;
}
.ut-widget[data-collapsed="true"] .w-artist {
	font-size: 12px;
	margin: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	color: var(--ut-mu);
}
.ut-widget[data-collapsed="true"] .w-transport {
	order: 4;
	gap: 0;
}
.ut-widget[data-collapsed="true"] .w-transport :deep([data-cy="playback-previous"]) {
	display: none;
}
.ut-widget[data-collapsed="true"] .w-transport :deep([data-cy="playback-toggle"]) {
	width: 40px;
	height: 40px;
}
.ut-widget[data-collapsed="true"] .w-transport :deep([data-cy="playback-toggle"] svg) {
	width: 19px;
	height: 19px;
}
.ut-widget[data-collapsed="true"] .w-tools {
	order: 5;
	margin: 0;
}
.ut-widget[data-collapsed="true"] .w-hair {
	display: block;
	position: absolute;
	left: 0;
	right: 0;
	bottom: 0;
	height: 2px;
	background: var(--ut-line);
}
.w-hair i {
	display: block;
	height: 100%;
	background: var(--ut-acc);
	transform-origin: 0 50%;
	transition: transform 0.95s linear;
}
/* A docked bar (fullscreen video) is folded and spans the width. */
.ut-widget[data-docked="true"] .w-grid {
	padding-inline: max(12px, env(safe-area-inset-left));
}

@container (max-width: 370px) {
	.w-hero {
		grid-template-columns: 76px minmax(0, 1fr);
		gap: 13px;
	}
	.w-cover {
		width: 76px;
	}
}
@media (max-width: 380px) {
	.w-body,
	.w-hero,
	.w-room,
	.w-mood,
	.w-foot {
		padding-left: 16px;
		padding-right: 16px;
	}
	.w-vol :deep(.volume) {
		width: 44px;
	}
}
@media (prefers-reduced-motion: reduce) {
	.w-hair i {
		transition: none;
	}
	.w-round:active {
		transform: none;
	}
}
</style>
