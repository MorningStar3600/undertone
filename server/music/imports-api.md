# Playlist reference synchronization

This implements spec 3.4's reference/metadata branch only. No downloader, local file
indexer, media endpoint or room queue command is introduced. Imported library changes
use the catalogue's durable version and postcommit invalidation; Rooms retain control
of their short automatic queue. Moods, favorites, disappeared membership, annotations
and files are never deleted or inferred by this importer.

## HTTP contract

All paths below are relative to `/api/music/imports`, behind the existing OTT account
token middleware. Only `req.user.id` selects the owner. Anonymous sessions and API keys
without an authenticated account are rejected. UUIDs belonging to another account give
404. Bodies and query strings reject unknown properties, including user IDs.
Responses use the existing `{ success: true, ... }` envelope. Errors contain fixed,
sanitized messages. `Cache-Control: private, no-store` applies throughout.

| Method | Path | Input / result |
| --- | --- | --- |
| GET | `/sources` | `limit` 1–100 (default 50), `offset` 0–10000; MusicPage of MusicImportSource |
| POST | `/sources` | `{url, daily?}` OR `{reference: {service: "youtube", id}, daily?}`; `{source}` |
| POST | `/sources/:sourceId/run` | Empty body; `{job}`; run now or retry failed job from saved cursor |
| PUT | `/sources/:sourceId/schedule` | `{daily: boolean}`; `{source}` |
| POST | `/sources/:sourceId/cancel` | Empty body; `{source}` |
| DELETE | `/sources/:sourceId` | Empty body; soft-stop source and cancel active job; `{source}` |
| GET | `/sources/:sourceId/jobs` | Same bounded pagination; MusicPage of MusicImportJob, newest first |

Shared DTOs are in `common/models/music-imports.ts`. Times are Unix milliseconds.
Reports whitelist fields, excluding provider references, private URLs, cursors, lease
tokens, account IDs, credentials, raw errors and provider response bodies. Source cards
use an opaque source ID; run history preserves counters and last completion. Repeating
registration is idempotent for owner/service/original playlist ID. Re-registering a stopped
source restores it. Registration defaults to daily off and does not create a job. Repeated
run requests while active return the same job, so clients can retry lost responses.

Supported collection import: **YouTube playlists only**, using the configured extractor's
adapter and API key. Accepts opaque playlist IDs or HTTPS playlist/watch/short-link URLs
with a `list` parameter on exact allowed YouTube hosts. No new credentials are accepted.
Channels, private watch-later/liked lists, arbitrary URLs, and preview-only generic
adapters are not advertised as complete import sources. Legacy previews retain their cap.

## Durability and execution

Migration `20261109220000-create-music-imports.js` adds MusicImportSources,
MusicImportJobs, and separate MusicImportProvenance, with foreign keys and unique
owner/provider and source/track constraints. Uses portable Sequelize UUID, JSON-free
scalar columns and DOUBLE timestamps for SQLite/PostgreSQL. Apply migrations **before**
starting the new app. The models register with the existing database lifecycle.

One worker per process starts after extractor initialization and stops on app shutdown;
it never starts from module imports and is disabled when `NODE_ENV=test`. Tests can
explicitly inject MusicImports' database, catalogue, provider and clock and call `step`
or create a controllable worker. It performs one page per step, with five seconds between
steps, at most fifty entries and two provider requests per page (15-second timeout per
request, bounded response size). No sources/jobs means no provider calls. Full imports
follow nextPageToken, independently of preview limits. Originals stay `youtube + videoId`;
temporary resolved URLs never become identities; title equality never merges recordings.

Every mutation takes a short shared `musicTransaction`. A source row lock in PostgreSQL
or SQLite IMMEDIATE writer lock serializes enqueue/claim/cancel/commit. Claims set a
random fencing token with a 60-second lease. The source active job, token, status and
expiry are rechecked under the source lock before page commit or error recording. A
worker that dies or loses its lease cannot subsequently overwrite progress. All workers
must use this service for job changes. No transaction spans provider requests. The shared
transaction helper handles failed SQLite COMMIT connection cleanup and retry.

A page commits track/source metadata, library links, provenance, catalogue version,
counters and next cursor atomically. SQL failure leaves the prior cursor; lease recovery
replays that page idempotently. Room notifications happen after commit. Imported IDs are
source-derived, never title-derived. Provenance is retained independently of personal
library membership. Available entries refresh public metadata; private/deleted/live or
unplayable entries increment unavailable counts without deleting previously known data.
When shared track metadata or source availability changes, the same transaction advances
every affected library owner's version. Postcommit `metadata` notifications carry those
owners and track IDs; a new membership uses its existing `library/added` notification.
Unchanged replay pages do not advance catalogue versions or emit redundant notifications.

PostgreSQL page commits acquire transaction-scoped advisory locks for all provider
identities, including absent rows, in sorted source-identity order. Manual reference
creation uses the same lock protocol. After resolution, imports lock actual Track rows
in sorted UUID order with `FOR NO KEY UPDATE`, then TrackSource rows in sorted UUID
order with `FOR UPDATE`. This also serializes different provider identities mapped to
the same Track without conflicting with foreign-key key-share locks. Both metadata and
availability are reread after acquisition; comparison and conditional writes happen
under those locks. An importer that previously read M0 must therefore observe a committed
M1 before restoring M0, and advance affected versions for that restoration. SQLite keeps
its existing database-wide IMMEDIATE writer lock and whole-transaction retry behavior.
Exact sanitized metadata/source noops do not issue updates or notifications.

