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
is internal. Service readiness is bounded, as are CLI calls, SQL statements, lock
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

## Live scenarios implemented (17 tests, not yet executed here)

- Seven PostgreSQL migration/catalogue cases: all discovered migrations on an empty
  schema; failed transactional DDL/reapplication and FK/unique constraints; actual
  advisory contention on absent provider identities with independent Sequelize
  pools; aliased shared tracks in cross order and exact no-ops; two M0/M1 row-wait
  interleavings for metadata/availability with owner-version rechecks; trigger-failed
  import rollback of page/cursor/provenance/library/metadata/versions followed by
  retry; repeatable-read tags/version coherence across a remote commit.
- Nine SQL Room cases: competing CAS writers; a load blocked behind staged normalized
  history/scores and finalized timeline; actual transaction-local 5s/10s settings and
  save-hook revocation rollback; Room grant revocation during a server-observed CAS
  wait; actual five-second PostgreSQL lock cancellation; failed normalized event
  write/retry without extra play credit; missing-state debt protection; restored
  account and guest manual requests detecting remote availability via durable
  fingerprints without nonlibrary membership or owner hooks.
- One Redis/SQL case: production `buildClients`/subscriber and Room save method over
  real sockets, TTL and serialized storable/syncable conversions, restoration through
  `redisStateToState`, SQL recovery after removing the test Redis key, and stable
  history/session/playback identity without another credit.

Concurrency synchronization observes `pg_stat_activity.wait_event_type = 'Lock'`,
or pauses an actual Sequelize `afterQuery` hook. It does not substitute SQL results.
The lock observer uses a monotonic deadline even when a scenario controls `Date.now`.
Tests use independent Sequelize pools and release their blockers in `finally`.

## Evidence from this Windows checkout

Base production revision: `e1a51665`. No production files or migrations were changed.

Validated on Node **24.11.1**, pinned Yarn **4.1.0**, Vitest **1.2.2**, Sequelize
**6.32.0**, pg client **8.11.0**, redis client **4.6.7**:

- **13 offline checks passed.** Initially four music migrations/22 total were
  discovered. Repeating with read copies from local-media commit
  `f518ed367b3ab01bf903a0602993d8e4f3f8d8f8` and recommendation commit
  `3b8697aca047a9926e17af5a7b20ef1e4667c5dd` discovered **24** total and generated SQL
  for all **six** music migrations, including the local-source FK and publication
  composite annotation FK. No cherry-pick or production feature import was used.
  The exact repeat command, after placing those two blobs and the CommonJS package
  marker under the ignored cache directory, was:

  ```powershell
  $env:TEST_MUSIC_EXTRA_MIGRATIONS_DIR = Join-Path $PWD "node_modules/.cache/music-migration-copies"
  node server/tests/integration/music-run.mjs --offline
  ```

- **17 live tests collected and explicitly skipped** with `--collect-only`.
- Server `tsc --noEmit`, focused ESLint and Biome checks passed.
- No-argument invocation rejected missing explicit test-service inputs.

**Real PostgreSQL tests run: 0. Real Redis tests run: 0.** There are no demonstrated
production failures and no measured database server versions from this run.

The installed Docker CLI reports **29.5.2 / API 1.54**. The initial `docker_engine`
pipe was absent. Docker Desktop was started hidden; subsequent engine requests to
both `docker_engine` and `dockerDesktopLinuxEngine` returned **HTTP 500 Internal
Server Error**, including `version` and image enumeration. The bounded harness
engine probe timed out after 30 seconds, before creating containers/networks or
pulling images, and removed its temporary configuration directory.

`com.docker.service` remained **Stopped**. `Start-Service com.docker.service` failed
with `CouldNotStartService`: the current account could not open that service on
computer `.`. `wsl --status` reports default Ubuntu-24.04 and WSL version 2; that does
not establish that Docker's Linux backend is healthy. Required prerequisite: a
healthy installed Docker Linux engine accessible to this account (or explicitly
provisioned isolated PostgreSQL/Redis URLs). No admin changes, updates, downloads of
Docker/WSL, reboot, or termination of other users' services were attempted.

The two additional migrations have only offline SQL-generation evidence here.
Their live DDL/constraint behavior, local-media balancer access controls, and
recommendation publication/adoption PostgreSQL locking are **not validated** by this
lot. Provider playback, browser/login, Redis failover/pubsub and multi-process Room
ownership beyond SQL CAS are also outside this evidence.
