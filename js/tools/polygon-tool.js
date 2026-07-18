// The polygon tool draws closed polygons; it also exports the shared drawing-
// tool factory that the line tool reuses (both tools have identical placement,
// rubber-band, and finish/cancel behavior; only closing rules differ). See
// ARCHITECTURE.md for the tool contract. Geometry is stored in the target
// layer's local space; the finished shape is committed as one undo command.

import { newId } from '../document.js';

// Screen-constant sizes (world units = screenPixels / pixelsPerLocalUnit).
const CLOSE_DISTANCE_SCREEN_PIXELS = 10;
const DUPLICATE_VERTEX_SCREEN_PIXELS = 4;
const OVERLAY_STROKE_SCREEN_PIXELS = 2;
const OVERLAY_VERTEX_SCREEN_PIXELS = 5;

const DRAWING_FALLBACK_COLOR = '#4f9cf9';
const CLOSING_CUE_COLOR = '#ffffff';

function activeClassColor(app) {
  const classEntry = app.annotationDocument.classes.find((entry) => entry.id === app.activeClassId);
  return classEntry?.color ?? DRAWING_FALLBACK_COLOR;
}

/** Distance between two world points expressed in on-screen pixels. */
function distanceInScreenPixels(app, worldA, worldB) {
  return Math.hypot(worldA.x - worldB.x, worldA.y - worldB.y) * app.viewer.viewTransform.scale;
}

/**
 * Build a click-to-place drawing tool. Both the polygon and line tools are made
 * this way; each returned tool keeps its own private in-progress state in this
 * closure, so switching between the two tools never crosses their state.
 */
