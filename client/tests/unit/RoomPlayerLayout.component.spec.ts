import { afterEach, describe, expect, it, vi } from "vitest";
import { h, nextTick } from "vue";
import RoomPlayerLayout from "@/components/RoomPlayerLayout.vue";
import { Theme } from "@/stores/settings";
import { buildNewStore } from "@/store";
import { mountComponent } from "./component-test-utils";

function pointer(type: string, x: number, y: number) {
	const event = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0 });
	Object.defineProperty(event, "pointerId", { value: 1 });
	Object.defineProperty(event, "isPrimary", { value: true });
	return event;
}

function stubViewport() {
	let resize: () => void = () => undefined;
	const disconnect = vi.fn();
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(callback: () => void) {
				resize = callback;
			}
			observe() {
				return undefined;
			}
			disconnect = disconnect;
		},
	);
	const viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0 });
	vi.stubGlobal("visualViewport", viewport);
	vi.stubGlobal("innerHeight", 800);
	vi.stubGlobal("innerWidth", 1200);
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		callback(0);
		return 0;
	});
	return { viewport, disconnect, resize: () => resize() };
}

function mountLayout(props: Record<string, unknown> = {}) {
	// Settings module state outlives a store: start every case from the default corner.
	buildNewStore().commit("settings/UPDATE", { playerWidget: null, theme: Theme.dark });
	const result = mountComponent(RoomPlayerLayout, {
		props,
		slots: {
			default: () => h("p", "Last queue row"),
			player: (w: { collapsed: boolean; docked: boolean }) =>
				h(
					"div",
					{
						"class": "widget-body",
						"data-collapsed": String(w.collapsed),
						"data-docked": String(w.docked),
					},
					["Now playing", h("button", "Transport")],
				),
		},
	});
	const dock = result.wrapper.get('[data-cy="room-player-dock"]');
	vi.spyOn(dock.element, "getBoundingClientRect").mockReturnValue({
		width: 400,
		height: 200,
	} as DOMRect);
	return { ...result, dock };
}

