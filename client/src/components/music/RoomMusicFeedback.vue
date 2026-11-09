<script setup lang="ts">
import { useMusicRoom } from "@/composables/use-music-room";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
const room = useMusicRoom();
const known = new Set([
	"applied",
	"duplicate",
	"confirmation-required",
	"revision-conflict",
	"slot-conflict",
	"request-conflict",
	"source-unavailable",
	"not-found",
	"invalid-confirmation",
	"rejected",
	"timeout",
	"disconnected",
]);
</script>

<template>
	<div aria-live="polite">
		<template v-if="room">
			<p v-if="!room.active.value" role="status">
				{{ $t("musicRoom.results.disconnected") }}
			</p>
			<p v-if="room.busy.value" role="status" class="flex items-center gap-2">
				<Spinner />{{ $t("common.loading") }}
			</p>
			<Alert
				v-if="room.status.value"
				:variant="room.retryCommand.value ? 'destructive' : 'default'"
			>
				<AlertDescription class="flex flex-wrap items-center gap-2">
					{{
						$t(
							`musicRoom.results.${
								known.has(room.status.value) ? room.status.value : "rejected"
							}`,
						)
					}}
					<Button
						v-if="room.retryCommand.value"
						variant="outline"
						:disabled="room.busy.value"
						data-cy="music-retry"
						@click="room.retry"
						>{{ $t("musicRoom.retry-intent") }}</Button
					>
				</AlertDescription>
			</Alert>
		</template>
	</div>
</template>
