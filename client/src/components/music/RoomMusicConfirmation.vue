<script setup lang="ts">
import { computed, watch } from "vue";
import { useMusicRoom } from "@/composables/use-music-room";
import { useMusic } from "@/composables/use-music";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogFooter,
} from "@/components/ui/dialog";
import RoomMusicFeedback from "./RoomMusicFeedback.vue";
const room = useMusicRoom()!;
const music = useMusic();
let opener: HTMLElement | null = null;
watch(
	() => room.confirmation.value,
	(value, previous) => {
		if (value && !previous) {
			opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		}
	},
	{ flush: "sync" },
);
function restoreFocus(event: Event) {
	event.preventDefault();
	if (opener?.isConnected) {
		opener.focus();
	}
}
const groups = computed(() => {
	const grouped = new Map<string, Set<string>>();
	for (const c of room.confirmation.value?.conflicts ?? []) {
		if (!grouped.has(c.participantId)) {
			grouped.set(c.participantId, new Set());
		}
		grouped.get(c.participantId)!.add(c.moodId);
	}
	return [...grouped].map(([id, moods]) => ({
		id,
		name: room.state.value?.participants.find(p => p.participantId === id)?.name,
		moods: [...moods],
	}));
});
const resolved = computed(() =>
	groups.value.every(g => !!g.name && g.moods.every(id => music.moods.has(id))),
);
function cancel() {
	if (room.confirmation.value && !room.busy.value) {
		void room.cancel(room.confirmation.value.requestId);
	}
}
</script>

<template>
	<Dialog
		:open="!!room.confirmation.value"
		@update:open="
			value => {
				if (!value) {
					cancel();
				}
			}
		"
	>
		<DialogContent
			:show-close-button="false"
			class="max-h-[calc(100dvh-2rem)] overflow-y-auto [&_button]:min-h-11 [&_button]:whitespace-normal"
			@close-auto-focus="restoreFocus"
			@escape-key-down.prevent="cancel"
			@pointer-down-outside.prevent
		>
			<DialogHeader>
				<DialogTitle>{{ $t("musicRoom.confirm-title") }}</DialogTitle>
				<DialogDescription>{{ $t("musicRoom.confirm-description") }}</DialogDescription>
			</DialogHeader>
			<p>{{ $t(`musicRoom.intent.${room.confirmation.value?.intent ?? "mix"}`) }}</p>
			<ul class="flex flex-col gap-2" data-cy="music-conflicts">
				<li v-for="group in groups" :key="group.id" class="break-words">
					<strong>{{ group.name || $t("musicRoom.unknown-participant") }}</strong>
					<ul>
						<li v-for="id in group.moods" :key="id">
							{{ music.moods.get(id)?.name || $t("music.unknown-mood") }}
						</li>
					</ul>
				</li>
			</ul>
			<p v-if="!resolved">{{ $t("musicRoom.unresolved-conflicts") }}</p>
			<RoomMusicFeedback />
			<DialogFooter>
				<Button
					v-if="!resolved"
					variant="outline"
					:disabled="room.busy.value"
					@click="room.confirmation.value = null"
					>{{ $t("musicRoom.review-later") }}</Button
				>
				<Button
					variant="outline"
					:disabled="room.busy.value"
					data-cy="music-cancel"
					@click="cancel"
					>{{ $t("common.cancel") }}</Button
				>
				<Button
					:disabled="
						!resolved ||
						room.busy.value ||
						!room.can({
							action: 'confirm',
							requestId: room.confirmation.value?.requestId ?? '',
							trackId: room.confirmation.value?.trackId ?? '',
							conflicts: [],
						})
					"
					data-cy="music-confirm"
					@click="room.confirm"
					>{{ $t("musicRoom.add-anyway") }}</Button
				>
			</DialogFooter>
		</DialogContent>
	</Dialog>
</template>
