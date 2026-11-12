<script setup lang="ts">
import { computed } from "vue";
import { RotateCcw } from "@lucide/vue";
import { useMusicRoom } from "@/composables/use-music-room";
import { useGrants } from "@/components/composables/grants";
import { useConnection } from "@/plugins/connection";
import { useRoomApi } from "@/util/roomapi";
import { useStore } from "@/store";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
const room = useMusicRoom()!;
const granted = useGrants();
const store = useStore();
const roomapi = useRoomApi(useConnection());
/** Recently played tracks, oldest first, then the one playing now. */
const played = computed(() => room.state.value?.played ?? []);
const current = computed(() => room.state.value?.current ?? null);
// Going back is a shared "previous": the same grant, and never a way around vote-skip.
const canGoBack = computed(
	() => granted("playback.skip") && !store.state.room.enableVoteSkip && room.active.value,
);
function playAgain(index: number) {
	roomapi.previous(played.value.length - index);
}
const entries = computed(() =>
	room.fullQueue.value ? room.queue.items.value : room.state.value?.queue.slice(0, 5) ?? [],
);
const contributor = (id: string) =>
	room.state.value?.participants.find(p => p.participantId === id)?.name ??
	room.participantNames.get(id);
</script>

<template>
	<section
		class="flex min-w-0 flex-col gap-4 p-4 [&_button]:min-h-11 [&_button]:max-w-full [&_button]:whitespace-normal"
		:aria-label="$t('musicRoom.queue')"
		data-cy="music-queue"
	>
		<div class="flex flex-wrap items-center gap-2">
			<h2>{{ $t("musicRoom.queue") }}</h2>
			<Badge variant="secondary">{{ room.state.value?.queueTotal ?? 0 }}</Badge>
			<Button
				variant="outline"
				:aria-pressed="room.fullQueue.value"
				data-cy="music-full-queue"
				@click="room.fullQueue.value = !room.fullQueue.value"
				>{{
					$t(room.fullQueue.value ? "musicRoom.show-peek" : "musicRoom.show-full")
				}}</Button
			>
		</div>
		<p class="text-sm text-muted-foreground">{{ $t("musicRoom.order-hint") }}</p>
		<ol v-if="played.length || current" class="flex flex-col gap-1" data-cy="music-played">
			<li v-for="(entry, index) in played" :key="entry.entryId" class="min-w-0">
				<button
					type="button"
					class="queue-track queue-track--played"
					:disabled="!canGoBack"
					:aria-label="
						$t('musicRoom.play-again', {
							title: entry.title || $t('musicRoom.untitled'),
						})
					"
					:title="$t('musicRoom.play-again-hint')"
					data-cy="music-play-again"
					@click="playAgain(index)"
				>
					<span class="queue-thumb">
						<img
							v-if="entry.artworkUrl"
							:src="entry.artworkUrl"
							alt=""
							loading="lazy"
						/>
					</span>
					<span class="queue-text">
						<b>{{ entry.title || $t("musicRoom.untitled") }}</b>
						<small>{{
							[entry.artists.join(", "), contributor(entry.contributorId)]
								.filter(Boolean)
								.join(" · ")
						}}</small>
					</span>
					<RotateCcw class="queue-again" aria-hidden="true" />
				</button>
			</li>
			<li v-if="current" class="min-w-0" aria-current="true" data-cy="music-now-playing">
				<div class="queue-track queue-track--current">
					<span class="queue-thumb">
						<img v-if="current.artworkUrl" :src="current.artworkUrl" alt="" />
					</span>
					<span class="queue-text">
						<b>{{
							current.title ||
							store.state.room.currentSource?.title ||
							$t("musicRoom.untitled")
						}}</b>
						<small>{{
							[current.artists.join(", "), contributor(current.contributorId)]
								.filter(Boolean)
								.join(" · ")
						}}</small>
					</span>
					<Badge>{{ $t("musicRoom.now-playing") }}</Badge>
				</div>
			</li>
		</ol>
		<h3 v-if="played.length || current">{{ $t("musicRoom.up-next") }}</h3>
		<p v-if="room.fullQueue.value && room.queue.loading.value" role="status">
			<Spinner />{{ $t("common.loading") }}
		</p>
		<p v-if="room.fullQueue.value && room.queue.error.value" role="alert">
			{{ $t("musicRoom.page-failed") }}
			<Button variant="outline" @click="room.queue.load()">{{ $t("music.retry") }}</Button>
		</p>
		<ol
			class="flex flex-col gap-3"
			:start="room.fullQueue.value ? room.queue.offset.value + 1 : 1"
		>
			<li
				v-for="entry in entries"
				:key="entry.entryId"
				class="flex min-w-0 flex-wrap items-center gap-2"
				:data-entry-id="entry.entryId"
			>
				<span class="queue-thumb">
					<img v-if="entry.artworkUrl" :src="entry.artworkUrl" alt="" loading="lazy" />
				</span>
				<div class="min-w-0 flex-1">
					<p class="break-words">{{ entry.title || $t("musicRoom.untitled") }}</p>
					<p class="break-words text-sm text-muted-foreground">
						{{ entry.artists.join(", ") }}
					</p>
					<p class="text-sm">
						{{
							$t("musicRoom.contributed-by", {
								name:
									contributor(entry.contributorId) ||
									$t("musicRoom.departed-participant"),
							})
						}}
					</p>
				</div>
				<Badge variant="secondary">{{ $t(`musicRoom.origin.${entry.origin}`) }}</Badge>
				<Button
					v-if="granted('manage-queue.remove')"
					variant="outline"
					:aria-label="
						$t('musicRoom.remove-entry', {
							title: entry.title || $t('musicRoom.untitled'),
						})
					"
					:disabled="room.busy.value || !room.active.value"
					data-cy="music-remove"
					@click="room.run({ action: 'remove', entryId: entry.entryId })"
					>{{ $t("common.remove") }}</Button
				>
			</li>
		</ol>
		<p v-if="!entries.length && !room.queue.loading.value">{{ $t("musicRoom.empty-queue") }}</p>
		<nav
			v-if="room.fullQueue.value"
			:aria-label="$t('music.pagination')"
			class="flex flex-wrap gap-2"
		>
			<Button
				variant="outline"
				:disabled="room.queue.loading.value || !room.queue.offset.value"
				@click="room.queue.load(Math.max(0, room.queue.offset.value - 25))"
				>{{ $t("music.previous") }}</Button
			>
			<Button
				variant="outline"
				:disabled="
					room.queue.loading.value ||
					room.queue.offset.value + 25 >= room.queue.total.value
				"
				@click="room.queue.load(room.queue.offset.value + 25)"
				>{{ $t("music.next") }}</Button
			>
		</nav>
		<section
			v-for="requestPage in [
				{ page: room.pendingRequests, label: 'pending-requests' },
				{ page: room.requests, label: 'requests' },
			]"
			:key="requestPage.label"
			class="flex flex-col gap-2"
			:data-cy="requestPage.label"
		>
			<h3>
				{{ $t(`musicRoom.${requestPage.label}`) }}
				<Badge variant="secondary">{{ requestPage.page.total.value }}</Badge>
			</h3>
			<p class="text-sm text-muted-foreground">
				{{ $t(`musicRoom.${requestPage.label}-hint`) }}
			</p>
			<p v-if="requestPage.page.loading.value" role="status">{{ $t("common.loading") }}</p>
			<p v-if="requestPage.page.error.value" role="alert">
				{{ $t("musicRoom.page-failed") }}
				<Button variant="outline" @click="requestPage.page.load()">{{
					$t("music.retry")
				}}</Button>
			</p>
			<ul class="flex flex-col gap-2">
				<li
					v-for="request in requestPage.page.items.value"
					:key="request.requestId"
					class="flex flex-wrap items-center gap-2"
					:data-request-id="request.requestId"
				>
					<span>{{ request.title || $t("musicRoom.requested-track") }}</span
					><Badge variant="secondary"
						>{{ $t(`musicRoom.intent.${request.intent}`) }} ·
						{{ $t(`musicRoom.request-status.${request.status}`) }}</Badge
					>
					<Button
						v-if="request.status === 'pending' && request.conflicts.length"
						variant="outline"
						:disabled="room.busy.value"
						@click="room.confirmation.value = request"
						>{{ $t("musicRoom.review-conflicts") }}</Button
					>
					<Button
						v-if="['pending', 'admitted'].includes(request.status)"
						variant="outline"
						:disabled="room.busy.value || !room.active.value"
						@click="room.cancel(request.requestId)"
						>{{ $t("common.cancel") }}</Button
					>
				</li>
			</ul>
			<p v-if="!requestPage.page.loading.value && !requestPage.page.items.value.length">
				{{ $t("musicRoom.empty-requests") }}
			</p>
			<nav :aria-label="$t(`musicRoom.${requestPage.label}`)" class="flex flex-wrap gap-2">
				<Button
					variant="outline"
					:disabled="requestPage.page.loading.value || !requestPage.page.offset.value"
					@click="requestPage.page.load(Math.max(0, requestPage.page.offset.value - 25))"
					>{{ $t("music.previous") }}</Button
				>
				<Button
					variant="outline"
					:disabled="
						requestPage.page.loading.value ||
						requestPage.page.offset.value + 25 >= requestPage.page.total.value
					"
					@click="requestPage.page.load(requestPage.page.offset.value + 25)"
					>{{ $t("music.next") }}</Button
				>
			</nav>
		</section>
	</section>
