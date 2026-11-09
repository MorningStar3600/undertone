# Undertone

Undertone is an independent fork of [OpenTogetherTube](https://github.com/dyc3/opentogethertube),
originally created by Carson McManus (dyc3) and its contributors. The fork is maintained by
[MorningStar3600](https://github.com/MorningStar3600) and is not an official upstream release.

The planned music library, moods, and fair-share room behavior are described in the
[Undertone specification](docs/undertone-spec.md); that specification does not mean these
features are already implemented.

- [Fork source code](https://github.com/MorningStar3600/undertone)
- [License](LICENSE): GNU AGPL version 3 or, at your option, any later version.
- [Origin, modification notices, and source availability](NOTICE.md)
- [Deployment and corresponding source](docs/how-to-deploy.md#source-availability)

Modification notice (2026-11-09): this fork adds the Undertone specification and fork/source
notices. Existing upstream credits and license notices are retained; Git history records changes.

## Upstream project

The badges, public instance, and project description below refer to the original
OpenTogetherTube project, not to an Undertone deployment or its build status.

[![CI/CD](https://github.com/dyc3/opentogethertube/actions/workflows/main.yml/badge.svg)](https://github.com/dyc3/opentogethertube/actions/workflows/main.yml)
[![codecov](https://codecov.io/gh/dyc3/opentogethertube/branch/master/graph/badge.svg)](https://codecov.io/gh/dyc3/opentogethertube)
[![Docker size](https://img.shields.io/docker/image-size/dyc3/opentogethertube)](https://hub.docker.com/r/dyc3/opentogethertube)

The easy way to watch videos with your friends.

Try it here: https://opentogethertube.com/

# Features

- Real-time video synchronization
  - No account registration required
- Bookmarkable rooms with custom URLs for easy sharing
- Text chat
- SponsorBlock integration
- Plays videos from:
  - YouTube
  - Vimeo
  - `.mp4` files served over HTTP
  - HLS VOD streams
  - DASH VOD streams
  - [Custom media manifests](docs/custom-media-format.md)
  - [...and some others.](https://github.com/dyc3/opentogethertube/tree/master/server/services)
- Vote mode: Vote on what to watch next
- Vote to skip
- DJ mode: Good for D&D background music
- Room permissions
- Multiple UI themes

# Deployment

See the [deployment docs](docs/how-to-deploy.md).

# Contributing

Contributions are welcome! Check out issues that have the "good first issue" label. Read [CONTRIBUTING.md](./CONTRIBUTING.md) for more information.
