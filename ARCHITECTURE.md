# exact-video-annotator — architecture

A browser-only, napari-style layered annotation app for video and images, built
on [exact-video-engine.js](https://github.com/jasper-tms/exact-video-engine.js).
Multiple layers share one canvas: media layers (video, image) and annotation
layers (Coordinates — points/lines/polylines, Segmentation, Frames — temporal
events), each with visibility, opacity, z-order, and a scale/offset transform.
Several videos can be open at once, each as its own layer with its own engine —
one is the primary, the rest follow it (see "Multiple videos" under "Video
pipeline"). No server, no build step: plain ES modules served statically.

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

There is **no separate select tool**: the point/line/polyline tools hit-test
their target layer on pointer-down, so pressing an existing annotation of
**any** kind **selects** it and dragging **moves** it (the whole item, or the
grabbed vertex) — no tool is blind to another kind's annotations. This shared
behavior lives in `js/tools/annotation-dragging.js`. A click on empty space
instead **deselects**; if it turns into a drag instead, it **pans** the view
regardless of which tool is active. Starting a brand-new annotation always
takes a **double-click** — on empty space, or on an annotation of a different
kind than the active tool. A double-click on a same-kind annotation is a no-op
(it was already selected by the two preceding pointer-downs), except
double-clicking a **segment** (not a vertex) of a same-kind line/polyline,
which inserts a vertex there — this one interaction stays kind-specific.
Escape on an in-progress line/polyline commits whatever has been placed so far
as an open shape rather than discarding it (falling back to discarding only
when there are too few vertices to be a valid shape at all).

### `js/layers/layer.js` — exports `class Layer extends EventTarget`

```js
layer.id; layer.type;                // 'video' | 'image' | 'coordinates' | 'segmentation' | 'frames'
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

The Coordinates layer implements `hitTest` plus generic editing methods so the
shared drag-editing helpers (`js/tools/annotation-dragging.js`) work without
knowing item internals (Segmentation and Frames are non-spatial stubs and
implement neither):

```js
layer.hitTest(localPoint, renderState)
  // → { itemId, part: 'body' | 'vertex' | 'segment', vertexIndex } | null
  // part 'vertex': vertexIndex names the vertex (a point item's one vertex is
  //   always 0).
  // part 'segment' (lines/polylines only): vertexIndex names the segment —
  //   segment i connects vertex i to vertex i + 1. A closed polyline's closing
  //   edge is an ordinary trailing segment here, not a wrap-around special
  //   case — see "Polylines: open vs. closed" below. A point item has no
  //   segments.
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
layer.moveVertexTo(itemId, vertexIndex, localPoint);  // moving vertex 0 of a
                                                 // closed polyline also moves
                                                 // its closing duplicate

// Command-returning methods (caller passes the result to undoHistory.execute):
layer.commandInsertVertex(itemId, segmentIndex, localPoint);  // lines/polylines only
layer.commandDeleteVertex(itemId, vertexIndex);  // deleting below the minimum
                                                 // vertex count (1 point, 2
                                                 // line/open polyline, 4 closed
                                                 // polyline) deletes the whole
                                                 // item instead
layer.commandDeleteItem(itemId);
```

### Polylines: open vs. closed

A polyline (`kind: 'polyline'`) is closed **exactly when its last stored vertex
is a literal duplicate of its first** — `isClosedPolyline(item)` in
`js/layers/coordinates-layer.js` is the sole source of truth; there is no
separate flag, and a line is never closed. The polyline tool
(`js/tools/polyline-tool.js`) appends that duplicate only when the shape is
closed by clicking back on its first vertex; finishing any other way (Enter,
double-click, or the line tool's fixed two-vertex cap) always leaves the shape
open. Because closure lives entirely in the vertex list, the closing edge is
just an ordinary trailing segment — rendering, hit-testing, and vertex
insertion need no separate "wrap to vertex 0" case. Dragging vertex 0 of a
closed polyline moves its closing duplicate along with it (`moveVertexTo`);
the duplicate itself is never independently draggable, since hit-testing
always finds vertex 0 first when the two coincide.

A finished drag is committed with a generic snapshot command: `apply()`
restores the after-snapshot, `revert()` the before-snapshot.

On top of this contract, a layer may implement the optional annotation-logic
hooks under "Plugins" below, which let it adjust geometry as it is drawn or
dragged. Layers without them are untouched by that machinery.

Annotation layers are **views over the document**: their `items` array IS the
corresponding document layer's `items` array (same object identity). They hold
no copied state. Every annotation layer class has the constructor signature
`new SegmentationLayer(documentLayer)` (likewise Frames): it copies `id`,
`name`, `visible`, `opacity`, and `transform` from the document layer into the
base-class fields, keeps `this.documentLayer = documentLayer`, and sets
`this.items = documentLayer.items`. `main.js` writes base-field changes (from
the layer panel) back into the document layer whenever the view layer
dispatches `'layer-changed'`. `CoordinatesLayer` additionally takes the
`Application` instance as a second constructor argument (`new
CoordinatesLayer(documentLayer, app)`) — kept only so `snapLocalPoint` can read
the document's integer-coordinate convention; the other constructors ignore
a second argument if passed one.

Frame binding for drawing: an item whose `frame` equals `renderState.frame`
draws at full strength; other frames draw dimmed at reduced alpha (the
movim-website "off-frame" convention) so nearby context stays visible. A
**frame-agnostic** item (`frame === null`) applies across every frame and so
always draws (and hit-tests) at full strength. The tool rail's anchored/agnostic
mode toggle (`app.annotationMode`, `app.newItemFrame`) decides which kind the
point/line/polyline tools create; it never alters existing items. Segmentation
and Frames layers have no spatial drawing (their `draw` is a no-op).

### `js/document.js` — the annotation document

```js
createEmptyDocument() → AnnotationDocument
documentToJson(annotationDocument) → plain object (stable, versioned)
documentFromJson(jsonObject) → AnnotationDocument (validates; no migration —
                                                    an old-schema file is
                                                    rejected outright)
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
  // Whether an integer (x, y) names a pixel's top-left corner (0, the
  // default) or its center (0.5); consulted only by the video layer's draw().
  integerCoordinateOffset: 0 | 0.5,
  layers: [
    { id, type: 'coordinates', name, visible, opacity, transform,
      allowFractionalCoordinates,
      plugin: { id: 'line-fitter', options: { … } },   // optional, see "Plugins"
      items: [ { id, frame, kind: 'point' | 'line' | 'polyline',
                 vertices: [[x, y], ...], classId, name } ] },
      // frame: integer (anchored to that frame) or null (frame-agnostic —
      //        applies across every frame; drawn full-strength on all frames)
      // a point item's vertices array always has exactly one [x, y] pair
      // a polyline item is closed iff its last vertex duplicates its first —
      //   see "Polylines: open vs. closed" above; a line item never is
      // allowFractionalCoordinates: when false (the default), every new or
      //   moved vertex snaps per integerCoordinateOffset (floor for 0, round
      //   for 0.5) — see CoordinatesLayer.snapLocalPoint. A live per-layer
      //   toggle, never locked, freely mixed with fractional annotations.
    { id, type: 'segmentation', name, visible, opacity, transform, items: [] },
      // stub: pixel-wise segmentation is not implemented yet, so items is
      // always empty — nothing produces or parses items for this type
    { id, type: 'frames', name,
      items: [ { id, eventTypeId, startFrame, endFrame } ] },
      // point events: endFrame === startFrame
      // an in-progress range has endFrame === null (never exported)
  ],
}
```

`classId` and `name` on items are both optional (`null`). Colors are CSS color
strings. A new document starts with one Coordinates layer and one Frames
layer (Segmentation is opt-in from the ＋ menu, since it's not usable yet).

A layer's optional `plugin` field names the plugin the layer belongs to and
carries that plugin's settings. Its items stay ordinary items of the layer's
`type`, so a build without that plugin still reads the file (it says so, opens
the layer plain, and keeps the field on re-export).

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
app.viewer;
app.engine;                          // the PRIMARY video's engine — null before
                                     // any video loads; everything transport-
                                     // and frame-related reads this alias
app.primaryVideoLayer;               // the VideoLayer whose engine that is
app.videoLayers;                     // every open video's layer, stack order
app.synchronizeFollowerVideos();     // seek followers to match the primary
app.setVideoLinkMode(videoLayer, mode);        // 'frame-index' | 'timestamp';
                                     // converts the offset so the current
                                     // alignment is preserved
app.setVideoTemporalOffset(videoLayer, value); // frames or seconds, per mode
app.closeVideoLayer(layerId);        // destroy engine + host, remove layer;
                                     // closing the primary promotes the next
                                     // video (not undoable)
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
app.startPlayback(); app.pausePlayback();      // unified play/pause: a single
                                     // engine's own play()/pause(), or the
                                     // app-driven synchronized loop when it applies
app.isPlaying;                       // playhead advancing either way (read this,
                                     // not engine.paused — a synced play leaves
                                     // every engine's own paused flag true)
app.isSyncedPlaying;                 // the synchronized loop is running
app.shouldUseSyncedPlayback();       // >1 video and all on the WebCodecs tier
app.annotationLayers;                // view layers of type coordinates/segmentation/frames
app.setActiveLayer(layerId);
app.addAnnotationLayer(type, { pluginId });  // undoable; returns the new view
                                     // layer (a plugin's, with a pluginId)
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
app.videoInformation;                // the PRIMARY video's facts: { name,
                                     // sizeBytes, numberOfFrames, ... } | null;
                                     // rebuilt on every index event, so its
                                     // counts follow a growing index (each
                                     // VideoLayer holds its own copy)
// app extends EventTarget; events: 'document-changed', 'frame-changed',
// 'selection-changed', 'layers-changed', 'tool-changed', 'video-loaded',
// 'playback-changed', 'index-changed'
```

UI modules export `initialize<Thing>(app, containerElement)` and subscribe to
app events; they never poll.

### UI modules

- `js/ui/transport.js` — play/pause, ±1 frame step, frame-unit scrubber,
  numeric frame input, frame/time readout, exactness indicator
  (`engine.frameIndexIsExact === false` shows a visible warning chip), and the
  growing-index displays described under "Video pipeline" below.
  Keyboard: Space play/pause; `ArrowLeft`/`,` and `ArrowRight`/`.` step.
- `js/ui/layer-tabs.js` — the layer tab bar under the canvas (leftmost tab =
  bottom of the stack): click to select, double-click to rename, drag a tab
  sideways to re-order the stack; each tab carries an eye icon (right of the
  name and type badge) toggling visibility; ＋ adds an annotation layer — its
  menu's second page, **Plugins ›**, adds a plugin layer — and ✕ deletes the
  selected one (confirming when it holds annotations). A video layer's ✕
  closes that video instead (via `app.closeVideoLayer`; confirming only when
  closing the primary would re-key existing annotations to the next video's
  frames). When several videos are open, the primary's tab carries a small
  clock icon. A plugin layer's badge
  names its plugin rather than its storage type.
- `js/ui/layer-detail.js` — settings for the selected layer (visibility,
  opacity, scale/offset transform; playback facts for a video layer — its own
  engine's, not necessarily the primary's; a plugin's own settings, built by
  the plugin). With several videos open, a follower video's panel adds the
  link controls ("follow the primary by" frame index or timestamp, plus the
  offset in frames or seconds), and the primary's says it is the primary.
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

## Plugins

A plugin is an annotation layer type with extra annotation logic baked in. It
is added from the tab bar's ＋ menu under **Plugins ›** (which also lists a
not-yet-functional **Upload…**), appears as its own tab, and contributes its
own settings to the layer detail panel.

