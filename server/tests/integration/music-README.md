# Opt-in music integration checks

From the repository root, with this checkout's own dependencies installed:

```powershell
$env:YARN_ENABLE_NETWORK = "0"
node .yarn/releases/yarn-4.1.0.cjs install --immutable --mode=skip-build
node server/tests/integration/music-run.mjs --docker
```

On Windows the runner defaults to
`C:/Program Files/Docker/Docker/resources/bin/docker.exe`; elsewhere it uses `docker`.
`TEST_DOCKER_BIN` can explicitly select another installed CLI. Start the installed
Docker engine beforehand. The runner does not install software, start/stop system
services, change WSL, or use the repository's compose file.

The runner inventories local images and uses an existing official `postgres:15*`
and `redis:7*` tag if present. Otherwise it pulls only `postgres:15-bullseye` and
`redis:7-alpine`. Docker always receives a fresh, empty `--config` directory under
`node_modules/.cache`; personal registry credentials and contexts are not loaded.

Each run generates a random network, container names, PostgreSQL database/role and
synthetic password. Containers use tmpfs for PostgreSQL data and Redis `/data`, no
existing volumes, and dynamic ports bound only to `127.0.0.1`. The bridge network
is internal. If Docker omits the requested publication on that internal network,
`music-docker-forward.mjs` opens dynamic loopback listeners and forwards raw TCP
through `docker exec -i` in the owned PostgreSQL image (Bash `/dev/tcp` and `cat`).
It pins the inspected immutable container ID and checks its run labels before
each exec; it never attaches an external bridge. Existing safe published ports
take precedence; unsafe bindings are rejected.
The shell program is static and receives validated host/port arguments separately.
Forward startup is bounded to 10s, connections to 64, and teardown to 35s. Teardown
closes listeners/sockets, waits for local exec children, and then removes only the
owned containers, which also ends their remote pumps. Its cleanup audit records
local ports/PIDs and verifies zero remaining forwarding resources on success/failure.
Service readiness is bounded, as are CLI calls, SQL statements, lock
waits and connection acquisition. Image pulls have a five-minute limit.

The runner removes only its generated containers/network after checking their run
labels. A failed `docker run` is covered by teardown too. Its temporary directory
is removed only after checking that its resolved path stays below the checkout's
cache. If cleanup cannot verify ownership or reach the engine, it fails and reports
the configuration path for manual recovery; it never prunes or touches other services.
Abrupt machine/process termination can require manual cleanup of the named resources.

Normal unit tests do not discover `*.integration.ts` or `*.offline.ts`. These suites
use their own Vitest config and never load `jest.setup.redis-mock.js`. The runner
passes a small environment allowlist plus explicit test inputs, and Vite's env
directory points at a nonexistent test directory. No application config files are
loaded. Provider extraction is mocked; Sequelize, PostgreSQL SQL, Redis networking,
Room reducers and stores remain real in the live suites. The auth-wait case replaces
token lookup with a synthetic session and revokes real in-memory Room grants.

## Explicit isolated services

For services you have already provisioned exclusively for this test run, omit
`--docker` and set all three inputs. This mode never creates or drops the database:

```powershell
$env:TEST_MUSIC_RUN_ID = node -e "process.stdout.write(require('node:crypto').randomBytes(12).toString('hex'))"
$testPassword = node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('hex'))"
$testRole = "ott_music_test_$env:TEST_MUSIC_RUN_ID"
# Provision a fresh database and role named $testRole, and an isolated Redis using
# $testPassword, on localhost ports you control; these examples assume 15432/16379.
$env:TEST_DATABASE_URL = "postgres://${testRole}:${testPassword}@127.0.0.1:15432/${testRole}"
$env:TEST_REDIS_URL = "redis://default:${testPassword}@127.0.0.1:16379/15"
node server/tests/integration/music-run.mjs
```

