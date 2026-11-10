<template>
	<div ref="rootElem" data-cy="youtube-player">
		<DebugPlayerWatcher v-if="isDev" :data="debugData" />
		<div ref="containerElem" class="youtube"></div>
	</div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import DebugPlayerWatcher from "@/components/debug/DebugPlayerWatcher.vue";
import { getSdk } from "@/util/playerHelper.js";
import toast from "@/util/toast";
import { ToastStyle } from "@/models/toast";
import type { CaptionTrack } from "@/models/media-tracks";
import { useCaptions } from "../composables";
import type { MediaPlayerError } from "../composables/media-player";
import { PlaybackDeferredError } from "@/playback/playback-controller";

const YOUTUBE_IFRAME_API_URL = "https://www.youtube.com/iframe_api";

const YOUTUBE_STATUS_UNSTARTED = -1;
const YOUTUBE_STATUS_ENDED = 0;
const YOUTUBE_STATUS_PLAYING = 1;
const YOUTUBE_STATUS_PAUSED = 2;
const YOUTUBE_STATUS_BUFFERING = 3;
const YOUTUBE_STATUS_CUED = 5;

type YoutubeStatus =
	| typeof YOUTUBE_STATUS_UNSTARTED
	| typeof YOUTUBE_STATUS_ENDED
	| typeof YOUTUBE_STATUS_PLAYING
	| typeof YOUTUBE_STATUS_PAUSED
	| typeof YOUTUBE_STATUS_BUFFERING
	| typeof YOUTUBE_STATUS_CUED;

interface YoutubeSdk {
	Player: new (
		element: HTMLElement,
		options: {
			events: {
				onApiChange: () => void;
				onReady: () => void;
				onStateChange: (event: YoutubeStateChangeEvent) => void;
				onError: (event: { data: number }) => void;
				onPlaybackRateChange: () => void;
				onAutoplayBlocked: () => void;
			};
			playerVars: Record<string, number>;
		},
	) => YoutubePlayerApi;
}

interface YoutubeStateChangeEvent {
	data: YoutubeStatus;
}

interface YoutubeCaptionTrack {
	languageCode: string;
	languageName?: string;
}

interface YoutubePlayerApi {
	destroy?: () => void;
	playVideo: () => void;
	pauseVideo: () => void;
	getCurrentTime: () => number;
	seekTo: (position: number) => void;
	setVolume: (volume: number) => void;
	getVolume: () => number;
	isMuted: () => boolean;
	unMute: () => void;
	loadModule: (module: string) => void;
	unloadModule: (module: string) => void;
	getOptions: () => string[];
	getOption: (module: "captions", option: "tracklist") => YoutubeCaptionTrack[] | undefined;
	setOption: (module: "captions", option: "reload", value: boolean) => void;
	setOption: (module: "captions", option: "fontSize", value: number) => void;
	setOption: (module: "captions", option: "track", value: YoutubeCaptionTrack) => void;
	getAvailablePlaybackRates: () => number[];
	getPlaybackRate: () => number;
	setPlaybackRate: (rate: number) => void;
	loadVideoById: (videoId: string) => void;
	cueVideoById: (videoId: string) => void;
	getVideoLoadedFraction: () => number;
	setSize: (width: string, height: string) => void;
}

interface Props {
	videoId: string;
	/** When true, show YouTube's native control bar. Volume/mute changes made through it are
	 * forwarded as user-* events; playback (play/pause/seek/rate) stays OTT-controlled. */
	nativeControls?: boolean;
	silent?: boolean;
}

const NATIVE_POLL_INTERVAL_MS = 250;

/**
 * Component that manages youtube's iframe player (and all of the woes that come with it), and provides the common OTT player interface.
 *
 * When the broswser has blocked autoplay videos (firefox):
 * - Youtube player state: UNSTARTED
 * - Youtube player state: BUFFERING
 * - Youtube player state: UNSTARTED
 * - At this point, the user must interact with the video manually in order to play the video.
 */

defineOptions({ name: "YoutubePlayer" });

const props = defineProps<Props>();
const emit = defineEmits<{
	"apiready": [];
	"ended": [];
	"playing": [];
	"paused": [];
	"buffering": [];
	"ready": [];
	"error": [error: MediaPlayerError];
	"buffer-progress": [progress: number];
	/** The user changed volume using YouTube's native control bar (nativeControls mode only). */
	"user-volume-change": [volume: number];
	/** The user toggled mute using YouTube's native control bar (nativeControls mode only). */
	"user-mute-change": [muted: boolean];
	/** YouTube's own playback rate changed, possibly via its native control bar (nativeControls
	 * mode only). Playback rate stays OTT-controlled, so the caller is expected to correct this
	 * back to the room's rate. */
	"native-rate-change": [rate: number];
}>();

