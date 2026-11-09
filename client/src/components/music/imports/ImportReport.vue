<script setup lang="ts">
import type { MusicImportJob } from "ott-common/models/music-imports";
import { Badge } from "@/components/ui/badge";
defineProps<{ job: MusicImportJob }>();
</script>

<template>
	<div class="flex flex-col gap-2" role="status" aria-live="polite">
		<Badge variant="secondary">{{ $t(`musicImports.status.${job.status}`) }}</Badge>
		<p>
			{{
				$t("musicImports.counters", {
					pages: job.pages,
					processed: job.processed,
					added: job.added,
					existing: job.existing,
					unavailable: job.unavailable,
				})
			}}
		</p>
		<p>{{ $t("musicImports.failures", { count: job.failures, retries: job.retryCount }) }}</p>
		<p v-if="job.error">{{ $t(`musicImports.errors.${job.error}`) }}</p>
		<p v-if="job.status === 'queued' && job.retryCount">
			{{ $t("musicImports.retryAt", { date: new Date(job.nextAttemptAt).toLocaleString() }) }}
		</p>
		<p v-if="job.completedAt">
			{{ $t("musicImports.completed", { date: new Date(job.completedAt).toLocaleString() }) }}
		</p>
	</div>
</template>
