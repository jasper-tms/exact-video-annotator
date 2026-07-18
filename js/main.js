// Application wiring: owns the app object (state + events), the video
// pipeline, the animation loop, tool switching, global keyboard handling,
// import/export, and autosave. See ARCHITECTURE.md for every contract.

import { Viewer } from './viewer.js';
import { VideoLayer } from './layers/video-layer.js';
import { PointsLayer } from './layers/points-layer.js';
import { ShapesLayer } from './layers/shapes-layer.js';
import { EventsLayer } from './layers/events-layer.js';
import { UndoHistory } from './undo.js';
import {
  createEmptyDocument, documentToJson, documentFromJson, newId,
  autosaveKey, saveAutosave, loadAutosave,
} from './document.js';
import { selectTool } from './tools/select-tool.js';
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

const ANNOTATION_LAYER_CONSTRUCTORS = {
  points: PointsLayer,
  shapes: ShapesLayer,
  events: EventsLayer,
};

const AUTOSAVE_DEBOUNCE_MILLISECONDS = 500;

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
  #keyHandlers = [];
  #autosaveTimer = null;

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

  /* ---------- Playback ---------- */

  get currentFrame() { return this.engine?.currentFrame ?? 0; }

  seekToFrame(frameIndex) {
    if (!this.engine) return;
    const lastFrame = Math.max(0, (this.engine.numFrames ?? 1) - 1);
    this.engine.seekToFrame(Math.min(lastFrame, Math.max(0, frameIndex)));
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
    this.activeLayerId = layerId;
    this.dispatchEvent(new CustomEvent('layers-changed'));
  }

  targetLayerForType(type) {
    const active = this.activeLayer;
    if (active?.type === type) return active;
    const existing = this.annotationLayers.find((layer) => layer.type === type);
    if (existing) return existing;
    return this.addAnnotationLayer(type);
  }

  addAnnotationLayer(type) {
    const documentLayer = {
      id: newId(), type,
      name: `${type[0].toUpperCase()}${type.slice(1)} ${this.annotationLayers.filter((layer) => layer.type === type).length + 1}`,
      visible: true, opacity: 1,
      transform: { scale: 1, offsetX: 0, offsetY: 0 },
      items: [],
    };
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
    const LayerConstructor = ANNOTATION_LAYER_CONSTRUCTORS[documentLayer.type];
    const viewLayer = new LayerConstructor(documentLayer);
    // Panel edits (name/visibility/opacity/transform) flow back to the document.
    viewLayer.addEventListener('layer-changed', () => {
      documentLayer.name = viewLayer.name;
      documentLayer.visible = viewLayer.visible;
      documentLayer.opacity = viewLayer.opacity;
      documentLayer.transform = { ...viewLayer.transform };
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
    [selectTool, pointTool, polygonTool, lineTool].map((tool) => [tool.id, tool]));

  setActiveTool(toolId) {
    const tool = this.toolRegistry[toolId];
    if (!tool || tool === this.activeTool) return;
    this.activeTool?.deactivate?.(this);
    this.activeTool = tool;
    tool.activate?.(this);
    this.viewer.stageCanvas.style.cursor = tool.cursor ?? 'default';
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
const engineTierLabel = document.getElementById('engine-tier-label');

app.viewer = new Viewer(stageCanvas);
app.viewer.toolDelegate = {
  onPointerDown: (worldPoint, event) => app.activeTool?.onPointerDown?.(app, worldPoint, event),
  onPointerMove: (worldPoint, event) => app.activeTool?.onPointerMove?.(app, worldPoint, event),
  onPointerUp: (worldPoint, event) => app.activeTool?.onPointerUp?.(app, worldPoint, event),
  onDoubleClick: (worldPoint, event) => app.activeTool?.onDoubleClick?.(app, worldPoint, event),
};
app.viewer.setOverlayPainter((context, renderState) => {
  app.activeTool?.drawOverlay?.(context, renderState);
});

initializeToasts(app, document.getElementById('toast-container'));
initializeTransport(app, document.getElementById('transport-container'));
initializeLayerTabs(app, document.getElementById('layer-tabs-container'));
initializeLayerDetail(app, document.getElementById('layer-detail-container'));
initializeClassManager(app, document.getElementById('class-manager-container'));
initializeAnnotationsTable(app, document.getElementById('annotations-table-container'));
initializeEventHotkeys(app);

app.rebuildAnnotationLayersFromDocument();
app.setActiveTool('select');

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
    const engine = await createBestEngine(source, {
      canvas: videoEngineCanvas, video: videoEngineElement,
    });
    attachEngine(engine, { name, sizeBytes });
  } catch (error) {
    app.showToast(`Could not open the video: ${error.message ?? error}`, { kind: 'error' });
  }
}

function attachEngine(engine, { name, sizeBytes }) {
  app.engine = engine;
  app.videoInformation = {
    name,
    sizeBytes: sizeBytes ?? null,
    numberOfFrames: engine.numFrames,
    // Mean rate, provenance only — frame indices are the source of truth.
    frameRate: engine.duration ? Number((engine.numFrames / engine.duration).toFixed(3)) : null,
    frameIndexIsExact: engine.frameIndexIsExact,
    durationSeconds: engine.duration,
    width: engine.videoWidth,
    height: engine.videoHeight,
  };

  engine.addEventListener('errormessage', (event) => {
    const detail = event.detail ?? {};
    if (!detail.message) return;
    if (detail.fatal) recoverFromFatalDecode();
    else app.showToast(detail.message, { kind: 'warning' });
  });

  const videoLayer = new VideoLayer(engine, videoHost);
  app.viewer.addLayer(videoLayer, 0);

  engineTierLabel.textContent = engine.tier ?? '';
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
    });
    attachEngine(engine, information);
    engine.seekToFrame(frameBeforeFailure);
  } catch (error) {
    app.showToast(`Fallback player also failed: ${error.message ?? error}`, { kind: 'error' });
  }
}

