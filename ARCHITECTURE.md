# exact-video-annotator — architecture

A browser-only, napari-style layered annotation app for video and images, built
on [exact-video-engine.js](https://github.com/jasper-tms/exact-video-engine.js).
Multiple layers share one canvas: media layers (video, image) and annotation
layers (points, shapes, temporal events), each with visibility, opacity,
z-order, and a scale/offset transform. No server, no build step: plain ES
modules served statically.

## Coding conventions (binding for all contributors)

- **No abbreviations** in identifiers, comments, or user-facing text.
  `context`, not `ctx`; `deltaX`, not `dx`; `numberOfFrames`, not `numFrames`
  (the engine's own `numFrames` member is external API and is used as-is at the
  call site, but never propagate the style). Universally understood terms
  (`id`, `min`, `max`, `JSON`) are fine.
- Plain ES modules, no framework, no build step. Modern browser baseline
  (same as WebCodecs-era browsers; no transpilation).
- **The integer frame index is the source of truth** for anything temporal.
  Never compute a frame as `time × frameRate`; the engine owns the mapping
  (`currentFrame`, `currentFrameFloat`, `seekToFrame`, `frameAtTime`).
- Annotation geometry is stored in **layer-local coordinates**, which for the
  default untransformed layers equal **upright source-video pixels**. Frame
  indices + source pixels make every annotation resolution- and
  layout-independent (the movim-website convention).
- All mutations of the annotation document go through `UndoHistory.execute`
  with a command object — never mutate document items directly from UI code.
- DOM that holds user focus (text inputs) must never be re-rendered while the
  user might be typing in it (rebuild lists item-wise, not `innerHTML` wipes).

## Coordinate spaces

```
layer-local  --layer.transform-->  world  --viewer.viewTransform-->  stage CSS pixels
```

- **layer-local**: the space annotation geometry is stored in. For a video
  layer, local space is the upright source video's pixel grid.
- **world**: the shared canvas space. `layer.transform = { scale, offsetX,
  offsetY }` maps local → world (`world = local × scale + offset`). Default is
  identity, so by default world equals the primary video's pixel space.
- **stage**: the on-screen canvas. `viewer.viewTransform = { scale, offsetX,
  offsetY }` maps world → stage CSS pixels and implements zoom + pan. The
  canvas backing store is stage CSS size × `devicePixelRatio`.

When a layer's `draw(context, renderState)` runs, the canvas transform is
already composed so the layer draws in **local coordinates**. Anything that
must have constant on-screen size (vertex handles, line widths) divides by
`renderState.pixelsPerLocalUnit`.

## Modules and contracts

### `js/viewer.js` — exports `class Viewer extends EventTarget`

Owns the stage `<canvas>`, the view transform, the layer list, and pointer
routing. Does not know about the document or tools' semantics.

```js
const viewer = new Viewer(stageCanvas);
viewer.layers;                       // Array<Layer>, index 0 = bottom
viewer.addLayer(layer); viewer.removeLayer(layer);
viewer.moveLayerToIndex(layer, index);
viewer.viewTransform;                // { scale, offsetX, offsetY }
viewer.worldFromPointerEvent(event); // → {x, y} world coordinates
viewer.zoomAtStagePoint(factor, stagePoint);
viewer.panByStagePixels(deltaX, deltaY);
viewer.fitToContent();               // frame the union of layer contentBounds()
viewer.requestRender();              // mark dirty; actual paint on next tick
viewer.renderIfNeeded(renderState);  // called from the main animation loop
viewer.setOverlayPainter(fn|null);   // fn(context, renderState) drawn above all
                                     // layers in WORLD coordinates (for tools)
// Events dispatched: 'view-changed' (after zoom/pan)
```

Zoom/pan interaction lives in the viewer (wheel or pinch to zoom about the
cursor, middle-drag to pan) so it works in every tool. When **no tool is
selected** (clicking the active tool button — or pressing its hotkey — while it
is already active toggles it off), a left-drag pans as well, via
`viewer.beginPanFromPointerEvent(event)`. Space is exclusively play/pause. All
other pointer events are forwarded to the active tool by `main.js`.

There is **no separate select tool**: the point/line/polygon tools hit-test
their target layer on pointer-down, so pressing an existing annotation of the
tool's own kind **selects** it, dragging **moves** it (the whole item, or the
grabbed vertex), and — for shapes — double-clicking a segment inserts a vertex;
only empty space creates. This shared behavior lives in
`js/tools/annotation-dragging.js`.

