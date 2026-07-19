// The shapes layer draws polygons and lines and implements the annotation
// editing contract (hitTest + snapshot/restore + moveItemBy/moveVertexTo +
// command methods) so the select tool edits shapes without knowing their
// internals. See ARCHITECTURE.md. Like every annotation view layer, its `items`
// array IS the backing document layer's array (same object identity); it holds
// no copied geometry.

import { Layer } from './layer.js';

// All sizes below are on-screen pixels; drawing divides them by
// renderState.pixelsPerLocalUnit so they stay constant regardless of zoom.
const STROKE_WIDTH_SCREEN_PIXELS = 2;
const VERTEX_HANDLE_SCREEN_PIXELS = 6;
const HIT_TOLERANCE_SCREEN_PIXELS = 8;
const LABEL_FONT_SCREEN_PIXELS = 12;

const FILL_ALPHA = 0.15;
const OFF_FRAME_ALPHA_MULTIPLIER = 0.25;
const HOVER_STROKE_MULTIPLIER = 1.75;
const ACTIVE_VERTEX_SIZE_MULTIPLIER = 1.4;

const FALLBACK_COLOR = '#4f9cf9';
const HANDLE_ACCENT_COLOR = '#ffffff';

export class ShapesLayer extends Layer {
  /** @param {object} documentLayer  The `type: 'shapes'` layer in the document. */
  constructor(documentLayer) {
    super({ id: documentLayer.id, type: 'shapes', name: documentLayer.name });
    this.visible = documentLayer.visible;
    this.opacity = documentLayer.opacity;
    this.transform = { ...documentLayer.transform };
    this.documentLayer = documentLayer;
    // Same array object as the document layer: this is a view, not a copy.
    this.items = documentLayer.items;
  }

  get isEditable() { return true; }

  /* ---------- Drawing ---------- */

  draw(context, renderState) {
    const pixelsPerLocalUnit = renderState.pixelsPerLocalUnit;
    const strokeWidth = STROKE_WIDTH_SCREEN_PIXELS / pixelsPerLocalUnit;
    const handleSize = VERTEX_HANDLE_SCREEN_PIXELS / pixelsPerLocalUnit;
    const fontSize = LABEL_FONT_SCREEN_PIXELS / pixelsPerLocalUnit;
    // The viewer has already set globalAlpha to this layer's opacity; compose
    // per-item dimming and fill transparency on top of it rather than replacing.
    const baseAlpha = context.globalAlpha;

    for (const item of this.items) {
      if (item.vertices.length === 0) continue;
      // A frame-agnostic shape (frame === null) applies to every frame, so it
      // always draws at full strength rather than the dimmed off-frame alpha.
      const isCurrentFrame = item.frame === null || item.frame === renderState.frame;
      const frameAlpha = isCurrentFrame ? 1 : OFF_FRAME_ALPHA_MULTIPLIER;
      const color = colorForItem(item, renderState);
      const isSelected = matchesItem(renderState.selection, this.id, item.id);
      const isHovered = matchesItem(renderState.hover, this.id, item.id);

      context.save();
      context.lineJoin = 'round';
      context.lineCap = 'round';

      // Build the shape path: closed for polygons, open for lines.
      context.beginPath();
      context.moveTo(item.vertices[0][0], item.vertices[0][1]);
      for (let index = 1; index < item.vertices.length; index++) {
        context.lineTo(item.vertices[index][0], item.vertices[index][1]);
      }
      if (item.kind === 'polygon') context.closePath();

      if (item.kind === 'polygon') {
        context.globalAlpha = baseAlpha * frameAlpha * FILL_ALPHA;
        context.fillStyle = color;
        context.fill();
      }

      context.globalAlpha = baseAlpha * frameAlpha;
      context.strokeStyle = color;
      context.lineWidth = isHovered ? strokeWidth * HOVER_STROKE_MULTIPLIER : strokeWidth;
      context.stroke();

      if (isSelected) {
        this.#drawVertexHandles(context, item, renderState, handleSize, strokeWidth, color, baseAlpha);
      }

      if (item.name) {
        context.globalAlpha = baseAlpha * frameAlpha;
        context.fillStyle = color;
        context.font = `${fontSize}px system-ui, -apple-system, sans-serif`;
        context.textBaseline = 'bottom';
        context.fillText(item.name, item.vertices[0][0] + handleSize, item.vertices[0][1] - handleSize);
      }

      context.restore();
    }
  }