/* ---------- Animation loop ---------- */

let lastReportedFrame = -1;

function animationTick(now) {
  const engine = app.engine;
  engine?.update(now);
  if (engine) {
    if (engine.currentFrame !== lastReportedFrame) {
      lastReportedFrame = engine.currentFrame;
      app.dispatchEvent(new CustomEvent('frame-changed'));
      app.viewer.requestRender();
    }
    if (!engine.paused) app.viewer.requestRender();
  }
  app.viewer.renderIfNeeded({
    frame: app.currentFrame,
    frameFloat: engine?.currentFrameFloat ?? 0,
    selection: app.selection,
    hover: app.hover,
    document: app.annotationDocument,
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
for (const button of toolButtons) {
  button.addEventListener('click', () => app.setActiveTool(button.dataset.tool));
}
app.addEventListener('tool-changed', () => {
  for (const button of toolButtons) {
    button.classList.toggle('active-tool', button.dataset.tool === app.activeTool?.id);
  }
});

document.getElementById('fit-view-button').addEventListener('click', () => app.viewer.fitToContent());

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

  for (const tool of Object.values(app.toolRegistry)) {
    if (tool.hotkey === event.key) { app.setActiveTool(tool.id); return; }
  }

  if (app.activeTool?.onKeyDown?.(app, event)) { event.preventDefault(); return; }

  if (app.runKeyHandlers(event)) event.preventDefault();
});

/* ---------- Optional ?video= URL parameter ---------- */

const videoUrlParameter = new URLSearchParams(window.location.search).get('video');
if (videoUrlParameter) {
  const nameFromUrl = videoUrlParameter.split('/').pop() || videoUrlParameter;
  loadVideoSource(videoUrlParameter, { name: nameFromUrl, sizeBytes: null });
}
