# Undertone desktop preview (Windows)

This is a runnable native GPUI player for **timeline protocol v1 and YouTube only**.
It does not boot the Vue app or support legacy playback. Native account, moods,
favorites, room preferences, URL admission and queue panels reuse the existing
server APIs. The full player and compact desktop widget share one playback host.
See [native UI](desktop-ui.md) and [account/music contracts](desktop-music.md).
The standalone `desktop/Cargo.toml` workspace and lockfile do not change the root
balancer workspace or its dependency features. Published upstream GPUI is pinned
to `0.2.2`; Wry is pinned to `0.57.2`. No UI component framework is used.

## Build and run

Prerequisites: Windows x64, the MSVC C++ build tools and Windows SDK, Rust 1.96,
Node 22–24, and Microsoft Edge WebView2 Runtime for YouTube. This change does not
install toolchains or WebView2. The application can start disconnected without
creating a WebView2 environment.

From the repository root, in PowerShell:

```powershell
node .yarn/releases/yarn-4.1.0.cjs install --immutable
node scripts/build-desktop-player.mjs
cargo build --manifest-path desktop/Cargo.toml --locked
.\desktop\target\debug\undertone-desktop.exe
```

Enter a full room URL such as `http://localhost:3000/room/my-room`, then select
**Join** or press Enter. With an empty field, Join can read a copied room URL. HTTPS and
deployment subpaths such as `https://example.com/ott/room/my-room` work. URLs with
embedded credentials, fragments, or query strings are rejected. Use the public
server port (or a running Vite proxy), not a static-only frontend server.

Alternatively:

```powershell
.\desktop\target\debug\undertone-desktop.exe --server http://localhost:3000 --room my-room --muted
```

The first connection obtains a temporary guest session and can play the room's
current YouTube track. The app defaults to volume 50; `--muted` starts silently.
Mute and volume are local. Native play/pause, previous/next and the seek bar
submit timeline intentions through the shared session. The server still
authorizes commands. Rejections appear in the native window. Controls remain
disabled until the session has a usable snapshot and clock. **Disconnect** closes
the socket and disposes the player. Join again to reconnect; there is no automatic
reconnect in this first slice.

For release builds, add `--release` to the Cargo build command; the executable is
`desktop/target/release/undertone-desktop.exe`. The
generated host is embedded in the executable, so Node and the repository files
are not needed at runtime. Re-run the Node build after changing any shared
playback, desktop host, or desktop string source. Generated files and Cargo build
outputs are ignored. No installer, signing, update service, or OS media integration
is included.

## Ownership and lifecycle

Rust owns one room WebSocket and obtains a guest credential from `GET
/api/auth/grant`, then sends the existing `{action:"auth",token}` frame. Password
login upgrades that same session through the native Account panel. The token is
held only in Rust memory and retained across same-server reconnects; it is never
persisted, logged, rendered or passed to JavaScript. No browser session is imported.

After a valid capability announcement, native source discovery subscribes with
its own nonce. It observes only atomic snapshot/event `attachment.item` metadata
and an epoch/sequence cursor. It does not implement a second playback clock or
timeline projection. The current server compacts all immediate events into an
empty-event snapshot; nonempty snapshot event arrays are explicitly unsupported
by native discovery. Gaps, invalid attachments, and epoch conflicts disconnect
with a visible error. Servers without protocol v1 fail visibly after ten seconds;
there is no legacy fallback. Missing snapshots time out after fifteen seconds.

Only a validated YouTube source creates the single child WebView2. Its local
`http://undertone.localhost/index.html` document serves the embedded tiny host and
bundle through Wry's custom protocol mapping, providing an HTTP origin/referrer
for YouTube. It uses the official iframe API; it never extracts YouTube streams.
Once the host reports ready, it starts `createPlaybackSession` with cached modern
capability and requests its **own fresh snapshot**. Playback, projection, clock
calibration, recovery, and drift correction reuse the existing client session and
controller without changing their policies or adding a desktop correction loop.

The direct YouTube adapter cues before playing and implements the existing
controller interface. Readiness and pending play waits are bounded and cancelled
on disposal/abort. Late callbacks cannot operate on a replacement instance or
undo a newer pause. Provider playback/rate changes report back to the controller.
Each new controller generation owns a new iframe; consecutive YouTube tracks
reuse the WebView environment. A non-YouTube source, clear, disconnect, window
close, or connection failure drops the WebView/controller. A later YouTube source
creates it again. The profile is InPrivate; no browser environment is prewarmed.

