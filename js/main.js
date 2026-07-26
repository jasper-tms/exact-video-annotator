// Application wiring: owns the app object (state + events), the video
// pipeline, the animation loop, tool switching, global keyboard handling,
// import/export, and autosave. See ARCHITECTURE.md for every contract.

import { Viewer } from './viewer.js';
import { VideoLayer } from './layers/video-layer.js';
import { CoordinatesLayer } from './layers/coordinates-layer.js';
import { SegmentationLayer } from './layers/segmentation-layer.js';
import { FramesLayer } from './layers/frames-layer.js';
import { UndoHistory } from './undo.js';
import {
  createEmptyDocument, documentToJson, documentFromJson, newId,
  autosaveKey, saveAutosave, loadAutosave,
} from './document.js';
import { panTool } from './tools/pan-tool.js';
import { findPlugin } from './plugins/registry.js';
import { refitSelectedItem } from './plugins/refit.js';
import { pointTool } from './tools/point-tool.js';
import { polygonTool } from './tools/polygon-tool.js';
import { lineTool } from './tools/line-tool.js';
import { initializeEventHotkeys } from './tools/event-hotkeys.js';
import { initializeTransport } from './ui/transport.js';
import { initializeLayerTabs } from './ui/layer-tabs.js';
import { initializeLayerDetail } from './ui/layer-detail.js';
import { initializeAnnotationsTable } from './ui/annotations-table.js';
import { initializeClassManager } from './ui/class-manager.js';
import { initializeToasts } from './ui/toasts.js';
import { initializeSettingsModal } from './ui/settings-modal.js';
import { drawPixelGrid } from './pixel-grid.js';

const ANNOTATION_LAYER_CONSTRUCTORS = {
  coordinates: CoordinatesLayer,
  segmentation: SegmentationLayer,
  frames: FramesLayer,
};

/** Layer type key -> the required tool, for the tool-rail's availability check. */
const TOOL_REQUIRED_LAYER_TYPE = { point: 'coordinates', line: 'coordinates', polygon: 'coordinates' };

function layerTypeDisplayName(type) {
  return `${type[0].toUpperCase()}${type.slice(1)}`;
}

const AUTOSAVE_DEBOUNCE_MILLISECONDS = 500;

// How long a seek must sit unresolved before the stall is shown on screen
// (the video picture dims) — see isSeekPendingDisplay.
const SEEK_PENDING_DISPLAY_DELAY_MILLISECONDS = 80;

// A growing index publishes frames faster than a panel rebuild is worth; this
// is how often those publishes are allowed to reach the UI. A settled index
// bypasses it — see attachEngine.
const INDEX_EVENT_THROTTLE_MILLISECONDS = 200;

class Application extends EventTarget {
  viewer = null;
  engine = null;
  videoSource = null;        // File/Blob or URL string, kept for decode recovery
  videoInformation = null;   // { name, sizeBytes, numberOfFrames, frameRate, ... }
  annotationDocument = createEmptyDocument();
  undoHistory = new UndoHistory();
  selection = null;
  hover = null;
  activeTool = null;
  activeLayerId = null;
  activeClassId = null;
  // How newly drawn point/shape annotations are bound in time:
  //   'anchored' — the item belongs to the current frame (frame = integer)
  //   'agnostic' — the item applies across every frame (frame = null)
  annotationMode = 'anchored';
  #keyHandlers = [];
  #autosaveTimer = null;
  // The frame last asked for via seekToFrame/stepFrame, kept to answer
  // isSeekPending: whether the engine has actually caught up to it yet.
  #requestedFrame = null;
  // Backing state for isSeekPendingDisplay; see that getter and
  // updateSeekPendingDisplay for the delay/suppression rules.
  #scrubDragActive = false;
  #seekPendingDisplayTimer = null;
  #isSeekPendingDisplay = false;

  /* ---------- Coordinates ---------- */

  localFromWorld(layer, worldPoint) {
    const { scale, offsetX, offsetY } = layer.transform;
    return { x: (worldPoint.x - offsetX) / scale, y: (worldPoint.y - offsetY) / scale };
  }

  worldFromLocal(layer, localPoint) {
    const { scale, offsetX, offsetY } = layer.transform;
    return { x: localPoint.x * scale + offsetX, y: localPoint.y * scale + offsetY };
  }

  /* ---------- Selection ---------- */

  setSelection(selectionOrNull) {
    this.selection = selectionOrNull;
    this.dispatchEvent(new CustomEvent('selection-changed'));
    this.viewer.requestRender();
  }

  /** Delete the current selection — a single vertex when one is selected,
      otherwise the whole item. Returns true if something was deleted. Bound to
      Delete / Backspace globally, so it works no matter which tool is active. */
  deleteSelection() {
    const selection = this.selection;
    if (!selection) return false;
    const layer = this.viewer.layers.find((candidate) => candidate.id === selection.layerId);
    if (!layer?.isEditable) return false;
    const command = (selection.vertexIndex !== null && layer.commandDeleteVertex)
      ? layer.commandDeleteVertex(selection.itemId, selection.vertexIndex)
      : layer.commandDeleteItem(selection.itemId);
    if (!command) return false;
    this.setSelection(null);
    this.undoHistory.execute(command);
    return true;
  }

  /* ---------- Playback ---------- */

  get currentFrame() { return this.engine?.currentFrame ?? 0; }

