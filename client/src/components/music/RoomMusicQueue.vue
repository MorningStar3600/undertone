<script setup lang="ts">
import { computed } from "vue";
import { useMusicRoom } from "@/composables/use-music-room";
import { useGrants } from "@/components/composables/grants";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
const room = useMusicRoom()!;
const granted = useGrants();
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
