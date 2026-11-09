<script setup lang="ts">
import { ref, watch } from "vue";
import type { AddLibraryTrackRequest, LibraryTrack } from "ott-common/models/music";
import { useMusic, useMusicPage, errorKind, type MusicError } from "@/composables/use-music";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import PageHeader from "@/components/PageHeader.vue";
import LogInForm from "@/components/LogInForm.vue";
import LibraryImport from "@/components/music/LibraryImport.vue";
import LibraryImports from "@/components/music/imports/LibraryImports.vue";
import MusicFavorites from "@/components/music/MusicFavorites.vue";
import MusicFeedback from "@/components/music/MusicFeedback.vue";
import MusicPagination from "@/components/music/MusicPagination.vue";
import TrackMoods from "@/components/music/TrackMoods.vue";

const music = useMusic();
const { authorized, version, expired } = music;
const page = useMusicPage<LibraryTrack>(music, () => "/library");
const { items, total, limit, offset, loading, error } = page;
const showLogin = ref(false);
const expanded = ref<string | null>(null);
const pending = ref(false);
const mutationError = ref<MusicError | null>(null);
const success = ref(false);
let retryMutation: (() => Promise<void>) | undefined;
watch(
	version,
	() => {
		expanded.value = null;
		pending.value = false;
		mutationError.value = null;
		success.value = false;
		retryMutation = undefined;
	},
	{ flush: "sync" },
);
watch(offset, () => {
	expanded.value = null;
});
async function mutate(action: () => Promise<unknown>, removing = false) {
	if (pending.value || !authorized.value) {
		return;
	}
	const epoch = version.value;
	retryMutation = () => mutate(action, removing);
	pending.value = true;
	mutationError.value = null;
	success.value = false;
	try {
		await action();
		if (epoch !== version.value) {
			return;
		}
		success.value = true;
		expanded.value = null;
		const lastOffset =
			removing && items.value.length === 1 && offset.value > 0
				? offset.value - limit.value
				: offset.value;
		await page.load(Math.max(0, lastOffset));
	} catch (failure) {
		if (epoch === version.value) {
			mutationError.value = errorKind(failure);
		}
	} finally {
		if (epoch === version.value) {
			pending.value = false;
		}
	}
}
function importTrack(input: AddLibraryTrackRequest) {
	return mutate(() => music.request("POST", "/library", input));
}
function removeTrack(id: string) {
	return mutate(() => music.request("DELETE", `/library/${encodeURIComponent(id)}`, {}), true);
}
</script>

<template>
	<main class="mx-auto flex w-full min-w-0 max-w-4xl flex-col gap-6 px-4 py-8 sm:px-6">
		<PageHeader :title="$t('music.library')" :eyebrow="$t('music.personal')" />
		<template v-if="!authorized">
			<p role="status">{{ $t(expired ? "music.errors.auth" : "music.sign-in") }}</p>
			<Button variant="outline" @click="showLogin = true">{{ $t("nav.login") }}</Button>
			<Dialog v-model:open="showLogin">
				<DialogContent
					><DialogTitle>{{ $t("nav.login") }}</DialogTitle
					><LogInForm @should-close="showLogin = false"
				/></DialogContent>
			</Dialog>
		</template>
		<Tabs v-else default-value="library" class="min-w-0">
			<TabsList class="flex h-auto flex-wrap">
				<TabsTrigger value="library">{{ $t("music.library") }}</TabsTrigger>
				<TabsTrigger value="favorites">{{ $t("music.favorites") }}</TabsTrigger>
				<TabsTrigger value="imports">{{ $t("musicImports.title") }}</TabsTrigger>
			</TabsList>
			<TabsContent value="library" class="flex min-w-0 flex-col gap-6">
				<LibraryImport :disabled="pending" @import="importTrack" />
				<MusicFeedback
					:loading="pending"
					:error="mutationError"
					retry
					@retry="retryMutation?.()"
				/>
				<p v-if="success" role="status">{{ $t("music.saved") }}</p>
				<MusicFeedback :loading="loading" :error="error" retry @retry="page.retry" />
				<p v-if="!loading && !error && !items.length" role="status">
					{{ $t("music.empty") }}
				</p>
				<ul class="flex min-w-0 flex-col gap-4">
					<li
						v-for="entry in items"
						:key="entry.track.id"
						class="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4"
					>
						<h2 class="break-words font-display text-xl">
							{{ entry.track.title.trim() || $t("music.unknown-title") }}
						</h2>
						<p class="break-words text-sm text-muted-foreground">
							{{
								entry.track.artists.length
									? entry.track.artists.join(", ")
									: $t("music.unknown-artist")
							}}
						</p>
						<p class="break-words text-sm text-muted-foreground">
							{{
								entry.track.styles.length
									? entry.track.styles.join(", ")
									: $t("music.unknown-style")
							}}
						</p>
						<p class="text-sm text-muted-foreground">
							{{
								entry.track.duration === null
									? $t("music.unknown-duration")
									: $t("music.duration", {
											seconds: Math.round(entry.track.duration),
									  })
							}}
						</p>
						<div class="flex flex-wrap gap-2" :aria-label="$t('music.sources')">
							<Badge
								v-for="source in entry.sources"
								:key="source.id"
								variant="secondary"
								>{{ $t(`music.services.${source.service}`) }} ·
								{{ $t(`music.availability.${source.availability}`) }}</Badge
							>
							<span v-if="!entry.sources.length">{{ $t("music.no-sources") }}</span>
						</div>
						<div class="flex flex-wrap gap-2">
							<Button
								type="button"
								variant="outline"
								:aria-expanded="expanded === entry.track.id"
								@click="
									expanded = expanded === entry.track.id ? null : entry.track.id
								"
								>{{ $t("music.track-moods") }}</Button
							>
							<Button
								type="button"
								variant="ghost"
								:disabled="pending"
								@click="removeTrack(entry.track.id)"
								>{{ $t("music.remove") }}</Button
							>
						</div>
						<TrackMoods
							v-if="expanded === entry.track.id"
							:track-id="entry.track.id"
							:contributor-mood-ids="[]"
						/>
					</li>
				</ul>
				<MusicPagination
					:offset="offset"
					:limit="limit"
					:total="total"
					:loading="loading || pending"
					@page="page.load"
				/>
			</TabsContent>
			<TabsContent value="favorites" class="min-w-0"
				><MusicFavorites :key="version"
			/></TabsContent>
			<TabsContent value="imports" class="min-w-0"
				><LibraryImports :key="version" @changed="page.load()"
			/></TabsContent>
		</Tabs>
	</main>
</template>