</template>

<style scoped>
.queue-track {
	display: flex;
	align-items: center;
	gap: 0.75rem;
	width: 100%;
	min-width: 0;
	padding: 0.4rem 0.5rem;
	border-radius: var(--radius);
	text-align: left;
}
/* Played tracks read as the past: quieter, and a click brings one back. */
.queue-track--played {
	color: var(--muted-foreground);
	cursor: pointer;
	transition: background-color 0.15s;
}
.queue-track--played:hover:not(:disabled),
.queue-track--played:focus-visible {
	background: var(--accent);
	color: var(--foreground);
}
.queue-track--played:disabled {
	cursor: default;
}
.queue-track--current {
	background: color-mix(in srgb, var(--primary) 12%, transparent);
	box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary) 35%, transparent);
}
.queue-thumb {
	display: block;
	flex: none;
	width: 2.5rem;
	height: 2.5rem;
	overflow: hidden;
	border-radius: 0.5rem;
	background: color-mix(in srgb, var(--foreground) 8%, transparent);
}
.queue-thumb img {
	width: 100%;
	height: 100%;
	object-fit: cover;
}
.queue-text {
	display: flex;
	min-width: 0;
	flex: 1;
	flex-direction: column;
}
.queue-text b,
.queue-text small {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.queue-text b {
	font-weight: 500;
}
.queue-text small {
	font-size: 0.8rem;
	color: var(--muted-foreground);
}
.queue-again {
	width: 1rem;
	height: 1rem;
	flex: none;
	opacity: 0;
	transition: opacity 0.15s;
}
.queue-track--played:hover:not(:disabled) .queue-again,
.queue-track--played:focus-visible .queue-again {
	opacity: 1;
}
</style>