  #drawVertexHandles(context, item, renderState, handleSize, strokeWidth, color, baseAlpha) {
    const activeVertexIndex = renderState.selection?.vertexIndex ?? null;
    context.globalAlpha = baseAlpha;
    context.lineWidth = strokeWidth * 0.75;
    for (let index = 0; index < item.vertices.length; index++) {
      const [x, y] = item.vertices[index];
      const isActive = index === activeVertexIndex;
      const size = isActive ? handleSize * ACTIVE_VERTEX_SIZE_MULTIPLIER : handleSize;
      // The active vertex inverts fill/stroke so it reads as distinct.
      context.fillStyle = isActive ? HANDLE_ACCENT_COLOR : color;
      context.strokeStyle = isActive ? color : HANDLE_ACCENT_COLOR;
      context.fillRect(x - size / 2, y - size / 2, size, size);
      context.strokeRect(x - size / 2, y - size / 2, size, size);
    }
  }

  contentBounds() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const item of this.items) {
      for (const [x, y] of item.vertices) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    if (minX === Infinity) return null;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  /* ---------- Hit testing ---------- */

  hitTest(localPoint, renderState) {
    const tolerance = HIT_TOLERANCE_SCREEN_PIXELS / renderState.pixelsPerLocalUnit;

    // Prefer current-frame items over off-frame ones, and within each group
    // prefer topmost-drawn (later items sit visually on top).
    const currentFrameItems = [];
    const offFrameItems = [];
    for (const item of this.items) {
      // Frame-agnostic shapes (frame === null) rank alongside current-frame ones.
      const onCurrentFrame = item.frame === null || item.frame === renderState.frame;
      (onCurrentFrame ? currentFrameItems : offFrameItems).push(item);
    }
    currentFrameItems.reverse();
    offFrameItems.reverse();
    const orderedItems = [...currentFrameItems, ...offFrameItems];

    // Priority (1): vertices, across all candidates.
    for (const item of orderedItems) {
      for (let index = 0; index < item.vertices.length; index++) {
        const [x, y] = item.vertices[index];
        if (Math.hypot(localPoint.x - x, localPoint.y - y) <= tolerance) {
          return { itemId: item.id, part: 'vertex', vertexIndex: index };
        }
      }
    }

    // Priority (2): segments. Segment i connects vertex i to i + 1, wrapping to
    // vertex 0 for closed polygons.
    for (const item of orderedItems) {
      const segmentCount = item.kind === 'polygon'
        ? item.vertices.length
        : item.vertices.length - 1;
      for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex++) {
        const [ax, ay] = item.vertices[segmentIndex];
        const [bx, by] = item.vertices[(segmentIndex + 1) % item.vertices.length];
        if (distanceToSegment(localPoint.x, localPoint.y, ax, ay, bx, by) <= tolerance) {
          return { itemId: item.id, part: 'segment', vertexIndex: segmentIndex };
        }
      }
    }

    // Priority (3): polygon interiors only.
    for (const item of orderedItems) {
      if (item.kind !== 'polygon') continue;
      if (pointInPolygon(localPoint.x, localPoint.y, item.vertices)) {
        return { itemId: item.id, part: 'body' };
      }
    }

    return null;
  }

  /* ---------- Editing contract ---------- */

  getItem(itemId) {
    return this.items.find((item) => item.id === itemId) ?? null;
  }

  snapshotItemGeometry(itemId) {
    const item = this.getItem(itemId);
    if (!item) return null;
    return { frame: item.frame, vertices: item.vertices.map((vertex) => [vertex[0], vertex[1]]) };
  }

  restoreItemGeometry(itemId, snapshot) {
    const item = this.getItem(itemId);
    if (!item || !snapshot) return;
    item.frame = snapshot.frame;
    item.vertices = snapshot.vertices.map((vertex) => [vertex[0], vertex[1]]);
  }

  moveItemBy(itemId, deltaLocal) {
    const item = this.getItem(itemId);
    if (!item) return;
    for (const vertex of item.vertices) {
      vertex[0] += deltaLocal.x;
      vertex[1] += deltaLocal.y;
    }
  }

  moveVertexTo(itemId, vertexIndex, localPoint) {
    const item = this.getItem(itemId);
    if (!item || !item.vertices[vertexIndex]) return;
    item.vertices[vertexIndex] = [localPoint.x, localPoint.y];
  }

  commandInsertVertex(itemId, segmentIndex, localPoint) {
    const item = this.getItem(itemId);
    if (!item) return null;
    const insertIndex = segmentIndex + 1;
    const newVertex = [localPoint.x, localPoint.y];
    return {
      label: 'Insert vertex',
      apply: () => { item.vertices.splice(insertIndex, 0, newVertex); },
      revert: () => { item.vertices.splice(insertIndex, 1); },
    };
  }

  commandDeleteVertex(itemId, vertexIndex) {
    const item = this.getItem(itemId);
    if (!item || !item.vertices[vertexIndex]) return null;
    const minimumVertexCount = item.kind === 'polygon' ? 3 : 2;
    // Removing this vertex would leave too few to be a valid shape, so delete
    // the whole item instead — as one undoable command that restores exactly.
    if (item.vertices.length - 1 < minimumVertexCount) {
      return this.commandDeleteItem(itemId);
    }
    const removedVertex = [item.vertices[vertexIndex][0], item.vertices[vertexIndex][1]];
    return {
      label: 'Delete vertex',
      apply: () => { item.vertices.splice(vertexIndex, 1); },
      revert: () => { item.vertices.splice(vertexIndex, 0, [removedVertex[0], removedVertex[1]]); },
    };
  }

  commandDeleteItem(itemId) {
    const item = this.getItem(itemId);
    if (!item) return null;
    const originalIndex = this.items.indexOf(item);
    return {
      label: 'Delete shape',
      apply: () => {
        const index = this.items.indexOf(item);
        if (index !== -1) this.items.splice(index, 1);
      },
      revert: () => {
        this.items.splice(Math.min(originalIndex, this.items.length), 0, item);
      },
    };
  }
}