### `js/layers/layer.js` — exports `class Layer extends EventTarget`

```js
layer.id; layer.type;                // 'video' | 'image' | 'points' | 'shapes' | 'events'
layer.name; layer.visible; layer.opacity;   // opacity 0..1
layer.transform;                     // { scale, offsetX, offsetY } local → world
layer.draw(context, renderState) {}  // context already in local coordinates
layer.contentBounds();               // {x, y, width, height} in local coords, or null
layer.hitTest(localPoint, renderState); // annotation layers only, see below
// Setters dispatch 'layer-changed' on the layer; Viewer re-renders on it.
```

`renderState` (assembled by `main.js` each paint):

```js
{
  frame,               // integer current frame (engine.currentFrame)
  frameFloat,          // engine.currentFrameFloat, for interpolated drawing
  pixelsPerLocalUnit,  // on-screen pixels per local unit for THIS layer
  selection,           // { layerId, itemId, vertexIndex } or null
  hover,               // same shape as selection, or null
  document,            // the AnnotationDocument (for class colors etc.)
}
```

### Annotation-layer editing contract

Annotation layers (points, shapes) implement `hitTest` plus generic editing
methods so the shared drag-editing helpers (`js/tools/annotation-dragging.js`)
work without knowing shape internals:

```js
layer.hitTest(localPoint, renderState)
  // → { itemId, part: 'body' | 'vertex' | 'segment', vertexIndex } | null
  // part 'vertex': vertexIndex names the vertex (points layers use 0).
  // part 'segment' (shapes only): vertexIndex names the segment — segment i
  //   connects vertex i to vertex i + 1 (wrapping for closed polygons).
  // Handle sizes are screen-constant: tolerance = HANDLE_RADIUS_SCREEN_PIXELS
  //                                              / renderState.pixelsPerLocalUnit
layer.getItem(itemId);               // live item object (read-only use)
layer.items;                         // the backing array from the document

// Direct-mutation methods, used by the drag helpers for live drag PREVIEW only
// (they bypass undo on purpose; the drag is committed once, on pointer up,
// via a snapshot command):
layer.snapshotItemGeometry(itemId);            // → opaque deep copy
layer.restoreItemGeometry(itemId, snapshot);   // set geometry from a snapshot
layer.moveItemBy(itemId, deltaLocal);          // translate the whole item
layer.moveVertexTo(itemId, vertexIndex, localPoint);

// Command-returning methods (caller passes the result to undoHistory.execute):
layer.commandInsertVertex(itemId, segmentIndex, localPoint);  // shapes only
layer.commandDeleteVertex(itemId, vertexIndex);  // shapes only; deleting below
                                                 // the minimum vertex count
                                                 // (3 polygon, 2 line) deletes
                                                 // the whole item
layer.commandDeleteItem(itemId);
```

A finished drag is committed with a generic snapshot command: `apply()`
restores the after-snapshot, `revert()` the before-snapshot.

Annotation layers are **views over the document**: their `items` array IS the
corresponding document layer's `items` array (same object identity). They hold
no copied state. Every annotation layer class has the constructor signature
`new PointsLayer(documentLayer)` (likewise shapes/events): it copies `id`,
`name`, `visible`, `opacity`, and `transform` from the document layer into the
base-class fields, keeps `this.documentLayer = documentLayer`, and sets
`this.items = documentLayer.items`. `main.js` writes base-field changes (from
the layer panel) back into the document layer whenever the view layer
dispatches `'layer-changed'`.

Frame binding for drawing: an item whose `frame` equals `renderState.frame`
draws at full strength; other frames draw dimmed at reduced alpha (the
movim-website "off-frame" convention) so nearby context stays visible. A
**frame-agnostic** item (`frame === null`) applies across every frame and so
always draws (and hit-tests) at full strength. The tool rail's anchored/agnostic
mode toggle (`app.annotationMode`, `app.newItemFrame`) decides which kind the
point/line/polygon tools create; it never alters existing items. Events layers
have no spatial drawing (their `draw` is a no-op).

### `js/document.js` — the annotation document