  /** Whether the pixels on screen have not yet caught up with the last seek.
      `currentFrame` lands the instant a seek is requested — on the WebCodecs
      tier, before the target frame is necessarily decoded — so a host that
      wants to know whether the picture itself has settled needs to compare
      against `presentedFrame` instead. Always false during playback: only a
      discrete, paused seek (a scrub click, a step, a table-row jump) counts
      as "pending" in this sense. */
  get isSeekPending() {
    return this.engine != null && this.engine.paused
      && this.#requestedFrame !== null
      // Older pinned engine builds have no presentedFrame; degrade to "never
      // pending" rather than comparing against undefined, which would never
      // match a real frame index and leave this stuck true forever.
      && typeof this.engine.presentedFrame === 'number'
      && this.engine.presentedFrame !== this.#requestedFrame;
  }

  /** Whether a stalled seek has been unresolved long enough to show on
      screen. Anything that indicates the stall (currently the video picture
      dimming in video-layer.js) keys off this single flag rather than
      running its own timer, so future indicators would change in step with
      it. Only true once isSeekPending has held for
      SEEK_PENDING_DISPLAY_DELAY_MILLISECONDS with no scrubber drag in
      progress — a seek that resolves within a tick or two, or one still
      being dragged through, should not flicker the indicator. */
  get isSeekPendingDisplay() { return this.#isSeekPendingDisplay; }

  #setSeekPendingDisplay(value) {
    if (this.#isSeekPendingDisplay === value) return;
    this.#isSeekPendingDisplay = value;
    this.dispatchEvent(new CustomEvent('seek-pending-display-changed'));
    // The flag can flip from a setTimeout, with no frame or index change to
    // otherwise trigger a repaint — request one directly so the video's own
    // dimming (see video-layer.js) shows up without waiting on something
    // unrelated to nudge the animation loop.
    this.viewer?.requestRender();
  }

  /** Re-evaluates isSeekPendingDisplay. Call whenever isSeekPending changes
      and whenever a scrubber drag starts or ends. */
  updateSeekPendingDisplay() {
    if (this.#seekPendingDisplayTimer !== null) {
      clearTimeout(this.#seekPendingDisplayTimer);
      this.#seekPendingDisplayTimer = null;
    }
    if (!this.isSeekPending || this.#scrubDragActive) {
      this.#setSeekPendingDisplay(false);
      return;
    }
    this.#seekPendingDisplayTimer = setTimeout(() => {
      this.#seekPendingDisplayTimer = null;
      if (this.isSeekPending && !this.#scrubDragActive) this.#setSeekPendingDisplay(true);
    }, SEEK_PENDING_DISPLAY_DELAY_MILLISECONDS);
  }

  /** Holding the scrubber suspends the seek-pending display: rapid-fire seeks
      mid-drag are expected to lag a little, and flagging every intermediate
      tick would be noise, not signal. Re-evaluated on release, so a drag's
      final, possibly-slow frame still gets flagged. */
  setScrubDragActive(active) {
    this.#scrubDragActive = active;
    this.updateSeekPendingDisplay();
  }

  /** The `frame` value a newly drawn annotation should get: the current frame
      in anchored mode, or null (applies to every frame) in agnostic mode. */
  get newItemFrame() {
    return this.annotationMode === 'agnostic' ? null : this.currentFrame;
  }

  setAnnotationMode(mode) {
    if (mode !== 'anchored' && mode !== 'agnostic') return;
    if (mode === this.annotationMode) return;
    this.annotationMode = mode;
    this.dispatchEvent(new CustomEvent('annotation-mode-changed'));
  }

  /** Playback supersedes any discrete seek: once the engine is playing, the
      last requested frame is no longer a target the picture is chasing, and
      keeping it around would make isSeekPending read true forever after the
      next pause (the playhead has moved past it, so presentedFrame can never
      match it again). The animation loop calls this on every unpaused tick. */
  invalidateSeekTarget() {
    this.#requestedFrame = null;
  }

  seekToFrame(frameIndex) {
    if (!this.engine) return;
    const lastFrame = Math.max(0, (this.engine.numFrames ?? 1) - 1);
    const clampedFrame = Math.min(lastFrame, Math.max(0, frameIndex));
    this.#requestedFrame = clampedFrame;
    this.engine.seekToFrame(clampedFrame);
    this.viewer.requestRender();
  }

  togglePlayback() {
    if (!this.engine) return;
    if (this.engine.paused) this.engine.play();
    else this.engine.pause();
    this.dispatchEvent(new CustomEvent('playback-changed'));
  }

  stepFrame(delta) {
    if (!this.engine) return;
    if (!this.engine.paused) {
      this.engine.pause();
      this.dispatchEvent(new CustomEvent('playback-changed'));
    }
    this.seekToFrame(this.currentFrame + delta);
  }

  /* ---------- Layers ---------- */

  get annotationLayers() {
    return this.viewer.layers.filter((layer) => layer.type in ANNOTATION_LAYER_CONSTRUCTORS);
  }

  /** The annotation layer new items go into (never the video layer). */
  get activeLayer() {
    return this.annotationLayers.find((layer) => layer.id === this.activeLayerId)
      ?? this.annotationLayers[0]
      ?? null;
  }

  /** The layer whose details are shown below the canvas — may be any layer,
      including the video layer. */
  get selectedLayer() {
    return this.viewer.layers.find((layer) => layer.id === this.activeLayerId)
      ?? this.activeLayer;
  }

  setActiveLayer(layerId) {
    // A no-op re-selection must not dispatch: the tab bar rebuilds its DOM on
    // every 'layers-changed' event, and doing that on the first click of a
    // double-click (to rename a tab already selected) would detach the very
    // element the second click and dblclick are about to land on.
    if (layerId === this.activeLayerId) return;
    this.activeLayerId = layerId;
    this.dispatchEvent(new CustomEvent('layers-changed'));
  }

  /** The layer new items of this type would go into — the active layer if it
      matches, else the first layer of that type — or null when none exists.
      Never creates a layer, so it is safe to call on every pointer move. */
  findAnnotationLayerForType(type) {
    const active = this.activeLayer;
    if (active?.type === type) return active;
    return this.annotationLayers.find((layer) => layer.type === type) ?? null;
  }

  targetLayerForType(type) {
    return this.findAnnotationLayerForType(type) ?? this.addAnnotationLayer(type);
  }

  /** Reorder the document's layer list to match the viewer's stack order
      (called after layer tabs are dragged into a new order). */
  synchronizeDocumentLayerOrder() {
    const annotationOrderIds = this.annotationLayers.map((layer) => layer.id);
    const documentLayerById = new Map(
      this.annotationDocument.layers.map((documentLayer) => [documentLayer.id, documentLayer]));
    this.annotationDocument.layers = annotationOrderIds
      .map((id) => documentLayerById.get(id))
      .filter((documentLayer) => documentLayer !== undefined);
    this.markDocumentChanged();
  }

  /**
   * Add an annotation layer of the given type. With a pluginId, the layer is
   * that plugin's: same storage type, but built by the plugin so it carries
   * the plugin's annotation logic and settings.
   */
  addAnnotationLayer(type, { pluginId = null } = {}) {
    const plugin = pluginId === null ? null : findPlugin(pluginId);
    const documentLayer = {
      id: newId(), type,
      name: plugin
        ? `${plugin.name} ${this.annotationLayers.filter((layer) => layer.plugin?.id === plugin.id).length + 1}`
        : `${type[0].toUpperCase()}${type.slice(1)} ${this.annotationLayers.filter((layer) => layer.type === type).length + 1}`,
      visible: true, opacity: 1,
      transform: { scale: 1, offsetX: 0, offsetY: 0 },
      items: [],
    };
    if (plugin) documentLayer.plugin = { id: plugin.id, options: {} };
    const viewLayer = this.#createViewLayer(documentLayer);
    this.undoHistory.execute({
      label: 'Add layer',
      apply: () => {
        this.annotationDocument.layers.push(documentLayer);
        this.viewer.addLayer(viewLayer);
        this.dispatchEvent(new CustomEvent('layers-changed'));
      },
      revert: () => {
        this.annotationDocument.layers = this.annotationDocument.layers
          .filter((layer) => layer.id !== documentLayer.id);
        this.viewer.removeLayer(viewLayer);
        this.dispatchEvent(new CustomEvent('layers-changed'));
      },
    });
    return viewLayer;
  }

  removeAnnotationLayer(layerId) {
    const viewLayer = this.annotationLayers.find((layer) => layer.id === layerId);
    const documentLayer = this.annotationDocument.layers.find((layer) => layer.id === layerId);
    if (!viewLayer || !documentLayer) return;
    const documentIndex = this.annotationDocument.layers.indexOf(documentLayer);
    const viewerIndex = this.viewer.layers.indexOf(viewLayer);
    this.undoHistory.execute({
      label: 'Delete layer',
      apply: () => {
        this.annotationDocument.layers.splice(this.annotationDocument.layers.indexOf(documentLayer), 1);
        this.viewer.removeLayer(viewLayer);
        if (this.activeLayerId === layerId) this.activeLayerId = null;
        if (this.selection?.layerId === layerId) this.setSelection(null);
        this.dispatchEvent(new CustomEvent('layers-changed'));
      },
      revert: () => {
        this.annotationDocument.layers.splice(documentIndex, 0, documentLayer);
        this.viewer.addLayer(viewLayer, viewerIndex);
        this.dispatchEvent(new CustomEvent('layers-changed'));
      },
    });
  }

  #createViewLayer(documentLayer) {
    const pluginId = documentLayer.plugin?.id ?? null;
    const plugin = pluginId === null ? null : findPlugin(pluginId);
    if (pluginId !== null && !plugin) {
      // A document written by a build that had this plugin. Its annotations are
      // ordinary items, so open them on a plain layer of the storage type and
      // keep the plugin field so re-exporting does not drop it.
      this.showToast(`Layer "${documentLayer.name}" was made by the "${pluginId}" plugin, `
        + 'which is not available here — opening it as a plain layer.', { kind: 'warning' });
    }
    // The extra `this` (app) argument is only read by CoordinatesLayer (to look
    // up the document's integer-coordinate convention); the other constructors,
    // and every plugin built on one of them, take it and silently ignore it.
    const viewLayer = plugin
      ? plugin.createViewLayer(documentLayer, this)
      : new ANNOTATION_LAYER_CONSTRUCTORS[documentLayer.type](documentLayer, this);
    // Panel edits (name/visibility/opacity/transform, plugin options) flow back
    // to the document.
    viewLayer.addEventListener('layer-changed', () => {
      documentLayer.name = viewLayer.name;
      documentLayer.visible = viewLayer.visible;
      documentLayer.opacity = viewLayer.opacity;
      documentLayer.transform = { ...viewLayer.transform };
      if (documentLayer.type === 'coordinates') {
        documentLayer.allowFractionalCoordinates = viewLayer.allowFractionalCoordinates;
      }
      if (viewLayer.plugin) {
        documentLayer.plugin = { id: viewLayer.plugin.id, options: { ...viewLayer.options } };
      }
      this.markDocumentChanged();
    });
    return viewLayer;
  }

