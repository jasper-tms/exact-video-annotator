// The coordinates layer draws and edits pixel-located annotations: points,
// lines, and polylines, distinguished by each item's `kind`. It is a view over
// a document layer: its `items` array IS that document layer's `items` array
// (same object identity), so it holds no copied geometry. See ARCHITECTURE.md
// ("Annotation-layer editing contract") for the methods the drawing tools rely
// on. A point is simply a `kind: 'point'` item with a single-element
// `vertices` array — there is no separate flat x/y representation — so the
// vertex/segment hit-testing and editing logic below is shared by all three
// kinds without a point-specific branch.
//
// A polyline is closed exactly when its last stored vertex is a literal
// duplicate of its first (see `isClosedPolyline` below) — there is no
// separate flag, and a line is never closed. Because closure is baked into
// the vertex list itself, the closing edge of a closed polyline is just an
// ordinary trailing segment in that list; nothing below needs to special-case
// wrapping the last vertex back to the first.

import { Layer } from './layer.js';

// All sizes below are on-screen pixels; drawing divides them by
// renderState.pixelsPerLocalUnit so they stay constant regardless of zoom.
const POINT_RADIUS_SCREEN_PIXELS = 5;
const POINT_OUTLINE_WIDTH_SCREEN_PIXELS = 1.5;
const SELECTION_RING_GAP_SCREEN_PIXELS = 3;
const SELECTION_RING_WIDTH_SCREEN_PIXELS = 2;
const HOVER_RING_WIDTH_SCREEN_PIXELS = 1.5;

const STROKE_WIDTH_SCREEN_PIXELS = 2;
const VERTEX_HANDLE_SCREEN_PIXELS = 6;
const HIT_TOLERANCE_SCREEN_PIXELS = 8;
const LABEL_FONT_SCREEN_PIXELS = 12;

const FILL_ALPHA = 0.15;
const OFF_FRAME_ALPHA_MULTIPLIER = 0.25;
const HOVER_STROKE_MULTIPLIER = 1.75;
const ACTIVE_VERTEX_SIZE_MULTIPLIER = 1.4;

const FALLBACK_COLOR = '#4f9cf9';
const POINT_OUTLINE_COLOR = '#101014';
const LABEL_COLOR = '#e8e8ec';
const HANDLE_ACCENT_COLOR = '#ffffff';

export class CoordinatesLayer extends Layer {
  /**
   * @param {object} documentLayer  The `type: 'coordinates'` layer in the document.
   * @param {object} app  The Application instance — kept only to read
   *   `app.annotationDocument.integerCoordinateOffset` for snapLocalPoint.
   */
  constructor(documentLayer, app) {
    super({ id: documentLayer.id, type: 'coordinates', name: documentLayer.name });
    this.visible = documentLayer.visible;
    this.opacity = documentLayer.opacity;
    this.transform = { ...documentLayer.transform };
    this.documentLayer = documentLayer;
    // Same array object as the document layer: this is a view, not a copy.
    this.items = documentLayer.items;
    this.app = app;
    // Whether items on this layer may hold fractional (x, y) values. When
    // false, every new or moved vertex snaps to whichever grid the document's
    // integer-coordinate convention names — this is a live per-layer toggle,
    // not an undoable command, and never locks (unlike that document setting).
    this.allowFractionalCoordinates = documentLayer.allowFractionalCoordinates ?? false;
  }

  get isEditable() { return true; }

  setAllowFractionalCoordinates(value) {
    this.allowFractionalCoordinates = value;
    this.dispatchEvent(new CustomEvent('layer-changed'));
  }

