<template>
	<div class="mx-auto max-w-3xl px-6 py-16">
		<span class="label-mono text-signal">{{ $t("attribution.eyebrow") }}</span>
		<h1 class="font-display mt-2 text-4xl tracking-wide">{{ $t("footer.attribution") }}</h1>
		<Separator class="my-6" />
		<div class="mb-6 flex flex-col gap-3 text-muted-foreground">
			<p>{{ $t("fork.notice") }}</p>
			<p>
				<a
					href="https://github.com/dyc3/opentogethertube/graphs/contributors"
					class="text-signal hover:text-primary"
					>{{ $t("fork.upstream-credit") }}</a
				>
			</p>
			<p>{{ $t("fork.modified") }}</p>
			<p>{{ $t("fork.terms") }}</p>
			<p class="flex flex-wrap gap-4">
				<a :href="sourceCodeUrl" class="text-signal hover:text-primary">{{
					$t("fork.source")
				}}</a>
				<a :href="licenseUrl" class="text-signal hover:text-primary">{{
					$t("fork.license")
				}}</a>
			</p>
		</div>
		<p class="text-muted-foreground">
			{{ $t("attribution.sponsorblock-text") }}
			<a href="https://sponsor.ajay.app" class="text-signal hover:text-primary"
				>https://sponsor.ajay.app</a
			>
		</p>
	</div>
</template>

<script setup lang="ts">
import { sourceCodeUrl, licenseUrl } from "@/util/source-code";
import { Separator } from "@/components/ui/separator";
</script>
