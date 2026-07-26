# exact-video-annotator

A layered, frame-exact annotation app for video and images that runs entirely
in the browser. Think napari or neuroglancer, but built for video: image/video
layers and annotation layers (points, polygons, lines, temporal events) share
one canvas, each with visibility, opacity, z-order, and scale/offset
transforms — and the playhead is frame-exact, courtesy of
[exact-video-engine.js](https://github.com/jasper-tms/exact-video-engine.js).

No server, no upload: videos open straight from local disk (read lazily by
byte range, so arbitrarily large files are fine) or from any URL that answers
HTTP Range requests. Annotations live in a single JSON file you export and
import, with localStorage autosave as a safety net.

## Design principles

- **The canvas is the app.** One sidebar (collapsible, and hideable with Tab)
  holds all setup — layers, classes, the annotations table. Everything else is
  canvas, a slim toolbar, and a transport bar.
- **The integer frame index is the source of truth.** Times are derived from
  the container's real per-frame timestamps by the engine; nothing in this app
  multiplies a time by an assumed frame rate. When a clip cannot be indexed
  the UI says so (`frame numbers approximate`) instead of quietly mislabeling
  frames.
- **Annotations are stored as (frame index, upright source-video pixels)** —
  independent of window size, zoom, device pixel ratio, and rotation.
- Keyboard-first: tools, frame stepping, and user-definable per-event-type
  hotkeys (case-sensitive add/remove keys).

## Running

It is a static page. Open `index.html` over any static server, for example:

```sh
python3 -m http.server --directory .
```

(The engine and mp4box load from pinned CDN URLs, so an internet connection is
needed on first load.)

## Testing

```sh
node test/smoke-test.mjs
```

Opens the app in headless Chromium, loads the frame-numbered variable-frame-rate
fixture, and exercises playback, frame stepping, every drawing tool, event
hotkeys, undo/redo, and the export round-trip. Fails on any page error.

Pass `--url` to run those same checks against a deployed app rather than a local
server — see below.

```sh
node test/growing-index-test.mjs
```

Covers what the app shows while a clip is still being indexed — the two-tone
scrubber, the frame count marked as a floor, the wait at the end of the indexed
range, and a pass that stops early. It drives those states through a wrapped
engine rather than a large fixture; see the comment at the top of the file.

## Deploying

Cloudflare Pages: build command `bash build.sh`, output directory `dist/`.

### What is live right now

The deployed app answers at both `/version` and `/version.json` (same bytes;
the extensionless one exists because it is easier to type):

```json
{
  "tag": "da3b37d",
  "commit": "da3b37dad570540fcb815466a7cf2c751cfea08b",
  "commitUrl": "https://github.com/jasper-tms/exact-video-annotator/commit/da3b37dad570540fcb815466a7cf2c751cfea08b",
  "branch": "main",
  "buildTimestamp": "2026-07-25T21:11:27Z",
  "videoEngineVersion": "v2.0.0"
}
```

`build.sh` writes it, so the stamp describes the commit that produced the
files being served rather than whatever the repository looks like now.
`videoEngineVersion` is read back out of the pinned CDN URL in `index.html`,
which makes this the quickest way to confirm which engine release production
actually picked up. Both paths are served `Cache-Control: no-store` — a
version stamp answered from cache would defeat its own purpose.

On Cloudflare the commit and branch come from `CF_PAGES_COMMIT_SHA` and
`CF_PAGES_BRANCH`, since its checkout is shallow and may carry no tags. Any
field that cannot be determined reads `unknown`; a missing stamp never fails
the build.

### Verifying a deploy

```sh
node test/smoke-test.mjs --url https://exact-video-annotator.pages.dev/
```

The full smoke suite against the deployed app, plus two checks the stamp makes
possible: that the engine the page actually loads matches `videoEngineVersion`,
and that the deployed commit is the local `HEAD`. The second one matters more
than it looks — run this straight after a push, while Cloudflare is still
building, and without it every check would pass against the *previous* deploy.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) — module contracts, coordinate spaces,
the annotation document format, and the editing contract that lets every
drawing tool select and move existing annotations generically across every
annotation layer type.

## License

MIT
