<template>
	<div ref="sky" class="ut-sky" aria-hidden="true" :data-running="running">
		<div
			v-for="scene in scenes"
			:key="scene.key"
			class="ut-scene"
			:class="`ut-m-${scene.motion}`"
			:data-phase="scene.phase"
			:data-ambience="scene.id"
			:style="scene.style"
		>
			<i v-for="layer in scene.layers" :key="layer" :class="layer" />
		</div>
	</div>
</template>

<script setup lang="ts">
import { nextTick, onUnmounted, ref, shallowRef, watch } from "vue";
import { getAmbience, type AmbienceId, type AmbienceMotion } from "ott-common/ambience";
import { useVisibleMotion } from "@/ambience/use-ambience";

const props = withDefaults(defineProps<{ ambience: AmbienceId; active?: boolean }>(), {
	active: true,
});

/** Layers per motion, and which of them are plain radial glows of g1/g2/g3. */
const LAYERS: Record<AmbienceMotion, [count: number, glows: Record<number, 1 | 2 | 3>]> = {
	drift: [3, { 1: 1, 2: 3, 3: 2 }],
	rise: [3, { 1: 1, 2: 2, 3: 3 }],
	sway: [4, { 4: 3 }],
	ripple: [4, { 4: 3 }],
	orbit: [2, {}],
	breathe: [3, { 1: 1, 2: 2, 3: 3 }],
	curtain: [5, { 5: 2 }],
	pendulum: [3, { 1: 1, 2: 2, 3: 3 }],
	aurora: [3, { 3: 3 }],
	halo: [2, { 2: 1 }],
	call: [3, { 1: 1, 2: 2, 3: 3 }],
	sweep: [3, { 3: 2 }],
};

interface Scene {
	key: number;
	id: AmbienceId;
	motion: AmbienceMotion;
	layers: string[];
	style: Record<string, string>;
	phase: "enter" | "shown" | "leave";
}

const sky = ref<HTMLElement>();
const running = useVisibleMotion(sky, () => props.active);
const scenes = shallowRef<Scene[]>([]);
let counter = 0;
const timers = new Set<ReturnType<typeof setTimeout>>();

function build(id: AmbienceId, phase: Scene["phase"]): Scene {
	const ambience = getAmbience(id);
	const [count, glows] = LAYERS[ambience.motion];
	const layers = Array.from({ length: count }, (_, i) =>
		glows[i + 1] ? `l${i + 1} ut-rg${glows[i + 1]}` : `l${i + 1}`,
	);
	const [g1, g2, g3] = ambience.palette.glows;
	return {
		key: ++counter,
		id: ambience.id,
		motion: ambience.motion,
		layers,
		style: { "--g1": g1, "--g2": g2, "--g3": g3 },
		phase,
	};
}

// One scene at a time: the new one fades in over the old, which is then removed.
watch(
	() => props.ambience,
	async id => {
		if (scenes.value.length && scenes.value[scenes.value.length - 1].id === id) {
			return;
		}
		const first = scenes.value.length === 0;
		const next = build(id, first ? "shown" : "enter");
		const leaving = scenes.value
			.filter(scene => scene.phase !== "leave")
			.map(scene => ({ ...scene, phase: "leave" as const }));
		scenes.value = [...scenes.value.filter(scene => scene.phase === "leave"), ...leaving, next];
		if (first) {
			return;
		}
		await nextTick();
		requestAnimationFrame(() =>
			requestAnimationFrame(() => {
				scenes.value = scenes.value.map(scene =>
					scene.key === next.key ? { ...scene, phase: "shown" } : scene,
				);
			}),
		);
		const timer = setTimeout(() => {
			timers.delete(timer);
			const gone = new Set(leaving.map(scene => scene.key));
			scenes.value = scenes.value.filter(scene => !gone.has(scene.key));
		}, 950);
		timers.add(timer);
	},
	{ immediate: true },
);

onUnmounted(() => {
	for (const timer of timers) {
		clearTimeout(timer);
	}
});

defineExpose({ running });
</script>
