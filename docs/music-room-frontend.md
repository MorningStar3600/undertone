# Collective music frontend contract

The room UI consumes `server/music/room-music-api.md` and the existing
`MusicRoomActionInput`, `MusicRoomPublic`, `MusicRoomRequestSummary` and
`MusicRoomResult` types. It adds no backend/common/store interface, REST control
channel, catalogue candidates, local scheduling, or demo data.

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

## Concrete upstream gaps

1. **Original preview identity.** `/data/previewAdd` returns Video[] only.
   InvidiousAdapter.parseAsDirect changes service/id to direct/HLS/DASH stream
   URLs; OdyseeAdapter.fetchVideoInfo replaces the original LBRY identity with a
   streaming URL. The UI cannot reliably recover the original adapter identity.
   Required addition: per-result originalReference `{ service, id }` (also for
   highlighted results/collections), retained before provider resolution. Keep
   playback metadata separate. The current UI permits stable references and
   direct URLs unchanged from the input; it disables ambiguous resolved streams.
   It does not submit the preview input URL as an invented provider ID.
2. **Public rule/conflict vocabulary.** Public participants and private conflicts
   contain mood IDs only. The paginated `/music/moods` endpoint requires a numeric
   account. A guest cannot resolve a custom mood absent from current contributor
   metadata, and an account may need several explicit vocabulary pages. Required
   addition: public Mood metadata for active rule IDs and offered conflicts
   (with authoritative participant display names), or a token-authorized public
   vocabulary lookup by IDs. Until then the dialog refuses unnamed confirmation;
   Review later preserves the pending request, while Cancel withdraws it.
3. **Pending request discovery and titles.** `requests` slices the complete
   historical request list in insertion order, with no pending filter, title or
   pending count. The UI refreshes page zero on revisions and offers explicit
   later pages; pending older requests require navigating those pages. It cannot
   promise automatic discovery of every reconfirmation without draining history.
   Required addition: pending-only pagination/count and a sanitized track title
   in request summaries. Absent titles are labelled "Requested track" rather
   than exposing UUIDs as product copy.

Playlist library jobs, recommendations and history browsing remain later lots.
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

Final implementation checks: client `tsc --noEmit`, Vite production build,
targeted client ESLint, Biome (18 changed source/test files), Vue Prettier checks,
E2E TypeScript and targeted E2E ESLint pass. Eight focused client suites pass
73 tests, including the 21 personal-music regression tests from the authorized
fix. The production build emits dependency pure-annotation/chunk-size and locale
dynamic-import warnings; Vitest also reports the existing standalone keyboard
injection and legacy component/Sass warnings. These are implementation checks,
not an independent review or browser/provider/SQL/Redis validation.
