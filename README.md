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
- **Plugins are layers.** An annotation layer can carry extra annotation logic
  — the bundled **line fitter** snaps a drawn line onto the edge, or the middle
  of the stripe, underneath it — while still storing plain annotations that a
  build without the plugin can read. Add one from the ＋ menu's **Plugins ›**
  page; see [ARCHITECTURE.md](ARCHITECTURE.md#plugins).

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
node test/line-fitter-test.mjs
```

The line-fitter plugin: the fitting math against synthetic edges and stripes
(including that points move perpendicular only, and that a later segment can
only slide a shared vertex along the segment fitted before it), then the plugin
end to end — added from the ＋ menu, two clicks committing one fitted line
against the fixture's real pixels, re-fitting, and the JSON round trip.

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
  "annotatorVersion": "0.9.0",
  "commit": "fc6a71fdcb59f93198b08c7d69be5dda9fb601ac",
  "commitUrl": "https://github.com/jasper-tms/exact-video-annotator/commit/fc6a71fdcb59f93198b08c7d69be5dda9fb601ac",
  "branch": "main",
  "buildTimestamp": "2026-07-26T12:16:00Z",
  "videoEngineVersion": "2.2.1"
}
```

`build.sh` writes it, so the stamp describes the commit that produced the
files being served rather than whatever the repository looks like now.
`annotatorVersion` is read from `VERSION` (see [Releasing](#releasing)) and
`videoEngineVersion` out of the pinned CDN URL in `index.html`, which makes
this the quickest way to confirm which engine release production actually
picked up. Both versions are reported bare, with no leading `v`. Both paths are
served `Cache-Control: no-store` — a version stamp answered from cache would
defeat its own purpose.

On Cloudflare the commit and branch come from `CF_PAGES_COMMIT_SHA` and
`CF_PAGES_BRANCH`, since its checkout is shallow. That shallowness is also why
the app version comes from the checked-in `VERSION` rather than from `git
describe`, which would have no tags to describe and would report a bare hash.
Any field that cannot be determined reads `unknown`; a missing stamp never
fails the build.

### Verifying a deploy

```sh
node test/smoke-test.mjs --url https://exact-video-annotator.pages.dev/
```

The full smoke suite against the deployed app, plus two checks the stamp makes
possible: that the engine the page actually loads matches `videoEngineVersion`,
and that the deployed commit is the local `HEAD`. The second one matters more
than it looks — run this straight after a push, while Cloudflare is still
building, and without it every check would pass against the *previous* deploy.

## Releasing

`VERSION` holds the app's version and nothing else, with no leading `v`. Editing
it on `main` is the whole release: a
[workflow](.github/workflows/release.yml) tags that commit `vX.Y.Z` and cuts a
GitHub release from it.

```sh
echo 0.10.0 > VERSION
git commit -am "Release v0.10.0"
git push                          # the workflow tags v0.10.0 and releases it
```

Nowhere else in the tree states the version, so nothing can drift out of step
with `VERSION` and there is no sync step or commit hook to run: `build.sh` reads
`VERSION` when it stamps a build, and the tag is derived from the same file. The
version is deliberately *not* baked into `index.html` — the deployed app reports
what it is at `/version`, and a copy in the page would be one more thing to keep
honest.

(This is the same ritual as
[exact-video-engine.js](https://github.com/jasper-tms/exact-video-engine.js#releasing),
minus its `sync_version.sh` hook, which exists there only because a library must
also state its version in `package.json` and in pinned CDN URLs.)

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) — module contracts, coordinate spaces,
the annotation document format, and the editing contract that lets every
drawing tool select and move existing annotations generically across every
annotation layer type.

## License

MIT