  /** Drop all annotation view layers and rebuild them from the document. */
  rebuildAnnotationLayersFromDocument() {
    for (const layer of [...this.annotationLayers]) this.viewer.removeLayer(layer);
    for (const documentLayer of this.annotationDocument.layers) {
      this.viewer.addLayer(this.#createViewLayer(documentLayer));
    }
    this.activeLayerId = null;
    this.setSelection(null);
    this.dispatchEvent(new CustomEvent('layers-changed'));
  }

  /* ---------- Tools ---------- */

  toolRegistry = Object.fromEntries(
    [panTool, pointTool, polygonTool, lineTool].map((tool) => [tool.id, tool]));

  setActiveTool(toolId) {
    // A null toolId means "no tool selected" — a canvas drag then pans the view.
    const tool = toolId === null ? null : this.toolRegistry[toolId];
    if (toolId !== null && !tool) return;   // unknown tool id
    if (tool === this.activeTool) return;   // already in this state
    this.activeTool?.deactivate?.(this);
    this.activeTool = tool;
    tool?.activate?.(this);
    this.viewer.stageCanvas.style.cursor = tool ? (tool.cursor ?? 'default') : 'grab';
    this.dispatchEvent(new CustomEvent('tool-changed'));
    this.viewer.requestRender();
  }

  /* ---------- Document lifecycle ---------- */

  markDocumentChanged() {
    this.dispatchEvent(new CustomEvent('document-changed'));
    this.viewer.requestRender();
    if (!this.videoInformation) return;
    clearTimeout(this.#autosaveTimer);
    this.#autosaveTimer = setTimeout(() => {
      saveAutosave(autosaveKey(this.videoInformation), this.annotationDocument, this.videoInformation);
    }, AUTOSAVE_DEBOUNCE_MILLISECONDS);
  }

