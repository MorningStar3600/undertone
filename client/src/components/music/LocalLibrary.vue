<script setup lang="ts">
import { onScopeDispose, ref, watch } from "vue";
import { API } from "@/common-http";
import { useMusic, useMusicPage } from "@/composables/use-music";
import type { LocalMediaStatus } from "ott-common/models/local-media";
import type { LibraryTrack } from "ott-common/models/music";
import { Button } from "@/components/ui/button";
import MusicPagination from "./MusicPagination.vue";
import MusicPreview from "./MusicPreview.vue";
import MusicFeedback from "./MusicFeedback.vue";
import type { VideoId } from "ott-common/models/video";

const props = defineProps<{ select?: boolean }>();
const emit = defineEmits<{ changed: [] }>();
const music = useMusic();
const status = ref<LocalMediaStatus | null>(null);
const page = useMusicPage<LibraryTrack>(music, () =>
	props.select && status.value?.enabled && status.value.roots.length ? "/library" : null,
);
const pending = ref(false),
	failed = ref(false);
let controller: AbortController | undefined;
function localReference(entry: LibraryTrack): VideoId | undefined {
	const source = entry.sources.find(
		source => source.service === "direct" && source.availability === "available",
	);
	return source ? { service: "direct", id: `local:${source.id}` } : undefined;
}
async function load(rootId?: string) {
	if (!music.authorized.value) {
		return;
	}
	controller?.abort();
	controller = new AbortController();
	const current = controller,
		version = music.version.value;
	status.value = rootId ? status.value : null;
	pending.value = true;
	failed.value = false;
	try {
		const result = await API.request<LocalMediaStatus & { success: boolean }>({
			method: rootId ? "POST" : "GET",
			url: rootId
				? `/local-media/roots/${encodeURIComponent(rootId)}/scan`
				: "/local-media/status",
			data: rootId ? {} : undefined,
			headers: rootId ? { "X-Local-Media-Scan": "1" } : undefined,
			signal: current.signal,
		});
		if (current.signal.aborted || version !== music.version.value) {
			return;
		}
		if (!result.data.success || !Array.isArray(result.data.roots)) {
			throw new Error("local-media");
		}
		status.value = result.data;
		if (rootId) {
			emit("changed");
			if (props.select) {
				await page.load();
			}
		}
	} catch {
		if (!current.signal.aborted && version === music.version.value) {
			failed.value = true;
		}
	} finally {
		if (!current.signal.aborted && version === music.version.value) {
			pending.value = false;
		}
	}
}
watch(
	[music.authorized, music.version],
	() => {
		controller?.abort();
		status.value = null;
		failed.value = false;
		pending.value = false;
		if (music.authorized.value) {
			void load();
		}
	},
	{ immediate: true },
);
onScopeDispose(() => controller?.abort());
</script>

<template>
	<section class="flex min-w-0 flex-col gap-4" :aria-label="$t('localMedia.title')">
		<h2>{{ $t("localMedia.title") }}</h2>
		<p v-if="pending" role="status">{{ $t("localMedia.working") }}</p>
		<p v-if="failed" role="alert">{{ $t("localMedia.error") }}</p>
		<Button variant="outline" :disabled="pending || !music.authorized.value" @click="load()">{{
			$t("localMedia.refresh")
		}}</Button>
		<p v-if="status && !status.enabled" role="status">{{ $t("localMedia.balancer") }}</p>
		<p v-else-if="status && !status.roots.length" role="status">
			{{ $t("localMedia.noRoots") }}
		</p>
		<template v-if="status?.enabled">
			<div
				v-for="root in status.roots"
				:key="root.id"
				class="flex flex-wrap items-center gap-3"
			>
				<span
					>{{ root.id }} · {{ $t(`localMedia.status.${root.status}`) }} ·
					{{ $t("localMedia.processed", { count: root.processed }) }}</span
				>
				<Button :disabled="pending || root.status === 'scanning'" @click="load(root.id)">{{
					$t("localMedia.scan")
				}}</Button>
			</div>
			<template v-if="select && status.roots.length">
				<MusicFeedback
					:loading="page.loading.value"
					:error="page.error.value"
					retry
					@retry="page.retry"
				/>
				<MusicPreview
					v-for="entry in page.items.value.filter(item => item.importKind === 'local')"
					:key="entry.track.id"
					:item="{
						service: 'direct',
						id: `local:${entry.sources[0]?.id}`,
						title: entry.track.title,
					}"
					:reference="localReference(entry)"
				/>
				<MusicPagination
					:offset="page.offset.value"
					:limit="page.limit.value"
					:total="page.total.value"
					:loading="page.loading.value"
					@page="page.load"
				/>
			</template>
		</template>
	</section>
</template>
