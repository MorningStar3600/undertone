<template>
	<div class="room-player-layout" :data-docked="docked">
		<slot />
		<div
			ref="dock"
			class="room-player-dock ut-palette"
			:class="{ 'is-placed': !!position, 'is-dragging': dragging }"
			:style="dockStyle"
			:data-docked="docked"
			data-cy="room-player-dock"
			@pointerdown="onPointerDown"
		>
			<slot
				name="player"
				:collapsed="collapsed"
				:docked="docked"
				:ambience="ambience"
				:toggle-collapsed="toggleCollapsed"
				:move-by="moveBy"
				:reset-position="resetPosition"
			/>
		</div>
		<!-- Keeps pointer events away from iframes (the YouTube player) while dragging. -->
		<div v-if="dragging" class="room-player-drag-shield" />
		<Teleport to="body">
			<div v-if="ambient" class="ut-backdrop" data-cy="room-ambience-backdrop">
				<AmbienceSky :ambience="ambience.id" :active="!fullscreen" />
			</div>
		</Teleport>
	</div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import AmbienceSky from "@/components/ambience/AmbienceSky.vue";
import { ambienceVars, useRoomAmbience } from "@/ambience/use-ambience";
import { useStore } from "@/store";
import { Theme, type PlayerWidgetPlacement } from "@/stores/settings";

const props = defineProps<{
	fullscreen?: boolean;
	/** Element the floating player must not cover, e.g. a visible YouTube player. */
	avoidSelector?: string;
}>();

const MARGIN = 8;
const DRAG_THRESHOLD = 4;
const LIGHT_THEMES = new Set<string>([Theme.light, Theme.strawberry]);

const store = useStore();
const { ambience } = useRoomAmbience();
const dock = ref<HTMLElement>();

// Fullscreen video leaves no free space to float in: the player docks as a bar below it.
const docked = computed(() => !!props.fullscreen);

/* ---------------------------------------------------------------------------
 *  Ambient page: the room takes the color of the playing cover (dark themes).
 * ------------------------------------------------------------------------ */
const ambient = computed(() => !LIGHT_THEMES.has(store.state.settings.theme));
const vars = computed(() => ambienceVars(ambience.value));
const AMBIENT_CLASSES = ["ut-ambient", "ut-palette"];
function paintDocument() {
	const root = document.documentElement;
	if (ambient.value) {
		root.classList.add(...AMBIENT_CLASSES);
		root.dataset.ambience = ambience.value.id;
		for (const [name, value] of Object.entries(vars.value)) {
			root.style.setProperty(name, value);
		}
	} else {
		clearDocument();
	}
}
function clearDocument() {
	const root = document.documentElement;
	root.classList.remove(...AMBIENT_CLASSES);
	delete root.dataset.ambience;
	for (const name of Object.keys(vars.value)) {
		root.style.removeProperty(name);
	}
}
watch([ambient, vars], paintDocument);

const dockStyle = computed(() => ({
	...vars.value,
	...(position.value && !docked.value
		? { transform: `translate3d(${position.value.left}px, ${position.value.top}px, 0)` }
		: {}),
}));

/* ---------------------------------------------------------------------------
 *  Floating placement
 * ------------------------------------------------------------------------ */
function defaultPlacement(): PlayerWidgetPlacement {
	return {
		horizontal: "end",
		vertical: "bottom",
		dx: 16,
		dy: 16,
		collapsed: window.innerWidth < 640,
	};
}
function validPlacement(value: unknown): value is PlayerWidgetPlacement {
	const p = value as PlayerWidgetPlacement | null;
	return (
		!!p &&
		(p.horizontal === "start" || p.horizontal === "end") &&
		(p.vertical === "top" || p.vertical === "bottom") &&
		Number.isFinite(p.dx) &&
		Number.isFinite(p.dy) &&
		typeof p.collapsed === "boolean"
	);
}
const placement = computed<PlayerWidgetPlacement>(() => {
	const saved = store.state.settings.playerWidget;
	return validPlacement(saved) ? saved : defaultPlacement();
});
const collapsed = computed(() => docked.value || placement.value.collapsed);
function savePlacement(next: PlayerWidgetPlacement) {
	store.commit("settings/UPDATE", { playerWidget: next });
}
function toggleCollapsed() {
	if (!docked.value) {
		savePlacement({ ...placement.value, collapsed: !placement.value.collapsed });
	}
}

