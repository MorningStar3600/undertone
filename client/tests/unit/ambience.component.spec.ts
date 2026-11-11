import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import AmbienceSky from "@/components/ambience/AmbienceSky.vue";
import VideoControls from "@/components/controls/VideoControls.vue";
import {
	ambienceForCover,
	coverUrl,
	knownAmbience,
	resetCoverAmbiences,
} from "@/ambience/cover-ambience";
import { buildNewStore } from "@/store";
import { mountComponent } from "./component-test-utils";

describe("undertone ambiences", () => {
	let reduced = false;
	let intersect: (entries: { isIntersecting: boolean }[]) => void = () => undefined;

	beforeEach(() => {
		reduced = false;
		buildNewStore().commit("settings/UPDATE", { ambienceMotion: "auto", playerWidget: null });
		vi.stubGlobal(
			"matchMedia",
			vi.fn(() => ({
				get matches() {
					return reduced;
				},
				addEventListener: () => undefined,
				removeEventListener: () => undefined,
			})),
		);
		vi.stubGlobal(
			"IntersectionObserver",
			class {
				constructor(callback: typeof intersect) {
					intersect = callback;
				}
				observe() {
					return undefined;
				}
				unobserve() {
					return undefined;
				}
				disconnect() {
					return undefined;
				}
			},
		);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
		resetCoverAmbiences();
	});

	function setVisibility(state: "visible" | "hidden") {
		Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
		document.dispatchEvent(new Event("visibilitychange"));
	}

	describe("ambience sky", () => {
		it("animates only while visible, on screen and allowed", async () => {
			const { wrapper, store } = mountComponent(AmbienceSky, { props: { ambience: "jade" } });
			await nextTick();
			const sky = () => wrapper.get(".ut-sky").attributes("data-running");
			expect(sky()).toBe("true");
			expect(wrapper.findAll(".ut-scene i")).toHaveLength(3);
			expect(wrapper.get(".ut-scene").classes()).toContain("ut-m-aurora");

			setVisibility("hidden");
			await nextTick();
			expect(sky()).toBe("false");
			setVisibility("visible");
			await nextTick();
			expect(sky()).toBe("true");

			// Off-screen is trusted only once the sky has been seen.
			intersect([{ isIntersecting: false }]);
			await nextTick();
			expect(sky()).toBe("true");
			intersect([{ isIntersecting: true }]);
			intersect([{ isIntersecting: false }]);
			await nextTick();
			expect(sky()).toBe("false");
			intersect([{ isIntersecting: true }]);
			await nextTick();
			expect(sky()).toBe("true");

			store.commit("settings/UPDATE", { ambienceMotion: "off" });
			await nextTick();
			expect(sky()).toBe("false");
			await wrapper.setProps({ active: false });
			store.commit("settings/UPDATE", { ambienceMotion: "on" });
			await nextTick();
			expect(sky()).toBe("false");
			await wrapper.setProps({ active: true });
			await nextTick();
			expect(sky()).toBe("true");
		});

		it("stays still under reduced motion unless the listener forces it", async () => {
			reduced = true;
			const { wrapper, store } = mountComponent(AmbienceSky, {
				props: { ambience: "braise" },
			});
			await nextTick();
			expect(wrapper.get(".ut-sky").attributes("data-running")).toBe("false");
			store.commit("settings/UPDATE", { ambienceMotion: "on" });
			await nextTick();
			expect(wrapper.get(".ut-sky").attributes("data-running")).toBe("true");
		});

		it("cross-fades to the next ambience and then drops the old scene", async () => {
			vi.useFakeTimers();
			vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
				setTimeout(() => callback(0), 16),
			);
			const { wrapper } = mountComponent(AmbienceSky, { props: { ambience: "lagune" } });
			await nextTick();
			await wrapper.setProps({ ambience: "grenat" });
			await nextTick();
			const scenes = () => wrapper.findAll(".ut-scene");
			expect(scenes().map(scene => scene.attributes("data-phase"))).toEqual([
				"leave",
				"enter",
			]);
			await vi.advanceTimersByTimeAsync(40);
			expect(scenes().map(scene => scene.attributes("data-phase"))).toEqual([
				"leave",
				"shown",
			]);
			await vi.advanceTimersByTimeAsync(1000);
			expect(scenes()).toHaveLength(1);
			expect(scenes()[0].attributes("data-ambience")).toBe("grenat");
			expect(scenes()[0].findAll("i")).toHaveLength(5);
		});
	});

	describe("cover ambience", () => {
		it("normalizes YouTube covers and keeps other thumbnails", () => {
			expect(coverUrl({ service: "youtube", id: "dQw4w9WgXcQ", thumbnail: "x" })).toBe(
				"https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg",
			);
			expect(coverUrl({ service: "youtube", id: "../evil", thumbnail: "t.jpg" })).toBe(
				"t.jpg",
			);
			expect(coverUrl({ service: "direct", id: "a", thumbnail: "c.jpg" })).toBe("c.jpg");
			expect(coverUrl({ service: "direct", id: "a" })).toBeNull();
			expect(coverUrl(null)).toBeNull();
		});

		it("samples a cover once, crops letterbox bars and falls back on failure", async () => {
			const drawImage = vi.fn();
			const getImageData = vi.fn(() => ({
				data: new Uint8ClampedArray(32 * 32 * 4).map((_, i) => [214, 40, 40, 255][i % 4]),
			}));
			vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
				drawImage,
				getImageData,
			} as unknown as CanvasRenderingContext2D);
			const loads: string[] = [];
			vi.stubGlobal(
				"Image",
				class {
					crossOrigin = "";
					decoding = "";
					naturalWidth = 480;
					naturalHeight = 360;
					onload: () => void = () => undefined;
					onerror: () => void = () => undefined;
					set src(url: string) {
						loads.push(url);
						setTimeout(() => (url.includes("broken") ? this.onerror() : this.onload()));
					}
				},
			);
			const [first, second] = await Promise.all([
				ambienceForCover("https://i.ytimg.com/vi/abcdefgh/mqdefault.jpg"),
				ambienceForCover("https://i.ytimg.com/vi/abcdefgh/mqdefault.jpg"),
			]);
			expect(first).toBe("grenat");
			expect(second).toBe("grenat");
			expect(loads).toHaveLength(1);
			// 480×360 has bars: only the central 480×270 band is read.
			expect(drawImage).toHaveBeenCalledWith(
				expect.anything(),
				0,
				45,
				480,
				270,
				0,
				0,
				32,
				32,
			);
			expect(knownAmbience("https://i.ytimg.com/vi/abcdefgh/mqdefault.jpg")).toBe("grenat");
			expect(await ambienceForCover("https://example.com/broken.jpg")).toBe("heure-bleue");
			expect(await ambienceForCover(null)).toBe("heure-bleue");
		});
	});

	describe("player widget", () => {
		it("shows the ambience, folds into one row and moves from the keyboard", async () => {
			const toggleCollapsed = vi.fn();
			const moveBy = vi.fn();
			const resetPosition = vi.fn();
			const { wrapper, store } = mountComponent(VideoControls, {
				props: {
					sliderPosition: 10,
					truePosition: 10,
					toggleCollapsed,
					moveBy,
					resetPosition,
				},
			});
			store.commit("room/SYNC", {
				currentSource: { service: "direct", id: "x", title: "Afterglow", length: 100 },
			});
			await nextTick();
			expect(wrapper.get('[data-cy="player-ambience"]').text()).toContain("Blue hour");
			expect(wrapper.get('[data-cy="player-ambience"]').text()).toContain("ambience 01");
			expect(wrapper.get(".ut-widget").attributes("data-collapsed")).toBe("false");

			await wrapper.get('[data-cy="player-fold"]').trigger("click");
			expect(toggleCollapsed).toHaveBeenCalledOnce();
			await wrapper.setProps({ collapsed: true });
			expect(wrapper.get(".ut-widget").attributes("data-collapsed")).toBe("true");
			expect(wrapper.get('[data-cy="player-fold"]').attributes("aria-label")).toBe(
				"Unfold the player",
			);
			await wrapper.setProps({ collapsed: false });

			const handle = wrapper.get('button[aria-label="Move the player"]');
			await handle.trigger("keydown", { key: "ArrowLeft" });
			await handle.trigger("keydown", { key: "ArrowDown", shiftKey: true });
			await handle.trigger("keydown", { key: "Home" });
			expect(moveBy).toHaveBeenNthCalledWith(1, -16, 0);
			expect(moveBy).toHaveBeenNthCalledWith(2, 0, 64);
			expect(resetPosition).toHaveBeenCalledOnce();
		});

		it("lets the listener choose background motion from the secondary panel", async () => {
			const { wrapper, store } = mountComponent(VideoControls, {
				props: { sliderPosition: 0, truePosition: 0 },
			});
			await wrapper.get('button[aria-label="More player controls"]').trigger("click");
			const group = wrapper.get('[role="group"][aria-label="Background motion"]');
			const off = group.findAll("button").find(button => button.text() === "Off");
			await off?.trigger("click");
			expect(store.state.settings.ambienceMotion).toBe("off");
			expect(off?.attributes("aria-pressed")).toBe("true");
		});
	});
});
