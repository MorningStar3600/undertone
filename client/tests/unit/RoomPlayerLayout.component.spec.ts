import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import RoomPlayerLayout from "@/components/RoomPlayerLayout.vue";

describe("RoomPlayerLayout", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("reserves the measured dock, follows the keyboard viewport and cleans up global state", () => {
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
		const removeListener = vi.spyOn(viewport, "removeEventListener");
		const style = document.documentElement.style;
		style.setProperty("--room-player-height", "42px");
		const wrapper = mount(RoomPlayerLayout, {
			slots: { default: "<p>Last queue row</p>", player: "<button>Transport</button>" },
		});
		vi.spyOn(
			wrapper.get('[data-cy="room-player-dock"]').element,
			"getBoundingClientRect",
		).mockReturnValue({ height: 144 } as DOMRect);
		resize();
		expect(style.getPropertyValue("--room-player-height")).toBe("144px");
		expect(style.getPropertyValue("--room-player-bottom")).toBe("0px");
		viewport.height = 400;
		viewport.offsetTop = 20;
		viewport.dispatchEvent(new Event("resize"));
		expect(style.getPropertyValue("--room-player-bottom")).toBe("380px");
		expect(style.getPropertyValue("--room-viewport-height")).toBe("400px");
		expect(style.getPropertyValue("--room-viewport-top")).toBe("20px");
		expect(wrapper.text()).toContain("Last queue row");
		wrapper.unmount();
		expect(disconnect).toHaveBeenCalledOnce();
		expect(removeListener).toHaveBeenCalledWith("resize", expect.any(Function));
		expect(removeListener).toHaveBeenCalledWith("scroll", expect.any(Function));
		expect(document.documentElement.classList.contains("room-player-active")).toBe(false);
		expect(style.getPropertyValue("--room-player-height")).toBe("42px");
		expect(style.getPropertyValue("--room-player-bottom")).toBe("");
		style.removeProperty("--room-player-height");
	});
});
