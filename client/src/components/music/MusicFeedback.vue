<script setup lang="ts">
import type { MusicError } from "@/composables/use-music";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
defineProps<{ loading?: boolean; error?: MusicError | null; retry?: boolean }>();
defineEmits<{ retry: [] }>();
</script>

<template>
	<p v-if="loading" role="status" class="flex items-center gap-2">
		<Spinner aria-hidden="true" />{{ $t("common.loading") }}
	</p>
	<Alert v-if="error" variant="destructive">
		<AlertDescription class="flex flex-wrap items-center gap-3">
			{{ $t(`music.errors.${error}`) }}
			<Button
				v-if="retry && error !== 'auth'"
				type="button"
				variant="outline"
				:disabled="loading"
				@click="$emit('retry')"
				>{{ $t("music.retry") }}</Button
			>
		</AlertDescription>
	</Alert>
</template>
