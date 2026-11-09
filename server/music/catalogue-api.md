# Catalogue integration contract

This module supplies persistent catalogue/library/annotation foundations. It does not change Room,
the WebSocket protocol, queue scheduling, frontend, media indexing or playlist jobs.

## Persistence and initial choices

Run the existing Sequelize migration command before using the API. Migration
`20261109190000-create-music-catalogue.js` adds six tables in one transaction and seeds the five
`DEFAULT_MOODS` from `ott-common/models/music.js`, using stable UUIDs. The down migration removes
only these six tables. Neither migration nor model registration imports any `CachedVideo`.

- `Track` stores title, artists, styles, reference duration in seconds and artwork URL. Existing
  adapter metadata has no reliable music credits/genres: artists/styles initially remain empty;
  duration/artwork may be null. No title parsing or title-based merging is performed.
- `TrackSource` is unique on `(service, providerId)`. The initial track/source UUIDs are deterministic
  opaque hashes of the original adapter identity. A resolved temporary direct URL is not that
  identity: Invidious/Odysee-style aliases are refreshed at playback time by the existing extractor.
  A source can later be explicitly associated with an equivalent Track by trusted catalogue code;
  there is deliberately no user-facing merge/relink endpoint.
- Availability starts `available` after successful resolution. Background playback starts `unknown`;
  seek starts true for a positive finite known duration. These are initial hints, not device guarantees.
- Shared mood names use Unicode NFKC, trim, collapsed whitespace and locale-independent lower case.
  Names are 1–64 characters after normalization; control/format characters are rejected. Creation is
  idempotent by normalized name and cannot rename/change an existing mood's icon. The icon key must
  be in `MOOD_ICON_KEYS`. Shared vocabulary administration is deferred.
- Library membership, per-track tags and favorite shortcuts are independent. Removing membership
  or a favorite keeps annotations. Tags do not require library membership (e.g. the current room track).
- All writes use Sequelize transactions and SQL unique/foreign-key constraints. SQLite uses
  IMMEDIATE transactions to acquire the database write lock before reads, including across
  connections/processes. A per-instance mutex also prevents competing transactions on the same
  connection. SQLITE_BUSY/SQLITE_LOCKED failures retry the whole transaction at most three times;
  other errors propagate. References resolve outside transactions and notifications follow commit.
- HTTP(S) URLs used as fallback titles are replaced by `Untitled track` at import, read and playback
  adaptation. Migration `20261109210000-redact-music-url-titles.js` cleans existing titles in a
  transaction, without changing source references, membership or annotations. Its down migration
  intentionally does not restore private URLs into public metadata. Normal titles remain intact.

## Personal REST API

Mounted at `/api/music` after the existing OTT `authTokenMiddleware`. Use the existing bearer token
or token cookie for an authenticated account. Guest tokens cannot use these endpoints. The router
takes the account exclusively from `req.user.id`, resolved by the session middleware. There is no
user ID parameter in any request body or path.

All responses use `{ success: true, ...result }`, or the usual `{ success: false, error }` envelope.
All successful mutations return HTTP 200 (including repeats/no-ops). Reads are private/no-store.
The existing IP rate limiter charges 1 point for reads and 10 for writes.

| Method | Path | Input / result |
| --- | --- | --- |
| GET | `/library` | Page of `LibraryTrack` (`track`, safe `sources`, `addedAt`, `importKind`) |
| POST | `/library` | Exactly one of `{ reference: { service, id } }`, `{ url }`, `{ trackId }`; returns `{ track }` |
| DELETE | `/library/:trackId` | Removes only the caller's membership |
| GET | `/moods` | Page of shared `Mood` objects |
| POST | `/moods` | `{ name, iconKey }`; returns `{ mood }`, reusing an existing normalized name |
| GET | `/tracks/:trackId/moods` | Page of the caller's tags on this track |
| PUT / DELETE | `/tracks/:trackId/moods/:moodId` | Adds/removes exactly the caller's annotation; empty body |
| GET | `/favorites` | Page of the caller's favorite moods |
| PUT / DELETE | `/favorites/:moodId` | Adds/removes exactly the caller's shortcut; empty body |

