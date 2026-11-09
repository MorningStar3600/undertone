import { z } from "zod";
import {
	getUnacceptedManualConflicts,
	isAutomaticMusicCandidate,
	sameMoodConflict,
} from "ott-common/music/room-mood-policy.js";
import type {
	ManualMusicIntent,
	ManualMusicRequest,
	MoodExclusionConflict,
	MusicCandidate,
	MusicJson,
	MusicPlan,
	MusicQueueEntry,
	MusicRandom,
	MusicSchedulerSettings,
	MusicSchedulerState,
	RoomMoodPreference,
} from "ott-common/music/types.js";
import {
	contributionScore,
	createPlaybackHistory,
	initializeContributor,
	musicRecencyWeight,
	MusicSchedulingException,
	recordPlaybackEnded,
	recordPlaybackSource,
	recordPlaybackStarted,
	trackRecencyDistance,
} from "./playback-history.js";

/** Proposed initial values from the spec. Artist/style penalties are soft so a
 * small library never becomes permanently unplayable. No wall clock or I/O. */
export const DEFAULT_MUSIC_SCHEDULER_SETTINGS: Readonly<MusicSchedulerSettings> = Object.freeze({
	fairShare: true,
	removeDepartedEntries: true,
	autoAdmitOnJoin: true,
	recencyEpsilon: 0.02,
	recencyTau: 10,
	artistRepeatWeight: 0.1,
	styleRepeatWeight: 0.5,
});

export const musicQueueTarget = (participants: number): number => {
	if (!Number.isSafeInteger(participants) || participants < 0) {
		throw new MusicSchedulingException("Invalid participant count");
	}
	return participants >= 10 ? 10 : [0, 10, 10, 9, 12, 10, 12, 14, 8, 9][participants];
};

export const createMusicScheduler = (
	roomId: string,
	sessionId: string,
	settings: Partial<MusicSchedulerSettings> = {},
	seed = 0x9e3779b9,
): MusicSchedulerState => ({
	version: 1,
	roomId,
	sessionId,
	revision: 0,
	planRevision: 0,
	updatedAt: 0,
	settings: settingsSchema.parse({ ...DEFAULT_MUSIC_SCHEDULER_SETTINGS, ...settings }),
	participants: [],
	participantOrder: [],
	autoContributorIds: [],
	roundRobinCursor: 0,
	candidates: [],
	queue: [],
	loadedPlaybackIds: [],
	requests: [],
	nextEntrySequence: 0,
	nextRequestSequence: 0,
	rngState: seed >>> 0 || 1,
	history: createPlaybackHistory(roomId, sessionId),
});

const isNextRequest = (state: MusicSchedulerState, entry: MusicQueueEntry): boolean =>
	state.requests.some(
		request => request.requestId === entry.requestId && request.intent === "next",
	);

const cursorAfter = (state: MusicSchedulerState, id: string): number =>
	(state.participantOrder.indexOf(id) + 1) % Math.max(1, state.participantOrder.length);

const refreshedCandidate = (
	state: MusicSchedulerState,
	candidate: MusicCandidate,
): MusicCandidate =>
	state.candidates.find(
		item =>
			item.trackId === candidate.trackId &&
			item.sourceId === candidate.sourceId &&
			item.contributorId === candidate.contributorId,
	) ?? candidate;

/** Updates pending intentions separately from the active queue. Missing library
 * items alone are not interpreted as revoked media permission. */