A plugin does **not** invent a storage format: it reuses one of the built-in
annotation layer types, so its annotations are ordinary items of that layer's
type in the document and in the export. Only the layer says which plugin made
it.

`js/plugins/registry.js` holds the descriptors:

```js
{
  id, name, description,
  layerType: 'coordinates' | 'segmentation' | 'frames',   // storage, and what tools target
  preferredToolId,                             // selected when a layer is added
  createViewLayer(documentLayer, app) → Layer,  // documentLayer.plugin = {id, options}
  buildSettings(app, layer) → HTMLElement,      // shown in the layer detail panel
}
```

The layer it builds is a normal annotation layer (usually a subclass of one)
that may implement any of these **optional annotation-logic hooks**. The
drawing tools and the drag helpers call them when they exist, so a layer
without them behaves exactly as before:

```js
layer.plugin;                                    // the descriptor, or absent
layer.options;                                   // the plugin's settings
layer.shouldFinishAfterVertex(vertices, kind);   // → true ends the shape now
layer.afterVertexPlaced(app, vertices, kind);    // may move the in-progress
                                                 // vertices (layer-local)
layer.beforeShapeCommitted(app, vertices, kind); // last word before the item
                                                 // becomes an undo command
layer.afterItemDragged(app, itemId);             // runs inside the drag's own
                                                 // command, so both undo as one
layer.refitItem(app, itemId);                    // → true if geometry changed;
                                                 // used by `r` and the panel
```