describe("RoomPlayerLayout", () => {
	afterEach(() => {
		// Placement is remembered in settings; each case starts from the default corner.
		localStorage.removeItem("settings");
		vi.unstubAllGlobals();
		document.documentElement.style.removeProperty("--room-player-height");
	});

	it("floats over the page, follows the keyboard viewport and cleans up global state", async () => {
		const { viewport, disconnect, resize } = stubViewport();
		const removeListener = vi.spyOn(viewport, "removeEventListener");
		const style = document.documentElement.style;
		style.setProperty("--room-player-height", "42px");
		const { wrapper, unmount } = mountLayout();
		resize();
		// A floating player overlays the page: dialogs need not reserve any height for it.
		expect(style.getPropertyValue("--room-player-height")).toBe("0px");
		expect(style.getPropertyValue("--room-player-bottom")).toBe("0px");
		viewport.height = 400;
		viewport.offsetTop = 20;
		viewport.dispatchEvent(new Event("resize"));
		expect(style.getPropertyValue("--room-player-bottom")).toBe("380px");
		expect(style.getPropertyValue("--room-viewport-height")).toBe("400px");
		expect(style.getPropertyValue("--room-viewport-top")).toBe("20px");
		expect(wrapper.text()).toContain("Last queue row");
		unmount();
		await nextTick();
		expect(disconnect).toHaveBeenCalledOnce();
		expect(removeListener).toHaveBeenCalledWith("resize", expect.any(Function));
		expect(removeListener).toHaveBeenCalledWith("scroll", expect.any(Function));
		expect(document.documentElement.classList.contains("room-player-active")).toBe(false);
		expect(style.getPropertyValue("--room-player-height")).toBe("42px");
		expect(style.getPropertyValue("--room-player-bottom")).toBe("");
	});

	it("docks as a folded bar that reserves its height during fullscreen video", async () => {
		const { resize } = stubViewport();
		const { wrapper, dock } = mountLayout({ fullscreen: true });
		resize();
		expect(document.documentElement.style.getPropertyValue("--room-player-height")).toBe(
			"200px",
		);
		expect(dock.attributes("data-docked")).toBe("true");
		expect(wrapper.get(".widget-body").attributes("data-collapsed")).toBe("true");
		expect(dock.attributes("style") ?? "").not.toContain("translate3d");
	});

	it("takes the page into the playing ambience in dark themes only", async () => {
		stubViewport();
		const root = document.documentElement;
		const { store, unmount } = mountLayout();
		await nextTick();
		expect(root.classList.contains("ut-ambient")).toBe(true);
		expect(root.dataset.ambience).toBe("heure-bleue");
		expect(root.style.getPropertyValue("--ut-bg0")).toBe("#0f1226");
		expect(document.querySelector('[data-cy="room-ambience-backdrop"] .ut-sky')).not.toBeNull();
		store.commit("settings/UPDATE", { theme: Theme.light });
		await nextTick();
		expect(root.classList.contains("ut-ambient")).toBe(false);
		expect(document.querySelector('[data-cy="room-ambience-backdrop"]')).toBeNull();
		store.commit("settings/UPDATE", { theme: Theme.dark });
		await nextTick();
		expect(root.classList.contains("ut-ambient")).toBe(true);
		unmount();
		expect(root.classList.contains("ut-ambient")).toBe(false);
		expect(root.style.getPropertyValue("--ut-bg0")).toBe("");
	});

	it("drags from any non-control area and remembers the nearest corner", async () => {
		const { resize } = stubViewport();
		const { wrapper, dock, store } = mountLayout();
		resize();
		await nextTick();
		// Default: bottom-right, 16px from the edges of a 1200×800 viewport.
		expect(dock.attributes("style")).toContain("translate3d(784px, 584px, 0)");

		// Pressing a control never starts a drag.
		wrapper.get("button").element.dispatchEvent(pointer("pointerdown", 900, 650));
		window.dispatchEvent(pointer("pointermove", 300, 100));
		window.dispatchEvent(pointer("pointerup", 300, 100));
		await nextTick();
		expect(dock.attributes("style")).toContain("translate3d(784px, 584px, 0)");

		wrapper.get(".widget-body").element.dispatchEvent(pointer("pointerdown", 900, 650));
		window.dispatchEvent(pointer("pointermove", 902, 651));
		await nextTick();
		expect(wrapper.find(".room-player-drag-shield").exists()).toBe(false);
		window.dispatchEvent(pointer("pointermove", 200, 150));
		await nextTick();
		expect(wrapper.find(".room-player-drag-shield").exists()).toBe(true);
		expect(dock.attributes("style")).toContain("translate3d(84px, 84px, 0)");
		window.dispatchEvent(pointer("pointerup", 200, 150));
		await nextTick();
		expect(wrapper.find(".room-player-drag-shield").exists()).toBe(false);
		expect(store.state.settings.playerWidget).toMatchObject({
			horizontal: "start",
			vertical: "top",
			dx: 84,
			dy: 84,
		});

		// Never dragged outside the viewport.
		wrapper.get(".widget-body").element.dispatchEvent(pointer("pointerdown", 100, 100));
		window.dispatchEvent(pointer("pointermove", -900, -900));
		window.dispatchEvent(pointer("pointerup", -900, -900));
		await nextTick();
		expect(dock.attributes("style")).toContain("translate3d(8px, 8px, 0)");
	});

	it("moves off an element it must not cover, like a visible YouTube player", async () => {
		const { resize } = stubViewport();
		const video = document.createElement("div");
		video.dataset.cy = "room-video-surface";
		document.body.appendChild(video);
		vi.spyOn(video, "getBoundingClientRect").mockReturnValue({
			left: 0,
			top: 0,
			right: 900,
			bottom: 520,
			width: 900,
			height: 520,
		} as DOMRect);
		const { wrapper, dock } = mountLayout({ avoidSelector: '[data-cy="room-video-surface"]' });
		resize();
		wrapper.get(".widget-body").element.dispatchEvent(pointer("pointerdown", 900, 650));
		window.dispatchEvent(pointer("pointermove", 400, 300));
		window.dispatchEvent(pointer("pointerup", 400, 300));
		await nextTick();
		// Dropped over the player at (284, 234): the closest free spot is just below it.
		expect(dock.attributes("style")).toContain("translate3d(284px, 528px, 0)");
	});
});
