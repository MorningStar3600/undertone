import { shallowRef, type ShallowRef } from "vue";
import type { QueueItem } from "ott-common/models/video";
import type { MediaPlayer } from "@/components/composables/media-player";
import {
	PlaybackDeferredError,
	type PlaybackAdapter,
	type PlaybackAdapterContext,
	type PlaybackAdapterEvent,
} from "./playback-controller";

export interface CapturedPlayer extends MediaPlayer {
	dispose(): void;
	activate?(): void;
	setPlaybackRate?(rate: number): void | Promise<void>;
}

export interface PlayerSurface {
	key: number;
	source: ShallowRef<QueueItem | null>;
	bind(value: CapturedPlayer): void;
	ready(): void;
	report(event: PlaybackAdapterEvent): void;
	readonly active: boolean;
}

/** A surface is immutable per controller generation. OmniPlayer binds this exact object. */
export function createPlayerSurfaces() {
	let serial = 0;
	const surface = shallowRef<PlayerSurface | null>(null);
	function allocate(context: PlaybackAdapterContext) {
		let player: CapturedPlayer | null = null;
		let usable = false;
		let dead = false;
		const waiters = new Set<() => void>();
		const source = shallowRef<QueueItem | null>(null);
		const wake = () => {
			for (const waiter of [...waiters]) {
				waiter();
			}
		};
		const abortError = () => new DOMException("Playback surface disposed", "AbortError");
		function wait() {
			return new Promise<void>((resolve, reject) => {
				const check = () => {
					if (!dead && !context.signal.aborted && (!player || !usable)) {
						return;
					}
					waiters.delete(check);
					clearTimeout(timeout);
					if (dead || context.signal.aborted) {
						reject(abortError());
					} else {
						resolve();
					}
				};
				const timeout = setTimeout(() => {
					waiters.delete(check);
					reject(new PlaybackDeferredError("Provider readiness timeout"));
				}, 15_000);
				waiters.add(check);
				check();
			});
		}
		async function call<T>(
			operation: (captured: CapturedPlayer) => T | Promise<T>,
		): Promise<T> {
			if (dead || context.signal.aborted || !player) {
				throw abortError();
			}
			const captured = player;
			return new Promise<T>((resolve, reject) => {
				const cancel = () => {
					if (!dead && !context.signal.aborted) {
						return;
					}
					waiters.delete(cancel);
					reject(abortError());
				};
				waiters.add(cancel);
				// Both completions are consumed even if disposal won. Never call through a mutable facade.
				try {
					Promise.resolve(operation(captured)).then(
						value => {
							waiters.delete(cancel);
							resolve(value);
						},
						error => {
							waiters.delete(cancel);
							reject(error);
						},
					);
				} catch (error) {
					waiters.delete(cancel);
					reject(error);
				}
			});
		}
		const binding = {
			key: ++serial,
			source,
			bind(value: CapturedPlayer) {
				if (dead) {
					value.dispose();
					return;
				}
				player = value;
				wake();
			},
			ready() {
				if (dead) {
					return;
				}
				usable = true;
				wake();
				context.report({ type: "resumed" });
			},
			report: context.report,
			get active() {
				return !dead;
			},
		};
		const adapter: PlaybackAdapter<QueueItem> = {
			ready() {
				if (dead) {
					throw abortError();
				}
			},
			async load(item) {
				source.value = item;
				surface.value = binding;
				await wait();
			},
			getPosition: () => call(p => p.getPosition()),
			seek: position =>
				call(async p => {
					await p.setPosition(position);
				}),
			supportsRate: rate =>
				!!player &&
				player.getAvailablePlaybackRates().includes(rate) &&
				(rate === 1 || !!player.setPlaybackRate),
			setRate: rate =>
				call(async p => {
					if (p.setPlaybackRate) {
						await p.setPlaybackRate(rate);
					} else if (rate !== 1) {
						throw new Error("Unsupported playback rate");
					}
				}),
			play: signal => call(p => p.play(signal)),
			pause: () => call(p => p.pause()),
			activate() {
				if (!dead) {
					player?.activate?.();
				}
			},
			dispose() {
				if (dead) {
					return;
				}
				dead = true;
				context.signal.removeEventListener("abort", adapter.dispose);
				try {
					player?.dispose();
				} finally {
					player = null;
					wake();
					if (surface.value === binding) {
						surface.value = null;
					}
				}
			},
		};
		context.signal.addEventListener("abort", adapter.dispose, { once: true });
		return { binding, adapter };
	}
	return {
		surface,
		createAdapter(context: PlaybackAdapterContext) {
			return allocate(context).adapter;
		},
	};
}
