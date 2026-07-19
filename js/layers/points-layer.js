// The points layer draws and edits point annotations. It is a view over a
// document layer: its `items` array IS that document layer's `items` array
// (same object identity), so it holds no copied geometry. See ARCHITECTURE.md
// ("Annotation-layer editing contract") for the methods the select tool relies
// on. Points have a single vertex (index 0) and no segments, so the vertex-
// insertion/deletion commands are intentionally absent.

import { Layer } from './layer.js';

// On-screen sizes are constant regardless of zoom: each is divided by
// renderState.pixelsPerLocalUnit to convert screen pixels into local units.
const POINT_RADIUS_SCREEN_PIXELS = 5;
const OUTLINE_WIDTH_SCREEN_PIXELS = 1.5;
const SELECTION_RING_GAP_SCREEN_PIXELS = 3;
const SELECTION_RING_WIDTH_SCREEN_PIXELS = 2;
const HOVER_RING_WIDTH_SCREEN_PIXELS = 1.5;
const LABEL_FONT_SCREEN_PIXELS = 12;
const HIT_TOLERANCE_SCREEN_PIXELS = 8;

// Fraction of full opacity used for items that are not on the current frame,
// so nearby-frame context stays faintly visible (the "off-frame" convention).
const OFF_FRAME_ALPHA_MULTIPLIER = 0.25;

const FALLBACK_COLOR = '#4f9cf9';
const OUTLINE_COLOR = '#101014';
const LABEL_COLOR = '#e8e8ec';

export class PointsLayer extends Layer {
  /** @param {object} documentLayer A document layer of type 'points'. */
  constructor(documentLayer) {
    super({ id: documentLayer.id, type: 'points', name: documentLayer.name });
    this.visible = documentLayer.visible;
    this.opacity = documentLayer.opacity;
    this.transform = { ...documentLayer.transform };
    this.documentLayer = documentLayer;
    // Same array identity as the document layer: this is a view, not a copy.
    this.items = documentLayer.items;
  }

  get isEditable() { return true; }

  colorForItem(item, renderState) {
    const classId = item.classId;
    if (classId === null || classId === undefined) return FALLBACK_COLOR;
    const matchingClass = renderState.document.classes.find((entry) => entry.id === classId);
    return matchingClass ? matchingClass.color : FALLBACK_COLOR;
  }

  draw(context, renderState) {
    const pixelsPerLocalUnit = renderState.pixelsPerLocalUnit;
    const radius = POINT_RADIUS_SCREEN_PIXELS / pixelsPerLocalUnit;
    const outlineWidth = OUTLINE_WIDTH_SCREEN_PIXELS / pixelsPerLocalUnit;
    const labelFontSize = LABEL_FONT_SCREEN_PIXELS / pixelsPerLocalUnit;
    // The viewer has already set globalAlpha to this layer's opacity; scale
    // relative to it so off-frame items dim on top of the layer opacity.
    const baseAlpha = context.globalAlpha;
    const selection = renderState.selection;
    const hover = renderState.hover;

    for (const item of this.items) {
      // A frame-agnostic item (frame === null) applies to every frame, so it
      // always draws at full strength rather than the dimmed off-frame alpha.
      const onCurrentFrame = item.frame === null || item.frame === renderState.frame;
      const color = this.colorForItem(item, renderState);

      context.globalAlpha = onCurrentFrame ? baseAlpha : baseAlpha * OFF_FRAME_ALPHA_MULTIPLIER;

      // Filled dot with a contrasting outline.
      context.beginPath();
      context.arc(item.x, item.y, radius, 0, Math.PI * 2);
      context.fillStyle = color;
      context.fill();
      context.lineWidth = outlineWidth;
      context.strokeStyle = OUTLINE_COLOR;
      context.stroke();

      // Selection and hover rings sit just outside the dot.
      const isSelected = selection
        && selection.layerId === this.id && selection.itemId === item.id;
      const isHovered = hover
        && hover.layerId === this.id && hover.itemId === item.id;
      if (isSelected) {
        context.beginPath();
        context.arc(item.x, item.y,
          radius + SELECTION_RING_GAP_SCREEN_PIXELS / pixelsPerLocalUnit, 0, Math.PI * 2);
        context.lineWidth = SELECTION_RING_WIDTH_SCREEN_PIXELS / pixelsPerLocalUnit;
        context.strokeStyle = '#ffffff';
        context.stroke();
      } else if (isHovered) {
        context.beginPath();
        context.arc(item.x, item.y,
          radius + SELECTION_RING_GAP_SCREEN_PIXELS / pixelsPerLocalUnit, 0, Math.PI * 2);
        context.lineWidth = HOVER_RING_WIDTH_SCREEN_PIXELS / pixelsPerLocalUnit;
        context.strokeStyle = 'rgba(255, 255, 255, 0.5)';
        context.stroke();
      }

      // Optional name label, offset to the upper right (local y increases
      // downward, so "up" is the negative y direction).
      if (item.name) {
        context.font = `${labelFontSize}px system-ui, sans-serif`;
        context.textAlign = 'left';
        context.textBaseline = 'bottom';
        context.fillStyle = LABEL_COLOR;
        context.fillText(item.name, item.x + radius, item.y - radius);
      }
    }

    context.globalAlpha = baseAlpha;
  }

