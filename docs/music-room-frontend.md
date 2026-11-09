# Collective music frontend contract

The room UI consumes `server/music/room-music-api.md` and the existing
`MusicRoomActionInput`, `MusicRoomPublic`, `MusicRoomRequestSummary` and
`MusicRoomResult` types. Additive preview, rule vocabulary and private pending-page
DTOs extend that contract, with no separate REST control channel, catalogue
candidates, local scheduling, or demo data.

## Ownership and lifecycle

`Room.vue` calls `provideMusicRoom()` once. Descendants use `useMusicRoom()`.
`createMusicRoomCommands()` owns one `api.onMusicResult` subscription, removes it
on scope disposal, and correlates only outstanding commands. Commands always
carry a fresh correlation UUID and the highest revision observed in public sync
or correlated replies. Only one mutation is outstanding at a time. Timers expire
after 20 seconds; late/foreign replies are ignored. Disconnect, room/route/client
identity changes, account replacement/logout and `users/SET_AUTH_TOKEN` clear
private pages, pending confirmations, retries and timers. Account/token mutations
also require a subsequent music sync before allowing new commands. Tokens are
never read by the composable, copied into DTOs or logged.

The authenticated participant is matched through `participants.clientIds` using
`store.state.users.you.id`; no participant ID is submitted by the UI. Grants are
rechecked at command time. Guests may issue authorized manual requests and edit
supplied room moods; personal tags/favorites explicitly require a login.

## Commands and privacy

- `request`: one original provider `service/id`, playback extras and explicit
  `mix` or `next` intent, with a fresh request UUID for each explicit play. Retry
  preserves that UUID, reference, options and intent. Next never calls `playNow`.
- `preferences`: only the viewer's draft inclusion/exclusion arrays, applied with
  explicit `keep` or `renew`. This is independent of track annotations/favorites.
- `settings`: only fairShare, autoAdmitOnJoin and removeDepartedEntries, under
  `configure-room.other`; replan uses `manage-queue.order`.
- `remove`: an occurrence entryId under `manage-queue.remove`.
- `confirm`: only the trackId and exact participantId/moodId pairs returned for
  this request. The dialog groups all pairs by excluding participant. Updated
  server conflicts replace the offer, so previously accepted pairs are not
  invented or accumulated by the client. Cancel sends `cancel`; it never admits.
- `queue`/`requests`: private correlated reads with 25 items per page, no imposed
  business quota or borrowed catalogue offset cap. Revision changes invalidate
  pages and refresh page zero. Old responses cannot replace a newer revision.
  The pending view sends `requests` with `filter: "pending"`; its total is the
  caller-only pending count. History keeps the default `all` filter. Both views
  refresh bounded slices on revisions; neither drains historical pages. Request
  titles come from sanitized summaries, with a localized fallback.

Results expose loading, rejection, source unavailability, slot conflict, stale
revision and uncertain timeout/disconnection. No failed mutation is automatically
replayed. Explicit retry repeats the same intent with a new correlation and the
latest known revision. The server remains responsible for final authorization,
idempotence, conflict validation and ordering.

## Rendering and playback

Music mode hides the legacy VideoQueue and RestoreQueue, including while music
sync is loading. The badge and five-item short peek use music.queue/queueTotal;
the full view requests server pages. Entries show title/artists, origin and the
public contributor name. A departed contributor has an honest unavailable label.
Names already observed in this mounted room are retained for departed contributors;
a restored room cannot identify an absent contributor by name until the server
supplies historical contributor names in entry DTOs.
There is no free reordering. Existing legacy modes retain their components.

The settings selector adds QueueMode.Music through the existing PATCH settings
API and set-queue-mode grant. Entering or leaving Music is disabled while any
source or active queue remains, and guarded again during form submission.

The single OmniPlayer and its existing source/autoplay/synchronization callbacks
are unchanged. VideoControls passes real music.current trackId,
contributorMoodIds and contributorMoods (including custom metadata) to the existing
TrackMoods. Personal favorites are reused independently. A coordinated Popover
and existing PlayerPanel allow one dock panel at a time. Transport/volume remain
mounted; small screens give panel triggers their own row. Panel scrolling uses
RoomPlayerLayout's visual-viewport and dock-height variables, including its
keyboard/safe-area behavior. No browser layout verification is implied by tests.

## Additive interfaces

- Preview results and highlighted items carry optional `originalReference: { service, id }`.
  Extractor/adapters retain the identity before playable service/ID transformation,
  including batches, filtered failures and cache hits. The UI prefers that returned
  reference and keeps its conservative fallback for older servers. Admission still
  validates the ordinary MusicReferenceSchema and grants. No client-supplied
  originalReference grants access. Playable metadata and catalogue identity stay separate.