const revalidateAdmissions = (state: MusicSchedulerState): void => {
	const present = new Set(state.participants.map(person => person.participantId));
	const existingManual = new Map(state.queue.filter(e => e.requestId).map(e => [e.requestId, e]));
	const reservedId = state.queue.find(entry => isNextRequest(state, entry))?.requestId;
	state.queue = state.queue
		.filter(entry => entry.origin === "automatic")
		.map(entry => ({ ...entry, ...refreshedCandidate(state, entry) }))
		.filter(
			entry =>
				(!state.settings.removeDepartedEntries || present.has(entry.contributorId)) &&
				isAutomaticMusicCandidate(entry, state.participants),
		);
	// A formerly pending intention may not steal an already promised slot when
	// its conflicts disappear. Validate the existing reservation first.
	const requests = [...state.requests].sort(
		(a, b) => Number(b.requestId === reservedId) - Number(a.requestId === reservedId),
	);
	for (const request of requests) {
		if (request.status === "consumed" || request.status === "cancelled") {
			continue;
		}
		request.candidate = structuredClone(refreshedCandidate(state, request.candidate));
		if (state.settings.removeDepartedEntries && !present.has(request.candidate.contributorId)) {
			request.status = "cancelled";
			continue;
		}
		request.offeredConflicts = getUnacceptedManualConflicts(
			request.candidate,
			state.participants,
			request.acceptedConflicts,
		);
		const occupied =
			request.intent === "next" && state.queue.some(entry => isNextRequest(state, entry));
		if (!request.candidate.sourceUsable || request.offeredConflicts.length || occupied) {
			request.status = "pending";
			continue;
		}
		request.status = "admitted";
		const previous = existingManual.get(request.requestId);
		state.queue.push({
			...structuredClone(request.candidate),
			entryId: request.entryId,
			origin: request.origin,
			requestId: request.requestId,
			admittedAt: previous?.admittedAt ?? state.updatedAt,
		});
	}
};

/** Pure projection: copies scores/cursor, never records a real start. The default
 * seeded RNG is serializable; an injected RNG must yield values in [0,1).
 * Call only on meaningful scheduling changes, then publish the returned plan.
 * Dequeue consumes that published plan without a second random choice. */