`js/plugins/refit.js` wraps `refitItem` in an undo command;
`js/plugins/frame-pixels.js` is the shared way to read the pixels of the frame
on screen (a luminance patch of the engine's display element, plus
layer-local ↔ video-pixel conversions), for plugins whose logic looks at the
image. With several videos open it reads the **topmost visible** video layer —
the picture actually in front of the user — using that same layer for both the
pixels and the coordinate conversions. Its sampler honors the coordinate convention the video layer draws
with: **integers sit at pixel corners** (pixel `k` spans `[k, k + 1)`, its
center is `k + 0.5`), so a fit lands where the feature is *drawn* — the border
between two pixel rows is an exact integer, the center of a pixel-aligned
stripe a half-integer. An index-as-position sampler would put every fit half a
pixel off on screen while looking correct in its own coordinates.

### The line fitter (`js/plugins/line-fitter/`)

A coordinates layer that snaps what you draw onto the structure under it. Drop two
points near an edge and the line locks onto the edge; the fit runs the moment a
vertex is dropped (the line tool is always done at two points, per its fixed
vertex cap — see "Polylines: open vs. closed"), after a drag when "re-fit after
dragging" is on, and on demand with `r`.

- **Points move perpendicular to their own segment only**, so the drawn length
  is preserved to within a fraction of a pixel however far they travel.