  /** Applies this layer's fractional-coordinate policy to a local point: pass
      it through unchanged when fractional coordinates are allowed, otherwise
      floor it (pixel top-left corner convention) or round it (pixel center
      convention), matching the document's integer-coordinate setting. Called
      both by every vertex-creating tool and internally by moveVertexTo /
      moveItemBy / commandInsertVertex, so no coordinate write can bypass it. */
  snapLocalPoint(point) {
    if (this.allowFractionalCoordinates) return point;
    const offset = this.app?.annotationDocument?.integerCoordinateOffset ?? 0;
    const roundFunction = offset === 0.5 ? Math.round : Math.floor;
    return { x: roundFunction(point.x), y: roundFunction(point.y) };
  }

  /* ---------- Drawing ---------- */

  draw(context, renderState) {
    const pixelsPerLocalUnit = renderState.pixelsPerLocalUnit;
    const baseAlpha = context.globalAlpha;
    for (const item of this.items) {
      if (item.vertices.length === 0) continue;
      if (item.kind === 'point') this.#drawPoint(context, renderState, item, pixelsPerLocalUnit, baseAlpha);
      else this.#drawPath(context, renderState, item, pixelsPerLocalUnit, baseAlpha);
    }
    context.globalAlpha = baseAlpha;
  }

  #drawPoint(context, renderState, item, pixelsPerLocalUnit, baseAlpha) {
    const radius = POINT_RADIUS_SCREEN_PIXELS / pixelsPerLocalUnit;
    const outlineWidth = POINT_OUTLINE_WIDTH_SCREEN_PIXELS / pixelsPerLocalUnit;
    const labelFontSize = LABEL_FONT_SCREEN_PIXELS / pixelsPerLocalUnit;
    const [x, y] = item.vertices[0];
    // A frame-agnostic item (frame === null) applies to every frame, so it
    // always draws at full strength rather than the dimmed off-frame alpha.
    const onCurrentFrame = item.frame === null || item.frame === renderState.frame;
    const color = colorForItem(item, renderState);

    context.globalAlpha = onCurrentFrame ? baseAlpha : baseAlpha * OFF_FRAME_ALPHA_MULTIPLIER;

    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
    context.lineWidth = outlineWidth;
    context.strokeStyle = POINT_OUTLINE_COLOR;
    context.stroke();

    const isSelected = matchesItem(renderState.selection, this.id, item.id);
    const isHovered = matchesItem(renderState.hover, this.id, item.id);
    if (isSelected) {
      context.beginPath();
      context.arc(x, y, radius + SELECTION_RING_GAP_SCREEN_PIXELS / pixelsPerLocalUnit, 0, Math.PI * 2);
      context.lineWidth = SELECTION_RING_WIDTH_SCREEN_PIXELS / pixelsPerLocalUnit;
      context.strokeStyle = '#ffffff';
      context.stroke();
    } else if (isHovered) {
      context.beginPath();
      context.arc(x, y, radius + SELECTION_RING_GAP_SCREEN_PIXELS / pixelsPerLocalUnit, 0, Math.PI * 2);
      context.lineWidth = HOVER_RING_WIDTH_SCREEN_PIXELS / pixelsPerLocalUnit;
      context.strokeStyle = 'rgba(255, 255, 255, 0.5)';
      context.stroke();
    }