export const projectMusicPlan = (
	snapshot: MusicSchedulerState,
	injectedRandom?: MusicRandom,
): MusicPlan => {
	const state = structuredClone(snapshot);
	revalidateAdmissions(state);
	let rngState = state.rngState;
	const random = (): number => {
		let value: number;
		if (injectedRandom) {
			value = injectedRandom();
		} else {
			rngState ^= rngState << 13;
			rngState ^= rngState >>> 17;
			rngState ^= rngState << 5;
			rngState >>>= 0;
			value = rngState / 0x100000000;
		}
		if (!(value >= 0 && value < 1)) {
			throw new MusicSchedulingException("RNG must yield [0,1)");
		}
		return value;
	};
	const scores = new Map(
		state.history.scores.map(score => [score.contributorId, score.base + score.plays]),
	);
	let cursor = state.roundRobinCursor;
	const previousReal = state.history.events.at(-1)?.entry;
	let previous = state.current?.entry ?? previousReal;
	const recentTracks = state.history.events.map(event => event.entry.trackId);
	const styleCounts = new Map<string, number>();
	for (const event of state.history.events.slice(-10)) {
		for (const id of new Set(event.entry.styleIds)) {
			styleCounts.set(id, (styleCounts.get(id) ?? 0) + 1);
		}
	}
	if (state.current && !state.current.started) {
		const entry = state.current.entry;
		scores.set(entry.contributorId, (scores.get(entry.contributorId) ?? 0) + 1);
		recentTracks.push(entry.trackId);
		if (!isNextRequest(state, entry)) {
			cursor = cursorAfter(state, entry.contributorId);
		}
	}
	const remaining = [...state.queue];
	const queuedTracks = new Set(remaining.map(entry => entry.trackId));
	const present = new Set(state.participants.map(person => person.participantId));
	let pool = state.candidates.filter(
		candidate =>
			present.has(candidate.contributorId) &&
			state.autoContributorIds.includes(candidate.contributorId) &&
			!queuedTracks.has(candidate.trackId) &&
			isAutomaticMusicCandidate(candidate, state.participants),
	);
	let capacity = Math.max(0, musicQueueTarget(state.participants.length) - remaining.length);
	let nextEntrySequence = state.nextEntrySequence;
	const entries: MusicQueueEntry[] = [];
	const simulate = (entry: MusicQueueEntry, priority = false): void => {
		entries.push(entry);
		scores.set(entry.contributorId, (scores.get(entry.contributorId) ?? 0) + 1);
		if (!priority) {
			cursor = cursorAfter(state, entry.contributorId);
		}
		previous = entry;
		recentTracks.push(entry.trackId);
		for (const id of new Set(entry.styleIds)) {
			styleCounts.set(id, (styleCounts.get(id) ?? 0) + 1);
		}
	};
	const reserved = remaining.findIndex(entry => isNextRequest(state, entry));
	if (reserved >= 0) {
		simulate(remaining.splice(reserved, 1)[0], true);
	}
	const weightedPick = <T extends MusicCandidate>(choices: T[]): T => {
		// Avoid immediate track repetition when this contributor has an alternative.
		const alternatives = choices.filter(candidate => candidate.trackId !== previous?.trackId);
		if (alternatives.length) {
			choices = alternatives;
		}
		const weights = choices.map(candidate => {
			const lastIndex = recentTracks.lastIndexOf(candidate.trackId);
			const distance = lastIndex < 0 ? undefined : recentTracks.length - 1 - lastIndex;
			const recency = musicRecencyWeight(
				distance,
				state.settings.recencyEpsilon,
				state.settings.recencyTau,
			);
			const artist = candidate.artistIds.some(id => previous?.artistIds.includes(id))
				? state.settings.artistRepeatWeight
				: 1;
			const style = candidate.styleIds.length
				? 1 /
					(1 +
						(state.settings.styleRepeatWeight *
							candidate.styleIds.reduce(
								(sum, id) => sum + (styleCounts.get(id) ?? 0),
								0,
							)) /
							candidate.styleIds.length)
				: 1;
			return recency * artist * style;
		});
		let needle = random() * weights.reduce((sum, weight) => sum + weight, 0);
		for (let index = 0; index < choices.length; index++) {
			needle -= weights[index];
			if (needle < 0) {
				return choices[index];
			}
		}
		return choices[choices.length - 1];
	};
	while (remaining.length || (capacity > 0 && pool.length)) {
		const available = [
			...new Set([
				...remaining.map(entry => entry.contributorId),
				...(capacity > 0 ? pool.map(candidate => candidate.contributorId) : []),
			]),
		];
		if (!available.length) {
			break;
		}
		let owner: string;
		if (state.settings.fairShare) {
			const min = Math.min(...available.map(id => scores.get(id) ?? 0));
			const tied = available.filter(id => (scores.get(id) ?? 0) === min);
			owner = tied[Math.floor(random() * tied.length)];
		} else {
			const order = state.participantOrder;
			const rotated = [...order.slice(cursor), ...order.slice(0, cursor)];
			owner = rotated.find(id => available.includes(id)) ?? available[0];
		}
		const manual = remaining
			.filter(entry => entry.contributorId === owner && entry.origin !== "automatic")
			.sort(
				(a, b) =>
					(state.requests.find(r => r.requestId === a.requestId)?.order ?? 0) -
					(state.requests.find(r => r.requestId === b.requestId)?.order ?? 0),
			)[0];
		let selected: MusicQueueEntry;
		if (manual) {
			selected = manual;
		} else {
			const existing = remaining.filter(entry => entry.contributorId === owner);
			const fresh =
				capacity > 0 ? pool.filter(candidate => candidate.contributorId === owner) : [];
			const choice = weightedPick<MusicCandidate>([...existing, ...fresh]);
			const admitted = existing.find(entry => entry === choice);
			if (admitted) {
				selected = admitted;
			} else {
				selected = {
					...structuredClone(choice),
					entryId: `${state.sessionId}:auto:${nextEntrySequence++}`,
					origin: "automatic",
					admittedAt: state.updatedAt,
				};
				capacity--;
			}
		}
		const index = remaining.indexOf(selected);
		if (index >= 0) {
			remaining.splice(index, 1);
		}
		pool = pool.filter(candidate => candidate.trackId !== selected.trackId);
		simulate(selected);
	}
	return { entries, rngState, nextEntrySequence };
};