- A vertex that already belongs to a fitted segment may only **slide along**
  that segment when the next one is fitted, so extending a polyline cannot drag
  an earlier segment off the edge it found. A closed polyline's closing segment
  — the last real corner back to the duplicate that marks it closed — is
  therefore fitted last, after every other segment, with that duplicate synced
  back onto the real first vertex once it lands (`fitClosingSegment` in
  `fit-line.js`).
- Both modes score a placement from its **perpendicular profile**: the mean
  luminance at each distance out from the candidate line, averaged along its
  length. Averaging along the line first is what makes a faint edge that runs
  the length of the line beat a strong one that merely crosses it.
- **Lock to edge** differentiates that profile at the line with a Gaussian
  derivative, normalized so the score reads as the height of the step the line
  sits on.
- **Lock to stripe center** compares a band of the profile centered on the line
  against the flanks just outside it, over every stripe half-width in range
  (1–20 px wide by default), minus half of any difference BETWEEN the two
  flanks — being centered means the same background on both sides, and that
  penalty exactly cancels the score's one imposter (a band parked beside the
  stripe with the whole stripe caught in one flank), which the descent would
  otherwise settle into. The winning half-width is a real measurement of the
  stripe, which is what the panel reports.
- **Both scores must peak, not plateau** — this is the whole reason they are
  shaped this way. A two-tap difference `|I(p+1) − I(p−1)|` scores *identically*
  anywhere within a tap-spacing of an edge, and a line-versus-two-probes score
  is flat right across the middle of a stripe once the probes clear it. Under a
  flat score the search stops wherever it entered the flat region, so the fit
  lands near the feature but never on it, differently every time. Both
  replacements have a single maximum, at the edge and at the stripe's center
  respectively; `test/line-fitter-test.mjs` pins that down by fitting a hard
  step and a one-pixel stripe from ten starting offsets and two tilts and
  requiring every one to land in the same place.