Membership notifications remain limited to actual library owners. Rooms additionally
poll durable public track/source fingerprints for only their current, queued and
pending/admitted occurrence tracks. Nonlibrary manual contributions, retained departed
contributions and guests converge on another monolith without a membership, private
recipient search or process-local hook. Unrelated tracks and favorites do not trigger
context regeneration. Polling remains at five seconds plus the RoomManager update;
there is no periodic full regeneration. See `room-music-api.md` for the internal contract.
The fingerprint is derived from committed rows, so this correction needs no migration
or new public REST/WebSocket DTO. Existing catalogue/room/import migrations still apply.

Five consecutive provider/storage failures use delays of 30s, 60s, 120s, 240s, then fail with saved
progress (maximum computed backoff 1h). Manual retry resets the consecutive retry budget,
retaining the cursor and cumulative counters. Successful pages reset consecutive retries.
Rolled-back storage errors receive a separate sanitized `storage` code and the same bounded
retry policy when SQL is available to record the failure; a database outage leaves the
lease recoverable and logs a fixed worker error without provider details.
A completed scan with unavailable entries is `partial`, never full success. Last full
success advances only for `succeeded`; last completion also records partial/failure/cancel.
Daily scans begin 24h after full success or partial completion, avoiding overlapping runs
and catch-up bursts. Terminal failures pause daily work until manual retry. Enabling daily
sync schedules from the last success (or 24h from enabling if none). Disabling daily sync
prevents future scheduled runs; an already queued/running job may finish. Cancel revokes
its lease immediately; a response already in flight is discarded. If daily remains enabled,
cancel defers the next scheduled scan 24h. Stop source disables daily and cancels atomically.
Neither operation removes imported tracks. App shutdown aborts HTTP and leaves the lease
recoverable after restart.

Runs stop at 10,000 pages (at most 500,000 playlist positions); `page-limit` is a terminal
sanitized report with progress retained. Provider pagination is a live scan rather than a
snapshot: edits between pages can shift entries; idempotence avoids duplicate library
links, and a subsequent full scan picks up missed references without destructive deletion.
History and source browsing use explicit pages, not an automatic bulk drain. UI refresh
is explicit; there is no background browser polling. Global fleet quota budgeting and
other playlist providers are future work; current request bounds apply per worker process.

## Integration and verification

Cherry-pick this local commit onto the integration branch, run the new migration using
the existing DB procedure, then build common/server/client. Mount remains in the personal
music router; no Room protocol/store/playback edits are required. This work introduces no
dependencies or lockfile changes. The Library Playlist sync tab reuses the personal music
session's cancellation/version mechanism, adds source/job request abort on unmount, resets
reports and draft references on account/token changes, and exposes run, retry, daily switch,
cancel, soft-stop, progress, errors and paginated history. Single-track import remains separate.

Tests mock all provider/network access. `music-imports.spec.ts` uses real migrated SQLite,
including a file reopen and independent connections for lease recovery. API tests cover
ownership, key-only rejection and strict inputs; adapter tests cover more than fifty entries
and unavailable results; UI tests cover typed commands, explicit pages and session changes.
PostgreSQL migration SQL generation is checked without a database; PostgreSQL runtime
concurrency has not been exercised here. See the implementation handoff for exact commands
and outcomes. No production job, real account import, push, PR or deployment is performed.

Verified in this worktree with pinned Yarn `node .yarn/releases/yarn-4.1.0.cjs` and
`NODE_ENV=test DB_MODE=sqlite`:

- `workspace ott-server sequelize db:migrate --config tests/music-imports-db.cjs`:
  all 22 migrations applied to `server/db/test.sqlite`, including the new import migration.
  The explicit test CLI config avoids loading private application config.
- `workspace ott-server vitest run tests/unit/music-imports.spec.ts tests/unit/music-imports-migration.spec.ts tests/unit/api/music-imports.spec.ts tests/unit/services/youtube-imports.spec.ts tests/unit/music-catalogue.spec.ts tests/unit/api/music.spec.ts tests/unit/services/youtube.spec.ts`:
  7 files, 107 tests passed. Expected SQLITE_BUSY messages come from catalogue commit-recovery tests.
- `workspace ott-client vitest run --config tests/music-imports.config.ts tests/unit/music-imports.component.spec.ts tests/unit/music.component.spec.ts`:
  2 files, 24 tests passed. The scoped config disables env-file loading.
- `workspace ott-{common,server,client} exec tsc --noEmit`: all passed.
- Scoped Biome, ESLint and Vue Prettier checks passed; two existing ESLint warnings in
  `api/music.ts` and `app.ts` remain. No new lint errors or warnings.
- Common/server builds and `workspace ott-client build --config tests/music-imports.config.ts`
  passed. Client retains existing bundle-size, annotation and locale dynamic-import warnings.

The immutable dependency installation linked packages but SQLite/Cypress native setup
failed in the restricted runner. Verification used the existing matching local SQLite
native binary copied into ignored `node_modules`. No dependency or lockfile was changed.

The shared-metadata correction adds `music-import-invalidation.spec.ts`: adapted review
probes for owner deduplication, sanitized noops, rollback/retry recipient recomputation,
reversed multi-entry independent-connection imports and a new-identity race; nonowner and
guest source-restoration admission, unrelated-track isolation, guest restart plus remote
connection polling, and current/queued/departed occurrence coverage. PostgreSQL adapter
simulations check lock ordering and rereads after an injected lock wait; they do not
establish live PostgreSQL runtime behavior. The focused six-suite Room/catalogue/import
set passes 139 tests. Server typechecking and scoped lint are reported in the handoff.