export type MusicSchedulerCommand =
	| {
			type: "context";
			participants: RoomMoodPreference[];
			/** Library candidates eligible for automatic generation only. */
			candidates: MusicCandidate[];
			/** Fresh metadata/tags/usability for queued or pending sources outside
			 * those libraries. These snapshots never enter the generation pool. */
			occurrenceCandidates?: MusicCandidate[];
			now: number;
	  }
	| { type: "settings"; settings: Partial<MusicSchedulerSettings>; now: number }
	| { type: "replan"; content?: "keep" | "renew"; now: number }
	| {
			type: "request";
			requestId: string;
			candidate: MusicCandidate;
			intent: ManualMusicIntent;
			origin?: "manual" | "recommendation";
			now: number;
	  }
	| {
			type: "confirm";
			requestId: string;
			trackId: string;
			conflicts: MoodExclusionConflict[];
			now: number;
	  }
	| { type: "cancel"; requestId: string; now: number }
	| { type: "remove"; entryId: string; now: number }
	| { type: "load-next"; playbackId: string; now: number }
	| { type: "started"; playbackId: string; now: number }
	| {
			type: "ended";
			playbackId: string;
			reason: "finished" | "skipped" | "interrupted" | "error";
			now: number;
	  }
	| { type: "update-source"; entryId: string; candidate: MusicCandidate; now: number };

export interface MusicSchedulerTransition {
	state: MusicSchedulerState;
	status:
		| "applied"
		| "duplicate"
		| "revision-conflict"
		| "request-conflict"
		| "slot-conflict"
		| "confirmation-required"
		| "source-unavailable"
		| "not-found"
		| "empty"
		| "invalid-confirmation";
	request?: ManualMusicRequest;
}

/** Pure transactional reducer. Room MUST serialize read -> transition -> persist
 * -> publish under its business mutex (or CAS the revision and retry on conflict).
 * Two reducers evaluated against one snapshot cannot commit both next-slot claims.
 * Authentication, permissions and trusted catalogue snapshots belong to the adapter.
 * An offered conflict list is not a capability: confirm must be the request author's
 * authenticated action. Never accept acceptedConflicts directly from a client.
 *
 * Integration sequence: context/rules -> persist+publish; load-next takes exactly
 * the published head (loading paused is free); started records the real start;
 * replan refills/reorders and must be published before the next load-next.
 * ended records the cause, including an unstarted load failure without a debit.
 * Supply fresh candidates AND occurrenceCandidates on relevant tag/source changes.
 * A favourite change needs no command. Return pending requests to their author,
 * not as rejected items in the public queue. No method interrupts current. */
