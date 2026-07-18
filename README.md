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

## Deploying

Cloudflare Pages: build command `bash build.sh`, output directory `dist/`.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) — module contracts, coordinate spaces,
the annotation document format, and the editing contract that lets the select
tool work generically across every annotation layer type.

## License

MIT
