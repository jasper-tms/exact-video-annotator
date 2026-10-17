---
name: building-video-examiner-plugins
description: How to build, test and publish a plugin for Video Examiner (examine.video, also called exact-video-annotator) — a folder with plugin.json and a JavaScript module that adds a new kind of annotation layer. Load when writing or debugging a Video Examiner plugin, or when someone asks how plugins work or how to share one.
---

# Building plugins for Video Examiner

A Video Examiner plugin adds a new kind of annotation layer to
[examine.video](https://examine.video): an ordinary layer of points, lines and
polylines (or of frame events) with your own logic built in. A plugin can draw
extra things on the frame, react to clicks and keys, adjust shapes as they are
drawn, keep its own settings, and show its own panels. Some examples of what
plugins do: snap a drawn line onto the edge under it, or mark a sports court's
named keypoints by picking each one on a diagram of the court.

A plugin never invents its own file format. Its annotations are ordinary items
of a built-in layer type, so an annotations file made with a plugin still opens
(as a plain layer) for someone who doesn't have the plugin.

A plugin is a folder that a web browser can fetch, holding:

- `plugin.json`, a short description of the plugin, and
- a JavaScript module (usually `index.js`) whose default export builds the
  plugin. The module may import other files from the same folder.

Video Examiner runs entirely in the browser, so a plugin is plain browser
JavaScript: no build step, no server, no package to install.

## A complete small plugin

This plugin, "Numbered points", is a points layer that writes 1, 2, 3… next to
the points on the current frame, with a setting for the size of the numbers.

`numbered-points/plugin.json`:

```json
{
  "manifestVersion": 1,
  "id": "example.numbered-points",
  "name": "Numbered points",
  "version": "0.1.0",
  "entry": "./index.js",
  "hostApiVersion": 1
}
```

`numbered-points/index.js`:

```js
// Numbered points: an ordinary points layer that writes a number next to each
// point on the current frame, in the order the points were placed.

export default function createPlugin(host) {
  const { CoordinatesLayer } = host.layers;

  class NumberedPointsLayer extends CoordinatesLayer {
    constructor(documentLayer, plugin, app) {
      super(documentLayer, app);
      this.plugin = plugin;
      // The layer's settings, saved in the document as the layer's plugin options.
      this.options = { fontSize: 14, ...(documentLayer.plugin?.options ?? {}) };
    }

    setFontSize(fontSize) {
      this.options = { ...this.options, fontSize };
      // Tells the app to copy the options into the document and redraw.
      this.dispatchEvent(new CustomEvent('layer-changed'));
    }

    draw(context, renderState) {
      super.draw(context, renderState);   // the points themselves
      const points = this.items.filter((item) =>
        item.kind === 'point' && (item.frame === renderState.frame || item.frame === null));
      // Text keeps its size on screen, so draw it in screen pixels.
      renderState.drawInStagePixels(() => {
        context.font = `${this.options.fontSize}px sans-serif`;
        context.fillStyle = 'white';
        points.forEach((item, index) => {
          const [x, y] = item.vertices[0];
          const position = renderState.stageFromLocal({ x, y });
          context.fillText(String(index + 1), position.x + 8, position.y - 8);
        });
      });
    }
  }

  return {
    id: 'example.numbered-points',   // must match plugin.json
    name: 'Numbered points',
    description: 'Points labeled 1, 2, 3… in the order they were placed on each frame.',
    layerType: 'coordinates',
    preferredToolId: 'point',

    createViewLayer(documentLayer, app) {
      return new NumberedPointsLayer(documentLayer, this, app);
    },

    buildSettings(app, layer) {
      const label = document.createElement('label');
      label.textContent = 'Number size ';
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '6';
      input.value = String(layer.options.fontSize);
      input.addEventListener('change', () => layer.setFontSize(Number(input.value)));
      label.appendChild(input);
      return label;
    },
  };
}
```

Once it is loaded (next section), add a layer of it from the ＋ button at the
end of the layer tabs, under **Plugins ›**. Double-click with the point tool to
place points, and select the layer's tab to see its "Number size" setting.

## Trying a plugin while you build it

1. Serve the folder that contains your plugin folder over HTTP, with a header
   that lets examine.video fetch from it (CORS). This Python script does that,
   and tells the browser not to cache, so a reload always picks up your latest
   edit. Save it as `serve_plugins.py` next to your plugin folder and run
   `python3 serve_plugins.py`:

   ```python
   #!/usr/bin/env python3
   import functools
   from pathlib import Path
   from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

   class Handler(SimpleHTTPRequestHandler):
       def end_headers(self):
           self.send_header('Access-Control-Allow-Origin', '*')
           self.send_header('Cache-Control', 'no-store')
           super().end_headers()

   directory = str(Path(__file__).resolve().parent)
   print('Serving plugins at http://localhost:8001/')
   ThreadingHTTPServer(('localhost', 8001),
                       functools.partial(Handler, directory=directory)).serve_forever()
   ```

2. Open examine.video with a `plugin` parameter naming your plugin's folder:
   `https://examine.video/?plugin=http://localhost:8001/numbered-points/`
   The app asks once whether to run the plugin's code; say yes.
3. After each edit, reload the page.

Problems show up as a message at the bottom of the app (for example a
`plugin.json` that couldn't be fetched, or an `id` that doesn't match), and
errors in your code show in the browser's developer console.

## Publishing a plugin

Anything that serves your folder's files over HTTPS with CORS headers works.
The folder's address (ending in `/`) is what people add.

- **A public GitHub repository**, through the jsDelivr CDN:
  `https://cdn.jsdelivr.net/gh/<owner>/<repository>@<tag or branch>/<plugin folder>/`.
  jsDelivr caches a branch for up to 12 hours, so for releases point at a tag
  (`@v1.0.0`) or a commit. Don't use `raw.githubusercontent.com`: it serves
  JavaScript as plain text, which browsers refuse to run as a module.
- **GitHub Pages**, or any other static host that sends
  `Access-Control-Allow-Origin`.
- **A private GitHub repository**, through Video Examiner's GitHub App: in the
  app, open Settings, and under Plugins click **Add from private GitHub
  repository…**. GitHub asks you to install the "Video Examiner" app and choose
  which repositories it may read. Your repositories then appear in Settings,
  each with a dropdown of the plugins found in it. A plugin is found when its
  `plugin.json` sits at the top of the repository or in a folder at the top of
  the repository. Only you (and anyone else with access to those repositories)
  can load them.

To install a published plugin, open Settings in Video Examiner and paste the
folder's address into the box under Plugins. The list is saved to your account
when you are logged in, and every plugin in it loads whenever the app starts.
A layer made by a plugin remembers the plugin's address, so someone who opens
your annotations file without the plugin is told where to get it.

## Reference

### `plugin.json`

| Field | Meaning |
| --- | --- |
| `manifestVersion` | Always `1`. |
| `id` | A unique, permanent identifier, such as `yourname.plugin-name`. Annotations files record it, so never change it once people use the plugin. |
| `name` | The name people see in menus and messages. |
| `version` | Your plugin's version, for your own bookkeeping. |
| `entry` | The module to run, relative to the folder. Defaults to `./index.js`. |
| `hostApiVersion` | Always `1`: the version of the `host` object described below. A plugin written for a different version is refused rather than half-loaded. |
| `description` | Optional, a sentence about what it does. |

### The entry module and `host`

The entry module's default export is a function that receives `host` and
returns the plugin's description (the next section). Get everything from the
app through `host`; don't import the app's own files, whose layout can change.
Import your own sibling files with relative paths (`import { x } from
'./helpers.js'`).

```js
host.hostApiVersion;     // 1
host.baseUrl;            // your plugin folder's address, for fetching your own assets
host.app;                // the app itself (see "The app" below)
host.layers;             // { Layer, CoordinatesLayer, SegmentationLayer, FramesLayer }
host.newId();            // a fresh unique id for an item or class
host.ui.createFloatingWindow(options);   // a panel floating over the frame (see below)
```

### The plugin description

```js
{
  id,                 // the same as plugin.json's id
  name,               // shown in the ＋ menu and on the layer
  description,        // shown as the menu entry's tooltip
  layerType,          // 'coordinates' (points, lines, polylines) or 'frames' (frame events)
  preferredToolId,    // the tool selected when a layer of yours is added: 'point',
                      // 'line', 'polyline' or 'pan'
  createViewLayer(documentLayer, app),   // returns your layer (see below)
  buildSettings(app, layer),             // optional; returns an element shown in
                                         // the layer's settings panel
}
```

`createViewLayer` is called whenever a layer of yours is created or rebuilt
(adding one, opening a file, undo). `documentLayer` is the layer as stored in
the annotations file; `documentLayer.plugin.options` holds your settings from
last time. Build your layer as a subclass of the matching `host.layers` class,
pass `documentLayer` and `app` to its constructor, and set `this.plugin` to the
description (inside `createViewLayer`, that's `this`).

### Your layer

A `CoordinatesLayer` already draws, selects, drags and deletes points, lines
and polylines. Its properties you will use most:

```js
layer.items;          // the layer's annotations, the same array as in the file
layer.classes;        // the layer's classes ({ id, name, color }), likewise;
                      // push to it to add one, then app.markDocumentChanged()
layer.options;        // your settings; replace the object, then dispatch
                      // 'layer-changed' to save them into the file
layer.getItem(itemId);
layer.draw(context, renderState);   // override, and call super.draw first
layer.offFrameOpacity; // 0–1, the opacity of other frames' items (default
                       // 0.25; layer.opacity is the current frame's). At 0
                       // they are hidden and can't be clicked.
                       // People adjust it in the layer panel; to change the
                       // default, set it in your constructor only when
                       // documentLayer.offFrameOpacity is undefined
```

An item of a coordinates layer looks like this (positions are in the video's
pixels, `[x, y]`, and frames are counted from 0):

```js
{ id, frame,                         // the frame it belongs to, or null for every frame
  kind: 'point' | 'line' | 'polyline',
  vertices: [[x, y], ...],           // a point has exactly one
  classId,                           // the label, an id in layer.classes, or null
  name,                              // or null
  metadata }                         // your own key-value pairs, all text: { key: 'text' }
```

`metadata` is the place for structured labels your plugin attaches to an item
(people can see and edit it in the annotations table). Its values are always
text: store a number as `'2'` and convert it back when you read it. Layer-wide state that
should be saved with the file goes in `layer.options`.

**Drawing.** `draw(context, renderState)` runs on every repaint with the canvas
already set to the layer's coordinates. `renderState.frame` is the frame on
screen. Marks that should keep their size on screen (text, handles, outlines)
are drawn in screen pixels: map each position with
`renderState.stageFromLocal({ x, y })`, then draw inside
`renderState.drawInStagePixels(() => { … })`.

**Optional hooks.** Define any of these methods on your layer and the app calls
them at the right moment:

```js
handleCanvasClick(app, worldPoint, event)        // a single click on empty canvas, with any tool
handleCanvasDoubleClick(app, worldPoint, event)  // return true to take over the point tool's
                                                 // double-click (which otherwise adds a point)
shouldFinishAfterVertex(vertices, kind)          // return true to finish the shape being drawn now
afterVertexPlaced(app, vertices, kind)           // may move the vertices of the shape being drawn
beforeShapeCommitted(app, vertices, kind)        // last chance to adjust a shape before it is added
afterItemDragged(app, itemId)                    // after the user drags an item or a vertex
refitItem(app, itemId)                           // the `r` key on a selected item; return true if
                                                 // you changed its geometry
```

`worldPoint` is in the canvas's shared coordinates; convert it to your layer's
with `app.localFromWorld(layer, worldPoint)`. For a layer that hasn't been
moved or scaled the two are the same.

### The app

The most useful parts of `app` (it is also an event target):

```js
app.annotationDocument;            // the whole annotations file: layers, their classes, items
app.currentFrame;                  // the frame on screen
app.seekToFrame(frame);
app.selection;                     // { layerId, itemId, vertexIndex } or null
app.setSelection(selection);
app.activeLayer;                   // the layer new annotations go into
app.undoHistory.execute({ label, apply() {…}, revert() {…} });   // see "Changing annotations"
app.showToast(message, { kind: 'info' | 'warning' | 'error' });
app.addKeyHandler((event) => { … return true to claim the key … });
app.isTypingTarget(event);         // true while the user types in a text box
app.localFromWorld(layer, worldPoint); app.worldFromLocal(layer, localPoint);
app.viewer.requestRender();        // repaint
// Events (app.addEventListener): 'frame-changed', 'selection-changed',
// 'document-changed', 'layers-changed', 'tool-changed'
```

**Changing annotations.** Make every change the user should be able to undo
through `app.undoHistory.execute` with an `apply` and a `revert` that exactly
undo each other; the app repaints and marks the file as changed after each.
Create new items with ids from `host.newId()`. A change made while the user is
in the middle of something (inside the hooks above that run during drawing or
dragging) is already part of their action and needs no command of its own.

**Keys.** A key handler sees the keys the app doesn't use itself, plus
Command/Control shortcuts other than undo and redo. Check that your layer is
`app.activeLayer` before acting, return `true` only for keys you handle, and
leave keys alone while `app.isTypingTarget(event)` is true.

### Floating windows

`host.ui.createFloatingWindow({ title, content, aspectRatio, designWidth,
worldRect, onWorldRectChanged })` shows a panel (your `content` element)
floating over the frame. It sticks to the footage like an annotation: it pans
and zooms with the view, the user moves it by its title bar and resizes it from
its corner, and `onWorldRectChanged(worldRect)` reports where it ended up, so
you can keep its place in `layer.options`. It returns `{ element, worldRect,
setVisible, setTitle, destroy }`.

## Good habits

- Keep the `id` permanent and the stored data plain (items, `metadata`,
  `options`), so old files keep opening with new versions of your plugin, and
  without it.
- Treat `options` loaded from a file as untrusted and incomplete: merge them
  over your defaults, as the example does.
- Frames are whole numbers counted from 0. Use `app.currentFrame` and
  `renderState.frame`; never work out a frame from a time in seconds.
- Plugins run with full access to the page and the user's annotations. Only
  install plugins from sources you trust, and say plainly what yours does.

## More

- The app's source code, including the full internal reference in
  [ARCHITECTURE.md](https://github.com/jasper-tms/exact-video-annotator/blob/main/ARCHITECTURE.md)
  (its "Plugins" section), is at
  [github.com/jasper-tms/exact-video-annotator](https://github.com/jasper-tms/exact-video-annotator).
- The built-in line fitter, in
  [`js/plugins/line-fitter/`](https://github.com/jasper-tms/exact-video-annotator/tree/main/js/plugins/line-fitter),
  is a larger worked example of the drawing hooks. It ships inside the app, so
  it imports the app's files directly; a plugin loaded from a URL gets the same
  classes from `host` instead.
- This guide is also the
  [Building plugins](https://github.com/jasper-tms/exact-video-annotator/wiki/Building-plugins)
  page of the project's wiki.