const isDev = import.meta.env.DEV;
const captions = useCaptions();
const rootElem = ref<HTMLElement>();
const containerElem = ref<HTMLElement>();
const player = ref<YoutubePlayerApi | null>(null);
const resizeObserver = ref<ResizeObserver | null>(null);
const youtubeState = ref<YoutubeStatus | null>(null);
const queuedSeek = ref<number | null>(null);
const queuedPlaying = ref<boolean | null>(null);
const queuedVolume = ref<number | null>(null);
// Tracks the last caption setting applied to YouTube, not a pending request.
const captionsEnabled = ref(false);
const isApiReady = ref(false);
let disposed = false;
let pendingPlay: { resolve(): void; reject(error: unknown): void; cleanup(): void } | null = null;
let requestedPlaying: boolean | null = null;
let playTimeout: ReturnType<typeof setTimeout> | undefined;
function settlePlay(error?: unknown) {
	clearTimeout(playTimeout);
	const pending = pendingPlay;
	pendingPlay = null;
	pending?.cleanup();
	if (error) {
		pending?.reject(error);
	} else {
		pending?.resolve();
	}
}
function onAutoplayBlocked() {
	settlePlay(new DOMException("Autoplay blocked", "NotAllowedError"));
}
const isCaptionsLoaded = ref(false);

// YouTube's IFrame API has no volume/mute change events, so native volume/mute control has to
// be polled. Volume/mute are the only bits of native input that get forwarded (see the module
// docblock for why) — comparing against the *last observed* value, rather than modeling our own
// intent, is enough to avoid an echo: a readback of our own setVolume() equals what we already
// observed and emits nothing.
const nativePollInterval = ref<ReturnType<typeof setInterval> | null>(null);
const lastObservedVolume = ref<number | null>(null);
const lastObservedMuted = ref<boolean | null>(null);

const debugData = computed(() => ({
	YoutubeState: youtubeState.value,
	queuedSeek: queuedSeek.value,
	queuedPlaying: queuedPlaying.value,
	isCaptionsEnabled: isCaptionsEnabled(),
	isCaptionsLoaded: isCaptionsLoaded.value,
}));

onMounted(async () => {
	const YT = (await getSdk(
		YOUTUBE_IFRAME_API_URL,
		"YT",
		"onYouTubeIframeAPIReady",
	)) as YoutubeSdk;

	if (disposed) {
		return;
	}
	if (!player.value && containerElem.value) {
		player.value = new YT.Player(containerElem.value, {
			events: {
				onApiChange,
				onReady,
				onStateChange,
				onError,
				onPlaybackRateChange,
				onAutoplayBlocked,
			},
			playerVars: {
				autoplay: 0,
				enablejsapi: 1,
				controls: props.nativeControls ? 1 : 0,
				// native keyboard shortcuts are kept disabled to avoid double-handling with OTT's
				// own keyboard shortcuts; native mouse control bar is what we want, not native keyboard.
				disablekb: 1,
				// OTT has its own fullscreen handling; the native fullscreen button would bypass it.
				fs: 0,
				// required for iOS
				playsinline: 1,
			},
		});
	}

	if (rootElem.value) {
		resizeObserver.value = new ResizeObserver(fitToContainer);
		resizeObserver.value.observe(rootElem.value);
	}

	fitToContainer();

	if (props.nativeControls) {
		nativePollInterval.value = setInterval(pollNativeVolume, NATIVE_POLL_INTERVAL_MS);
	}
});

function dispose() {
	if (disposed) {
		return;
	}
	disposed = true;
	settlePlay(new DOMException("Player disposed", "AbortError"));
	resizeObserver.value?.disconnect();
	resizeObserver.value = null;
	if (nativePollInterval.value) {
		clearInterval(nativePollInterval.value);
		nativePollInterval.value = null;
	}
	player.value?.destroy?.();
	player.value = null;
	isApiReady.value = false;
}
onBeforeUnmount(dispose);

watch(
	() => props.videoId,
	videoId => {
		if (!player.value) {
			return;
		}
		emit("buffering");
		isCaptionsLoaded.value = false;
		captionsEnabled.value = false;
		if (props.silent) {
			player.value.cueVideoById(videoId);
		} else {
			player.value.loadVideoById(videoId);
		}
		// the new video can reset volume/mute; don't mistake that for user input. The next
		// pollNativeVolume() re-baselines from whatever the player reports.
		lastObservedVolume.value = null;
		lastObservedMuted.value = null;
	},
);

