# Audio display and music playback

Checked on 10 November 2026.

The room's **Audio** display mode changes presentation. It keeps the existing player mounted
and hides its picture. For YouTube, this still uses the same official IFrame player and video
ID; it does not select an audio-only stream or guarantee reduced data usage. No transfer-size
or bitrate measurement was performed for this check.

The [official IFrame API](https://developers.google.com/youtube/iframe_api_reference) and
[player parameters](https://developers.google.com/youtube/player_parameters) do not document
an audio-only playback option. Hiding the picture cannot be treated as a bandwidth control.
There is no supported quality setter used here to promise a lower bitrate.

## Songs without a music video

A YouTube Music watch link is resolved as a YouTube source with the same `v` ID. A song with
static artwork does not need a separate music video to use this path: the relevant requirement
is whether YouTube can play that particular ID in an embedded player for the listener. No
replacement video is searched for automatically. A Music link does not connect a Music
subscription or grant additional playback rights.

For the supplied example, `https://music.youtube.com/watch?v=5MO2drnQIFM`:

- An unauthenticated public fetch returned HTTP 200 and the title
  "What We Did - (I Know What You Did Last Summer | Alex' remix)".
- YouTube's public [oEmbed response](https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D5MO2drnQIFM&format=json)
  returned HTTP 200, the same title, and an iframe for `5MO2drnQIFM`.
- Regression tests cover accepting the Music URL, preserving its ID through resolution, and
  passing that ID to the player. Mocked SDK errors cover unavailable and non-embeddable tracks.

These checks establish public metadata and the application's routing. **Live playback, the
track's actual artwork/video content, regional availability, account restrictions, and browser
autoplay behavior were not tested.** An oEmbed response does not guarantee playback for every
listener. YouTube errors 100, 101/150, and 153 now receive localized explanations for unavailable
content, disabled embedding, and missing player identification respectively; other errors keep
the generic message. Provider failures also settle pending play attempts immediately, rather
than later being mistaken for an autoplay timeout.

The explanations also appear in a local notification, because Audio display hides the
player's error overlay. Repeated callbacks for the same active failure are deduplicated.

## Actual audio-only sources

A direct MP3 link can already resolve and play as `audio/mpeg`. The native media element
accepts audio-only files despite being a `<video>` element; no separate video file is requested
by this code. Server tests cover audio-only metadata/duration, and client tests cover loading
the exact source, readiness, play, pause, and seeking. These are mocked media tests, not codec
decoding or live network tests. Hosting must allow the app's cross-origin media requests, and
the listener's browser must support the audio format.

For an audio-only transfer, use a supported direct audio source you are authorized to stream.
The YouTube IFrame path cannot promise the same bandwidth behavior.