Both URLs must use localhost and explicit ports. The database and role must match
the 24-hex run ID; its password must be 48 hex characters. Redis must use the same
synthetic password, the default ACL username and DB 15. URL options are rejected.
The fixture verifies `current_database()` and `current_user` before creating a
unique schema. Every connection uses only that schema in its search path. Teardown
checks schema owner and its run-ID comment before `DROP SCHEMA ... CASCADE`.
Redis tests atomically claim their exact run-prefixed Room key before allowing
deletion; no `FLUSHDB`, key scan, or external database reset is used.

## Migration discovery and parent read copies

Live fixtures discover **all** timestamped `.js` migrations in `server/migrations`
and apply them in filename order to their empty schema, without `sync()` replacing
the schema or any Sequelize CLI development configuration. There is no frozen list
of 22: a parent checkout with the local-media and recommendation migrations will
automatically apply all 24 (and future additions).

For a bounded older checkout, `TEST_MUSIC_EXTRA_MIGRATIONS_DIR` can point at a trusted
directory of migration read copies. The runner passes this explicit input through
to both live and offline checks. Names are merged into the same sorted discovery;
the checkout's canonical file takes precedence if a name exists in both places.
Use a `package.json` containing `{"type":"commonjs"}` alongside copied `.js` files.
Only migration modules are loaded; this does not import their production features.

Offline validation and collection without service connections:

```powershell
node server/tests/integration/music-run.mjs --offline
node server/tests/integration/music-run.mjs --collect-only
```

The offline suite validates target rejection and invokes the actual Sequelize
PostgreSQL query generator for every discovered music migration. **Only that offline
check** replaces query execution/transactions. It does not prove DDL acceptance,
foreign-key enforcement, rollback or concurrency on PostgreSQL. Collection skips
every live test and proves only that all test modules load successfully.

Test both directions of relay EOF separately using the actual Linux Bash program:

```powershell
node server/tests/integration/music-forward-check.mjs --docker
```

These two checks use disposable `postgres:15-bullseye` containers with no network,
volumes or database process. An internal loopback fixture verifies the final bytes,
child exit and socket cleanup before teardown. Failed checks remove only the exact
container after checking its unique ownership label. Git Bash on Windows is not a
substitute here: its handling of signals during a blocked pipe read differs from
the Linux runtime used by the relay.

## Live scenarios (21 tests)

-   Seven PostgreSQL migration/catalogue cases: all discovered migrations on an empty
    schema; failed transactional DDL/reapplication and FK/unique constraints; actual
    advisory contention on absent provider identities with independent Sequelize
    pools; aliased shared tracks in cross order and exact no-ops; two M0/M1 row-wait
    interleavings for metadata/availability with owner-version rechecks; trigger-failed
    import rollback of page/cursor/provenance/library/metadata/versions followed by
    retry; repeatable-read tags/version coherence across a remote commit.
-   Nine SQL Room cases: competing CAS writers; a load blocked behind staged normalized
    history/scores and finalized timeline; actual transaction-local 5s/10s settings and
    save-hook revocation rollback; Room grant revocation during a server-observed CAS
    wait; actual five-second PostgreSQL lock cancellation; failed normalized event
    write/retry without extra play credit; missing-state debt protection; restored
    account and guest manual requests detecting remote availability via durable
    fingerprints without nonlibrary membership or owner hooks.
-   One Redis/SQL case: production `buildClients`/subscriber and Room save method over
    real sockets, TTL and serialized storable/syncable conversions, restoration through
    `redisStateToState`, SQL recovery after removing the test Redis key, and stable
    history/session/playback identity without another credit.
-   Four timeline durability cases: a thrown finalizer and a trigger-rejected final
    snapshot update both roll back SQL, live state and publication, then retry with
    exactly sequences 1, 2, 3 and one play credit; commit-time retiming of the public
    event, SQL playback anchor and normalized start after an observed CAS wait;
    Redis and SQL-only restoration with distinct fresh public epochs while keeping
    domain playback/session identity, history, two-contributor fairness and future plan.

