import type { QueueItem } from "ott-common/models/video";
import {
	PlaybackDeferredError,
	type PlaybackAdapter,
	type PlaybackAdapterContext,
} from "../playback/playback-controller";
import strings from "../locales/desktop-en.json";

export interface YoutubeApi {
	destroy(): void;
	cueVideoById(id: string): void;
	playVideo(): void;
	pauseVideo(): void;
	getCurrentTime(): number;
	seekTo(seconds: number, allowSeekAhead: boolean): void;
	getAvailablePlaybackRates(): number[];
	getPlaybackRate(): number;
	setPlaybackRate(rate: number): void;
	setVolume(volume: number): void;
	mute(): void;
	unMute(): void;
}

export interface YoutubeSdk {
	Player: new (
		element: HTMLElement,
		options: {
			width: string;
			height: string;
			playerVars: Record<string, string | number>;
			events: {
				onReady(): void;
				onStateChange(event: { data: number }): void;
				onError(): void;
				onPlaybackRateChange(): void;
				onAutoplayBlocked(): void;
			};
		},
	) => YoutubeApi;
}

declare global {
	interface Window {
		YT?: YoutubeSdk;
		onYouTubeIframeAPIReady?: () => void;
	}
}

let sdkPromise: Promise<YoutubeSdk> | undefined;
const youtubeId = /^[A-Za-z0-9_-]{11}$/;
export function loadYoutubeSdk(): Promise<YoutubeSdk> {
	if (window.YT?.Player) {
		return Promise.resolve(window.YT);
	}
	sdkPromise ??= new Promise((resolve, reject) => {
		const script = document.createElement("script");
		const timeout = setTimeout(() => reject(new Error(strings.providerTimeout)), 10_000);
		window.onYouTubeIframeAPIReady = () => {
			clearTimeout(timeout);
			if (window.YT?.Player) {
				resolve(window.YT);
			} else {
				reject(new Error(strings.providerError));
			}
		};
		script.onerror = () => {
			clearTimeout(timeout);
			reject(new Error(strings.providerError));
		};
		script.src = "https://www.youtube.com/iframe_api";
		document.head.append(script);
	});
	return sdkPromise;
}

const cancelled = () => new DOMException("", "AbortError");

