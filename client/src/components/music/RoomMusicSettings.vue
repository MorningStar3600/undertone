<script setup lang="ts">
import { useMusicRoom } from "@/composables/use-music-room";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field";
const room = useMusicRoom();
const keys = ["fairShare", "autoAdmitOnJoin", "removeDepartedEntries"] as const;
</script>

<template>
	<section
		v-if="room?.state.value"
		class="flex min-w-0 flex-col gap-4 p-4 [&_button]:min-h-11 [&_button]:max-w-full [&_button]:whitespace-normal"
		:aria-label="$t('musicRoom.settings')"
	>
		<h2>{{ $t("musicRoom.settings") }}</h2>
		<FieldGroup>
			<Field v-for="key in keys" :key="key" orientation="horizontal">
				<Checkbox
					:id="`music-setting-${key}`"
					:model-value="room.state.value.settings[key]"
					:disabled="room.busy.value || !room.can({ action: 'settings', settings: {} })"
					:data-cy="`music-setting-${key}`"
					@update:model-value="value => room!.run({ action: 'settings', settings: { [key]: value === true } })"
				/>
				<div>
					<FieldLabel :for="`music-setting-${key}`">{{
						$t(`musicRoom.settings-label.${key}`)
					}}</FieldLabel
					><FieldDescription>{{ $t(`musicRoom.settings-hint.${key}`) }}</FieldDescription>
				</div>
			</Field>
		</FieldGroup>
		<div class="flex flex-wrap gap-2">
			<Button
				v-for="content in (['keep', 'renew'] as const)"
				:key="content"
				variant="outline"
				:disabled="room.busy.value || !room.can({ action: 'replan', content })"
				@click="room.run({ action: 'replan', content })"
				>{{ $t(`musicRoom.replan-${content}`) }}</Button
			>
		</div>
	</section>
	<p v-else role="status">{{ $t("common.loading") }}</p>
</template>
