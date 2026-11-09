# Explicit track recommendations (spec §12)

The Library Suggestions tab is opened manually. Loading it never infers library exhaustion,
listening recency, or zero compatible personal tracks from a page. A query requires every selected
mood to belong to **one** publisher's current, explicitly published annotations on that track.
Empty selection means any nonempty published combination. No query, publication or adoption
creates a Room request, changes room filters, starts playback or inserts queue entries.

## Consent and privacy

Publication is per authenticated account and track, private by default. The publisher must own
library membership and explicitly choose 1–20 of their current own annotations. Favorites,
another person's annotations, and implicit moods cannot be published. The UI discloses the
audience (authenticated accounts on this instance), the shared metadata (title, artists, styles,
duration and selected moods), anonymous attribution, and the limits of withdrawal.

Withdrawal immediately excludes subsequent discovery/adoption transactions. A transaction that
already holds the publication lock may commit before withdrawal; withdrawal cannot undo copies
already adopted. Removing an annotation cascades its publication consent away; adding that tag
again requires explicit republication. Removing membership or losing an eligible source hides
the publication until those eligibility conditions hold again. Publication does not copy or
delete any private annotations or favorite shortcuts.

Responses whitelist track UUID, sanitized title/artists/styles, duration, public mood vocabulary
fields and an opaque publication reference. They omit source IDs, provider identities, resource
URLs (including artwork), library contents, account IDs, usernames, email and unrelated tags.
No guest endpoint, total count, revoked-reference listing or author lookup is provided. Raw
ORM/provider errors are never forwarded. Reads use `Cache-Control: private, no-store`.

## Initial source policy

The allowlist contains only existing **YouTube** sources with an available catalogue status and
a canonical eleven-character `[A-Za-z0-9_-]` provider identity. Sources must actually be present;
the existence of a public Track alone is insufficient. Direct, HLS, DASH, local media, Vimeo,
other existing adapters and all new services are excluded by default. A track with an eligible
YouTube source and other sources can be recommended; none of its other sources is disclosed.

This is an explicit provider-class allowlist, not a live check of provider visibility or continued
availability. A canonical provider ID may later become private/unavailable. Discovery performs
no resolution or network requests. The publisher explicitly opts to share metadata; discovery
and library membership grant **no** media authorization. Normal Room source validation still
applies at playback, including when the adopter subsequently enters a Room. No title fusion.

## REST contract

Mounted at `/api/music/recommendations` under the existing `authTokenMiddleware` and personal
music authentication check. The router also enforces authenticated positive account IDs on its
own. All ownership comes from `req.user.id`; user IDs are forbidden in input. The standard
rate limiter charges 1 point for reads and 10 for mutations. Success is HTTP 200 with
`{ success: true, ...result }`; validation is 400, unavailable references 404, already-owned first
adoption 409, and unexpected failures 500. Error envelopes contain a generic safe message.

| Method | Suffix | Strict request | Result |
| --- | --- | --- | --- |
| GET | `/` | `moods` = comma-separated distinct UUIDs (0–20, default empty), `limit` = 1–50 (default 20), optional `after` track UUID | `{ items: MusicRecommendation[], next: TrackId \| null }` |
| GET | `/publications/:trackId` | Empty query/body | `{ publication: { eligible, moods } }` for **only the caller's** consent |
| PUT | `/publications/:trackId` | `{ moodIds: UUID[] }` (1–20 distinct own tags), empty query | Replaces selected publication consent; returns `{ publication }` |
| DELETE | `/publications/:trackId` | Empty body/query | `{}`; idempotent withdrawal of **only the caller's** consent |
| POST | `/:id/adopt` | `{ moodIds: UUID[] }` (0–20 distinct currently offered tags), empty query | `{ adoption: { trackId, inLibrary, moodIds } }` |

