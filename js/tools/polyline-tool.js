// The polyline tool draws an open or closed multi-segment shape; it also
// exports the shared drawing-tool factory that the line tool reuses (both
// tools have identical placement, rubber-band, and finish/cancel behavior;
// only closing rules and vertex-count limits differ). See ARCHITECTURE.md for
// the tool contract. Geometry is stored in the target layer's local space; the
// finished shape is committed as one undo command. Each tool also edits
// existing shapes of its own kind (select, drag-move, double-click a segment
// to insert a vertex) via annotation-dragging.js — there is no separate select
// tool.
//
// A polyline is open or closed purely by data: closed means its last stored
// vertex is a literal duplicate of its first (see coordinates-layer.js's
// `isClosedPolyline`) — there is no separate kind or flag for it. Clicking
// back on the first vertex is the only thing that appends that duplicate and
// closes the shape; finishing any other way (Enter, double-click, or running
// out of the tool's maximum vertex count) always leaves it open.
//
// Starting a brand-new shape takes a double-click on empty space (or on an
// annotation of a different kind); a single click there instead arms a
// potential pan, so dragging on empty space always pans the view. Once a
// shape is in progress, each further single click places the next vertex —
// unless that press turns into a drag, which pans instead of dropping a
// point.

import { newId } from '../document.js';
import {
  hitTestLayer, beginDragOnExistingItem, updateDragOnExistingItem,
  endDragOnExistingItem, cancelDragOnExistingItem, updateHover, clearHover,
} from './annotation-dragging.js';

// Screen-constant sizes (world units = screenPixels / pixelsPerLocalUnit).
const CLOSE_DISTANCE_SCREEN_PIXELS = 10;
const DUPLICATE_VERTEX_SCREEN_PIXELS = 4;
const OVERLAY_STROKE_SCREEN_PIXELS = 2;
const OVERLAY_VERTEX_SCREEN_PIXELS = 5;
// How far a press has to move before it's treated as a pan instead of a
// click placing the next vertex.
const DRAG_THRESHOLD_SCREEN_PIXELS = 4;
// Closing a shape (clicking back on its first vertex) needs enough vertices
// that the result is an actual shape rather than a point re-clicked on
// itself — independent of minimumVertexCount, which only guards finishing
// open.
const MINIMUM_VERTICES_TO_CLOSE = 3;

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
 * Build a click-to-place drawing tool. Both the polyline and line tools are made
 * this way; each returned tool keeps its own private in-progress state in this
 * closure, so switching between the two tools never crosses their state.
 */