Only playback snapshot/event/result and clock reply messages cross into the host.
The browser may send only strictly validated clock probes, subscriptions, and
playback commands. Authentication, chat, users, arbitrary network operations, and
arbitrary native invocations have no IPC route. WebView2 IPC requires the exact
main-document URL; iframe messages are rejected. Top-level navigation, new
windows, downloads, and unrelated browser permissions are blocked. The local
document has a restrictive CSP allowing the YouTube API and iframe. All values
sent into JavaScript are JSON serialized. Connection and host generations fence
late events after reconnect or host replacement.

## Resource bounds and limits

Native UI updates on events; no application 60 fps timer is installed. The app
owns one current-thread Tokio network runtime. GPUI and WebView2 can create their
own platform threads/processes. Queues hold at most 64 UI events and 32 outbound
socket messages; WebSocket frames/messages are capped at 256 KiB, IPC at 16 KiB,
and sends at 32 per ten seconds. The shared session's bounded caches remain in
use. Before host readiness, messages are not replay-buffered: the host requests
fresh authority. The host publishes native progress only when its displayed
second or state changes. IPC queue overflow terminates that host's connection with
a visible bridge error instead of silently losing a state, command, or readiness
message. Rejoin to recover. The shared session/controller timers exist only while
the YouTube host exists. GPU rendering alone is not a RAM guarantee; no memory or
idle CPU guarantee is implied.

An initial Windows debug-build measurement at `a1d3b276` sampled ten seconds after
startup. Disconnected, the application had about 73 MiB resident memory and 81 MiB
private committed memory, with 0.31% of one CPU core during that interval. A separate
muted loopback fixture requesting YouTube created one WebView and its browser
process tree. The whole owned process tree used about 620 MiB private committed
memory and 8.59% of one core in its sample. This is a short startup-adjacent observation,
not a release or steady-playback benchmark; GPU memory is excluded. Summing resident
sets would double-count shared pages. Native guest authentication, the host's fresh
subscription, and clock probes were observed; audible playback and successful media
decoding were not established. The browser cost must not be confused with the 84 KiB
JavaScript bundle. Measurement artifacts are in ignored `test-results/desktop-*-measurement.json`.

Non-YouTube playback, OAuth/Discord login, private-room password admission,
audio-only mode, captions controls and arbitrary seek text input are out of scope.
Music panels require a Music-mode room and the relevant server permissions;
joining never changes room mode. Personal tagging requires an account and a real
catalogue track ID. Mood search filters loaded pages, with explicit Load more.
Previous/Next are available for an active YouTube session; there are no playback
controls for empty or unsupported sources. Sources can still change from another
client, and the native observer will create/dispose the YouTube host accordingly.
YouTube embedding, region/age restrictions, provider availability, autoplay, and
WebView2 availability can prevent playback; errors are visible. This preview does
not claim live YouTube or deployed-room validation from mocked tests. If autoplay
is denied, an Enable playback button appears inside the browser surface. Its click
activates the local provider synchronously without sending a room command; the
native Play/Pause button continues to control the room's authoritative state.

## Checks

```powershell
node scripts/build-desktop-player.mjs
node node_modules/typescript/bin/tsc --noEmit -p client/tsconfig.json
node node_modules/vitest/vitest.mjs run --config client/src/desktop/vitest.config.ts
cargo test --manifest-path desktop/Cargo.toml --no-default-features --locked
cargo fmt --manifest-path desktop/Cargo.toml --check
cargo clippy --manifest-path desktop/Cargo.toml --all-targets --locked -- -D warnings
cargo build --manifest-path desktop/Cargo.toml --locked
.\desktop\target\debug\undertone-desktop.exe --smoke-test
```

The smoke test opens its own native window muted, asserts zero room connections
and zero WebViews, and exits after two seconds. It ignores connection CLI options.
Rust transport tests use a loopback HTTP/WebSocket fixture with a dummy guest
credential; they never contact existing rooms, databases, or Redis. YouTube
adapter tests use a mocked SDK and produce no audio. The host bundler checks its
import graph for accidental Vue, router, axios, or real connection dependencies.
