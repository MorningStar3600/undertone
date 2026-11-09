import {
	computed,
	inject,
	onScopeDispose,
	provide,
	reactive,
	ref,
	shallowRef,
	watch,
	type InjectionKey,
} from "vue";
import type { Store } from "vuex";
import type { FullOTTStoreState } from "@/store";
import { useStore } from "@/store";
import { useConnection, type OttRoomConnection } from "@/plugins/connection";
import { useRoomApi } from "@/util/roomapi";
import { useRoute } from "vue-router";
import { QueueMode } from "ott-common/models/types";
import { parseIntoGrantMask } from "ott-common/permissions";
import type {
	MusicRoomActionInput,
	MusicRoomEntry,
	MusicRoomRequestSummary,
	MusicRoomResult,
} from "ott-common/models/music-room";
import type { QueueItemExtras, VideoId } from "ott-common/models/video";
import { DEFAULT_MOODS, type Mood } from "ott-common/models/music";

type WithoutEnvelope<T> = T extends unknown ? Omit<T, "expectedRevision" | "correlationId"> : never;
export type MusicCommand = WithoutEnvelope<MusicRoomActionInput>;
const READS = new Set(["queue", "requests"]);
export const MUSIC_RESULT_TIMEOUT = 20000;

/** One owner per mounted Room. Private replies are accepted only for outstanding correlations. */
export function createMusicRoomCommands(
	store: Store<FullOTTStoreState>,
	connection: OttRoomConnection,
	roomKey: () => unknown,
) {
	const api = useRoomApi(connection);
	const state = computed(() => store.state.room.music);
	const identityReady = ref(true);
	const active = computed(
		() =>
			identityReady.value &&
			store.state.room.queueMode === QueueMode.Music &&
			!!state.value &&
			connection.connected.value,
	);
	const own = computed(() =>
		state.value?.participants.find(p => p.clientIds?.includes(store.state.users.you.id)),
	);
	const version = ref(0);
	const participantNames = reactive(new Map<string, string>());
	const revision = ref(0);
	const busy = ref(false);
	const status = ref<string | null>(null);
	const confirmation = shallowRef<MusicRoomRequestSummary | null>(null);
	const publicMoods = computed(() => {
		const moods = new Map<string, Mood>(DEFAULT_MOODS.map(m => [m.id, m]));
		for (const mood of [
			...(state.value?.ruleMoods ?? []),
			...(state.value?.current?.contributorMoods ?? []),
		]) {
			moods.set(mood.id, mood);
		}
		return moods;
	});
	function conflictDetails(participantId: string, moodId: string) {
		const metadata = confirmation.value?.conflictMetadata?.find(
			c => c.participantId === participantId && c.moodId === moodId,
		);
		return {
			name: metadata?.participantName ?? participantNames.get(participantId),
			mood: metadata?.mood?.id === moodId ? metadata.mood : publicMoods.value.get(moodId),
		};
	}
	const retryCommand = shallowRef<MusicCommand | null>(null);
	const waiting = new Map<
		string,
		{ timer: ReturnType<typeof setTimeout>; finish: (result: MusicRoomResult | null) => void }
	>();
	let disposed = false;
	const allowed = (permission: Parameters<typeof parseIntoGrantMask>[0][number]) =>
		!!(store.getters["users/grants"] & parseIntoGrantMask([permission]));
	function can(command: MusicCommand) {
		if (!active.value || !own.value) {
			return false;
		}
		switch (command.action) {
			case "request":
				return (
					allowed("manage-queue.add") &&
					(command.intent !== "next" || allowed("manage-queue.order"))
				);
			case "confirm":
				return (
					allowed("manage-queue.add") &&
					(confirmation.value?.intent !== "next" || allowed("manage-queue.order"))
				);
			case "settings":
				return allowed("configure-room.other");
			case "remove":
				return allowed("manage-queue.remove");
			case "replan":
				return allowed("manage-queue.order");
			default:
				return true;
		}
	}
	function reset() {
		version.value++;
		participantNames.clear();
		for (const item of waiting.values()) {
			clearTimeout(item.timer);
			item.finish(null);
		}
		waiting.clear();
		busy.value = false;
		status.value = null;
		confirmation.value = null;
		retryCommand.value = null;
		revision.value = state.value?.revision ?? 0;
	}
	const unsubscribe = api.onMusicResult(result => {
		const item = waiting.get(result.correlationId);
		if (!item || disposed || !active.value) {
			return;
		}
		waiting.delete(result.correlationId);
		clearTimeout(item.timer);
		revision.value = Math.max(revision.value, result.revision);
		item.finish(result);
	});
	async function send(command: MusicCommand): Promise<MusicRoomResult | null> {
		if (disposed || !can(command)) {
			return null;
		}
		// A sync and a click can arrive in the same turn, before the page watcher runs.
		revision.value = Math.max(revision.value, state.value?.revision ?? 0);
		const correlationId = crypto.randomUUID();
		return new Promise(resolve => {
			const timer = setTimeout(() => {
				waiting.delete(correlationId);
				resolve({ correlationId, revision: revision.value, status: "timeout" });
			}, MUSIC_RESULT_TIMEOUT);
			waiting.set(correlationId, { timer, finish: resolve });
			try {
				api.music({ ...command, expectedRevision: revision.value, correlationId });
			} catch {
				clearTimeout(timer);
				waiting.delete(correlationId);
				resolve({ correlationId, revision: revision.value, status: "disconnected" });
			}
		});
	}
	function page<T extends MusicRoomEntry | MusicRoomRequestSummary>(
		action: "queue" | "requests",
		filter?: "pending",
	) {
		const items = shallowRef<T[]>([]),
			total = ref(0),
			offset = ref(0),
			loading = ref(false),
			error = ref<string | null>(null);
		let sequence = 0;
		async function load(nextOffset = offset.value) {
			if (!active.value || !own.value || disposed || nextOffset < 0) {
				return;
			}
			const current = ++sequence,
				epoch = version.value;
			loading.value = true;
			error.value = null;
			items.value = [];
			offset.value = nextOffset;
			const result = await send(
				action === "requests"
					? { action, offset: nextOffset, limit: 25, ...(filter ? { filter } : {}) }
					: { action, offset: nextOffset, limit: 25 },
			);
			if (epoch !== version.value || current !== sequence) {
				return;
			}
			loading.value = false;
			if (!result?.page || result.status !== "applied") {
				error.value = result?.status ?? "disconnected";
				return;
			}
			// Pages are snapshots. A late page must never replace a newer public revision.
			if (result.revision < revision.value) {
				void load(0);
				return;
			}
			items.value = result.page.items as T[];
			total.value = result.page.total;
			offset.value = result.page.offset;
		}
		watch(
			version,
			() => {
				sequence++;
				items.value = [];
				total.value = 0;
				offset.value = 0;
				loading.value = false;
				error.value = null;
			},
			{ flush: "sync" },
		);
		return { items, total, offset, loading, error, load };
	}
	const queue = page<MusicRoomEntry>("queue");
	const requests = page<MusicRoomRequestSummary>("requests");
	const pendingRequests = page<MusicRoomRequestSummary>("requests", "pending");
	async function run(command: MusicCommand) {
		if (READS.has(command.action) || busy.value || !can(command)) {
			return;
		}
		const epoch = version.value;
		busy.value = true;
		status.value = null;
		retryCommand.value = null;
		const result = await send(command);
		if (epoch !== version.value) {
			return;
		}
		busy.value = false;
		status.value = result?.status ?? "disconnected";
		if (result?.request) {
			confirmation.value =
				result.request.status === "pending" && result.request.conflicts.length
					? result.request
					: null;
		}
		if (!["applied", "duplicate", "confirmation-required"].includes(status.value)) {
			retryCommand.value = command;
		}
		// Read only: never silently replay a mutation after conflict/reconnect.
		void pendingRequests.load(0);
		void requests.load(0);
		if (fullQueue.value) {
			void queue.load(0);
		}
	}
	const fullQueue = ref(false);
	watch(
		[
			roomKey,
			() => store.state.room.name,
			() => store.state.user,
			() => store.state.users.you.id,
			active,
		],
		reset,
		{ flush: "sync", immediate: true },
	);
	const tokenUnsubscribe = store.subscribe(m => {
		if (["LOGIN", "LOGOUT", "users/SET_AUTH_TOKEN"].includes(m.type)) {
			identityReady.value = false;
			reset();
		}
		if (m.type === "room/SYNC" && m.payload && "music" in m.payload) {
			identityReady.value = true;
		}
	});
	watch(
		[version, () => state.value?.participants],
		() => {
			for (const participant of state.value?.participants ?? []) {
				if (participant.name) {
					participantNames.set(participant.participantId, participant.name);
				}
			}
		},
		{ immediate: true },
	);
	watch(
		[() => state.value?.revision, version, () => own.value?.participantId],
		() => {
			revision.value = Math.max(revision.value, state.value?.revision ?? 0);
			if (active.value && own.value) {
				void pendingRequests.load(0);
				void requests.load(0);
				if (fullQueue.value) {
					void queue.load(0);
				}
			}
		},
		{ immediate: true },
	);
	watch(fullQueue, value => {
		if (value) {
			void queue.load(0);
		}
	});
	watch(requests.items, items => {
		const request = items.find(r => r.requestId === confirmation.value?.requestId);
		if (request) {
			confirmation.value =
				request.status === "pending" && request.conflicts.length ? request : null;
		}
	});
	watch(pendingRequests.items, items => {
		const request = items.find(r => r.requestId === confirmation.value?.requestId);
		if (request) {
			confirmation.value = request;
		} else if (!pendingRequests.loading.value && pendingRequests.total.value <= items.length) {
			confirmation.value = null;
		}
	});
	onScopeDispose(() => {
		disposed = true;
		unsubscribe();
		tokenUnsubscribe();
		reset();
	});
	return {
		state,
		participantNames,
		publicMoods,
		conflictDetails,
		own,
		active,
		version,
		revision,
		busy,
		status,
		confirmation,
		retryCommand,
		can,
		run,
		queue,
		requests,
		pendingRequests,
		fullQueue,
		request: (reference: VideoId, extras: QueueItemExtras, intent: "mix" | "next") =>
			run({
				action: "request",
				requestId: crypto.randomUUID(),
				reference: { ...reference },
				extras: { ...extras },
				intent,
			}),
		confirm: () => {
			const r = confirmation.value;
			if (
				r &&
				r.conflicts.length &&
				r.conflicts.every(c => {
					const detail = conflictDetails(c.participantId, c.moodId);
					return !!detail.name && !!detail.mood?.name;
				})
			) {
				return run({
					action: "confirm",
					requestId: r.requestId,
					trackId: r.trackId,
					conflicts: r.conflicts.map(c => ({
						participantId: c.participantId,
						moodId: c.moodId,
					})),
				});
			}
		},
		cancel: (requestId: string) => run({ action: "cancel", requestId }),
		retry: () => {
			if (retryCommand.value) {
				return run(retryCommand.value);
			}
		},
	};
}
export type MusicRoomCommands = ReturnType<typeof createMusicRoomCommands>;
const key: InjectionKey<MusicRoomCommands> = Symbol("music-room");
export function provideMusicRoom() {
	const route = useRoute();
	const music = createMusicRoomCommands(useStore(), useConnection(), () => route.params.roomId);
	provide(key, music);
	return music;
}
export const useMusicRoom = () => inject(key, undefined);