function play(signal?: AbortSignal): Promise<void> {
	if (disposed || signal?.aborted) {
		return Promise.reject(new DOMException("Play cancelled", "AbortError"));
	}
	requestedPlaying = true;
	if (!player.value) {
		queuedPlaying.value = true;
		return Promise.resolve();
	}
	if (!props.silent) {
		player.value.playVideo();
		return Promise.resolve();
	}
	return new Promise<void>((resolve, reject) => {
		settlePlay();
		const cancel = () => pause();
		pendingPlay = {
			resolve,
			reject,
			cleanup: () => signal?.removeEventListener("abort", cancel),
		};
		signal?.addEventListener("abort", cancel, { once: true });
		playTimeout = setTimeout(() => {
			// Hidden iframes can defer PLAYING without rejecting autoplay. Bound the command
			// and cancel its late effects, but reserve NotAllowedError for the SDK policy event.
			requestedPlaying = false;
			settlePlay(new PlaybackDeferredError("YouTube play timeout"));
			player.value?.pauseVideo();
		}, 4_000);
		player.value!.playVideo();
	});
}

function pause(): void {
	requestedPlaying = false;
	settlePlay(new DOMException("Play cancelled by pause", "AbortError"));
	if (!player.value) {
		queuedPlaying.value = false;
		return;
	}
	player.value.pauseVideo();
}

function getPosition(): number {
	if (!player.value) {
		return 0;
	}
	return player.value.getCurrentTime();
}

function setPosition(position: number): void {
	if (!player.value) {
		queuedSeek.value = position;
		return;
	}
	player.value.seekTo(position);
}

function setVolume(volume: number): void {
	if (!player.value) {
		queuedVolume.value = volume;
		return;
	}
	player.value.setVolume(volume);
	// OTT models mute as volume 0, but YouTube keeps a separate muted flag; without this,
	// setting volume back up after a native mute would leave the video silent.
	if (volume > 0) {
		player.value.unMute();
	}
	lastObservedVolume.value = Math.round(volume);
	lastObservedMuted.value = player.value.isMuted();
}

function isCaptionsSupported(): boolean {
	return true;
}

function isCaptionsEnabled(): boolean {
	return captionsEnabled.value;
}

function setCaptionsEnabled(value: boolean): void {
	if (!player.value || !isApiReady.value) {
		return;
	}
	if (value) {
		loadCaptionsIfNeeded();
		player.value.loadModule("captions");
		player.value.setOption("captions", "fontSize", 0);
	} else if (player.value.getOptions().includes("captions")) {
		// Unloading emits onApiChange; skip the unload when its callback reports no module.
		player.value.unloadModule("captions");
	}
	captionsEnabled.value = value;
}

function getRawCaptionsTracks(): YoutubeCaptionTrack[] {
	return player.value?.getOption("captions", "tracklist") ?? [];
}

function getCaptionsTracks(): CaptionTrack[] {
	return getRawCaptionsTracks().map(track => ({
		kind: "captions",
		label: track.languageName,
		srclang: track.languageCode,
	}));
}

function setCaptionsTrack(track: number): void {
	if (!player.value) {
		return;
	}
	loadCaptionsIfNeeded();
	const tracklist = getRawCaptionsTracks();
	console.debug("youtube: found tracks:", tracklist);
	const selectedTrack = tracklist[track];
	if (selectedTrack) {
		player.value.setOption("captions", "track", selectedTrack);
	} else {
		toast.add({
			content: `Unknown captions track ${track}`,
			style: ToastStyle.Error,
			duration: 4000,
		});
	}
}

function isQualitySupported(): boolean {
	return false;
}

function getAvailablePlaybackRates(): number[] {
	if (!player.value) {
		return [1];
	}
	return player.value.getAvailablePlaybackRates();
}

function getPlaybackRate(): number {
	if (!player.value) {
		return 1;
	}
	return player.value.getPlaybackRate();
}

function setPlaybackRate(rate: number): void {
	if (!player.value) {
		return;
	}
	player.value.setPlaybackRate(rate);
}

function onApiChange(): void {
	console.debug("youtube: onApiChange");
	captions.captionsTracks.value = getCaptionsTracks();
	restoreCaptionsPreference();
}

function restoreCaptionsPreference(): void {
	// Always enforce off; apply on once per video to avoid reloading the module on every event.
	if (!captions.isCaptionsEnabled.value || !captionsEnabled.value) {
		setCaptionsEnabled(captions.isCaptionsEnabled.value);
	}
}