  replaceDocument(annotationDocument) {
    this.annotationDocument = annotationDocument;
    this.undoHistory.clear();
    this.rebuildAnnotationLayersFromDocument();
    this.markDocumentChanged();
  }

  /* ---------- Keyboard plumbing ---------- */

  addKeyHandler(handler) { this.#keyHandlers.push(handler); }

  runKeyHandlers(event) {
    return this.#keyHandlers.some((handler) => handler(event));
  }

  isTypingTarget(event) {
    const element = event.target;
    return element instanceof HTMLInputElement
      || element instanceof HTMLTextAreaElement
      || element instanceof HTMLSelectElement
      || (element instanceof HTMLElement && element.isContentEditable);
  }

  showToast(message, options = {}) {
    // Replaced by initializeToasts; fallback for very early errors.
    console.log(`[toast:${options.kind ?? 'info'}] ${message}`);
  }
}

/* ================== Bootstrap ================== */

const app = new Application();
window.exactVideoAnnotator = app;   // console access for debugging

const stageCanvas = document.getElementById('stage-canvas');
const stageContainer = document.getElementById('stage-container');
const videoHost = document.getElementById('video-host');
const videoEngineCanvas = document.getElementById('video-engine-canvas');
const videoEngineElement = document.getElementById('video-engine-element');
const dropHint = document.getElementById('drop-hint');
const indexingStatus = document.getElementById('indexing-status');
const hoveredPixelLabel = document.getElementById('hovered-pixel-label');

app.viewer = new Viewer(stageCanvas);

/** Which world pixel the cursor is over — a property of the canvas itself,
    not of whatever media layer happens to be loaded, so it shows regardless
    of whether a video is open. Cleared on pointerleave, below. */
function updateHoveredPixelLabel(worldPoint) {
  const pixelX = Math.floor(worldPoint.x);
  const pixelY = Math.floor(worldPoint.y);
  hoveredPixelLabel.textContent = `x=${pixelX}, y=${pixelY}`;
}
stageCanvas.addEventListener('pointerleave', () => { hoveredPixelLabel.textContent = ''; });

app.viewer.toolDelegate = {
  onPointerDown: (worldPoint, event) => {
    // No tool selected: a canvas drag pans the view (the viewer takes over the
    // move/up of this pointer once panning has begun).
    if (!app.activeTool) { app.viewer.beginPanFromPointerEvent(event); return; }
    app.activeTool.onPointerDown?.(app, worldPoint, event);
  },
  onPointerMove: (worldPoint, event) => {
    updateHoveredPixelLabel(worldPoint);
    app.activeTool?.onPointerMove?.(app, worldPoint, event);
  },
  onPointerUp: (worldPoint, event) => app.activeTool?.onPointerUp?.(app, worldPoint, event),
  onDoubleClick: (worldPoint, event) => app.activeTool?.onDoubleClick?.(app, worldPoint, event),
};
app.viewer.setOverlayPainter((context, renderState) => {
  drawPixelGrid(context, renderState);
  app.activeTool?.drawOverlay?.(context, renderState);
});

initializeToasts(app, document.getElementById('toast-container'));
initializeTransport(app, document.getElementById('transport-container'));
initializeLayerTabs(app, document.getElementById('layer-tabs-container'));
initializeLayerDetail(app, document.getElementById('layer-detail-container'));
initializeClassManager(app, document.getElementById('class-manager-container'));
initializeAnnotationsTable(app, document.getElementById('annotations-table-container'));
initializeSettingsModal(app, document.getElementById('settings-button'));
initializeEventHotkeys(app);

// `r` re-fits the selected annotation on a plugin layer that can fit (the line
// fitter). Registered after the event hotkeys so a user-defined event key named
// `r` keeps winning; it also does nothing unless a fittable item is selected.
app.addKeyHandler((event) => {
  if (event.key !== 'r' && event.key !== 'R') return false;
  return refitSelectedItem(app);
});

app.rebuildAnnotationLayersFromDocument();
app.setActiveTool('pan');

/* ---------- Video loading ---------- */

async function loadVideoSource(source, { name, sizeBytes }) {
  try {
    if (app.engine) {
      app.engine.destroy();
      const oldVideoLayer = app.viewer.layers.find((layer) => layer.type === 'video');
      if (oldVideoLayer) app.viewer.removeLayer(oldVideoLayer);
      app.engine = null;
    }
    app.videoSource = source;
    // Destroying an engine does not stop an index pass already reading the
    // file, so a clip opened while another was still indexing would otherwise
    // keep hearing the old pass's progress. Only the newest load may write.
    const loadIdentifier = ++mostRecentLoadIdentifier;
    showIndexingStatus({ fraction: 0, framesFound: 0, etaMs: 0 });
    const engine = await createBestEngine(source, {
      canvas: videoEngineCanvas, video: videoEngineElement,
      // We read and display exact source-pixel values for annotation, never a
      // smoothed approximation of them — the engine defaults to smoothing on
      // (right for a typical video player, wrong for us).
      imageSmoothingEnabled: false,
      // Hand back a playable engine as soon as the opening frames have been
      // certified, and keep indexing the rest underneath it, rather than making
      // someone wait for the last byte of a long clip before they can annotate
      // its first second. Every frame number reported is still exact and
      // permanent — only the SET of nameable frames grows — so an annotation
      // written now against frame 412 keeps meaning that picture. See the
      // engine README's "Playing while the index is still being built".
      playWhileIndexing: true,
      onProgress: (progress) => {
        if (loadIdentifier === mostRecentLoadIdentifier) showIndexingStatus(progress);
      },
    });
    attachEngine(engine, { name, sizeBytes });
  } catch (error) {
    hideIndexingStatus();
    app.showToast(`Could not open the video: ${error.message ?? error}`, { kind: 'error' });
  }
}

/* ---------- Indexing progress ---------- */

// Counts loads so a superseded one can tell it is no longer the current video.
let mostRecentLoadIdentifier = 0;

function formatIndexingEta(milliseconds) {
  // etaMs is 0 at the very start and at the end, where it means "no estimate"
  // rather than "no time left".
  if (!milliseconds) return '';
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return ` (~${seconds} s left)`;
  return ` (~${Math.round(seconds / 60)} min left)`;
}

function showIndexingStatus(progress) {
  const percent = Math.round((progress.fraction ?? 0) * 100);
  const frames = progress.framesFound ?? 0;
  indexingStatus.hidden = false;
  indexingStatus.textContent =
    `Indexing… ${percent}% · ${frames.toLocaleString()} frames so far${formatIndexingEta(progress.etaMs)}`;
}

function hideIndexingStatus() {
  indexingStatus.hidden = true;
  indexingStatus.textContent = '';
}

/** The video's facts as the engine currently knows them. While the index is
    still growing these describe the certified prefix, not the whole clip —
    numberOfFrames is a floor and durationSeconds is the time indexed so far —
    which is why `frameIndexState` travels with them into the export instead of
    letting a partial count pass for a total. Rebuilt on every index event, so
    an export taken after the pass finishes carries the finished numbers. */
function videoInformationFromEngine(engine, { name, sizeBytes }) {
  return {
    name,
    sizeBytes: sizeBytes ?? null,
    numberOfFrames: engine.numFrames,
    // Mean rate, provenance only — frame indices are the source of truth.
    frameRate: engine.duration ? Number((engine.numFrames / engine.duration).toFixed(3)) : null,
    frameIndexIsExact: engine.frameIndexIsExact,
    // 'complete' | 'growing' | 'truncated'. The native tier reports none, and
    // only ever hands back a finished index.
    frameIndexState: engine.frameIndexState ?? 'complete',
    durationSeconds: engine.duration,
    declaredDurationSeconds: engine.expectedDuration || null,
    width: engine.videoWidth,
    height: engine.videoHeight,
  };
}

function attachEngine(engine, { name, sizeBytes }) {
  app.engine = engine;
  app.videoInformation = videoInformationFromEngine(engine, { name, sizeBytes });
  if (engine.frameIndexState !== 'growing') hideIndexingStatus();

  // The index publishes certified prefixes as it goes; each one moves the frame
  // count, the duration and the scrubber's geometry, so refresh the facts and
  // tell the panels. Publishes can arrive faster than a DOM rebuild is worth,
  // hence the throttle — but a settled index is dispatched immediately, since
  // that is the edge the readout changes color on.
  let lastIndexDispatchMilliseconds = 0;
  let pendingIndexDispatch = null;
  const refreshIndexFacts = ({ immediate }) => {
    // A throttled dispatch can outlive the video it belongs to.
    if (app.engine !== engine) return;
    app.videoInformation = videoInformationFromEngine(engine, { name, sizeBytes });
    clearTimeout(pendingIndexDispatch);
    const sinceLast = performance.now() - lastIndexDispatchMilliseconds;
    if (!immediate && sinceLast < INDEX_EVENT_THROTTLE_MILLISECONDS) {
      pendingIndexDispatch = setTimeout(() => refreshIndexFacts({ immediate: true }),
        INDEX_EVENT_THROTTLE_MILLISECONDS - sinceLast);
      return;
    }
    lastIndexDispatchMilliseconds = performance.now();
    app.dispatchEvent(new CustomEvent('index-changed'));
  };

  // Complete and truncated are both ends of the pass: nothing more is coming,
  // so the progress badge goes away and the panels get the final numbers now
  // rather than at the end of a throttle window.
  const settleIndex = () => {
    if (app.engine !== engine) return;
    hideIndexingStatus();
    refreshIndexFacts({ immediate: true });
  };

  engine.addEventListener('indexextended', () => refreshIndexFacts({ immediate: false }));
  engine.addEventListener('indexcomplete', settleIndex);
  engine.addEventListener('indextruncated', settleIndex);

  engine.addEventListener('errormessage', (event) => {
    const detail = event.detail ?? {};
    if (!detail.message) return;
    // An index that stopped early is flagged fatal too, but it is not a dead
    // decoder: the frames already published stay exact and keep playing, and
    // rebuilding on the native tier would only re-scan the same container —
    // which that tier refuses a partial result from anyway. Say so and keep
    // the engine we have.
    if (detail.incomplete) {
      app.showToast(detail.message, { kind: 'warning' });
      return;
    }
    if (detail.fatal) recoverFromFatalDecode();
    else app.showToast(detail.message, { kind: 'warning' });
  });

  const videoLayer = new VideoLayer(engine, videoHost);
  app.viewer.addLayer(videoLayer, 0);

  dropHint.classList.add('hidden');
  app.viewer.fitToContent();

  // Offer any autosaved annotations for this exact video (name + size).
  const key = autosaveKey(app.videoInformation);
  const autosaved = loadAutosave(key);
  if (autosaved && autosaved.document.layers.some((layer) => layer.items.length > 0)) {
    app.replaceDocument(autosaved.document);
    app.showToast(`Restored autosaved annotations (${autosaved.savedAt ?? 'unknown time'}). Import a file to replace them.`);
  }

  if (engine.frameIndexIsExact === false) {
    app.showToast('This clip could not be indexed — frame numbers are approximate.', { kind: 'warning' });
  }

  // A freshly loaded video starts out as the selected layer, so its tab
  // highlights and its facts appear in the detail panel. (Set after any
  // autosave restore, which resets the selected layer.)
  app.setActiveLayer(videoLayer.id);

  app.dispatchEvent(new CustomEvent('video-loaded'));
  app.dispatchEvent(new CustomEvent('frame-changed'));
}

/** WebKit can pass load-time checks then kill the decoder mid-stream (see the
    engine README): rebuild on the native tier at the same playhead. */
async function recoverFromFatalDecode() {
  const frameBeforeFailure = app.currentFrame;
  const information = app.videoInformation;
  app.showToast('The video decoder failed mid-stream; switching to the fallback player…', { kind: 'warning' });
  try {
    app.engine.destroy();
    const oldVideoLayer = app.viewer.layers.find((layer) => layer.type === 'video');
    if (oldVideoLayer) app.viewer.removeLayer(oldVideoLayer);
    const engine = await createBestEngine(app.videoSource, {
      canvas: videoEngineCanvas, video: videoEngineElement, prefer: 'native',
      imageSmoothingEnabled: false,
    });
    attachEngine(engine, information);
    engine.seekToFrame(frameBeforeFailure);
  } catch (error) {
    app.showToast(`Fallback player also failed: ${error.message ?? error}`, { kind: 'error' });
  }
}

/* ---------- Animation loop ---------- */

let lastReportedFrame = -1;
let lastReportedPresentedFrame = -1;
let lastReportedWaitingForIndex = false;
let lastReportedSeekPending = false;

function animationTick(now) {
  const engine = app.engine;
  engine?.update(now);
  if (engine) {
    if (engine.currentFrame !== lastReportedFrame) {
      lastReportedFrame = engine.currentFrame;
      app.dispatchEvent(new CustomEvent('frame-changed'));
      app.viewer.requestRender();
    }
    // The frame actually painted on screen can lag behind currentFrame: on the
    // WebCodecs tier currentFrame lands the instant a seek is requested, before
    // the target frame is necessarily decoded. Repaint off presentedFrame too,
    // so a seek that stalls mid-decode still gets its canvas caught up once the
    // stall clears, instead of sitting on the previous frame until some
    // unrelated action (a pan, a hotkey) requests a render for its own reasons.
    if (engine.presentedFrame !== lastReportedPresentedFrame) {
      lastReportedPresentedFrame = engine.presentedFrame;
      app.viewer.requestRender();
    }
    if (!engine.paused) app.invalidateSeekTarget();
    if (app.isSeekPending !== lastReportedSeekPending) {
      lastReportedSeekPending = app.isSeekPending;
      app.updateSeekPendingDisplay();
    }
    // Playback pinned at the last indexed frame is the one state nothing else
    // announces: the frame stops changing, so 'frame-changed' goes quiet, and
    // the engine is neither paused nor at the end of the clip.
    if (engine.waitingForIndex !== lastReportedWaitingForIndex) {
      lastReportedWaitingForIndex = !!engine.waitingForIndex;
      app.dispatchEvent(new CustomEvent('index-changed'));
    }
    if (!engine.paused) app.viewer.requestRender();
  }
  app.viewer.renderIfNeeded({
    frame: app.currentFrame,
    frameFloat: engine?.currentFrameFloat ?? 0,
    selection: app.selection,
    hover: app.hover,
    document: app.annotationDocument,
    isSeekPendingDisplay: app.isSeekPendingDisplay,
  });
  requestAnimationFrame(animationTick);
}
requestAnimationFrame(animationTick);

/* ---------- Undo/redo buttons ---------- */

const undoButton = document.getElementById('undo-button');
const redoButton = document.getElementById('redo-button');
app.undoHistory.addEventListener('history-changed', () => {
  undoButton.disabled = !app.undoHistory.canUndo;
  redoButton.disabled = !app.undoHistory.canRedo;
  undoButton.title = app.undoHistory.nextUndoLabel
    ? `Undo ${app.undoHistory.nextUndoLabel} (Cmd/Ctrl+Z)` : 'Undo (Cmd/Ctrl+Z)';
  app.markDocumentChanged();
});
undoButton.addEventListener('click', () => app.undoHistory.undo());
redoButton.addEventListener('click', () => app.undoHistory.redo());

/* ---------- Toolbar ---------- */

const toolButtons = [...document.querySelectorAll('#tool-rail button[data-tool]')];
// Preserved so an unavailable button's hotkey tooltip can be restored once a
// matching layer exists again.
for (const button of toolButtons) button.dataset.baseTitle = button.title;

function toolIsAvailable(toolId) {
  const requiredType = TOOL_REQUIRED_LAYER_TYPE[toolId];
  return !requiredType || app.annotationLayers.some((layer) => layer.type === requiredType);
}

for (const button of toolButtons) {
  const toolId = button.dataset.tool;
  const requiredType = TOOL_REQUIRED_LAYER_TYPE[toolId];

  button.addEventListener('click', () => {
    if (!toolIsAvailable(toolId)) {
      app.showToast(
        `Requires a ${layerTypeDisplayName(requiredType)} layer: Right-click to create one`,
        { kind: 'warning' });
      return;
    }
    // Switch to a matching layer first, if the active one isn't already of the
    // required type, so the tool draws into the layer it just switched to.
    if (requiredType) {
      const targetLayer = app.findAnnotationLayerForType(requiredType);
      if (targetLayer && app.activeLayer?.id !== targetLayer.id) app.setActiveLayer(targetLayer.id);
    }
    // Clicking the already-active tool deselects it, falling back to pan.
    app.setActiveTool(app.activeTool?.id === toolId ? 'pan' : toolId);
  });

  if (requiredType) {
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      if (toolIsAvailable(toolId)) return;
      const layer = app.addAnnotationLayer(requiredType);
      app.setActiveLayer(layer.id);
      app.setActiveTool(toolId);
    });
  }
}

