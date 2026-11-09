import { Heart, Headphones, Zap, Sun, CloudRain, Moon, Sparkles, Coffee, Flame } from "@lucide/vue";
import type { MoodIconKey } from "ott-common/models/music";
import type { Component } from "vue";

export const moodIcons: Record<MoodIconKey, Component> = {
	heart: Heart,
	headphones: Headphones,
	bolt: Zap,
	sun: Sun,
	"cloud-rain": CloudRain,
	moon: Moon,
	sparkles: Sparkles,
	coffee: Coffee,
	flame: Flame,
};