function onReady(): void {
	if (!player.value) {
		return;
	}
	isApiReady.value = true;
	emit("apiready");
	// cueVideoById (not loadVideoById) so a fresh/remounted player doesn't start playing from 0
	// before the room's actual position and play state have been applied. See onStateChange's
	// CUED handling below, and Room.vue's onPlayerReady, which re-applies both once this settles.
	player.value.cueVideoById(props.videoId);
	setCaptionsEnabled(captions.isCaptionsEnabled.value);
}

function onStateChange(event: YoutubeStateChangeEvent): void {
	if (!player.value) {
		return;
	}
	youtubeState.value = event.data;
	// A late PLAYING callback from an aborted attempt cannot undo newer pause intent.
	if (props.silent && requestedPlaying === false && event.data === YOUTUBE_STATUS_PLAYING) {
		player.value.pauseVideo();
		return;
	}
	if (event.data === YOUTUBE_STATUS_PLAYING) {
		settlePlay();
	}
	if (event.data === YOUTUBE_STATUS_ENDED) {
		emit("ended");
	} else if (event.data === YOUTUBE_STATUS_PLAYING) {
		emit("playing");
	} else if (event.data === YOUTUBE_STATUS_PAUSED) {
		emit("paused");
	} else if (event.data === YOUTUBE_STATUS_BUFFERING) {
		emit("buffering");
	} else if (event.data === YOUTUBE_STATUS_CUED) {
		emit("ready");
	}

	if (
		event.data === YOUTUBE_STATUS_PLAYING ||
		event.data === YOUTUBE_STATUS_PAUSED ||
		event.data === YOUTUBE_STATUS_CUED
	) {
		// HACK: YouTube can restore captions after playback or seeking without onApiChange.
		restoreCaptionsPreference();
		if (queuedSeek.value !== null) {
			player.value.seekTo(queuedSeek.value);
			queuedSeek.value = null;
		}
		if (queuedPlaying.value !== null) {
			if (queuedPlaying.value) {
				player.value.playVideo();
			} else {
				player.value.pauseVideo();
			}
			queuedPlaying.value = null;
		}
		if (queuedVolume.value !== null) {
			player.value.setVolume(queuedVolume.value);
			queuedVolume.value = null;
		}
	}

	emit("buffer-progress", player.value.getVideoLoadedFraction());
}

function onError(event: { data: number }): void {
	if (disposed) {
		return;
	}
	// Keep provider details out of the UI; OmniPlayer localizes these categories.
	let type: MediaPlayerError["type"] = "unknown";
	switch (event.data) {
		case 100:
			type = "youtube-unavailable";
			break;
		case 101:
		case 150:
			type = "youtube-embed-disabled";
			break;
		case 153:
			type = "youtube-embed-identity";
			break;
		default:
			break;
	}
	// A provider failure must not later become an autoplay-blocked timeout.
	settlePlay(new Error("YouTube playback failed"));
	emit("error", { type });
}

/**
 * YouTube fires this for both programmatic and native-control rate changes (e.g. picking a
 * speed from the native bar's menu). Playback rate stays OTT-controlled, so this just reports
 * the new rate; the caller is expected to override it back to the room's rate if they differ.
 */
function onPlaybackRateChange(): void {
	if (!props.nativeControls || !player.value) {
		return;
	}
	emit("native-rate-change", player.value.getPlaybackRate());
}

/**
 * YouTube's IFrame API has no volume/mute change events, so native volume/mute control (the
 * one bit of native input that stays synced both ways) has to be polled.
 */
function pollNativeVolume(): void {
	if (!props.nativeControls || !player.value) {
		return;
	}
	const volume = Math.round(player.value.getVolume());
	const muted = player.value.isMuted();
	if (lastObservedVolume.value !== null && volume !== lastObservedVolume.value) {
		emit("user-volume-change", volume);
	}
	if (lastObservedMuted.value !== null && muted !== lastObservedMuted.value) {
		emit("user-mute-change", muted);
	}
	lastObservedVolume.value = volume;
	lastObservedMuted.value = muted;
}

function fitToContainer(): void {
	if (!player.value) {
		return;
	}
	player.value.setSize("100%", "100%");
}

function loadCaptionsIfNeeded(): void {
	if (!player.value || isCaptionsLoaded.value) {
		return;
	}
	player.value.setOption("captions", "reload", true);
	isCaptionsLoaded.value = true;
}

defineExpose({
	dispose,
	play,
	pause,
	getPosition,
	setPosition,
	setVolume,
	isCaptionsSupported,
	isCaptionsEnabled,
	setCaptionsEnabled,
	getCaptionsTracks,
	setCaptionsTrack,
	isQualitySupported,
	getAvailablePlaybackRates,
	getPlaybackRate,
	setPlaybackRate,
});
</script>