export const transitionMusicScheduler = (
	snapshot: MusicSchedulerState,
	command: MusicSchedulerCommand,
	options: { expectedRevision: number; random?: MusicRandom },
): MusicSchedulerTransition => {
	const unchanged = (status: MusicSchedulerTransition["status"]): MusicSchedulerTransition => ({
		state: snapshot,
		status,
	});
	if (options.expectedRevision !== snapshot.revision) {
		return unchanged("revision-conflict");
	}
	time.parse(command.now);
	const state = structuredClone(snapshot);
	state.updatedAt = command.now;
	let plan = true;
	let status: MusicSchedulerTransition["status"] = "applied";
	let requestId: string | undefined;
	switch (command.type) {
		case "context": {
			const ids = command.participants.map(person => person.participantId);
			if (new Set(ids).size !== ids.length) {
				throw new MusicSchedulingException("Participants must be deduplicated");
			}
			const established = ids.filter(id =>
				state.history.scores.some(s => s.contributorId === id),
			);
			for (const id of ids) {
				state.history = initializeContributor(state.history, id, established);
				if (!state.participantOrder.includes(id)) {
					state.participantOrder.push(id);
				}
				if (
					!snapshot.participants.some(p => p.participantId === id) &&
					state.settings.autoAdmitOnJoin
				) {
					state.autoContributorIds.push(id);
				}
			}
			state.autoContributorIds = [...new Set(state.autoContributorIds)].filter(id =>
				ids.includes(id),
			);
			state.participants = z.array(preferenceSchema).parse(command.participants);
			state.candidates = z.array(candidateSchema).parse(command.candidates);
			for (const candidate of z
				.array(candidateSchema)
				.parse(command.occurrenceCandidates ?? [])) {
				const matches = (item: MusicCandidate): boolean =>
					item.trackId === candidate.trackId &&
					item.sourceId === candidate.sourceId &&
					item.contributorId === candidate.contributorId;
				for (const entry of state.queue) {
					if (matches(entry)) {
						Object.assign(entry, candidate);
					}
				}
				for (const request of state.requests) {
					if (matches(request.candidate)) {
						request.candidate = candidate;
					}
				}
			}
			break;
		}
		case "settings": {
			const enabled =
				command.settings.autoAdmitOnJoin === true && !state.settings.autoAdmitOnJoin;
			state.settings = settingsSchema.parse({ ...state.settings, ...command.settings });
			if (enabled) {
				state.autoContributorIds = state.participants.map(p => p.participantId);
			}
			break;
		}
		case "replan":
			if (command.content === "renew") {
				state.queue = state.queue.filter(e => e.origin !== "automatic");
			}
			break;
		case "request": {
			const existing = state.requests.find(
				request => request.requestId === command.requestId,
			);
			if (existing) {
				if (
					existing.candidate.trackId !== command.candidate.trackId ||
					existing.candidate.contributorId !== command.candidate.contributorId ||
					existing.intent !== command.intent
				) {
					return unchanged("request-conflict");
				}
				return { ...unchanged("duplicate"), request: structuredClone(existing) };
			}
			if (
				!state.participants.some(p => p.participantId === command.candidate.contributorId)
			) {
				return unchanged("not-found");
			}
			if (
				command.intent === "next" &&
				state.queue.some(entry => isNextRequest(state, entry))
			) {
				return unchanged("slot-conflict");
			}
			requestId = command.requestId;
			state.requests.push({
				requestId,
				candidate: candidateSchema.parse(command.candidate),
				intent: command.intent,
				origin: command.origin ?? "manual",
				requestedAt: command.now,
				order: state.nextRequestSequence++,
				entryId: `${state.sessionId}:manual:${requestId}`,
				status: "pending",
				acceptedConflicts: [],
				offeredConflicts: [],
			});
			break;
		}
		case "confirm": {
			const request = state.requests.find(item => item.requestId === command.requestId);
			if (!request || request.candidate.trackId !== command.trackId) {
				return unchanged("not-found");
			}
			if (request.status === "consumed" || request.status === "cancelled") {
				return unchanged("duplicate");
			}
			if (
				command.conflicts.some(
					conflict =>
						!request.offeredConflicts.some(offered =>
							sameMoodConflict(conflict, offered),
						) &&
						!request.acceptedConflicts.some(accepted =>
							sameMoodConflict(conflict, accepted),
						),
				)
			) {
				return unchanged("invalid-confirmation");
			}
			const additions = command.conflicts.filter(
				(conflict, index) =>
					command.conflicts.findIndex(other => sameMoodConflict(conflict, other)) ===
						index &&
					!request.acceptedConflicts.some(accepted =>
						sameMoodConflict(conflict, accepted),
					),
			);
			if (!additions.length && request.status === "admitted") {
				return unchanged("duplicate");
			}
			if (
				request.intent === "next" &&
				state.queue.some(
					entry => entry.requestId !== request.requestId && isNextRequest(state, entry),
				)
			) {
				return unchanged("slot-conflict");
			}
			request.acceptedConflicts.push(...structuredClone(additions));
			request.confirmedAt = command.now;
			requestId = request.requestId;
			break;
		}
		case "cancel": {
			const request = state.requests.find(item => item.requestId === command.requestId);
			if (!request) {
				return unchanged("not-found");
			}
			if (request.status === "consumed" || request.status === "cancelled") {
				return unchanged("duplicate");
			}
			request.status = "cancelled";
			state.queue = state.queue.filter(entry => entry.requestId !== request.requestId);
			break;
		}
		case "remove": {
			const entry = state.queue.find(item => item.entryId === command.entryId);
			if (!entry) {
				return unchanged("not-found");
			}
			state.queue = state.queue.filter(item => item.entryId !== command.entryId);
			const request = state.requests.find(item => item.requestId === entry.requestId);
			if (request) {
				request.status = "cancelled";
			}
			break;
		}
		case "load-next": {
			if (state.loadedPlaybackIds.includes(command.playbackId)) {
				return unchanged("duplicate");
			}
			const entry = state.queue.shift();
			if (!entry) {
				return unchanged("empty");
			}
			state.current = { entry, playbackId: command.playbackId, started: false };
			state.loadedPlaybackIds.push(id.parse(command.playbackId));
			const request = state.requests.find(item => item.requestId === entry.requestId);
			if (request) {
				request.status = "consumed";
			}
			// Deliberately no refill or random draw at dequeue. Replan separately and
			// publish before another load-next; the existing published head is stable.
			plan = false;
			break;
		}
		case "started": {
			if (state.history.events.some(event => event.playbackId === command.playbackId)) {
				return unchanged("duplicate");
			}
			if (state.current?.playbackId !== command.playbackId) {
				return unchanged("not-found");
			}
			if (!state.current.entry.sourceUsable) {
				return unchanged("source-unavailable");
			}
			state.history = recordPlaybackStarted(
				state.history,
				command.playbackId,
				state.current.entry,
				command.now,
			);
			state.current.started = true;
			if (!isNextRequest(state, state.current.entry)) {
				state.roundRobinCursor = cursorAfter(state, state.current.entry.contributorId);
			}
			plan = false;
			break;
		}
		case "ended": {
			if (state.current?.playbackId === command.playbackId && !state.current.started) {
				delete state.current;
				break;
			}
			if (!state.history.events.some(event => event.playbackId === command.playbackId)) {
				return unchanged("not-found");
			}
			if (
				state.history.events.some(
					event => event.playbackId === command.playbackId && event.endedAt !== undefined,
				)
			) {
				return unchanged("duplicate");
			}
			state.history = recordPlaybackEnded(
				state.history,
				command.playbackId,
				command.now,
				command.reason,
			);
			plan = false;
			break;
		}
		case "update-source": {
			const entry =
				state.current?.entry.entryId === command.entryId
					? state.current.entry
					: state.queue.find(e => e.entryId === command.entryId);
			const request = state.requests.find(r => r.entryId === command.entryId);
			const original = entry ?? request?.candidate;
			if (!original) {
				return unchanged("not-found");
			}
			if (
				original.trackId !== command.candidate.trackId ||
				original.contributorId !== command.candidate.contributorId
			) {
				return unchanged("request-conflict");
			}
			const candidate = candidateSchema.parse(command.candidate);
			if (entry) {
				Object.assign(entry, candidate);
			}
			if (request) {
				request.candidate = candidate;
			}
			state.candidates = state.candidates.map(c =>
				c.trackId === candidate.trackId &&
				c.contributorId === candidate.contributorId &&
				c.sourceId === candidate.sourceId
					? candidate
					: c,
			);
			// Replace snapshot of this source without adding a non-library fallback
			// to the automatic pool. Queue/manual snapshots remain authoritative.
			if (state.current?.entry.entryId === command.entryId) {
				state.history = recordPlaybackSource(
					state.history,
					state.current.playbackId,
					command.candidate.sourceId,
				);
				plan = false;
			}
			break;
		}
	}
	state.revision++;
	if (plan) {
		revalidateAdmissions(state);
		const projected = projectMusicPlan(state, options.random);
		state.queue = projected.entries;
		state.rngState = projected.rngState;
		state.nextEntrySequence = projected.nextEntrySequence;
		state.planRevision = state.revision;
	}
	const request = state.requests.find(item => item.requestId === requestId);
	if (request?.offeredConflicts.length) {
		status = "confirmation-required";
	} else if (request && !request.candidate.sourceUsable) {
		status = "source-unavailable";
	}
	return { state, status, ...(request ? { request: structuredClone(request) } : {}) };
};