    if (item.name) {
      context.font = `${labelFontSize}px system-ui, sans-serif`;
      context.textAlign = 'left';
      context.textBaseline = 'bottom';
      context.fillStyle = LABEL_COLOR;
      context.fillText(item.name, x + radius, y - radius);
    }
  }

  #drawPath(context, renderState, item, pixelsPerLocalUnit, baseAlpha) {
    const strokeWidth = STROKE_WIDTH_SCREEN_PIXELS / pixelsPerLocalUnit;
    const handleSize = VERTEX_HANDLE_SCREEN_PIXELS / pixelsPerLocalUnit;
    const fontSize = LABEL_FONT_SCREEN_PIXELS / pixelsPerLocalUnit;
    const isCurrentFrame = item.frame === null || item.frame === renderState.frame;
    const frameAlpha = isCurrentFrame ? 1 : OFF_FRAME_ALPHA_MULTIPLIER;
    const color = colorForItem(item, renderState);
    const isSelected = matchesItem(renderState.selection, this.id, item.id);
    const isHovered = matchesItem(renderState.hover, this.id, item.id);

    context.save();
    context.lineJoin = 'round';
    context.lineCap = 'round';

    context.beginPath();
    context.moveTo(item.vertices[0][0], item.vertices[0][1]);
    for (let index = 1; index < item.vertices.length; index++) {
      context.lineTo(item.vertices[index][0], item.vertices[index][1]);
    }
    const closed = isClosedPolyline(item);
    if (closed) context.closePath();

    if (closed) {
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

    // Priority (2): segments. Segment i connects vertex i to i + 1. A closed
    // polyline's closing edge is an ordinary trailing segment here, not a
    // wrap-around special case, since its last vertex already duplicates its
    // first. A point has no segments.
    for (const item of orderedItems) {
      const segmentCount = Math.max(0, item.vertices.length - 1);
      for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex++) {
        const [ax, ay] = item.vertices[segmentIndex];
        const [bx, by] = item.vertices[segmentIndex + 1];
        if (distanceToSegment(localPoint.x, localPoint.y, ax, ay, bx, by) <= tolerance) {
          return { itemId: item.id, part: 'segment', vertexIndex: segmentIndex };
        }
      }
    }

    // Priority (3): closed polyline interiors only.
    for (const item of orderedItems) {
      if (!isClosedPolyline(item)) continue;
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
      const snapped = this.snapLocalPoint({ x: vertex[0] + deltaLocal.x, y: vertex[1] + deltaLocal.y });
      vertex[0] = snapped.x;
      vertex[1] = snapped.y;
    }
  }

  moveVertexTo(itemId, vertexIndex, localPoint) {
    const item = this.getItem(itemId);
    if (!item || !item.vertices[vertexIndex]) return;
    // A closed polyline's last vertex is a literal duplicate of its first;
    // dragging vertex 0 must keep that duplicate in lockstep, or the shape
    // would silently spring open. (The duplicate itself is never draggable —
    // hit-testing always finds vertex 0 first, since they're coincident.)
    const wasClosed = vertexIndex === 0 && isClosedPolyline(item);
    const snapped = this.snapLocalPoint(localPoint);
    item.vertices[vertexIndex] = [snapped.x, snapped.y];
    if (wasClosed) item.vertices[item.vertices.length - 1] = [snapped.x, snapped.y];
  }

  commandInsertVertex(itemId, segmentIndex, localPoint) {
    const item = this.getItem(itemId);
    if (!item) return null;
    const insertIndex = segmentIndex + 1;
    const snapped = this.snapLocalPoint(localPoint);
    const newVertex = [snapped.x, snapped.y];
    return {
      label: 'Insert vertex',
      apply: () => { item.vertices.splice(insertIndex, 0, newVertex); },
      revert: () => { item.vertices.splice(insertIndex, 1); },
    };
  }

  commandDeleteVertex(itemId, vertexIndex) {
    const item = this.getItem(itemId);
    if (!item || !item.vertices[vertexIndex]) return null;
    // A closed polyline needs at least 4 stored vertices (3 distinct corners
    // plus the closing duplicate) to remain a non-degenerate closed shape.
    const minimumVertexCount = item.kind === 'point' ? 1
      : isClosedPolyline(item) ? 4
      : 2;
    // Removing this vertex would leave too few to be a valid item, so delete
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
      label: item.kind === 'point' ? 'Delete point' : 'Delete shape',
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

/** A polyline is closed exactly when its last stored vertex duplicates its
    first — there is no separate boolean or kind for it; a line is never
    closed. */
export function isClosedPolyline(item) {
  if (item.kind !== 'polyline' || item.vertices.length < 2) return false;
  const first = item.vertices[0];
  const last = item.vertices[item.vertices.length - 1];
  return first[0] === last[0] && first[1] === last[1];
}

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