export function createDrawingTool({
  id, name, hotkey, kind, commandLabel, minimumVertexCount, canClickToClose,
}) {
  // In-progress shape, or null: { app, layer, frame, vertices: [[x, y], ...],
  // pointerWorld }. Vertices live in the target layer's local space.
  let inProgress = null;

  function worldVertexAt(index) {
    const [x, y] = inProgress.vertices[index];
    return inProgress.app.worldFromLocal(inProgress.layer, { x, y });
  }

  function cancel(app) {
    inProgress = null;
    app.viewer.requestRender();
  }

  function finish(app) {
    if (!inProgress || inProgress.vertices.length < minimumVertexCount) return false;
    const layer = inProgress.layer;
    const items = layer.items;
    const item = {
      id: newId(),
      frame: inProgress.frame,
      kind,
      vertices: inProgress.vertices.map((vertex) => [vertex[0], vertex[1]]),
      classId: app.activeClassId ?? null,
      name: null,
    };
    inProgress = null;
    app.undoHistory.execute({
      label: commandLabel,
      apply: () => { items.push(item); },
      revert: () => {
        const index = items.indexOf(item);
        if (index !== -1) items.splice(index, 1);
      },
    });
    app.setSelection({ layerId: layer.id, itemId: item.id, vertexIndex: null });
    app.viewer.requestRender();
    return true;
  }

  return {
    id, name, hotkey, cursor: 'crosshair',

    activate(app) {}, // eslint-disable-line no-unused-vars

    deactivate(app) {
      if (inProgress) cancel(app);
    },

    onPointerDown(app, worldPoint, event) { // eslint-disable-line no-unused-vars
      if (!inProgress) {
        // Start a new shape on the shapes target layer, at the current frame,
        // storing the vertex in that layer's local space.
        const layer = app.targetLayerForType('shapes');
        const localPoint = app.localFromWorld(layer, worldPoint);
        inProgress = {
          app,
          layer,
          frame: app.currentFrame,
          vertices: [[localPoint.x, localPoint.y]],
          pointerWorld: worldPoint,
        };
        app.viewer.requestRender();
        return;
      }
      if (canClickToClose
          && distanceInScreenPixels(app, worldVertexAt(0), worldPoint) <= CLOSE_DISTANCE_SCREEN_PIXELS) {
        // Clicking the first vertex closes the polygon when it is large enough;
        // otherwise ignore the click rather than stack a duplicate vertex.
        if (inProgress.vertices.length >= minimumVertexCount) finish(app);
        return;
      }
      const localPoint = app.localFromWorld(inProgress.layer, worldPoint);
      inProgress.vertices.push([localPoint.x, localPoint.y]);
      app.viewer.requestRender();
    },

    onPointerMove(app, worldPoint, event) { // eslint-disable-line no-unused-vars
      if (!inProgress) return;
      inProgress.pointerWorld = worldPoint;
      app.viewer.requestRender();
    },

    onPointerUp(app, worldPoint, event) {}, // eslint-disable-line no-unused-vars

    onDoubleClick(app, worldPoint, event) { // eslint-disable-line no-unused-vars
      if (!inProgress) return;
      // A double-click arrives after two pointer-downs, so the second press has
      // already appended a near-coincident duplicate vertex; drop it.
      const vertices = inProgress.vertices;
      if (vertices.length >= 2
          && distanceInScreenPixels(app, worldVertexAt(vertices.length - 1), worldVertexAt(vertices.length - 2))
             <= DUPLICATE_VERTEX_SCREEN_PIXELS) {
        vertices.pop();
      }
      finish(app);
    },

    onKeyDown(app, event) {
      if (!inProgress) return false;
      if (event.key === 'Escape') { cancel(app); return true; }
      if (event.key === 'Enter') { finish(app); return true; }
      if (event.key === 'Backspace') {
        inProgress.vertices.pop();
        if (inProgress.vertices.length === 0) cancel(app);
        else app.viewer.requestRender();
        return true;
      }
      return false;
    },

    drawOverlay(context, renderState) {
      if (!inProgress) return;
      const app = inProgress.app;
      const pixelsPerLocalUnit = renderState.pixelsPerLocalUnit;
      const strokeWidth = OVERLAY_STROKE_SCREEN_PIXELS / pixelsPerLocalUnit;
      const vertexSize = OVERLAY_VERTEX_SCREEN_PIXELS / pixelsPerLocalUnit;
      const color = activeClassColor(app);
      const worldVertices = inProgress.vertices.map(
        (vertex) => app.worldFromLocal(inProgress.layer, { x: vertex[0], y: vertex[1] }));

      context.save();
      context.lineWidth = strokeWidth;
      context.strokeStyle = color;
      context.lineJoin = 'round';
      context.lineCap = 'round';

      // The already-placed polyline.
      if (worldVertices.length > 1) {
        context.beginPath();
        context.moveTo(worldVertices[0].x, worldVertices[0].y);
        for (let index = 1; index < worldVertices.length; index++) {
          context.lineTo(worldVertices[index].x, worldVertices[index].y);
        }
        context.stroke();
      }

      // The rubber-band segment from the last vertex to the pointer.
      const pointer = inProgress.pointerWorld;
      if (pointer && worldVertices.length > 0) {
        const last = worldVertices[worldVertices.length - 1];
        context.save();
        context.setLineDash([strokeWidth * 3, strokeWidth * 3]);
        context.beginPath();
        context.moveTo(last.x, last.y);
        context.lineTo(pointer.x, pointer.y);
        context.stroke();
        context.restore();
      }

      // Vertex markers.
      context.fillStyle = color;
      for (const worldVertex of worldVertices) {
        context.beginPath();
        context.arc(worldVertex.x, worldVertex.y, vertexSize / 2, 0, Math.PI * 2);
        context.fill();
      }

      // Closing cue: ring the first vertex when the pointer is close enough to
      // close a large-enough polygon.
      if (canClickToClose && pointer && worldVertices.length >= minimumVertexCount
          && distanceInScreenPixels(app, worldVertices[0], pointer) <= CLOSE_DISTANCE_SCREEN_PIXELS) {
        context.beginPath();
        context.arc(worldVertices[0].x, worldVertices[0].y, vertexSize, 0, Math.PI * 2);
        context.strokeStyle = CLOSING_CUE_COLOR;
        context.lineWidth = strokeWidth;
        context.stroke();
      }

      context.restore();
    },
  };
}

export const polygonTool = createDrawingTool({
  id: 'polygon',
  name: 'Draw polygons',
  hotkey: 'g',
  kind: 'polygon',
  commandLabel: 'Add polygon',
  minimumVertexCount: 3,
  canClickToClose: true,
});