/* ---------- Module-level geometry helpers ---------- */

function colorForItem(item, renderState) {
  const classEntry = renderState.document?.classes?.find((entry) => entry.id === item.classId);
  return classEntry?.color ?? FALLBACK_COLOR;
}

function matchesItem(reference, layerId, itemId) {
  return Boolean(reference) && reference.layerId === layerId && reference.itemId === itemId;
}

function distanceToSegment(pointX, pointY, ax, ay, bx, by) {
  const deltaX = bx - ax;
  const deltaY = by - ay;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  if (lengthSquared === 0) return Math.hypot(pointX - ax, pointY - ay);
  let projection = ((pointX - ax) * deltaX + (pointY - ay) * deltaY) / lengthSquared;
  projection = Math.max(0, Math.min(1, projection));
  const closestX = ax + projection * deltaX;
  const closestY = ay + projection * deltaY;
  return Math.hypot(pointX - closestX, pointY - closestY);
}

function pointInPolygon(pointX, pointY, vertices) {
  let inside = false;
  for (let current = 0, previous = vertices.length - 1; current < vertices.length; previous = current++) {
    const [currentX, currentY] = vertices[current];
    const [previousX, previousY] = vertices[previous];
    const straddlesRay = (currentY > pointY) !== (previousY > pointY);
    if (straddlesRay) {
      const intersectionX = (previousX - currentX) * (pointY - currentY) / (previousY - currentY) + currentX;
      if (pointX < intersectionX) inside = !inside;
    }
  }
  return inside;
}