  contentBounds() {
    if (this.items.length === 0) return null;
    let minimumX = Infinity;
    let minimumY = Infinity;
    let maximumX = -Infinity;
    let maximumY = -Infinity;
    for (const item of this.items) {
      if (item.x < minimumX) minimumX = item.x;
      if (item.y < minimumY) minimumY = item.y;
      if (item.x > maximumX) maximumX = item.x;
      if (item.y > maximumY) maximumY = item.y;
    }
    return {
      x: minimumX, y: minimumY,
      width: maximumX - minimumX, height: maximumY - minimumY,
    };
  }

  hitTest(localPoint, renderState) {
    const tolerance = HIT_TOLERANCE_SCREEN_PIXELS / renderState.pixelsPerLocalUnit;
    const toleranceSquared = tolerance * tolerance;
    let nearestOnFrame = null;
    let nearestOnFrameDistanceSquared = Infinity;
    let nearestOffFrame = null;
    let nearestOffFrameDistanceSquared = Infinity;

    for (const item of this.items) {
      const deltaX = item.x - localPoint.x;
      const deltaY = item.y - localPoint.y;
      const distanceSquared = deltaX * deltaX + deltaY * deltaY;
      if (distanceSquared > toleranceSquared) continue;
      // Frame-agnostic items (frame === null) rank alongside current-frame ones.
      if (item.frame === null || item.frame === renderState.frame) {
        if (distanceSquared < nearestOnFrameDistanceSquared) {
          nearestOnFrameDistanceSquared = distanceSquared;
          nearestOnFrame = item;
        }
      } else if (distanceSquared < nearestOffFrameDistanceSquared) {
        nearestOffFrameDistanceSquared = distanceSquared;
        nearestOffFrame = item;
      }
    }

    // Prefer a current-frame item over an off-frame one when both are in range.
    const chosen = nearestOnFrame ?? nearestOffFrame;
    if (!chosen) return null;
    return { itemId: chosen.id, part: 'vertex', vertexIndex: 0 };
  }

  /* ---------- Editing contract ---------- */

  getItem(itemId) {
    return this.items.find((item) => item.id === itemId) ?? null;
  }

  snapshotItemGeometry(itemId) {
    const item = this.getItem(itemId);
    if (!item) return null;
    return { frame: item.frame, x: item.x, y: item.y };
  }

  restoreItemGeometry(itemId, snapshot) {
    const item = this.getItem(itemId);
    if (!item || !snapshot) return;
    item.frame = snapshot.frame;
    item.x = snapshot.x;
    item.y = snapshot.y;
  }

  moveItemBy(itemId, deltaLocal) {
    const item = this.getItem(itemId);
    if (!item) return;
    item.x += deltaLocal.x;
    item.y += deltaLocal.y;
  }

  moveVertexTo(itemId, vertexIndex, localPoint) {
    // A point has a single vertex; moving it is moving the whole item.
    const item = this.getItem(itemId);
    if (!item) return;
    item.x = localPoint.x;
    item.y = localPoint.y;
  }

  commandDeleteItem(itemId) {
    const index = this.items.findIndex((item) => item.id === itemId);
    if (index === -1) return null;
    const item = this.items[index];
    return {
      label: 'Delete point',
      apply: () => {
        const currentIndex = this.items.indexOf(item);
        if (currentIndex !== -1) this.items.splice(currentIndex, 1);
      },
      revert: () => {
        this.items.splice(index, 0, item);
      },
    };
  }
}