- Public `ruleMoods: Mood[]` contains vocabulary only for active include/exclude IDs.
  Private request `conflictMetadata` describes exactly the offered pairs, with mood
  name/icon/ID and authoritative excluding participant names. Guests reuse these
  supplied values; an account vocabulary browse is optional. Unknown names or moods
  keep confirmation disabled. New offers replace old pairs. Departed participants
  can retain the last authoritative name, without exposing unrelated annotations.
- `requests.filter` accepts `all` (the legacy default) or `pending` and rejects
  unknown fields/values. Replies add caller-only `pendingCount`; page totals follow
  the chosen filter. Request summaries add a sanitized `title`. Older requests
  invalidated today and pending requests after history entry 25 are discoverable
  directly in the bounded pending view. Cancellation, next-slot conflicts and
  requestId idempotence use the existing protocol.

RoomMusic accepts an optional final constructor callback
`names: () => { participantId: string; name: string }[]`, after redisSnapshot.
Room supplies authoritative names via getUserInfo and musicIdentity, including guests.
The integrated Room regression exercises a guest's private custom-mood conflict and
confirmation through processUnauthorizedRequest. No commit/playback/context/scheduler
or authorization semantics are changed by this name callback.

Playlist library jobs are owned by a concurrent lot; recommendations and listening
history browsing remain later lots.
No multi-track admission or manual queue cap is invented here.

## Verification

The focused client tests use mocked transport/provider DTOs, never fabricated
production state. The live E2E scenario in `tests/e2e/integration/music-room.spec.ts`
requires the normal OTT services and migrated music SQL tables; it uses real
guest commands and no live provider. It is added but has not been run here.

Validation uses pinned Yarn 4.1.0. Native build scripts are skipped during the
immutable install. Vite/Vitest use the existing client config with envDir
overridden to an empty directory via an ignored temporary config under
node_modules/.cache/music-room-validation, so instance environment files and
development credentials are not read. Esbuild needs escalation because sandbox
ancestor-directory resolution fails before test collection. No lockfile changes,
push, PR or deployment are part of this lot.

Contract follow-up checks: `tsc --noEmit` passes in common, server and client;
the client Vite production build, targeted ESLint, Biome and Vue Prettier checks pass.
Seven focused client suites pass 71 tests, including all 21 personal-music paging
regressions. Nine server suites pass 196 tests with real SQLite fixtures and
mocked provider transport; all 71 common tests pass. The provider fixture coverage
includes actual Invidious direct/HLS/DASH transformation, Odysee identities, cached
search/metadata, filtered/reordered batches, highlighted collections, and stable
catalogue identity across refreshed playable aliases. Room fixtures exercise 30
pending requests, old requests invalidated now, private dispatch and account/guest
isolation. The production build emits dependency pure-annotation and locale
dynamic-import warnings; Vitest reports existing legacy component/Sass warnings.
These are implementation checks, not independent review or live browser, provider,
PostgreSQL or Redis validation. The Room name callback integration is covered as above.

Exact focused suites (pinned Yarn via `node .yarn/releases/yarn-4.1.0.cjs`):

- Server `vitest run tests/unit/room-music.spec.ts tests/unit/room-music-boundaries.spec.ts tests/unit/preview-reference.spec.ts tests/unit/infoextractor.spec.ts tests/unit/services/invidious.spec.ts tests/unit/services/odysee.spec.ts tests/unit/music-catalogue.spec.ts tests/unit/api/music.spec.ts tests/unit/music-scheduler.spec.ts`.
- Client `vitest run --config ../node_modules/.cache/music-room-validation/vite.config.mjs tests/unit/collective-music.component.spec.ts tests/unit/AddPreview.component.spec.ts tests/unit/room-music.spec.ts tests/unit/music.component.spec.ts tests/unit/RoomSettingsForm.component.spec.ts tests/unit/RoomPlayerLayout.component.spec.ts tests/unit/VideoControls.component.spec.ts`.
- Common `vitest run`; each workspace `tsc --noEmit`; client
  `vite build --config ../node_modules/.cache/music-room-validation/vite.config.mjs`.
- Targeted ESLint covers all changed TS/Vue source and test files, Biome covers
  the 16 changed TS files, and Prettier checks the four changed Vue files.

Server tests use `NODE_ENV=test DB_MODE=sqlite`; no development configuration
was loaded. The native SQLite 5.1.5 binary was reused from the parent checkout in
ignored node_modules. The immutable install skips native build scripts and changes
no package manifest or lockfile. Browser, visual and E2E tests were not run.
