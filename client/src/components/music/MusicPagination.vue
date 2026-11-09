<script setup lang="ts">
import { Button } from "@/components/ui/button";
import { MUSIC_MAX_OFFSET } from "@/util/music-api";
defineProps<{ offset: number; limit: number; total: number; loading: boolean }>();
defineEmits<{ page: [offset: number] }>();
</script>

<template>
	<nav :aria-label="$t('music.pagination')" class="flex flex-wrap items-center gap-3">
		<Button
			type="button"
			variant="outline"
			:disabled="loading || offset === 0"
			@click="$emit('page', Math.max(0, offset - limit))"
			>{{ $t("music.previous") }}</Button
		>
		<span role="status" class="text-sm text-muted-foreground">{{
			$t("music.page", { page: Math.floor(offset / limit) + 1, total })
		}}</span>
		<Button
			type="button"
			variant="outline"
			:disabled="loading || offset + limit >= total || offset + limit > MUSIC_MAX_OFFSET"
			@click="$emit('page', offset + limit)"
			>{{ $t("music.next") }}</Button
		>
		<p
			v-if="offset + limit > MUSIC_MAX_OFFSET && offset + limit < total"
			class="text-sm text-muted-foreground"
		>
			{{ $t("music.page-limit") }}
		</p>
	</nav>
</template>
