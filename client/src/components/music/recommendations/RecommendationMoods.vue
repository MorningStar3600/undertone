<script setup lang="ts">
import { useId } from "vue";
import type { Mood } from "ott-common/models/music";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
const props = defineProps<{
	moods: Mood[];
	modelValue: string[];
	disabled?: boolean;
	label: string;
}>();
const emit = defineEmits<{ "update:modelValue": [ids: string[]] }>();
const id = useId();
function toggle(moodId: string, active: boolean) {
	emit(
		"update:modelValue",
		active
			? [...new Set([...props.modelValue, moodId])].slice(0, 20)
			: props.modelValue.filter(id => id !== moodId)
	);
}
</script>
<template>
	<FieldSet :disabled="disabled">
		<FieldLegend>{{ label }}</FieldLegend>
		<FieldGroup>
			<Field v-for="mood in moods" :key="mood.id" orientation="horizontal">
				<Checkbox
					:id="`${id}-${mood.id}`"
					:model-value="modelValue.includes(mood.id)"
					:disabled="
						disabled || (!modelValue.includes(mood.id) && modelValue.length >= 20)
					"
					@update:model-value="toggle(mood.id, $event === true)"
				/>
				<FieldLabel :for="`${id}-${mood.id}`">{{ mood.name }}</FieldLabel>
			</Field>
		</FieldGroup>
	</FieldSet>
</template>
