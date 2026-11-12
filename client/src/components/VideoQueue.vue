<template>
	<div class="video-queue">
		<QueueHistory :played="played" :current="current" class="mb-3" />
		<h3 v-if="played.length || current" class="queue-heading">
			{{ $t("musicRoom.up-next") }}
		</h3>
		<div class="empty-queue" v-if="store.state.room.queue.length === 0">
			<div class="empty-inner">
				<div class="msg label-mono">
					{{ $t("video-queue.no-videos") }}
				</div>
				<Button variant="marquee" size="xl" class="w-full" @click="$emit('switchtab')">
					<Icon :icon="mdiPlus" class="size-5" />
					{{ $t("video-queue.add-video") }}
				</Button>
			</div>
		</div>
		<div class="queue-controls" v-if="store.state.room.queue.length > 0">
			<Button
				variant="ghost"
				size="icon"
				:aria-label="$t('room.shuffle-queue')"
				@click="roomapi.shuffle()"
			>
				<Icon :icon="mdiShuffleVariant" class="size-5" />
			</Button>
			<Dialog v-model:open="exportDialog">
				<DialogTrigger as-child>
					<Button variant="outline" size="sm">
						<Icon :icon="mdiExportVariant" class="size-4" />
						{{ $t("video-queue.export") }}
					</Button>
				</DialogTrigger>
				<DialogContent class="max-w-xl sm:max-w-xl">
					<DialogHeader>
						<DialogTitle class="font-display text-2xl tracking-wide">
							{{ $t("video-queue.export-diag-title") }}
						</DialogTitle>
					</DialogHeader>
					<p class="text-sm text-muted-foreground">{{ $t("video-queue.export-hint") }}</p>
					<Textarea
						v-model="exportedQueue"
						readonly
						ref="exportTextBox"
						rows="8"
						class="font-mono"
						:class="copyExportSuccess ? 'text-success' : ''"
					/>
					<p v-if="copyExportSuccess" class="text-xs text-success font-mono">
						{{ $t("share-invite.copied") }}
					</p>
					<DialogFooter>
						<Button variant="ghost" @click="exportDialog = false">
							{{ $t("common.close") }}
						</Button>
						<Button @click="copyExported">
							<Icon :icon="mdiContentCopy" class="size-4" />
							{{ $t("common.copy") }}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
		<Sortable
			:list="store.state.room.queue"
			@move.capture="() => granted('manage-queue.order')"
			@end="onQueueDragDrop"
			:options="{ animation: 200, handle: '.drag-handle' }"
			item-key="id"
		>
			<template #item="{ element, index }">
				<VideoQueueItem :key="element.id" :item="element" :index="index" />
			</template>
		</Sortable>
	</div>
</template>

<script lang="ts" setup>
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Textarea } from "@/components/ui/textarea";
import { mdiPlus, mdiShuffleVariant, mdiExportVariant, mdiContentCopy } from "@mdi/js";
import { ref, computed } from "vue";
import VideoQueueItem from "@/components/VideoQueueItem.vue";
import QueueHistory, { type QueueHistoryTrack } from "@/components/QueueHistory.vue";
import { coverUrl } from "@/ambience/cover-ambience";
import type { QueueItem } from "ott-common/models/video";
import { useStore } from "@/store";
import { Sortable } from "sortablejs-vue3";
import { useConnection } from "@/plugins/connection";
import { useRoomApi } from "@/util/roomapi";
import { exportQueue } from "ott-common/queueexport";
import { useCopyFromTextbox } from "./composables";
import { useGrants } from "./composables/grants";

defineEmits(["switchtab"]);

const store = useStore();
const roomapi = useRoomApi(useConnection());
const granted = useGrants();

const SERVICE_NAMES: Record<string, string> = { youtube: "YouTube", vimeo: "Vimeo" };
const historyTrack = (item: QueueItem, key: string): QueueHistoryTrack => ({
	key,
	title: item.title,
	cover: coverUrl(item),
	detail: SERVICE_NAMES[item.service] ?? item.service,
});
/** Recently played tracks, oldest first, then the one playing now. */
const played = computed(() =>
	(store.state.room.playedTracks ?? []).map((item, index) =>
		historyTrack(item, `${index}:${item.service}:${item.id}`),
	),
);
const current = computed(() =>
	store.state.room.currentSource ? historyTrack(store.state.room.currentSource, "current") : null,
);

function onQueueDragDrop(e: { oldIndex: number; newIndex: number }) {
	roomapi.queueMove(e.oldIndex, e.newIndex);
}

const exportDialog = ref(false);
const exportedQueue = computed(() => {
	const queue = [...store.state.room.queue];
	if (store.state.room.currentSource) {
		queue.unshift(store.state.room.currentSource);
	}
	return exportQueue(queue);
});
const exportTextBox = ref();
const { copy: copyExported, copySuccess: copyExportSuccess } = useCopyFromTextbox(
	exportedQueue,
	exportTextBox,
);
</script>

<style lang="scss" scoped>
.queue-heading {
	margin: 1rem 0.5rem 0.4rem;
	font: 600 0.8rem/1.2 var(--ut-f-text, var(--font-body));
	letter-spacing: 0.02em;
	text-transform: none;
	color: var(--muted-foreground);
}
.video-queue {
	margin: 0 10px;
	min-height: 500px;
}

.empty-queue {
	display: flex;
	align-items: center;
	justify-content: center;
	height: 300px;

	.empty-inner {
		display: flex;
		flex-direction: column;
		gap: 16px;
		align-items: center;
		text-align: center;
		max-width: 360px;
		width: 100%;
	}

	.msg {
		color: var(--muted-foreground);
		font-size: 0.85rem;
	}
}

.queue-controls {
	display: flex;
	align-items: center;
	gap: 8px;
	margin-top: 6px;
	margin-bottom: 4px;
}

// Transition animation
.video-queue-enter-active,
.video-queue-leave-active {
	transition: all 0.2s;
}
.video-queue-enter-from,
.video-queue-leave-to {
	opacity: 0;
	transform: translateX(-30px) scaleY(0);
}
.video-queue-move {
	transition: transform 0.2s;
}
</style>