- **The search is a local descent, not a sweep, in both modes.** From exactly
  where the points were dropped, the placement walks uphill in score — each
  endpoint nudged along its allowed direction, alone and together — moving
  only while a neighboring placement strictly improves, with the step halving
  from 0.5 px down to 0.01 px. It settles into the NEAREST local optimum and
  can never cross a valley to a stronger feature further away, which is the
  point: a faint edge under the line always beats a bold one a few pixels off.
  Travel is deliberately unbounded — while every step keeps improving, the
  line is still riding one continuous feature and may follow it as far as it
  goes (a wide soft edge pulls a line in from many pixels away). What bounds
  the fit instead is capture: the score only feels a feature within the
  profile's reach (about ±2 px in edge mode, the widest stripe plus its
  flanks in stripe mode), so a line placed further off than that from
  anything at all visibly stays put rather than leaping. Exact ties go to
  leaving the points where the user put them, so a flat image moves nothing.
  Fitted coordinates within 0.01 px of a half-integer are rounded to it
  (edges live on pixel borders, stripe centers on pixel centers).
- Pixels are read one bounded patch at a time: the layer reads the shape's
  bounding box plus the profile's reach and a few pixels of travel headroom,
  and a fit that ends pressed against the patch border (where clamped pixels
  read as flat) is simply re-run against a fresh patch read around where it
  got to, until it stops moving.

`js/plugins/line-fitter/fit-line.js` is pure math over a `sampleLuminance(x, y)`
function, with no DOM and no app — which is what lets `test/line-fitter-test.mjs`
drive it with synthetic edges and stripes.

## Keyboard map (global, suppressed while typing in inputs)

| Key | Action |
| --- | --- |
| `Space` | play/pause |
| `ArrowLeft` / `,` , `ArrowRight` / `.` | step one frame |
| `1`–`9` | activate the Nth tool-rail button from the top (currently: `1` pan, `2` point, `3` line, `4` polyline) |
| `0` | scroll to/from the details section (same button, bottom of the tool rail) |
| `v` | toggle the selected layer's visibility |
| `a` | toggle frame-agnostic mode for new annotations |
| `f` | fit the view to the content |
| `r` | re-fit the selected annotation (plugin layers that fit; see "Plugins") |
| `Delete`/`Backspace` | delete selected item (or selected vertex) — works in any tool |
| `Escape` | commit an in-progress line/polyline as an open shape (or cancel outright if too few vertices), else clear the selection |
| `Cmd/Ctrl+Z`, `Shift+Cmd/Ctrl+Z` | undo, redo |
| event-type hotkeys | user-defined, case-sensitive |

Tool number keys are assigned by position, not written statically per tool —
see the `toolHotkeys` map built in `main.js` from `#tool-rail button[data-tool]`
order. Only the first 9 tool-rail buttons get one; `0` is reserved for the
scroll-to-details button regardless of how many tools exist. A tool hotkey (or
button click) for the tool that is already active does not deselect it back to
pan — every tool pans on its own now (an empty-space drag always pans), so
there is nothing useful to fall back to — it just **blinks** the button
briefly instead, acknowledging the press.

## Video pipeline

The engine is loaded from pinned jsDelivr script tags (mp4box first), exactly
as its README prescribes. Each `VideoLayer` owns one engine and hosts that
engine's canvas + `<video>` element inside its own hidden, correctly sized
container (a per-video `<div>` created inside `#video-host`; the engine sizes
its canvas backing store from its parent), and its `draw` paints
`engine.displayElement` onto the stage — identical code for both engine tiers,
rotation already applied. The main animation loop calls `engine.update(now)`
on every open engine every tick and repaints while playing or when anything is
dirty (including any engine's `presentedFrame` changing — a follower's seek
landing must reach the canvas too).