const position = ref<{ left: number; top: number } | null>(null);
const viewport = () => ({
	width: document.documentElement.clientWidth || window.innerWidth,
	height: window.visualViewport?.height ?? window.innerHeight,
});
function size() {
	const rect = dock.value?.getBoundingClientRect();
	return { width: rect?.width ?? 0, height: rect?.height ?? 0 };
}
function clamp(left: number, top: number) {
	const { width, height } = size();
	const view = viewport();
	return {
		left: Math.round(
			Math.min(Math.max(MARGIN, left), Math.max(MARGIN, view.width - width - MARGIN)),
		),
		top: Math.round(
			Math.min(Math.max(MARGIN, top), Math.max(MARGIN, view.height - height - MARGIN)),
		),
	};
}
function fromPlacement(p: PlayerWidgetPlacement) {
	const { width, height } = size();
	const view = viewport();
	return clamp(
		p.horizontal === "start" ? p.dx : view.width - width - p.dx,
		p.vertical === "top" ? p.dy : view.height - height - p.dy,
	);
}
function toPlacement(left: number, top: number): PlayerWidgetPlacement {
	const { width, height } = size();
	const view = viewport();
	const horizontal = left + width / 2 < view.width / 2 ? "start" : "end";
	const vertical = top + height / 2 < view.height / 2 ? "top" : "bottom";
	return {
		horizontal,
		vertical,
		dx: Math.round(horizontal === "start" ? left : view.width - width - left),
		dy: Math.round(vertical === "top" ? top : view.height - height - top),
		collapsed: placement.value.collapsed,
	};
}

function overlaps(
	a: DOMRect | { left: number; top: number; right: number; bottom: number },
	b: DOMRect,
) {
	return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}
/** Moves the player off the element it must not cover, by the shortest distance. */
function avoid(at: { left: number; top: number }) {
	const target = props.avoidSelector ? document.querySelector(props.avoidSelector) : null;
	const forbidden = target?.getBoundingClientRect();
	const { width, height } = size();
	const box = (p: { left: number; top: number }) => ({
		left: p.left,
		top: p.top,
		right: p.left + width,
		bottom: p.top + height,
	});
	if (!forbidden || forbidden.width === 0 || !overlaps(box(at), forbidden)) {
		return at;
	}
	const candidates = [
		clamp(forbidden.left - width - MARGIN, at.top),
		clamp(forbidden.right + MARGIN, at.top),
		clamp(at.left, forbidden.top - height - MARGIN),
		clamp(at.left, forbidden.bottom + MARGIN),
	].filter(candidate => !overlaps(box(candidate), forbidden));
	if (candidates.length === 0) {
		return at;
	}
	const distance = (p: { left: number; top: number }) =>
		Math.hypot(p.left - at.left, p.top - at.top);
	return candidates.reduce((best, candidate) =>
		distance(candidate) < distance(best) ? candidate : best,
	);
}

function place() {
	if (!dock.value || docked.value) {
		return;
	}
	position.value = avoid(fromPlacement(placement.value));
}

function moveBy(dx: number, dy: number) {
	if (docked.value) {
		return;
	}
	const from = position.value ?? fromPlacement(placement.value);
	const next = clamp(from.left + dx, from.top + dy);
	position.value = next;
	savePlacement(toPlacement(next.left, next.top));
}
function resetPosition() {
	savePlacement({ ...defaultPlacement(), collapsed: placement.value.collapsed });
}

/* ---------------------------------------------------------------------------
 *  Dragging from anywhere that is not a control
 * ------------------------------------------------------------------------ */
const INTERACTIVE =
	'button, a, input, select, textarea, label, [role="slider"], [role="button"], [contenteditable="true"], [data-no-drag]';
const dragging = ref(false);
let drag: { id: number; x: number; y: number; left: number; top: number } | null = null;