```js
createEmptyDocument() → AnnotationDocument
documentToJson(annotationDocument) → plain object (stable, versioned)
documentFromJson(jsonObject) → AnnotationDocument (validates, migrates)
newId() → unique string id
autosaveKey(videoInformation) → string      // keyed by video name + size
saveAutosave(key, annotationDocument); loadAutosave(key); clearAutosave(key)
```

Document shape (also the export JSON, `format: "exact-video-annotator"`,
`version: 1`):

```js
{
  video: { name, numberOfFrames, frameRate, frameIndexIsExact,
           durationSeconds, width, height },      // provenance, written on export
  classes: [ { id, name, color } ],               // label registry for spatial items
  eventTypes: [ { id, name, kind: 'point' | 'range', color,
                  addHotkey, removeHotkey } ],    // hotkeys are single characters,
                                                  // case-sensitive (may be null)
  layers: [
    { id, type: 'points', name, visible, opacity, transform,
      items: [ { id, frame, x, y, classId, name } ] },
      // frame: integer (anchored to that frame) or null (frame-agnostic —
      //        applies across every frame; drawn full-strength on all frames)
    { id, type: 'shapes', name, visible, opacity, transform,
      items: [ { id, frame, kind: 'polygon' | 'line',
                 vertices: [[x, y], ...], classId, name } ] },
      // frame: integer or null, same frame-agnostic meaning as points
    { id, type: 'events', name,
      items: [ { id, eventTypeId, startFrame, endFrame } ] },
      // point events: endFrame === startFrame
      // an in-progress range has endFrame === null (never exported)
  ],
}
```

`classId` and `name` on items are both optional (`null`). Colors are CSS color
strings. A new document starts with one layer of each type.

### `js/undo.js` — exports `class UndoHistory extends EventTarget`

```js
undoHistory.execute(command);   // applies and pushes
undoHistory.undo(); undoHistory.redo();
undoHistory.canUndo; undoHistory.canRedo;
// command: { label, apply(), revert() } — apply/revert must be exact inverses
//          and are also responsible for dispatching nothing; UndoHistory
//          dispatches 'history-changed' after any operation.
```

`main.js` listens for `'history-changed'` and re-renders + autosaves.

### `js/tools/…` — tool objects

A tool is a plain object registered in `main.js`'s `toolRegistry`:

```js
{
  id: 'point', name: 'Add points', hotkey: 'o', cursor: 'crosshair',
  activate(app) {}, deactivate(app) {},
  onPointerDown(app, worldPoint, event) {},   // worldPoint: {x, y} world coords
  onPointerMove(app, worldPoint, event) {},
  onPointerUp(app, worldPoint, event) {},
  onKeyDown(app, event) → boolean,            // true if handled
  drawOverlay(context, renderState) {},       // world coordinates, above layers
}
```

Tools convert world → layer-local via `app.localFromWorld(layer, worldPoint)`.
Tools mutate only through `app.undoHistory.execute(...)`.

### `js/main.js` — the `app` object (passed to tools and UI initializers)

```js
app.viewer; app.engine;              // engine may be null before a video loads
app.annotationDocument; app.undoHistory;
app.activeLayer;                     // the annotation layer new items go into
app.activeClassId;                   // class assigned to newly created items
app.selection;                       // { layerId, itemId, vertexIndex } | null
app.setSelection(selectionOrNull);
app.setActiveTool(toolId);           // toolId null clears the tool (drag pans);
                                     // pressing the active tool's hotkey (or
                                     // clicking its button) clears it too
app.activeTool;
app.deleteSelection();               // delete selected vertex/item; Delete key
app.localFromWorld(layer, worldPoint); app.worldFromLocal(layer, localPoint);
app.seekToFrame(frameIndex);         // clamps, delegates to engine
app.currentFrame;                    // engine.currentFrame or 0
app.showToast(message, { kind } = {});   // kind: 'info' | 'warning' | 'error'
app.markDocumentChanged();           // dispatches 'document-changed' + autosave
app.hover;                           // set by tools while hovering an existing
                                     // annotation; same shape as selection
app.togglePlayback(); app.stepFrame(delta);
app.annotationLayers;                // view layers of type points/shapes/events
app.setActiveLayer(layerId);
app.addAnnotationLayer(type);        // undoable; returns the new view layer
app.removeAnnotationLayer(layerId);  // undoable
app.findAnnotationLayerForType(type);// active layer if it matches, else first
                                     // of that type, else null (never creates
                                     // — safe on every pointer move)
app.targetLayerForType(type);        // same, but creates a layer if none exists
app.synchronizeDocumentLayerOrder(); // document layer order ← viewer stack
                                     // order (after tabs are dragged)
app.addKeyHandler(handler);          // handler(event) → true if handled; runs
                                     // after tool onKeyDown (event-hotkeys)
app.isTypingTarget(event);           // true when focus is in a text input
app.videoInformation;                // { name, sizeBytes, numberOfFrames, ... } | null
// app extends EventTarget; events: 'document-changed', 'frame-changed',
// 'selection-changed', 'layers-changed', 'tool-changed', 'video-loaded',
// 'playback-changed'
```