const id = z.string().min(1);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const time = z.number().finite();
const json: z.ZodType<MusicJson> = z.lazy(() =>
	z.union([
		z.null(),
		z.boolean(),
		z.number().finite(),
		z.string(),
		z.array(json),
		z.record(json),
	]),
);
const candidateSchema = z.object({
	trackId: id,
	sourceId: id,
	contributorId: id,
	artistIds: z.array(id),
	styleIds: z.array(id),
	tagsByUser: z.record(z.array(id)),
	sourceUsable: z.boolean(),
	mediaRef: json,
});
const entrySchema = candidateSchema.extend({
	entryId: id,
	origin: z.enum(["automatic", "manual", "recommendation"]),
	admittedAt: time,
	requestId: id.optional(),
});
const conflictSchema = z.object({ participantId: id, moodId: id });
const preferenceSchema = z
	.object({ participantId: id, includeMoodIds: z.array(id), excludeMoodIds: z.array(id) })
	.refine(
		p => !p.includeMoodIds.some(id => p.excludeMoodIds.includes(id)),
		"A mood cannot be included and excluded by the same person",
	);
const settingsSchema = z.object({
	fairShare: z.boolean(),
	removeDepartedEntries: z.boolean(),
	autoAdmitOnJoin: z.boolean(),
	recencyEpsilon: z.number().positive().max(1),
	recencyTau: z.number().positive().finite(),
	artistRepeatWeight: z.number().positive().max(1),
	styleRepeatWeight: z.number().nonnegative().max(1),
});
const stateSchema = z.object({
	version: z.literal(1),
	roomId: id,
	sessionId: id,
	revision: count,
	planRevision: count,
	updatedAt: time,
	settings: settingsSchema,
	participants: z.array(preferenceSchema),
	participantOrder: z.array(id),
	autoContributorIds: z.array(id),
	roundRobinCursor: count,
	candidates: z.array(candidateSchema),
	queue: z.array(entrySchema),
	loadedPlaybackIds: z.array(id),
	current: z.object({ entry: entrySchema, playbackId: id, started: z.boolean() }).optional(),
	requests: z.array(
		z.object({
			requestId: id,
			candidate: candidateSchema,
			intent: z.enum(["mix", "next"]),
			origin: z.enum(["manual", "recommendation"]),
			requestedAt: time,
			order: count,
			entryId: id,
			status: z.enum(["pending", "admitted", "consumed", "cancelled"]),
			acceptedConflicts: z.array(conflictSchema),
			offeredConflicts: z.array(conflictSchema),
			confirmedAt: time.optional(),
		}),
	),
	nextEntrySequence: count,
	nextRequestSequence: count,
	rngState: count.min(1).max(0xffffffff),
	history: z.object({
		version: z.literal(1),
		roomId: id,
		sessionId: id,
		scores: z.array(z.object({ contributorId: id, base: count, plays: count })),
		events: z.array(
			z.object({
				playbackId: id,
				roomId: id,
				sessionId: id,
				entry: entrySchema,
				startedAt: time,
				endedAt: time.optional(),
				endReason: z.enum(["finished", "skipped", "interrupted", "error"]).optional(),
				actualSourceId: id,
			}),
		),
	}),
});