Concurrency synchronization observes `pg_stat_activity.wait_event_type = 'Lock'`,
or pauses an actual Sequelize `afterQuery` hook. It does not substitute SQL results.
The lock observer uses a monotonic deadline even when a scenario controls `Date.now`.
Tests warm independent Sequelize pools before bounded lock observation and release
blockers in `finally`. The observer deadline remains 4s; test/hook limits remain
20s/30s and production transaction settings remain 5s lock/10s statement.

## Historical evidence (before these harness fixes)

The initial harness at production base `e1a51665` had 13 offline checks passing and
17 live tests collected/skipped, with no live PostgreSQL/Redis execution because
Docker was unhealthy. That historical result is not a live pass.

A later read-only validation at `f5f6bd86`, recorded under
`D:/undertone/test-results/live-playback-review`, measured Docker 29.9.3,
PostgreSQL 15.13 and Redis 7.4.5. The canonical runner failed before tests because
Docker omitted the internal network's requested published ports. Temporary ignored
transport/schema adapters ran the original 17 cases (12 passed, 5 failed), then
focused corrected follow-ups plus four timeline probes passed 9/9. The combined
21 distinct scenarios passed across those phases; this was **not one canonical
21-case green run**. The tracked harness now incorporates those bounded corrections.

## Final validation on integrated product

Product revision: `98145c5a1bc62d8c936bb27d5d7d54726cfac90f` (includes the server
event timeline, command/undo correction and client controller). This change edits
only the integration harness. Final run ID: `4dbb2238c9ad5aac08e89ab7`.

The tracked canonical runner completed **21 passed / 0 failed / 0 skipped** in
**457.55s**: all original 17 cases and all four timeline probes in one fresh run.
The exact invocation, with additional evidence reporters only, was:

```powershell
node server/tests/integration/music-run.mjs --docker --reporter=verbose --reporter=json --outputFile=../test-results/music-harness-final/live-results.json
```

Measured versions: Node **24.11.1**, Yarn **4.1.0**, Docker engine **29.9.3**,
PostgreSQL **15.13 (Debian 15.13-1.pgdg110+1), x86_64**, Redis server **7.4.5**;
Vitest **1.2.2**, Sequelize **6.32.0**, pg **8.11.0**, redis client **4.6.7**,
TypeScript **6.0.3**, ESLint **8.57.0**, Biome **2.6.3**. Existing official images
`postgres:15-bullseye` and `redis:7-alpine` were used; no pull was needed. All 24
canonical migrations applied to empty private schemas. No dependency/lockfile,
application environment, product or migration changes were made.

Additional checks: **23 offline checks passed**, 21 live tests collected/skipped
with `--collect-only`, server `tsc --noEmit`, scoped ESLint, Biome formatting/lint,
Node syntax and `git diff --check` passed. No-input execution rejected missing
isolated-service inputs. The runner's fallback was exercised live; the ordinary
published-port selection/rejection path has offline evidence on this engine.

An earlier diagnostic attempt hit unchanged setup deadlines because repeated
Docker CLI ownership inspections consumed the SQL connection startup budget.
Its known Vitest process tree was stopped and the runner cleaned its resources.
The final implementation pins label-verified immutable container IDs, checks that
metadata before each exec, and avoids those repeated cold CLI probes. No assertion,
4s observer deadline, test/hook timeout or production SQL setting was relaxed.

Redacted logs, source hashes, raw Vitest JSON and exact-label cleanup evidence are
under the ignored `test-results/music-harness-final` directory. The final and
aborted-run cleanup audits check only their own labels, listener ports and known
process IDs; neither prunes resources nor changes existing services or data.

The tests exercise migrations and bounded music persistence/timeline behavior.
They do not establish browser/provider playback, login security, Redis failover,
multi-process Room ownership beyond SQL CAS, or broad local-media/recommendation
feature correctness. All 24 migrations are applied, and selected music
FK/unique/rollback cases exercise constraints; this does not validate every feature
using those tables. No product defect or production security approval is inferred
from a passing integration run.
