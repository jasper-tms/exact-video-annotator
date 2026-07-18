// The Viewer owns the stage canvas, the world→stage view transform (zoom and
// pan), the layer stack, and raw pointer handling. Zoom and pan work in every
// tool (wheel and pinch to zoom, middle-drag to pan; the select tool
// additionally pans when dragging empty space); all other pointer events are
// forwarded to a tool delegate installed by main.js.
//
// A tool can also request a pan explicitly (the select tool's empty-space
// drag) by calling beginPanFromPointerEvent(event) from its onPointerDown.

const MINIMUM_VIEW_SCALE = 0.01;
const MAXIMUM_VIEW_SCALE = 200;
const FIT_MARGIN_FRACTION = 0.03;

export class Viewer extends EventTarget {
  /** @param {HTMLCanvasElement} stageCanvas */
  constructor(stageCanvas) {
    super();
    this.stageCanvas = stageCanvas;
    this.context = stageCanvas.getContext('2d');
    this.layers = [];
    this.viewTransform = { scale: 1, offsetX: 0, offsetY: 0 };
    this.backgroundColor = '#101014';

    // Installed by main.js: { onPointerDown, onPointerMove, onPointerUp }
    // receiving (worldPoint, event). Absent handlers are skipped.
    this.toolDelegate = null;
    // Optional painter drawn above all layers, in world coordinates.
    this.overlayPainter = null;

    this.#needsRender = true;
    this.#activePan = null;

    this.#resizeObserver = new ResizeObserver(() => this.requestRender());
    this.#resizeObserver.observe(stageCanvas);

    this.#attachPointerHandlers();
  }

  #needsRender; #activePan; #resizeObserver;

  /* ---------- Layer stack ---------- */

