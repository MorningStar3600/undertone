<script setup lang="ts">
import { ref, useId, watch } from "vue";
import { useMusicImports } from "@/composables/use-music-imports";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field";
import {
	Card,
	CardHeader,
	CardTitle,
	CardDescription,
	CardContent,
	CardFooter,
} from "@/components/ui/card";
import MusicFeedback from "@/components/music/MusicFeedback.vue";
import MusicPagination from "@/components/music/MusicPagination.vue";
import ImportReport from "./ImportReport.vue";

const emit = defineEmits<{ changed: [] }>();
const imports = useMusicImports(() => emit("changed"));
const { sources, jobs, selected, pending, error } = imports;
const { items, loading, error: loadError, offset, limit, total } = sources;
const {
	items: jobItems,
	loading: jobLoading,
	error: jobError,
	offset: jobOffset,
	limit: jobLimit,
	total: jobTotal,
} = jobs;
const value = ref("");
watch(
	imports.music.version,
	() => {
		value.value = "";
	},
	{ flush: "sync" },
);
const id = useId();
async function register() {
	const reference = value.value.trim();
	if (!reference) return;
	await imports.create(
		reference.startsWith("https://")
			? { url: reference }
			: { reference: { service: "youtube", id: reference } },
	);
}
</script>

<template>
	<section class="flex min-w-0 flex-col gap-4" :aria-label="$t('musicImports.title')">
		<form class="flex flex-col gap-4" @submit.prevent="register">
			<h2 class="font-display text-2xl">{{ $t("musicImports.title") }}</h2>
			<FieldGroup>
				<Field>
					<FieldLabel :for="`${id}-playlist`">{{
						$t("musicImports.reference")
					}}</FieldLabel>
					<Input
						:id="`${id}-playlist`"
						v-model="value"
						required
						maxlength="2048"
						:disabled="pending"
						:aria-describedby="`${id}-hint`"
					/>
					<FieldDescription :id="`${id}-hint`">{{
						$t("musicImports.hint")
					}}</FieldDescription>
				</Field>
			</FieldGroup>
			<Button type="submit" :disabled="pending || !value.trim()">{{
				$t("musicImports.register")
			}}</Button>
		</form>
		<p>{{ $t("musicImports.retention") }}</p>
		<MusicFeedback :loading="pending" :error="error" />
		<Button
			type="button"
			variant="outline"
			:disabled="pending || loading || jobLoading"
			@click="imports.refresh"
			>{{ $t("musicImports.refresh") }}</Button
		>
		<MusicFeedback :loading="loading" :error="loadError" retry @retry="sources.retry" />
		<p v-if="!loading && !loadError && !items.length" role="status">
			{{ $t("musicImports.empty") }}
		</p>
		<Card v-for="source in items" :key="source.id">
			<CardHeader>
				<CardTitle>{{
					$t("musicImports.source", { id: source.id.slice(0, 8) })
				}}</CardTitle>
				<CardDescription>{{
					$t(source.removed ? "musicImports.removed" : "musicImports.referenceOnly")
				}}</CardDescription>
			</CardHeader>
			<CardContent class="flex flex-col gap-3">
				<Field orientation="horizontal">
					<FieldLabel :for="`${id}-${source.id}`">{{
						$t("musicImports.daily")
					}}</FieldLabel>
					<Switch
						:id="`${id}-${source.id}`"
						:model-value="source.daily"
						:disabled="pending || source.removed"
						@update:model-value="imports.schedule(source.id, !!$event)"
					/>
				</Field>
				<p>
					{{
						$t("musicImports.lastSuccess", {
							date: source.lastSuccessAt
								? new Date(source.lastSuccessAt).toLocaleString()
								: $t("musicImports.never"),
						})
					}}
				</p>
				<p v-if="source.nextRunAt">
					{{
						$t("musicImports.nextRun", {
							date: new Date(source.nextRunAt).toLocaleString(),
						})
					}}
				</p>
				<ImportReport v-if="source.lastJob" :job="source.lastJob" />
				<p v-else role="status">{{ $t("musicImports.noRuns") }}</p>
			</CardContent>
			<CardFooter class="flex flex-wrap gap-2">
				<Button
					type="button"
					:disabled="pending || source.removed"
					@click="imports.run(source.id)"
					>{{
						$t(
							source.lastJob?.status === "failed"
								? "musicImports.retry"
								: "musicImports.run",
						)
					}}</Button
				>
				<Button
					v-if="
						source.lastJob &&
						['queued', 'running', 'failed'].includes(source.lastJob.status)
					"
					type="button"
					variant="outline"
					:disabled="pending"
					@click="imports.cancel(source.id)"
					>{{ $t("musicImports.cancel") }}</Button
				>
				<Button
					type="button"
					variant="ghost"
					:disabled="pending || source.removed"
					@click="imports.remove(source.id)"
					>{{ $t("musicImports.remove") }}</Button
				>
				<Button
					type="button"
					variant="outline"
					:aria-expanded="selected === source.id"
					@click="selected = selected === source.id ? null : source.id"
					>{{ $t("musicImports.history") }}</Button
				>
			</CardFooter>
		</Card>
		<MusicPagination
			:offset="offset"
			:limit="limit"
			:total="total"
			:loading="loading || pending"
			@page="sources.load"
		/>
		<section
			v-if="selected"
			class="flex flex-col gap-3"
			:aria-label="$t('musicImports.history')"
		>
			<h3>{{ $t("musicImports.sourceHistory", { id: selected.slice(0, 8) }) }}</h3>
			<MusicFeedback :loading="jobLoading" :error="jobError" retry @retry="jobs.retry" />
			<p v-if="!jobLoading && !jobError && !jobItems.length">
				{{ $t("musicImports.noRuns") }}
			</p>
			<ImportReport v-for="job in jobItems" :key="job.id" :job="job" />
			<MusicPagination
				:offset="jobOffset"
				:limit="jobLimit"
				:total="jobTotal"
				:loading="jobLoading || pending"
				@page="jobs.load"
			/>
		</section>
	</section>
</template>