Large files work lazily end to end: `File`/`Blob` sources are read by byte
range on demand (the engine's `FileRangeReader`), the container index is a few
range reads for MP4, and decode memory is byte-budgeted around the playhead.

A fatal mid-stream decode error (see engine README) rebuilds that one video
with `createBestEngine(source, { prefer: 'native' })` at the same playhead and
swaps the new engine into the existing layer (`videoLayer.replaceEngine`) —
except when the error carries `detail.incomplete`, which is an index that
stopped early rather than a dead decoder. Those frames keep playing and the
native tier would only re-scan the same container, so that case only warns.

### Multiple videos: one primary, seek-following followers

A newly dropped or opened video (`loadVideoIntoWorkspace`) usually becomes a
new video layer stacked directly above the topmost video (videos sit together
beneath the annotation layers). Re-dropping an already-open clip opens another
layer of it — two copies at different temporal offsets is a legitimate way to
compare moments of one clip.

The exception is the **"Second video" setting** (Settings modal, a global
`localStorage` preference — `js/second-video-preference.js`), which governs the
one case where a single video is already open and another is loaded: `'prompt'`
(default) asks each time via a small dialog (`js/ui/second-video-prompt.js`,
with an optional "save my choice"), `'replace'` swaps out the current video,
and `'new-layer'` stacks it. With no video open the drop is simply the first
video; with two or more already open it always makes a new layer, regardless of
the setting (there is no single video to replace). Replace loads the new clip as
a follower, then closes the video it replaces — which promotes the newcomer to
primary (`app.closeVideoLayer`) and refits the view. The annotation document is
left untouched by a replace: its frame indices now describe the new video's
frames, matching how promoting a video on close already behaves.

A video added as a **new layer** loads at 50% opacity so the videos beneath
show through it, and the first time a second video joins, the primary drops
from a full 100% to 50% too (a primary already at some other opacity is left as
the user set it; a third-or-later video only dims itself). Replace skips this —
its incoming video becomes the sole primary, so it stays at 100%.

- **One video is the primary** (`app.primaryVideoLayer`): the first one
  loaded. Its engine drives the transport bar, `app.currentFrame`,
  `renderState.frame`, annotation frame indices, and the autosave key —
  `app.engine` is an alias for it, so everything that predates multiple
  videos keeps meaning what it always meant. Closing the primary promotes
  the next remaining video (bottom of the stack first); annotation frame
  numbers then mean THAT video's frames.
- **Other videos are followers**, seeked to the frame matching the primary
  per their link settings (`videoLayer.linkMode`, `videoLayer.temporalOffset`
  — session-only state, never written into the document):
  - `'frame-index'` (the default): follower frame = primary frame + offset in
    frames. Right when the files correspond frame for frame regardless of
    what their timestamps claim — trigger-synchronized camera rigs, processed
    renditions of the same clip.
  - `'timestamp'`: follower frame = `frameAtTime(primary time + offset in
    seconds)`, through the follower engine's own frame↔time table — never an
    assumed frame rate. Right for independent recordings of the same scene at
    different frame rates.
  Switching modes converts the offset so the current alignment is preserved
  (`app.setVideoLinkMode`).
- **Continuous playback is synchronized across every video**, and stays
  frame-exact rather than drifting. Instead of any engine playing on its own
  clock (which would drift, since each engine keeps its own), the app owns one
  master clock and, every animation tick, seeks *every* engine — the primary
  included, never `engine.play()` — to the frame matching that clock, then
  paints only once **all** of them have their target frame decoded (the
  barrier). So every composite that reaches the canvas shows the correct frame
  from every video at the same instant. This is only feasible because a
  forward-by-one `seekToFrame` is cheap on the WebCodecs tier — it reuses the
  warm decode pipeline and read-ahead cache rather than re-seeking — which the
  engine's `sync-benchmark` test pins (four 1080p engines sustain real time
  with ~1 tick per frame). The whole loop lives in `app.driveSyncedPlayback`,
  driven from the animation tick while `app.isSyncedPlaying`; play/pause go
  through `app.startPlayback`/`pausePlayback` so the transport is unchanged.
  - When the decoders cannot quite keep up, a global preference
    (`js/synced-playback-preference.js`, Settings ▸ "Multi-video playback")
    decides what gives, both keeping every painted composite exact:
    `'realtime'` (the default) holds the wall clock and skips frames from view;
    `'every-frame'` advances only once every engine is ready, slowing below real
    time. The pacing is captured at play start, so changing it mid-play takes
    effect on the next play.
  - Synchronized playback applies only with **more than one video, all on the
    WebCodecs tier** (`app.shouldUseSyncedPlayback`). A single video, or any
    follower on the native `<video>` tier (where a forward seek is a real,
    non-cheap element seek), falls back to the primary playing on its own clock
    with followers catching up on each discrete frame change while paused and on
    each pause — including the playhead reaching the end of the clip, which the
    animation loop announces as a `'playback-changed'`.

