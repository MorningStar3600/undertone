<template>
	<div class="flex shrink-0 items-center gap-1 font-mono text-xs tabular-nums">
		<Input
			v-if="editing"
			ref="editor"
			v-model="draft"
			class="editor h-8 w-22"
			:aria-label="$t('room.playback-position')"
			@keydown.enter.prevent="apply"
			@keydown.esc.prevent="editing = false"
			@blur="editing = false"
		/>
		<button
			v-else-if="canSeek"
			type="button"
			class="editable min-h-8 rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
			:aria-label="$t('room.playback-position')"
			@click="edit"
		>
			{{ secondsToTimestamp(currentPosition) }}
		</button>
		<span v-else>{{ secondsToTimestamp(currentPosition) }}</span>
		<span>/</span>
		<span>{{ secondsToTimestamp(store.state.room.currentSource?.length ?? 0) }}</span>
	</div>
</template>

<script lang="ts" setup>
import { computed, nextTick, ref } from "vue";
import { Input } from "@/components/ui/input";
import { useStore } from "@/store";
import { useConnection } from "@/plugins/connection";
import { useRoomApi } from "@/util/roomapi";
import { secondsToTimestamp, timestampToSeconds } from "@/util/timestamp";
import { useGrants } from "../composables/grants";

const props = withDefaults(defineProps<{ currentPosition?: number }>(), { currentPosition: 0 });
const store = useStore();
const roomapi = useRoomApi(useConnection());
const granted = useGrants();
const editing = ref(false);
const draft = ref("");
const editor = ref<InstanceType<typeof Input>>();
const canSeek = computed(
	() => !!store.state.room.currentSource?.length && granted("playback.seek"),
);
async function edit() {
	draft.value = secondsToTimestamp(props.currentPosition);
	editing.value = true;
	await nextTick();
	editor.value?.$el.focus();
}
function apply() {
	try {
		const position = timestampToSeconds(draft.value);
		if (canSeek.value && Number.isFinite(position)) {
			roomapi.seek(
				Math.max(0, Math.min(position, store.state.room.currentSource?.length ?? 0)),
			);
		}
	} catch {
		// An incomplete timestamp leaves the shared position unchanged.
	}
	editing.value = false;
}
</script>