function reflectActiveTool() {
  for (const button of toolButtons) {
    button.classList.toggle('active-tool', button.dataset.tool === app.activeTool?.id);
  }
}
app.addEventListener('tool-changed', reflectActiveTool);
// The initial tool is set during bootstrap, before this listener exists, so sync
// the button highlight once now (otherwise 'pan' stays unhighlighted at load).
reflectActiveTool();

function reflectToolAvailability() {
  for (const button of toolButtons) {
    const toolId = button.dataset.tool;
    const requiredType = TOOL_REQUIRED_LAYER_TYPE[toolId];
    if (!requiredType) continue;
    const available = toolIsAvailable(toolId);
    button.classList.toggle('rail-button-unavailable', !available);
    button.title = available
      ? button.dataset.baseTitle
      : `Requires a ${layerTypeDisplayName(requiredType)} layer: Right-click to create one`;
  }
}
app.addEventListener('layers-changed', reflectToolAvailability);
reflectToolAvailability();

/* The paintbrush (segmentation) button has no backing tool yet — pixel-wise
   painting is not implemented, regardless of whether a Segmentation layer
   exists, so it always shows the same message rather than participating in
   the generic tool-availability machinery above. */
const paintToolButton = document.getElementById('paint-tool-button');
paintToolButton.classList.add('rail-button-unavailable');
function announcePaintNotImplemented() {
  app.showToast("Pixel painting isn't implemented yet.", { kind: 'warning' });
}
paintToolButton.addEventListener('click', announcePaintNotImplemented);
paintToolButton.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  announcePaintNotImplemented();
});