UI modules export `initialize<Thing>(app, containerElement)` and subscribe to
app events; they never poll.

### UI modules

- `js/ui/transport.js` — play/pause, ±1 frame step, frame-unit scrubber,
  numeric frame input, frame/time readout, exactness indicator
  (`engine.frameIndexIsExact === false` shows a visible warning chip).
  Keyboard: Space play/pause; `ArrowLeft`/`,` and `ArrowRight`/`.` step.
- `js/ui/layer-tabs.js` — the layer tab bar under the canvas (leftmost tab =
  bottom of the stack): click to select, double-click to rename, drag a tab
  sideways to re-order the stack; each tab carries an eye icon (right of the
  name and type badge) toggling visibility; ＋ adds an annotation layer and ✕
  deletes the selected one (confirming when it holds annotations).
- `js/ui/layer-detail.js` — settings for the selected layer (visibility,
  opacity, scale/offset transform; playback facts for the video layer).
- `js/ui/annotations-table.js` — items of the selected layer by default, or of
  every annotation layer when "Show all annotations" (top right of the panel)
  is checked; sortable; click a row to select + jump to its frame; per-row
  delete.
- `js/ui/class-manager.js` — edit `classes` and `eventTypes` (name, color,
  hotkeys); pick `app.activeClassId`.
- `js/ui/toasts.js` — transient notifications; `initializeToasts` wires
  `app.showToast`.
- `js/tools/event-hotkeys.js` — global key handling for event types
  (add/remove keys, range start/stop semantics from
  simple-html-tools/video-annotator: first press starts a range at the current
  frame, second press ends it; point events are single-press; remove key
  deletes the event overlapping the current frame).

## Keyboard map (global, suppressed while typing in inputs)

| Key | Action |
| --- | --- |
| `Space` | play/pause |
| `ArrowLeft` / `,` , `ArrowRight` / `.` | step one frame |
| `o` | point tool |
| `g` | polygon tool |
| `l` | line tool |
| `v` | toggle the selected layer's visibility |
| `a` | toggle frame-agnostic mode for new annotations |
| `f` | fit the view to the content |
| `Delete`/`Backspace` | delete selected item (or selected vertex) — works in any tool |
| `Escape` | cancel in-progress shape / clear selection |
| `Cmd/Ctrl+Z`, `Shift+Cmd/Ctrl+Z` | undo, redo |
| event-type hotkeys | user-defined, case-sensitive |

A tool hotkey pressed while that tool is already active **deselects** it
(back to no tool, where a left-drag pans).

## Video pipeline

The engine is loaded from pinned jsDelivr script tags (mp4box first), exactly
as its README prescribes. `VideoLayer` hosts the engine's canvas + `<video>`
element inside a hidden, correctly sized container (the engine sizes its canvas
backing store from its parent), and its `draw` paints
`engine.displayElement` onto the stage — identical code for both engine tiers,
rotation already applied. The main animation loop calls `engine.update(now)`
every tick and repaints while playing or when anything is dirty.

Large files work lazily end to end: `File`/`Blob` sources are read by byte
range on demand (the engine's `FileRangeReader`), the container index is a few
range reads for MP4, and decode memory is byte-budgeted around the playhead.

A fatal mid-stream decode error (see engine README) rebuilds with
`createBestEngine(source, { prefer: 'native' })` at the same playhead.

## Persistence

- Export/import: a single JSON file (`<video-name>.annotations.json`).
- Autosave: the serialized document under `localStorage` keyed by video
  name + size, saved (debounced) on every `'document-changed'`; offered for
  restore when the same video is reopened.

## Deploy

Cloudflare Pages, build command `bash build.sh`, output directory `dist/`.
`build.sh` copies the static app (index.html, style.css, js/) into `dist/` —
there is no compile step.
