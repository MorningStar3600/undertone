<template>
	<span></span>
</template>

<script lang="ts" setup>
import { onUnmounted } from "vue";
import { useConnection } from "@/plugins/connection";
import { useStore } from "@/store";

const store = useStore();
const connection = useConnection();
const owned: (() => void)[] = [];
const add: typeof connection.addMessageHandler = (action, handler) => {
	connection.addMessageHandler(action, handler);
	owned.push(() => connection.removeMessageHandler(action, handler));
};

add("sync", msg => {
	store.dispatch("room/sync", msg);
});
add("chat", msg => {
	store.dispatch("chat", msg);
});
add("announcement", msg => {
	store.dispatch("announcement", msg);
});
add("user", msg => {
	store.dispatch("users/user", msg);
});
add("you", msg => {
	store.dispatch("users/you", msg);
});
add("event", msg => {
	store.dispatch("event", msg);
});
add("eventcustom", msg => {
	store.dispatch("eventcustom", msg);
});

onUnmounted(() => {
	for (const unsub of owned) {
		unsub();
	}
});
</script>