/** Restore without reshuffling or losing confirmations/RNG/debt. Persist this
 * document atomically with history events; never restore an untrusted client DTO. */
export const restoreMusicScheduler = (serialized: unknown): MusicSchedulerState => {
	const state = stateSchema.parse(serialized) as MusicSchedulerState;
	const unique = (ids: string[]): boolean => new Set(ids).size === ids.length;
	const plays = new Map<string, number>();
	for (const event of state.history.events) {
		plays.set(event.entry.contributorId, (plays.get(event.entry.contributorId) ?? 0) + 1);
	}
	const scoreIds = new Set(state.history.scores.map(score => score.contributorId));
	const automaticEntries = [
		...state.queue,
		...(state.current ? [state.current.entry] : []),
		...state.history.events.map(event => event.entry),
	].filter(entry => entry.origin === "automatic");
	const autoPrefix = `${state.sessionId}:auto:`;
	const requestMatches = (entry: MusicQueueEntry): boolean => {
		if (entry.origin === "automatic") {
			return entry.requestId === undefined;
		}
		return state.requests.some(
			request =>
				request.requestId === entry.requestId &&
				request.entryId === entry.entryId &&
				request.candidate.trackId === entry.trackId &&
				request.candidate.contributorId === entry.contributorId &&
				request.origin === entry.origin,
		);
	};
	if (
		state.history.roomId !== state.roomId ||
		state.history.sessionId !== state.sessionId ||
		state.planRevision > state.revision ||
		!unique(state.queue.map(e => e.entryId)) ||
		!unique(state.requests.map(r => r.requestId)) ||
		!unique(state.requests.map(r => r.entryId)) ||
		!unique(state.requests.map(r => String(r.order))) ||
		!unique(state.participantOrder) ||
		!unique(state.participants.map(p => p.participantId)) ||
		!unique(state.history.events.map(e => e.playbackId)) ||
		!unique(state.loadedPlaybackIds) ||
		!unique(state.history.scores.map(s => s.contributorId)) ||
		state.history.scores.some(score => score.plays !== (plays.get(score.contributorId) ?? 0)) ||
		state.history.events.some(event => !scoreIds.has(event.entry.contributorId)) ||
		state.history.events.some(event => !state.loadedPlaybackIds.includes(event.playbackId)) ||
		state.participants.some(
			p =>
				!state.participantOrder.includes(p.participantId) || !scoreIds.has(p.participantId),
		) ||
		state.autoContributorIds.some(
			id => !state.participants.some(p => p.participantId === id),
		) ||
		state.roundRobinCursor >= Math.max(1, state.participantOrder.length) ||
		state.requests.some(request => request.order >= state.nextRequestSequence) ||
		state.requests.some(
			request => request.entryId !== `${state.sessionId}:manual:${request.requestId}`,
		) ||
		automaticEntries.some(entry => {
			const sequence = Number(entry.entryId.slice(autoPrefix.length));
			return (
				!entry.entryId.startsWith(autoPrefix) ||
				!Number.isSafeInteger(sequence) ||
				sequence < 0 ||
				sequence >= state.nextEntrySequence
			);
		}) ||
		state.queue.some(entry => !requestMatches(entry)) ||
		state.requests.some(
			request =>
				(request.status === "admitted") !==
				state.queue.some(entry => entry.requestId === request.requestId),
		) ||
		(state.current &&
			(!state.loadedPlaybackIds.includes(state.current.playbackId) ||
				state.queue.some(entry => entry.entryId === state.current!.entry.entryId) ||
				!requestMatches(state.current.entry) ||
				state.current.started !==
					state.history.events.some(
						event => event.playbackId === state.current!.playbackId,
					))) ||
		state.history.events.some(
			e => e.roomId !== state.roomId || e.sessionId !== state.sessionId,
		) ||
		state.queue.filter(e => isNextRequest(state, e)).length > 1
	) {
		throw new MusicSchedulingException("Inconsistent scheduler snapshot");
	}
	return state;
};

export const serializeMusicScheduler = (state: MusicSchedulerState): MusicSchedulerState =>
	restoreMusicScheduler(state);

// Re-export useful history queries for adapters needing one scheduling import.
export { contributionScore, trackRecencyDistance };
