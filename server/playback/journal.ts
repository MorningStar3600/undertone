import { randomUUID } from "node:crypto";
import {
	acceptPlaybackEvent,
	compactPlaybackTimeline,
	createPlaybackTimeline,
	expectedPlaybackAt,
	type PlaybackEvent,
	type PlaybackTimeline,
} from "ott-common/playback/index.js";
import type { PlaybackAttachment, PlaybackServerMessage } from "ott-common/playback/transport.js";
import type { QueueItem } from "ott-common/models/video.js";

export interface PlaybackObservation {
	currentSource: QueueItem | null;
	positionSeconds: number;
	isPlaying: boolean;
	rate: number;
	playbackId?: string;
}
type EventBody = PlaybackEvent extends infer E
	? E extends PlaybackEvent
		? Omit<E, "epoch" | "sequence" | "effectiveAtMs" | "occurrenceId">
		: never
	: never;

/** Single synchronous install/publication boundary. No durable receipts or scheduled work. */
export class PlaybackJournal {
	private timeline: PlaybackTimeline;
	private attachment: PlaybackAttachment | null = null;
	private sourceKey = "";
	constructor(
		private emit: (message: PlaybackServerMessage) => void,
		now = Date.now(),
	) {
		this.timeline = createPlaybackTimeline(randomUUID(), now);
	}
	get epoch() {
		return this.timeline.epoch;
	}
	get sequence() {
		return this.timeline.baseline.sequence;
	}
	get occurrenceId() {
		return this.timeline.baseline.state?.occurrenceId ?? null;
	}
	stage(
		value: PlaybackObservation,
		options: { load?: boolean; seek?: boolean } = {},
		atMs = Date.now(),
	): () => void {
		const messages: PlaybackServerMessage[] = [];
		const candidate = new PlaybackJournal(message => messages.push(message));
		candidate.timeline = structuredClone(this.timeline);
		candidate.attachment = structuredClone(this.attachment);
		candidate.sourceKey = this.sourceKey;
		candidate.commit(value, options, atMs);
		return () => {
			this.timeline = candidate.timeline;
			this.attachment = candidate.attachment;
			this.sourceKey = candidate.sourceKey;
			for (const message of messages) {
				this.emit(message);
			}
		};
	}
	private append(body: EventBody, now: number, attachment?: PlaybackAttachment) {
		const event = {
			...body,
			epoch: this.epoch,
			sequence: this.sequence + 1,
			effectiveAtMs: now,
			occurrenceId: this.timeline.baseline.lastOccurrenceId + (body.type === "load" ? 1 : 0),
		} as PlaybackEvent;
		const candidate = acceptPlaybackEvent(this.timeline, event).timeline;
		this.timeline = compactPlaybackTimeline(candidate, now);
		if (attachment) {
			this.attachment = attachment;
		}
		if (body.type === "clear") {
			this.attachment = null;
		}
		this.emit({
			action: "playback-event",
			event,
			...(attachment ? { attachment: structuredClone(attachment) } : {}),
		});
	}
	/** Called explicitly by accepted transitions, never by dirty setters or sync. */
	commit(
		value: PlaybackObservation,
		options: { load?: boolean; seek?: boolean } = {},
		atMs = Date.now(),
	) {
		const now = Math.max(
			atMs,
			this.timeline.baseline.serverTimeMs,
			this.timeline.baseline.lastEffectiveAtMs,
		);
		const state = expectedPlaybackAt(this.timeline, now).state;
		if (!value.currentSource) {
			if (state) {
				this.append({ type: "clear" }, now);
			}
			this.sourceKey = "";
			return;
		}
		const sourceKey = JSON.stringify([value.currentSource, value.playbackId]);
		const load = !state || options.load || this.attachment?.playbackId !== value.playbackId;
		if (load || sourceKey !== this.sourceKey) {
			// Even refreshed URLs with an unchanged provider ID get a new public mapping.
			const media = { service: "adapter", id: randomUUID() };
			const attachment: PlaybackAttachment = {
				epoch: this.epoch,
				sequence: this.sequence + 1,
				occurrenceId: this.timeline.baseline.lastOccurrenceId + (load ? 1 : 0),
				media,
				item: structuredClone(value.currentSource),
				...(value.playbackId ? { playbackId: value.playbackId } : {}),
			};
			// Session fingerprints are internal; guest domain IDs must not copy them here.
			if (attachment.item.contributorId?.startsWith("guest:")) {
				delete attachment.item.contributorId;
			}
			this.append(
				load
					? {
							type: "load",
							media,
							positionSeconds: value.positionSeconds,
							isPlaying: value.isPlaying,
							rate: value.rate,
						}
					: { type: "source", media },
				now,
				attachment,
			);
			this.sourceKey = sourceKey;
			if (load) {
				return;
			}
		}
		if (options.seek) {
			this.append({ type: "seek", positionSeconds: value.positionSeconds }, now);
		}
		if (state.rate !== value.rate) {
			this.append({ type: "rate", rate: value.rate }, now);
		}
		if (state.isPlaying !== value.isPlaying) {
			this.append({ type: value.isPlaying ? "play" : "pause" }, now);
		}
	}
	snapshot(nonce: string): Extract<PlaybackServerMessage, { action: "playback-snapshot" }> {
		// Snapshot-only recovery deliberately exposes no historical private source URLs.
		return structuredClone({
			action: "playback-snapshot",
			nonce,
			timeline: this.timeline,
			attachment: this.attachment,
		});
	}
}
