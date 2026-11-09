<template>
	<div class="room-player-layout" :data-fullscreen="fullscreen">
		<slot />
		<div ref="dock" class="room-player-dock border-t bg-background" data-cy="room-player-dock">
			<slot name="player" />
		</div>
	</div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";

defineProps<{ fullscreen?: boolean }>();
const dock = ref<HTMLElement>();
let observer: ResizeObserver | undefined;
const properties = [
	"--room-player-height",
	"--room-player-bottom",
	"--room-viewport-height",
	"--room-viewport-top",
];
const previous = new Map<string, string>();

function measure() {
	const viewport = window.visualViewport;
	const style = document.documentElement.style;
	style.setProperty(
		"--room-player-height",
		`${dock.value?.getBoundingClientRect().height ?? 0}px`,
	);
	// The visual viewport shrinks when the software keyboard opens, even on browsers
	// whose layout viewport (and fixed positioning) still extends behind the keyboard.
	style.setProperty(
		"--room-player-bottom",
		`${Math.max(
			0,
			window.innerHeight -
				(viewport?.height ?? window.innerHeight) -
				(viewport?.offsetTop ?? 0),
		)}px`,
	);
	style.setProperty("--room-viewport-height", `${viewport?.height ?? window.innerHeight}px`);
	style.setProperty("--room-viewport-top", `${viewport?.offsetTop ?? 0}px`);
}

onMounted(() => {
	for (const property of properties) {
		previous.set(property, document.documentElement.style.getPropertyValue(property));
	}
	document.documentElement.classList.add("room-player-active");
	observer = new ResizeObserver(measure);
	if (dock.value) {
		observer.observe(dock.value);
	}
	window.addEventListener("resize", measure);
	window.visualViewport?.addEventListener("resize", measure);
	window.visualViewport?.addEventListener("scroll", measure);
	measure();
});

onUnmounted(() => {
	observer?.disconnect();
	window.removeEventListener("resize", measure);
	window.visualViewport?.removeEventListener("resize", measure);
	window.visualViewport?.removeEventListener("scroll", measure);
	document.documentElement.classList.remove("room-player-active");
	for (const property of properties) {
		const value = previous.get(property);
		if (value) {
			document.documentElement.style.setProperty(property, value);
		} else {
			document.documentElement.style.removeProperty(property);
		}
	}
});
</script>

<style scoped>
.room-player-layout {
	min-width: 0;
	/* 160px is an initial mobile allowance until ResizeObserver measures the dock. */
	padding-bottom: calc(var(--room-player-height, 160px) + var(--room-player-bottom, 0px));
}
.room-player-dock {
	position: fixed;
	inset-inline: 0;
	bottom: var(--room-player-bottom, 0px);
	z-index: 40;
	padding-inline: env(safe-area-inset-left, 0px) env(safe-area-inset-right, 0px);
	padding-bottom: env(safe-area-inset-bottom, 0px);
}
@media (max-height: 500px) {
	/* Leave room for the visible source in landscape and above a software keyboard. */
	.room-player-layout[data-fullscreen="true"] :deep(.video-controls) {
		padding-block: 0.25rem;
		row-gap: 0;
	}
	.room-player-layout[data-fullscreen="true"] :deep(.player-metadata img),
	.room-player-layout[data-fullscreen="true"] :deep(.player-metadata p + p) {
		display: none;
	}
	.room-player-layout[data-fullscreen="true"] :deep(#videoSlider) {
		margin-block: 4px;
	}
}
/* Portalled room dialogs also reserve the dock's measured height. Modal semantics
 * stay intact; the player-owned secondary panels are nonmodal and keep it usable. */
:global(html.room-player-active [data-slot="dialog-content"]) {
	max-height: max(0px, calc(var(--room-viewport-height) - var(--room-player-height) - 2rem));
	top: calc(
		var(--room-viewport-top) + (var(--room-viewport-height) - var(--room-player-height)) / 2
	);
	overflow-y: auto;
}
:global(html.room-player-active [data-slot="popover-content"]) {
	max-height: max(0px, calc(var(--room-viewport-height) - var(--room-player-height) - 1rem));
	overflow-y: auto;
}
</style>