Each page is `{ items, total, limit, offset }`. `limit` defaults to 50, maximum 100; `offset` defaults
to 0, maximum 10000. Invalid/unknown query fields or payload fields are rejected. Reference strings
are bounded to 2048 characters and provider identities to 2048 UTF-8 bytes (to keep PostgreSQL's
unique B-tree index bounded). URL imports resolve exactly one reference through an existing adapter;
collections are rejected here, for a later bounded import job. File URLs, disk paths, credentials in
URLs and arbitrary icon resource paths are rejected. Library source summaries omit `providerId`;
there is no public route to enumerate other people's libraries/annotations or resolve their sources.
Provider errors are returned without private URLs/paths. IDs are UUIDs. Missing tracks/moods are 404.

## Server integration exports

`ott-common/models/music.js` exports `TrackId`, `TrackSourceId`, `MoodId`, `Track`, `TrackSource`,
`TrackSourceCapabilities`, `TrackSourceSummary`, `Mood`, `MoodIconKey`, `MOOD_ICON_KEYS`, `DEFAULT_MOODS`,
`UserLibraryTrack`, `UserTrackMood`, `UserFavoriteMood`, `LibraryTrack`, `MusicPage`,
`AddLibraryTrackRequest`, `CreateMoodRequest`, `MusicQueueItem` and `CatalogueChange`.

`server/models/index.ts` exports initialized Sequelize model statics `Track`, `TrackSource`, `Mood`,
`UserLibraryTrack`, `UserTrackMood`, `UserFavoriteMood`. `createMusicModels(connection)` and `MusicModels`
are exported from `server/models/music.ts` for isolated tests. Normal application loading uses
`loadModels()` as before.

`server/music/catalogue.ts` exports `MusicCatalogue`, singleton `musicCatalogue`, `CatalogueResolver`,
`CatalogueException`, the five input schemas (`MusicIdSchema`, `MusicPaginationSchema`,
`MusicReferenceSchema`, `AddLibraryTrackSchema`, `CreateMoodSchema`), `validateMusicUrl`, and
`subscribeCatalogueChanges(listener)` returning an unsubscribe function.

- `resolveTrack(reference: VideoId | { url }) -> { track, source }` resolves/imports a catalogue
  reference without joining a library or changing any tags. Useful for authorized manual room requests.
- `getTrack(trackId)`, `listLibrary(userId, pagination)`, `addLibraryTrack(userId, input)`,
  `removeLibraryTrack(userId, trackId)`, `listMoods(pagination)`, `createMood(userId, input)`,
  `listTrackMoods(userId, trackId, pagination)`, `setTrackMood(userId, trackId, moodId, active)`,
  `listFavorites(userId, pagination)`, `setFavorite(userId, moodId, active)` implement the personal API.
- `toQueueItem(trackId, sourceId, extras?: QueueItemExtras) -> MusicQueueItem` resolves fresh legacy
  playback metadata, retaining `startAt`, `endAt`, `subtitleUrl`, provider-specific video fields and
  adding `trackId`/`sourceId`. It checks track/source association and rejects unavailable sources.
  **The caller must authorize room/library/source access first.** This is a server integration
  method, not a public media endpoint or permission grant. No change to `common/models/video.ts` is
  needed: `MusicQueueItem` is a compatible subtype for the integrator to use.
- `subscribeCatalogueChanges` receives committed, actual changes:
  `{ kind: "library", userId, trackId, action: "added" | "removed" }` or
  `{ kind: "annotation", userId, trackId, moodId, action }`. Listeners run after the DB transaction
  and outside the writer mutex, may return a promise, and are isolated from write responses if they
  throw. Favorites and repeated no-ops emit nothing. The future Room integrator should invalidate
  affected candidates and serialize replanning from this hook. It is process-local; cross-monolith
  propagation, durable retry/outbox and room revision management belong to that integration.

`server/api/music.ts` exports `buildMusicRouter(catalogue?)` and its default production router.

## Validation

The focused Vitest suites use real migrated SQLite databases, including a file reopened in a second
connection. They cover defaults, migration up/down and failed-migration rollback, failed-import
rollback, concurrent idempotence, changing stream aliases, absence of cache-to-library import,
normalization, SQL constraints, personal separation, favorites independence, hooks after commit,
source switching, legacy playback options, auth boundary and bounded/private REST responses.
Adapter network access and the router's rate limiter are mocked; tests do not claim live provider
or full login/browser coverage. PostgreSQL execution requires a separately configured test service.
