<template>
	<iframe
		ref="containerElem"
		:title="$t('player.peertube-player')"
		class="peertube"
		id="peertube-player"
		:src="peertubeUrl"
	></iframe>
</template>

<script lang="ts">
import { computed, defineComponent, onMounted, onBeforeUnmount, ref } from "vue";
import { PeerTubePlayer as Peertube } from "@peertube/embed-api";

// CURRENTLY SOMEWHAT BROKEN
// does not respect position syncing for some reason.

// biome-ignore lint/style/noVueOptionsApi: TODO: convert to setup
const PeertubePlayer = defineComponent({
	name: "PeertubePlayer",
	props: {
		videoId: { type: String, required: true },
	},
	emits: ["playing", "paused", "ready", "apiready", "error"],
	setup(props, { emit }) {
		let player: Peertube | undefined;
		let supportedRates: number[] = [1];
		const containerElem = ref<HTMLIFrameElement>();
		let disposed = false;
		function dispose() {
			disposed = true;
			const captured = player;
			player = undefined;
			captured?.removeEventListener("playbackStatusChange", onPlaybackStatusChange);
			captured?.destroy();
			// embed-api 0.0.6 destroy only removes the iframe; also release its jschannel registry.
			(
				captured as unknown as { channel?: { destroy(): void } } | undefined
			)?.channel?.destroy();
			containerElem.value?.remove();
		}
		onBeforeUnmount(dispose);

		const videoId = computed(() => props.videoId.split(":"));
		const peertubeHost = computed(() => videoId.value[0]);
		const peertubeId = computed(() => videoId.value[1]);
		const peertubeUrl = computed(
			() => `https://${peertubeHost.value}/videos/embed/${peertubeId.value}?controls=0&api=1`,
		);

		onMounted(async () => {
			const container = containerElem.value;
			if (!container) {
				return;
			}

			const captured = new Peertube(container);
			player = captured;
			try {
				await captured.ready;
				if (disposed) {
					return;
				}
				const rates = await captured.getPlaybackRates();
				if (disposed) {
					return;
				}
				supportedRates = Array.isArray(rates)
					? rates.filter(rate => typeof rate === "number" && Number.isFinite(rate))
					: [];
				captured.addEventListener("playbackStatusChange", onPlaybackStatusChange);
				emit("apiready");
				emit("ready");
			} catch {
				if (!disposed) {
					emit("error");
				}
			}
		});

		function onPlaybackStatusChange(status: "playing" | "paused") {
			if (status === "playing") {
				emit("playing");
			} else if (status === "paused") {
				emit("paused");
			}
		}

		async function play(): Promise<void> {
			if (!player) {
				return;
			}
			return await player.play();
		}
		async function pause(): Promise<void> {
			if (!player) {
				return;
			}
			return await player.pause();
		}
		async function getPosition(): Promise<number> {
			if (!player) {
				return 0;
			}
			return player.getCurrentPosition();
		}
		function setPosition(position: number) {
			if (!player) {
				return;
			}
			return player.seek(position);
		}
		function setVolume(value: number) {
			if (!player) {
				return;
			}
			return player.setVolume(value / 100);
		}
		function isCaptionsSupported(): boolean {
			return false;
		}

		function isQualitySupported(): boolean {
			return false;
		}

		function getAvailablePlaybackRates(): number[] {
			return [...supportedRates];
		}

		async function getPlaybackRate(): Promise<number> {
			return (await player?.getPlaybackRate()) ?? 1;
		}

		async function setPlaybackRate(rate: number): Promise<void> {
			await player?.setPlaybackRate(rate);
		}

		return {
			containerElem,
			dispose,
			peertubeUrl,

			play,
			pause,
			getPosition,
			setPosition,
			setVolume,
			isCaptionsSupported,
			isQualitySupported,
			getAvailablePlaybackRates,
			getPlaybackRate,
			setPlaybackRate,
		};
	},
});

// biome-ignore lint/style/noVueOptionsApi: TODO: convert to setup
export default PeertubePlayer;
</script>
