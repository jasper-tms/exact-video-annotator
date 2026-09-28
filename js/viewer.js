// The Viewer owns the stage canvas, the world→stage view transform (zoom and
// pan), the layer stack, and raw pointer handling. Zoom and pan work in every
// tool (wheel and pinch to zoom, middle-drag to pan; every tool additionally
// pans when dragging empty space, since starting a new annotation takes a
// double-click); all other pointer events are forwarded to a tool delegate
// installed by main.js.
//
// A tool can also request a pan explicitly (an empty-space drag, or a drag
// that started on empty space but hasn't moved far enough yet to tell click
// from drag) by calling beginPanFromPointerEvent(event) from its
// onPointerDown or onPointerMove.
//
// World units need not be square on screen. When every loaded media layer
// shares one non-square pixel shape (an anamorphic video), world units are
// those stored pixels, and the view transform shows each one
// pixelAspectRatio times as wide as it is tall. So world → stage is
//   stageX = worldX × scale × pixelAspectRatio + offsetX
//   stageY = worldY × scale                    + offsetY
// and anything drawn under the resulting canvas transform is stretched the
// same way. Layers that draw marks meant to keep a fixed on-screen shape
// (points, handles, strokes, text) position them with renderState.stageFromLocal
// and draw them in stage pixels instead (see renderState below).

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
    // Width ÷ height of one world unit on screen: 1 (square) unless every
    // media layer shares an anamorphic pixel shape. Set by main.js through
    // setPixelAspectRatio.
    this.pixelAspectRatio = 1;
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
    return {
      x: (stagePoint.x - offsetX) / (scale * this.pixelAspectRatio),
      y: (stagePoint.y - offsetY) / scale,
    };
  }

  stageFromWorldPoint(worldPoint) {
    const { scale, offsetX, offsetY } = this.viewTransform;
    return {
      x: worldPoint.x * scale * this.pixelAspectRatio + offsetX,
      y: worldPoint.y * scale + offsetY,
    };
  }

  worldFromPointerEvent(event) {
    return this.worldFromStagePoint(this.stagePointFromPointerEvent(event));
  }

  /** Compose a layer's local→world transform with the view transform:
      stage = local × (scaleX, scaleY) + (offsetX, offsetY). The two scales
      differ exactly when world units are not square on screen. */
  stageTransformForLayer(layer) {
    return this.#stageTransformFor(layer.transform);
  }

  /** The identity layer transform: stage transform for world coordinates. */
  stageTransformForWorld() {
    return this.#stageTransformFor({ scale: 1, offsetX: 0, offsetY: 0 });
  }

  #stageTransformFor(local) {
    const view = this.viewTransform;
    const horizontalViewScale = view.scale * this.pixelAspectRatio;
    return {
      scaleX: horizontalViewScale * local.scale,
      scaleY: view.scale * local.scale,
      offsetX: view.offsetX + horizontalViewScale * local.offsetX,
      offsetY: view.offsetY + view.scale * local.offsetY,
    };
  }

  /** Change how wide a world unit is shown relative to its height, keeping
      whatever world point sits at the center of the stage where it is. */
  setPixelAspectRatio(pixelAspectRatio) {
    if (!(pixelAspectRatio > 0) || pixelAspectRatio === this.pixelAspectRatio) return;
    const centerX = this.stageCanvas.clientWidth / 2;
    const centerWorldX = this.worldFromStagePoint({ x: centerX, y: 0 }).x;
    this.pixelAspectRatio = pixelAspectRatio;
    this.viewTransform = {
      ...this.viewTransform,
      offsetX: centerX - centerWorldX * this.viewTransform.scale * pixelAspectRatio,
    };
    this.#viewChanged();
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
    // Widths are fitted as they will be SHOWN, which for non-square world
    // units is pixelAspectRatio times their world width.
    const shownContentWidth = (union.right - union.left) * this.pixelAspectRatio;
    const contentHeight = union.bottom - union.top;
    if (!stageWidth || !stageHeight || !shownContentWidth || !contentHeight) return;
    const scale = Math.min(
      (stageWidth * (1 - 2 * FIT_MARGIN_FRACTION)) / shownContentWidth,
      (stageHeight * (1 - 2 * FIT_MARGIN_FRACTION)) / contentHeight,
    );
    this.viewTransform = {
      scale,
      offsetX: (stageWidth - shownContentWidth * scale) / 2
        - union.left * scale * this.pixelAspectRatio,
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
   * frameFloat, selection, hover, and document; the viewer fills in, per layer
   * (and for the overlay, with world coordinates as the local ones):
   *   pixelsPerLocalUnit   on-screen CSS pixels per local unit along the
   *                        SHORTER-drawn axis — the one that decides when a
   *                        source pixel is big enough to see (smoothing, the
   *                        pixel grid's fade-in). Equal to both axes' scale
   *                        whenever world units are square.
   *   stageFromLocal(point) → {x, y} in stage CSS pixels. Marks with a fixed
   *                        on-screen size and shape are positioned through
   *                        this and drawn by drawInStagePixels.
   *   drawInStagePixels(callback) runs callback with the context transform
   *                        set to stage CSS pixels (device pixel ratio only),
   *                        then restores the local transform. A path built
   *                        BEFORE the call keeps its local geometry, so
   *                        stroking it inside gives an even, screen-pixel
   *                        line width even when local units are not square.
   *   devicePixelRatio
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

    // Media layers (video and image) paint in reverse stack order: the leftmost
    // media tab paints last among the media, so it sits on TOP of the others
    // rather than beneath them — leftmost tab is frontmost. Every non-media
    // (annotation) layer keeps its position, so annotations still draw over all
    // footage. Each media slot is filled from the reversed media list; nothing
    // else moves. This is why the leftmost video is also the frontmost video,
    // and dragging a media tab leftmost brings it to the front.
    const reversedMediaLayers = this.layers.filter((layer) => layer.isMedia).reverse();
    let nextReversedMedia = 0;
    const paintOrder = this.layers.map((layer) =>
      layer.isMedia ? reversedMediaLayers[nextReversedMedia++] : layer);

    for (const layer of paintOrder) {
      if (!layer.visible || layer.opacity === 0) continue;
      const layerTransform = this.stageTransformForLayer(layer);
      context.save();
      context.globalAlpha = layer.opacity;
      layer.draw(context, this.#enterLocalSpace(
        context, layerTransform, devicePixelRatioNow, renderState));
      context.restore();
    }

    if (this.overlayPainter) {
      context.save();
      // A throw in the overlay painter must not blank the canvas (the layers
      // above are already painted) or kill the render loop — degrade to "no
      // overlay this frame" and log the failure once so it stays diagnosable
      // without spamming the console every tick.
      try {
        this.overlayPainter(context, this.#enterLocalSpace(
          context, this.stageTransformForWorld(), devicePixelRatioNow, renderState));
        this.overlayPainterErrorLogged = false;
      } catch (error) {
        if (!this.overlayPainterErrorLogged) {
          console.error('Overlay painter threw; skipping the overlay this frame.', error);
          this.overlayPainterErrorLogged = true;
        }
      } finally {
        context.restore();
      }
    }
  }

  /** Set the context's transform to draw in the local space of stageTransform
      and return the renderState a draw call in that space receives (see
      renderIfNeeded). */
  #enterLocalSpace(context, stageTransform, devicePixelRatioNow, renderState) {
    const { scaleX, scaleY, offsetX, offsetY } = stageTransform;
    const localTransform = [
      devicePixelRatioNow * scaleX, 0, 0, devicePixelRatioNow * scaleY,
      devicePixelRatioNow * offsetX, devicePixelRatioNow * offsetY,
    ];
    context.setTransform(...localTransform);
    return {
      ...renderState,
      pixelsPerLocalUnit: Math.min(scaleX, scaleY),
      devicePixelRatio: devicePixelRatioNow,
      stageFromLocal: (point) => ({ x: point.x * scaleX + offsetX, y: point.y * scaleY + offsetY }),
      drawInStagePixels: (callback) => {
        context.setTransform(devicePixelRatioNow, 0, 0, devicePixelRatioNow, 0, 0);
        try { callback(); } finally { context.setTransform(...localTransform); }
      },
    };
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
      // Right-click is reserved for tools (for example, closing a polyline).
      event.preventDefault();
    });
  }

  /** Start panning with the given pointer (used for middle-drag here, and by
      tools for left-drags that start on empty space). */
  beginPanFromPointerEvent(event) {
    this.#activePan = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY };
    this.stageCanvas.setPointerCapture(event.pointerId);
  }

  get isPanning() { return this.#activePan !== null; }
}