Spatial alignment is the layer transform that every layer already has;
per-video visibility and opacity likewise come free from the layer system.

### An index that is still being built

The app opens clips with `playWhileIndexing: true`, so a container with no
central index (WebM/MKV, fragmented MP4) starts playing as soon as its opening
frames are certified and keeps indexing underneath. `engine.numFrames` and
`engine.duration` then describe the **indexed prefix**, not the clip, and rise
as it grows; `engine.expectedDuration` is the container's declared total, a
claim that never names a frame. Every frame number already published is exact
and permanent, so annotations written during indexing need no special handling.

Matroska declares that total, so WebM and MKV get a scrubber sized against the
whole clip. A fragmented MP4 usually declares none (`expectedDuration` is `0`),
and its track simply grows — the paths below all handle a `0` declared duration
rather than assuming one.

What the UI does with that:

- `engine.frameIndexState` drives the readout: `frame 128 / 1284+ · 0:04.20 /
  ~2:14.03` dimmed while `growing` (the `+` marks a floor, the `~` a declared
  total), full weight and no marks when `complete`, and the warning color with
  `(partial)` when `truncated`.
- The scrubber's `max` is projected from the declared duration so the track
  does not stretch under the cursor; the un-indexed remainder is painted in a
  dimmer grey, and `app.seekToFrame` clamps to what is indexed, so it cannot be
  seeked into. The projection is geometry only and is never displayed.
- `engine.waitingForIndex` (playback pinned at the last indexed frame — not
  paused, not the end of the clip) shows a "waiting for index…" chip. The
  animation loop watches it, since the playhead stops moving and
  `'frame-changed'` goes quiet.
- `#indexing-status` reports the pass itself from `onProgress`
  (`{fraction, framesFound, etaMs}`), from the first read until the index
  settles — one line per video, attributed by name, since several clips can
  be indexing at once. Each load carries an identifier
  (`videoLayer.loadIdentifier`) so a video closed mid-index silences the pass
  still reading its file.
- `videoInformation.frameIndexState` travels into the export, so annotations
  saved mid-pass are not recorded against a frame count that was only a floor.

## Persistence

- Export/import: a single JSON file (`<video-name>.annotations.json`).
- Autosave: the serialized document under `localStorage` keyed by the
  **primary** video's name + size, saved (debounced) on every
  `'document-changed'`; offered for restore when the same video is reopened
  as the primary (never when it arrives as a follower).
- Follower videos and their link settings are session-only viewing aids: the
  document's `video` provenance block stays keyed to the primary, so
  version-1 files stay valid. Recording followers in the export would be a
  deliberate schema change (the format rejects unknown schemas).

## Deploy

Cloudflare Pages, build command `bash build.sh`, output directory `dist/`.
`build.sh` copies the static app (index.html, style.css, js/) into `dist/` —
there is no compile step — and writes the version stamp served at `/version`.

The app's version lives in `VERSION` and nowhere else: no module imports it and
nothing in `index.html` states it, so there is no copy to keep in step. It
reaches the outside world only through the stamp `build.sh` writes and the
`vX.Y.Z` tag the release workflow cuts from the same file. See the README's
[Releasing](README.md#releasing) and [What is live right
now](README.md#what-is-live-right-now).

This is unrelated to the annotation document's `version: 1`, which numbers the
JSON format rather than the app.