IDs are UUIDs and unknown input fields are rejected. Query ordering is ascending track UUID,
with one deterministic matching publication per track (minimum publication UUID). Membership
exclusion is a database `NOT EXISTS` across the caller's entire library. Already-adopted
publication references are also excluded, including after removing the adopted track; their
idempotent receipts cannot perform a new adoption. A different publisher's matching publication
can still be offered after that removal. The `after` cursor is the
last **returned track**; adopting or withdrawing earlier records does not cause offset skips.
Pagination is a live view: concurrent publications with lower IDs require loading from the
beginning. `next: null` means the current discovery query has no next page, not that a personal
library has been exhausted or has no compatible tracks. There are no automatic filter changes.

The adoption dialog preselects the currently offered moods and requires explicit confirmation.
The person may deselect any or all of them. Additional/different moods can then be selected
through the existing personal catalogue/track annotation workflow in Library; they are never
inferred from someone else's private annotations. Publication controls read bounded pages of own
annotations and the complete bounded publication state. Unknown/unloaded tags remain unknown;
the controls do not drain 10,000 annotations or reinterpret absence on the first page as false.

## Durable schema and atomic adoption

Migration `20261110020000-create-music-recommendations.js` creates three tables transactionally:

- `MusicPublications`: UUID primary key, account/track FKs with cascades, unique account+track,
  `active` false by default, track+active index. Withdrawal retains the row/reference privately.
- `MusicPublicationMoods`: publication+mood primary key and cascading FKs; a composite
  `(userId, trackId, moodId)` FK to `UserTrackMoods` removes consent on annotation deletion.
- `MusicRecommendationAdoptions`: account+publication primary key with cascading FKs. A durable
  receipt prevents technical retries from restoring removed membership or overwriting later edits.

Down removes only these tables. No existing library, source, favorite, import, room, or playback
table/algorithm is changed. Production model registration uses `musicRecommendationModels`;
isolated connections receive the same cached models.

`MusicRecommendations` accepts connection/catalogue/model providers for isolated testing.
It uses the existing `musicTransaction` writer (SQLite IMMEDIATE with existing rollback/retry and
per-connection mutex). PostgreSQL writers lock the publication row; first publication/withdrawal
also locks the account row. Adoption rechecks active consent, publisher membership, source
eligibility and current published tags under the transaction; membership, source and annotation
rows have share locks to serialize relevant concurrent deletion/update. Unknown, revoked and
private publication references have the same unavailable response.

The same transaction writes the adopter's membership, only explicitly confirmed missing tags,
the receipt, and the existing durable catalogue revision using the narrow
`MusicCatalogue.invalidateLibraryAdoption(userId, transaction)` seam. Existing own tags remain
intact. It reuses the existing postcommit `notifyImported(changes)` notification dispatcher;
notices include actual library/tag changes attributed **only to the adopter**, outside the writer
lock. Repeats create no changes/notices. No favorite writes, import lock/fingerprint changes,
source resolution, Room calls or queue effects occur. A retry returns current personal state,
which the client verifies before removing a result. A receipt never resurrects a removed track.
There is no durable notification outbox; existing durable Room revision polling remains the
cross-process recovery mechanism.

## Verification and limits

`tests/music-recommendations.config.ts` disables server env-file loading and uses
`node_modules/.cache` for test cache. Client verification uses the existing env-free
`client/tests/music-imports.config.ts` through the recommendation config (which only redirects
its cache), `NODE_ENV=test`, mocked API/providers and no browser.
Regression suites exercise real SQLite migrations/constraints and three accounts, cross-author
AND, privacy, tag deletion/reannotation, source policy, stable cursor paging, complete membership
exclusion, durable invalidation, rollback (including failure after revision write), postcommit
notices, retries preserving edits, cross-connection withdrawal ordering, and normal later Room
refresh attribution. Real Vue components exercise explicit load/confirmation, errors/retry,
verified adoption results, session/token cancellation and bounded publication of own tags.

PostgreSQL migration SQL is generated and asserted offline; **no real PostgreSQL execution or
concurrency claim** is made. Live providers, browser/mobile/background playback, service visibility
checks and deployment were not exercised. No automatic exhaustion heuristic, public author profile,
notification outbox or automatic adoption/queue integration is included.