  addLayer(layer, index = this.layers.length) {
    this.layers.splice(index, 0, layer);
    layer.addEventListener('layer-changed', this.#onLayerChanged);
    this.dispatchEvent(new CustomEvent('layers-changed'));
    this.requestRender();
  }

  removeLayer(layer) {
    const index = this.layers.indexOf(layer);
    if (index === -1) return;
    this.layers.splice(index, 1);
    layer.removeEventListener('layer-changed', this.#onLayerChanged);
    this.dispatchEvent(new CustomEvent('layers-changed'));
    this.requestRender();
  }

  moveLayerToIndex(layer, index) {
    const currentIndex = this.layers.indexOf(layer);
    if (currentIndex === -1) return;
    this.layers.splice(currentIndex, 1);
    this.layers.splice(Math.min(Math.max(index, 0), this.layers.length), 0, layer);
    this.dispatchEvent(new CustomEvent('layers-changed'));
    this.requestRender();
  }

  #onLayerChanged = () => this.requestRender();

  /* ---------- Coordinate transforms ---------- */

  /** Stage CSS pixel position of a pointer event, relative to the canvas. */
  stagePointFromPointerEvent(event) {
    const rectangle = this.stageCanvas.getBoundingClientRect();
    return { x: event.clientX - rectangle.left, y: event.clientY - rectangle.top };
  }

  worldFromStagePoint(stagePoint) {
    const { scale, offsetX, offsetY } = this.viewTransform;
    return { x: (stagePoint.x - offsetX) / scale, y: (stagePoint.y - offsetY) / scale };
  }

  stageFromWorldPoint(worldPoint) {
    const { scale, offsetX, offsetY } = this.viewTransform;
    return { x: worldPoint.x * scale + offsetX, y: worldPoint.y * scale + offsetY };
  }

  worldFromPointerEvent(event) {
    return this.worldFromStagePoint(this.stagePointFromPointerEvent(event));
  }

  /** Compose a layer's local→world transform with the view transform. */
  stageTransformForLayer(layer) {
    const view = this.viewTransform;
    const local = layer.transform;
    return {
      scale: view.scale * local.scale,
      offsetX: view.offsetX + view.scale * local.offsetX,
      offsetY: view.offsetY + view.scale * local.offsetY,
    };
  }

  /* ---------- Zoom and pan ---------- */

  zoomAtStagePoint(factor, stagePoint) {
    const previousScale = this.viewTransform.scale;
    const scale = Math.min(MAXIMUM_VIEW_SCALE, Math.max(MINIMUM_VIEW_SCALE, previousScale * factor));
    if (scale === previousScale) return;
    const ratio = scale / previousScale;
    this.viewTransform = {
      scale,
      offsetX: stagePoint.x - (stagePoint.x - this.viewTransform.offsetX) * ratio,
      offsetY: stagePoint.y - (stagePoint.y - this.viewTransform.offsetY) * ratio,
    };
    this.#viewChanged();
  }

  panByStagePixels(deltaX, deltaY) {
    this.viewTransform = {
      ...this.viewTransform,
      offsetX: this.viewTransform.offsetX + deltaX,
      offsetY: this.viewTransform.offsetY + deltaY,
    };
    this.#viewChanged();
  }

  fitToContent() {
    let union = null;
    for (const layer of this.layers) {
      const bounds = layer.contentBounds?.();
      if (!bounds) continue;
      const { scale, offsetX, offsetY } = layer.transform;
      const worldBounds = {
        left: bounds.x * scale + offsetX,
        top: bounds.y * scale + offsetY,
        right: (bounds.x + bounds.width) * scale + offsetX,
        bottom: (bounds.y + bounds.height) * scale + offsetY,
      };
      union = union === null ? worldBounds : {
        left: Math.min(union.left, worldBounds.left),
        top: Math.min(union.top, worldBounds.top),
        right: Math.max(union.right, worldBounds.right),
        bottom: Math.max(union.bottom, worldBounds.bottom),
      };
    }
    if (!union) return;
    const stageWidth = this.stageCanvas.clientWidth;
    const stageHeight = this.stageCanvas.clientHeight;
    const contentWidth = union.right - union.left;
    const contentHeight = union.bottom - union.top;
    if (!stageWidth || !stageHeight || !contentWidth || !contentHeight) return;
    const scale = Math.min(
      (stageWidth * (1 - 2 * FIT_MARGIN_FRACTION)) / contentWidth,
      (stageHeight * (1 - 2 * FIT_MARGIN_FRACTION)) / contentHeight,
    );
    this.viewTransform = {
      scale,
      offsetX: (stageWidth - contentWidth * scale) / 2 - union.left * scale,
      offsetY: (stageHeight - contentHeight * scale) / 2 - union.top * scale,
    };
    this.#viewChanged();
  }

  #viewChanged() {
    this.dispatchEvent(new CustomEvent('view-changed'));
    this.requestRender();
  }

  /* ---------- Rendering ---------- */

  requestRender() { this.#needsRender = true; }

  /**
   * Called once per animation frame by main.js. renderState carries frame,
   * frameFloat, selection, hover, and document; the viewer fills in
   * pixelsPerLocalUnit per layer.
   */
  renderIfNeeded(renderState) {
    if (!this.#needsRender) return;
    this.#needsRender = false;

    const canvas = this.stageCanvas;
    const devicePixelRatioNow = window.devicePixelRatio || 1;
    const backingWidth = Math.round(canvas.clientWidth * devicePixelRatioNow);
    const backingHeight = Math.round(canvas.clientHeight * devicePixelRatioNow);
    if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
      canvas.width = backingWidth;
      canvas.height = backingHeight;
    }
    if (!backingWidth || !backingHeight) return;

    const context = this.context;
    context.setTransform(devicePixelRatioNow, 0, 0, devicePixelRatioNow, 0, 0);
    context.fillStyle = this.backgroundColor;
    context.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);

    for (const layer of this.layers) {
      if (!layer.visible || layer.opacity === 0) continue;
      const layerTransform = this.stageTransformForLayer(layer);
      context.save();
      context.globalAlpha = layer.opacity;
      context.setTransform(
        devicePixelRatioNow * layerTransform.scale, 0,
        0, devicePixelRatioNow * layerTransform.scale,
        devicePixelRatioNow * layerTransform.offsetX,
        devicePixelRatioNow * layerTransform.offsetY,
      );
      layer.draw(context, { ...renderState, pixelsPerLocalUnit: layerTransform.scale });
      context.restore();
    }

    if (this.overlayPainter) {
      const view = this.viewTransform;
      context.save();
      context.setTransform(
        devicePixelRatioNow * view.scale, 0, 0, devicePixelRatioNow * view.scale,
        devicePixelRatioNow * view.offsetX, devicePixelRatioNow * view.offsetY,
      );
      this.overlayPainter(context, { ...renderState, pixelsPerLocalUnit: view.scale });
      context.restore();
    }
  }

  setOverlayPainter(painter) {
    this.overlayPainter = painter;
    this.requestRender();
  }

  /* ---------- Pointer handling ---------- */

  #attachPointerHandlers() {
    const canvas = this.stageCanvas;

    canvas.addEventListener('pointerdown', (event) => {
      if (event.button === 1) {
        this.beginPanFromPointerEvent(event);
        event.preventDefault();
        return;
      }
      if (event.button !== 0) return;
      canvas.setPointerCapture(event.pointerId);
      this.toolDelegate?.onPointerDown?.(this.worldFromPointerEvent(event), event);
    });

    canvas.addEventListener('pointermove', (event) => {
      if (this.#activePan && event.pointerId === this.#activePan.pointerId) {
        this.panByStagePixels(event.clientX - this.#activePan.lastX,
                              event.clientY - this.#activePan.lastY);
        this.#activePan.lastX = event.clientX;
        this.#activePan.lastY = event.clientY;
        return;
      }
      this.toolDelegate?.onPointerMove?.(this.worldFromPointerEvent(event), event);
    });

    const endPointer = (event) => {
      if (this.#activePan && event.pointerId === this.#activePan.pointerId) {
        this.#activePan = null;
        return;
      }
      this.toolDelegate?.onPointerUp?.(this.worldFromPointerEvent(event), event);
    };
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);

    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      // Trackpad pinch arrives as wheel with ctrlKey; both gestures zoom.
      const zoomFactor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002));
      this.zoomAtStagePoint(zoomFactor, this.stagePointFromPointerEvent(event));
    }, { passive: false });

    canvas.addEventListener('dblclick', (event) => {
      this.toolDelegate?.onDoubleClick?.(this.worldFromPointerEvent(event), event);
    });

    canvas.addEventListener('contextmenu', (event) => {
      // Right-click is reserved for tools (for example, closing a polygon).
      event.preventDefault();
    });
  }

  /** Start panning with the given pointer (used for middle-drag here, and by
      the select tool for left-drags that start on empty space). */
  beginPanFromPointerEvent(event) {
    this.#activePan = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY };
    this.stageCanvas.setPointerCapture(event.pointerId);
  }

  get isPanning() { return this.#activePan !== null; }
}