document.getElementById('fit-view-button').addEventListener('click', () => app.viewer.fitToContent());

/* ---------- Annotation-mode toggle (frame-anchored vs frame-agnostic) ---------- */

const frameAgnosticToggle = document.getElementById('frame-agnostic-toggle');
frameAgnosticToggle.addEventListener('click', () => {
  app.setAnnotationMode(app.annotationMode === 'agnostic' ? 'anchored' : 'agnostic');
});
function reflectAnnotationMode() {
  const agnostic = app.annotationMode === 'agnostic';
  frameAgnosticToggle.classList.toggle('mode-active', agnostic);
  frameAgnosticToggle.title = agnostic
    ? 'Frame-agnostic mode on: new annotations apply across all frames (a)'
    : 'Frame-agnostic mode off: new annotations anchor to the current frame (a)';
}
app.addEventListener('annotation-mode-changed', reflectAnnotationMode);
reflectAnnotationMode();

/* ---------- Scroll-to-details toggle (bottom of the tool rail) ---------- */

const scrollToggleButton = document.getElementById('scroll-toggle-button');
// Treat anything within a few pixels of the top as "fully scrolled up".
const SCROLL_TOP_THRESHOLD_PIXELS = 4;

function isScrolledToTop() {
  return window.scrollY <= SCROLL_TOP_THRESHOLD_PIXELS;
}