export function createDrawingTool({
  id, name, hotkey, kind, commandLabel, minimumVertexCount, maximumVertexCount, canClickToClose,
}) {
  // In-progress shape, or null: { app, layer, frame, vertices: [[x, y], ...],
  // pointerWorld }. Vertices live in the target layer's local space.
  let inProgress = null;
  // A press on empty space while a shape is in progress, not yet resolved as
  // a click (place the next vertex on release) or a drag (pan instead):
  // { downClientX, downClientY }, or null.
  let pendingVertexPress = null;

  function worldVertexAt(index) {
    const [x, y] = inProgress.vertices[index];
    return inProgress.app.worldFromLocal(inProgress.layer, { x, y });
  }

  function cancel(app) {
    inProgress = null;
    pendingVertexPress = null;
    app.viewer.requestRender();
  }

  /** Append the next vertex to the in-progress shape, at pointer release. */
  function commitInProgressVertex(app, worldPoint) {
    const layer = inProgress.layer;
    const localPoint = layer.snapLocalPoint(app.localFromWorld(layer, worldPoint));
    inProgress.vertices.push([localPoint.x, localPoint.y]);
    // On a plugin layer, dropping a vertex can move the geometry (the line
    // fitter snaps the segment just completed onto the edge under it).
    layer.afterVertexPlaced?.(app, inProgress.vertices, kind);
    // The line tool caps at two vertices — a line is always a single segment,
    // finished the moment its second point is down.
    if (maximumVertexCount && inProgress.vertices.length >= maximumVertexCount) {
      finish(app);
      return;
    }
    if (layer.shouldFinishAfterVertex?.(inProgress.vertices, kind)) {
      finish(app);
      return;
    }
    app.viewer.requestRender();
  }

  function finish(app) {
    if (!inProgress || inProgress.vertices.length < minimumVertexCount) return false;
    const layer = inProgress.layer;
    // Plugin layers get the last word on the geometry before it is committed
    // (the line fitter fits a closed polyline's closing segment here).
    layer.beforeShapeCommitted?.(app, inProgress.vertices, kind);
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
      pendingVertexPress = null;
      cancelDragOnExistingItem();
      clearHover(app);
    },

    onPointerDown(app, worldPoint, event) { // eslint-disable-line no-unused-vars
      if (!inProgress) {
        const layer = app.targetLayerForType('coordinates');
        // Pressing an existing shape of this same kind selects it, and
        // dragging then moves the grabbed vertex or the whole shape.
        // Starting a new shape takes a double-click, so a press anywhere else
        // just arms a potential pan.
        const hit = layer.visible ? hitTestLayer(app, layer, worldPoint) : null;
        if (hit && layer.getItem(hit.itemId)?.kind === kind) {
          beginDragOnExistingItem(app, layer, hit, worldPoint);
          app.viewer.requestRender();
          return;
        }
        app.viewer.beginPanFromPointerEvent(event);
        return;
      }
      if (canClickToClose
          && distanceInScreenPixels(app, worldVertexAt(0), worldPoint) <= CLOSE_DISTANCE_SCREEN_PIXELS) {
        // Clicking the first vertex closes the shape when it is large enough
        // to be one; otherwise ignore the click rather than stack a duplicate
        // vertex. Closing means literally duplicating the first vertex onto
        // the end of the array — that duplication is the only thing that
        // makes a shape read as closed anywhere else in the app.
        if (inProgress.vertices.length >= MINIMUM_VERTICES_TO_CLOSE) {
          const first = inProgress.vertices[0];
          inProgress.vertices.push([first[0], first[1]]);
          finish(app);
        }
        return;
      }
      // Defer placing the vertex until release, so a drag from here can pan
      // instead of dropping a point.
      pendingVertexPress = { downClientX: event.clientX, downClientY: event.clientY };
    },

    onPointerMove(app, worldPoint, event) { // eslint-disable-line no-unused-vars
      if (updateDragOnExistingItem(app, worldPoint)) return;
      if (pendingVertexPress) {
        const deltaX = event.clientX - pendingVertexPress.downClientX;
        const deltaY = event.clientY - pendingVertexPress.downClientY;
        if (Math.hypot(deltaX, deltaY) > DRAG_THRESHOLD_SCREEN_PIXELS) {
          pendingVertexPress = null;
          app.viewer.beginPanFromPointerEvent(event);
        }
        return;
      }
      if (inProgress) {
        inProgress.pointerWorld = worldPoint;
        app.viewer.requestRender();
        return;
      }
      const layer = app.findAnnotationLayerForType('coordinates');
      const hit = updateHover(app, layer, worldPoint, (item) => item?.kind === kind);
      app.viewer.stageCanvas.style.cursor = hit ? 'move' : this.cursor;
    },

    onPointerUp(app, worldPoint, event) { // eslint-disable-line no-unused-vars
      if (endDragOnExistingItem(app)) return;
      if (pendingVertexPress) {
        pendingVertexPress = null;
        if (inProgress) commitInProgressVertex(app, worldPoint);
      }
    },

    onDoubleClick(app, worldPoint, event) { // eslint-disable-line no-unused-vars
      if (!inProgress) {
        const layer = app.findAnnotationLayerForType('coordinates');
        const hit = layer?.visible ? hitTestLayer(app, layer, worldPoint) : null;
        if (hit && layer.getItem(hit.itemId)?.kind === kind) {
          // Same-kind hit: double-clicking a segment inserts a vertex there;
          // double-clicking a vertex or the body does nothing (it was already
          // selected by the two preceding pointer-downs).
          if (hit.part !== 'segment') return;
          const command = layer.commandInsertVertex?.(
            hit.itemId, hit.vertexIndex, app.localFromWorld(layer, worldPoint));
          if (!command) return;
          app.undoHistory.execute(command);
          // The inserted vertex sits after the segment's first vertex.
          app.setSelection({ layerId: layer.id, itemId: hit.itemId, vertexIndex: hit.vertexIndex + 1 });
          return;
        }
        // Empty space, or an annotation of a different kind: start a new
        // shape here, on the shapes target layer at the current frame,
        // storing the vertex in that layer's local space.
        const targetLayer = app.targetLayerForType('coordinates');
        const localPoint = targetLayer.snapLocalPoint(app.localFromWorld(targetLayer, worldPoint));
        inProgress = {
          app,
          layer: targetLayer,
          frame: app.newItemFrame,
          vertices: [[localPoint.x, localPoint.y]],
          pointerWorld: worldPoint,
        };
        app.viewer.requestRender();
        return;
      }
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
      // close a large-enough shape.
      if (canClickToClose && pointer && worldVertices.length >= MINIMUM_VERTICES_TO_CLOSE
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

export const polylineTool = createDrawingTool({
  id: 'polyline',
  name: 'Draw polylines',
  hotkey: 'g',
  kind: 'polyline',
  commandLabel: 'Add polyline',
  minimumVertexCount: 2,
  canClickToClose: true,
});