/** One captured SDK instance per controller generation; never a mutable current-player facade. */
export function createYoutubeAdapter(
	context: PlaybackAdapterContext,
	root: HTMLElement,
	getVolume: () => number,
	loadSdk = loadYoutubeSdk,
): PlaybackAdapter<QueueItem> & { setVolume(): void } {
	const container = document.createElement("div");
	const target = document.createElement("div");
	container.append(target);
	root.replaceChildren(container);
	let api: YoutubeApi | undefined;
	let disposed = false;
	let ready = false;
	let cued = false;
	let requestedPlaying = false;
	let failure: Error | undefined;
	let pendingPlay: ((error?: Error) => void) | undefined;
	const waiters = new Set<() => void>();
	const live = () => !disposed && !context.signal.aborted;
	function check(signal: AbortSignal) {
		if (!live() || signal.aborted) {
			throw cancelled();
		}
		if (failure) {
			throw failure;
		}
	}
	function wait(predicate: () => boolean, signal: AbortSignal) {
		return new Promise<void>((resolve, reject) => {
			const deadline = performance.now() + 8_000;
			let timer: ReturnType<typeof setTimeout>;
			const finish = (error?: unknown) => {
				clearTimeout(timer);
				signal.removeEventListener("abort", abort);
				waiters.delete(abort);
				if (error) {
					reject(error);
				} else {
					resolve();
				}
			};
			const abort = () => finish(cancelled());
			const poll = () => {
				try {
					check(signal);
					if (predicate()) {
						finish();
					} else if (performance.now() >= deadline) {
						finish(new Error(strings.providerTimeout));
					} else {
						timer = setTimeout(poll, 50);
					}
				} catch (error) {
					finish(error);
				}
			};
			waiters.add(abort);
			signal.addEventListener("abort", abort, { once: true });
			poll();
		});
	}
	function setVolume() {
		if (api && live()) {
			const volume = getVolume();
			api.setVolume(volume);
			if (volume === 0) {
				api.mute();
			} else {
				api.unMute();
			}
		}
	}
	function fail(error: Error) {
		failure = error;
		requestedPlaying = false;
		pendingPlay?.(error);
		context.report({ type: "error", error });
	}
	function dispose() {
		if (disposed) {
			return;
		}
		disposed = true;
		requestedPlaying = false;
		pendingPlay?.(cancelled());
		for (const abort of [...waiters]) {
			abort();
		}
		container.remove();
		api?.destroy();
		context.signal.removeEventListener("abort", dispose);
	}
	context.signal.addEventListener("abort", dispose, { once: true });
	return {
		async ready(signal) {
			let sdk: YoutubeSdk | undefined;
			// SDK loading is shared, but its completion cannot create a disposed generation.
			void (async () => {
				try {
					sdk = await loadSdk();
				} catch (error) {
					if (live()) {
						failure = error instanceof Error ? error : new Error(strings.providerError);
					}
				}
			})();
			await wait(() => !!sdk, signal);
			check(signal);
			api = new sdk!.Player(target, {
				width: "100%",
				height: "100%",
				playerVars: {
					autoplay: 0,
					controls: 0,
					disablekb: 1,
					playsinline: 1,
					origin: location.origin,
				},
				events: {
					onReady() {
						if (!live()) {
							return;
						}
						ready = true;
						setVolume();
					},
					onStateChange({ data }) {
						if (!live()) {
							return;
						}
						if (data === 1 && !requestedPlaying) {
							api?.pauseVideo();
							return;
						}
						if (data === 5) {
							cued = true;
						}
						if (data === 1) {
							pendingPlay?.();
						}
						if (data === 3) {
							context.report({ type: "buffering" });
						}
						if (data === 1 || data === 2 || data === 5) {
							context.report({ type: "resumed" });
							context.report({ type: "playback-change", isPlaying: data === 1 });
						}
					},
					onError() {
						if (live()) {
							fail(new Error(strings.providerError));
						}
					},
					onPlaybackRateChange() {
						if (live() && api) {
							context.report({ type: "rate-change", rate: api.getPlaybackRate() });
						}
					},
					onAutoplayBlocked() {
						if (!live()) {
							return;
						}
						requestedPlaying = false;
						pendingPlay?.(new DOMException(strings.providerBlocked, "NotAllowedError"));
						api?.pauseVideo();
					},
				},
			});
			await wait(() => ready, signal);
		},
		async load(source, signal) {
			check(signal);
			if (source.service !== "youtube" || !youtubeId.test(source.id)) {
				throw new Error(strings.sourceInvalid);
			}
			cued = false;
			requestedPlaying = false;
			api!.cueVideoById(source.id);
			await wait(() => cued, signal);
		},
		getPosition(signal) {
			check(signal);
			return api!.getCurrentTime();
		},
		seek(seconds, signal) {
			check(signal);
			api!.seekTo(seconds, true);
		},
		supportsRate(rate) {
			return !!api?.getAvailablePlaybackRates().includes(rate);
		},
		setRate(rate, signal) {
			check(signal);
			api!.setPlaybackRate(rate);
		},
		activate() {
			check(context.signal);
			// Called synchronously by a click inside the host document, before any await.
			requestedPlaying = true;
			api?.playVideo();
		},
		play(signal) {
			check(signal);
			pendingPlay?.(cancelled());
			requestedPlaying = true;
			return new Promise<void>((resolve, reject) => {
				const cancel = () => {
					requestedPlaying = false;
					pendingPlay?.(cancelled());
					api?.pauseVideo();
				};
				const timeout = setTimeout(() => {
					requestedPlaying = false;
					pendingPlay?.(new PlaybackDeferredError(strings.providerDeferred));
					api?.pauseVideo();
				}, 4_000);
				pendingPlay = error => {
					clearTimeout(timeout);
					signal.removeEventListener("abort", cancel);
					pendingPlay = undefined;
					if (error) {
						reject(error);
					} else {
						resolve();
					}
				};
				signal.addEventListener("abort", cancel, { once: true });
				api!.playVideo();
			});
		},
		pause(signal) {
			check(signal);
			requestedPlaying = false;
			pendingPlay?.(cancelled());
			api!.pauseVideo();
		},
		setVolume,
		dispose,
	};
}