function reflectScrollToggle() {
  const atTop = isScrolledToTop();
  // The arrow SVG points down by default; rotate it 180° to point up.
  scrollToggleButton.classList.toggle('pointing-up', !atTop);
  scrollToggleButton.title = atTop ? 'Scroll down to the details' : 'Scroll back to the top';
}

scrollToggleButton.addEventListener('click', () => {
  if (isScrolledToTop()) {
    // Reveal the details section, leaving it just below the sticky toolbar.
    const details = document.getElementById('details-section');
    const toolbarHeight = document.getElementById('toolbar').offsetHeight;
    const target = details.getBoundingClientRect().top + window.scrollY - toolbarHeight;
    window.scrollTo({ top: target, behavior: 'smooth' });
  } else {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
});
window.addEventListener('scroll', reflectScrollToggle, { passive: true });
reflectScrollToggle();

const videoFileInput = document.getElementById('video-file-input');
document.getElementById('open-video-button').addEventListener('click', () => videoFileInput.click());
videoFileInput.addEventListener('change', () => {
  const file = videoFileInput.files?.[0];
  if (file) loadVideoSource(file, { name: file.name, sizeBytes: file.size });
  videoFileInput.value = '';
});

const annotationsFileInput = document.getElementById('annotations-file-input');
document.getElementById('import-annotations-button').addEventListener('click', () => annotationsFileInput.click());
annotationsFileInput.addEventListener('change', async () => {
  const file = annotationsFileInput.files?.[0];
  annotationsFileInput.value = '';
  if (file) await importAnnotationsFile(file);
});

async function importAnnotationsFile(file) {
  try {
    const parsed = documentFromJson(JSON.parse(await file.text()));
    const hasExistingItems = app.annotationDocument.layers.some((layer) => layer.items.length > 0);
    if (hasExistingItems
        && !window.confirm('Importing replaces the current annotations. Continue?')) {
      return;
    }
    app.replaceDocument(parsed);
    app.showToast(`Imported annotations from ${file.name}.`);
  } catch (error) {
    app.showToast(`Could not import ${file.name}: ${error.message ?? error}`, { kind: 'error' });
  }
}

document.getElementById('export-annotations-button').addEventListener('click', () => {
  const json = documentToJson(app.annotationDocument, app.videoInformation);
  const baseName = (app.videoInformation?.name ?? 'annotations').replace(/\.[^.]+$/, '');
  const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `${baseName}.annotations.json`;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
});

/* ---------- Drag and drop ---------- */

stageContainer.addEventListener('dragover', (event) => {
  event.preventDefault();
  stageContainer.classList.add('drag-over');
});
stageContainer.addEventListener('dragleave', () => stageContainer.classList.remove('drag-over'));
stageContainer.addEventListener('drop', async (event) => {
  event.preventDefault();
  stageContainer.classList.remove('drag-over');
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  if (file.name.toLowerCase().endsWith('.json')) await importAnnotationsFile(file);
  else loadVideoSource(file, { name: file.name, sizeBytes: file.size });
});

/* ---------- Global keyboard ---------- */

window.addEventListener('keydown', (event) => {
  if (app.isTypingTarget(event)) return;

  const commandOrControl = event.metaKey || event.ctrlKey;
  if (commandOrControl && (event.key === 'z' || event.key === 'Z')) {
    event.preventDefault();
    if (event.shiftKey) app.undoHistory.redo();
    else app.undoHistory.undo();
    return;
  }
  if (commandOrControl) return;   // leave other browser shortcuts alone

  if (event.code === 'Space') {
    event.preventDefault();
    app.togglePlayback();
    return;
  }
  if (event.key === 'ArrowLeft' || event.key === ',') { event.preventDefault(); app.stepFrame(-1); return; }
  if (event.key === 'ArrowRight' || event.key === '.') { event.preventDefault(); app.stepFrame(1); return; }
  if (event.key === 'f') { app.viewer.fitToContent(); return; }
  if (event.key === 'a' || event.key === 'A') {
    app.setAnnotationMode(app.annotationMode === 'agnostic' ? 'anchored' : 'agnostic');
    return;
  }
  if (event.key === 'v') {
    const layer = app.selectedLayer;
    if (layer) layer.setVisible(!layer.visible);
    return;
  }

  for (const tool of Object.values(app.toolRegistry)) {
    if (tool.hotkey === event.key) {
      // Pressing the active tool's hotkey deselects it, falling back to pan.
      app.setActiveTool(app.activeTool?.id === tool.id ? 'pan' : tool.id);
      return;
    }
  }

  if (app.activeTool?.onKeyDown?.(app, event)) { event.preventDefault(); return; }

  // Escape clears the selection when no tool claimed it (a tool claims it for
  // canceling an in-progress placement or shape).
  if (event.key === 'Escape' && app.selection) {
    app.setSelection(null);
    return;
  }

  // Delete/Backspace removes the selection regardless of the active tool (the
  // active tool got first refusal above, e.g. Backspace while drawing a shape).
  if ((event.key === 'Delete' || event.key === 'Backspace') && app.deleteSelection()) {
    event.preventDefault();
    return;
  }

  if (app.runKeyHandlers(event)) event.preventDefault();
});

/* ---------- Optional ?video= URL parameter ---------- */

const videoUrlParameter = new URLSearchParams(window.location.search).get('video');
if (videoUrlParameter) {
  const nameFromUrl = videoUrlParameter.split('/').pop() || videoUrlParameter;
  loadVideoSource(videoUrlParameter, { name: nameFromUrl, sizeBytes: null });
}