function onPointerDown(event: PointerEvent) {
	if (docked.value || event.button !== 0 || event.isPrimary === false) {
		return;
	}
	const target = event.target as Element | null;
	if (target?.closest(INTERACTIVE)) {
		return;
	}
	const from = position.value ?? fromPlacement(placement.value);
	drag = { id: event.pointerId, x: event.clientX, y: event.clientY, ...from };
	window.addEventListener("pointermove", onPointerMove);
	window.addEventListener("pointerup", onPointerUp);
	window.addEventListener("pointercancel", onPointerUp);
}
function onPointerMove(event: PointerEvent) {
	if (!drag || event.pointerId !== drag.id) {
		return;
	}
	const dx = event.clientX - drag.x;
	const dy = event.clientY - drag.y;
	if (!dragging.value) {
		if (Math.hypot(dx, dy) < DRAG_THRESHOLD) {
			return;
		}
		dragging.value = true;
		try {
			dock.value?.setPointerCapture?.(drag.id);
		} catch {
			// The shield still keeps the drag alive over iframes.
		}
	}
	event.preventDefault();
	position.value = clamp(drag.left + dx, drag.top + dy);
}
function onPointerUp(event: PointerEvent) {
	if (!drag || event.pointerId !== drag.id) {
		return;
	}
	window.removeEventListener("pointermove", onPointerMove);
	window.removeEventListener("pointerup", onPointerUp);
	window.removeEventListener("pointercancel", onPointerUp);
	const wasDragging = dragging.value;
	drag = null;
	dragging.value = false;
	if (wasDragging && position.value) {
		const settled = avoid(position.value);
		position.value = settled;
		savePlacement(toPlacement(settled.left, settled.top));
	}
}

/* ---------------------------------------------------------------------------
 *  Measurements shared with dialogs and popovers
 * ------------------------------------------------------------------------ */
let observer: ResizeObserver | undefined;
const properties = [
	"--room-player-height",
	"--room-player-bottom",
	"--room-viewport-height",
	"--room-viewport-top",
];
const previous = new Map<string, string>();

function measure() {
	const view = window.visualViewport;
	const style = document.documentElement.style;
	// Only a docked bar takes space from the page; the floating player overlays it.
	style.setProperty(
		"--room-player-height",
		`${docked.value ? dock.value?.getBoundingClientRect().height ?? 0 : 0}px`,
	);
	// The visual viewport shrinks when the software keyboard opens, even on browsers
	// whose layout viewport (and fixed positioning) still extends behind the keyboard.
	style.setProperty(
		"--room-player-bottom",
		`${Math.max(
			0,
			window.innerHeight - (view?.height ?? window.innerHeight) - (view?.offsetTop ?? 0),
		)}px`,
	);
	style.setProperty("--room-viewport-height", `${view?.height ?? window.innerHeight}px`);
	style.setProperty("--room-viewport-top", `${view?.offsetTop ?? 0}px`);
	place();
}

watch([placement, docked, () => props.avoidSelector], () => requestAnimationFrame(measure), {
	flush: "post",
});

onMounted(() => {
	for (const property of properties) {
		previous.set(property, document.documentElement.style.getPropertyValue(property));
	}
	document.documentElement.classList.add("room-player-active");
	paintDocument();
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
	window.removeEventListener("pointermove", onPointerMove);
	window.removeEventListener("pointerup", onPointerUp);
	window.removeEventListener("pointercancel", onPointerUp);
	document.documentElement.classList.remove("room-player-active");
	clearDocument();
	for (const property of properties) {
		const value = previous.get(property);
		if (value) {
			document.documentElement.style.setProperty(property, value);
		} else {
			document.documentElement.style.removeProperty(property);
		}
	}
});

defineExpose({ moveBy, resetPosition, toggleCollapsed });
</script>

<style scoped>
.room-player-layout {
	min-width: 0;
	/* The floating player keeps a little room at the end of the page so the last rows can be
	 * scrolled out from under it; a docked bar reserves its measured height. */
	padding-bottom: 6rem;
}
.room-player-layout[data-docked="true"] {
	padding-bottom: calc(var(--room-player-height, 72px) + var(--room-player-bottom, 0px));
}
.room-player-dock {
	position: fixed;
	z-index: 40;
	right: 16px;
	bottom: calc(16px + var(--room-player-bottom, 0px));
	width: min(400px, calc(100vw - 16px));
	border-radius: 22px;
	touch-action: none;
}
.room-player-dock.is-placed {
	left: 0;
	top: 0;
	right: auto;
	bottom: auto;
}
.room-player-dock.is-dragging {
	cursor: grabbing;
	user-select: none;
}
.room-player-dock[data-docked="true"] {
	inset-inline: 0;
	top: auto;
	left: 0;
	right: 0;
	bottom: var(--room-player-bottom, 0px);
	width: auto;
	transform: none;
	border-radius: 0;
	padding-inline: env(safe-area-inset-left, 0px) env(safe-area-inset-right, 0px);
	padding-bottom: env(safe-area-inset-bottom, 0px);
}
.room-player-drag-shield {
	position: fixed;
	inset: 0;
	z-index: 39;
	cursor: grabbing;
}
/* Portalled room dialogs also reserve a docked bar's measured height. Modal semantics
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
