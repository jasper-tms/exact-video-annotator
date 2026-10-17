// Shared "grab what's already there" behavior for the pan, point, line, and
// polyline tools — there is no separate select tool; each of them selects,
// drags, and edits existing annotations. Pressing an existing item selects it,
// dragging moves the whole item or the grabbed vertex, and hovering highlights
// what a press would grab. A press that newly selects an item only starts
// moving it once it has been held for UNSELECTED_ITEM_DRAG_HOLD_MILLISECONDS,
// so a quick click that wobbles slightly can't nudge an annotation by
// accident; an already-selected item moves at once. Drags mutate geometry live for preview (bypassing
// undo on purpose) and are committed as one undo command, built from
// before/after snapshots, on pointer up. It is generic over every annotation
// layer through the editing contract in ARCHITECTURE.md (hitTest +
// snapshot/restore + moveItemBy/moveVertexTo).

import { isClosedPolyline } from '../layers/coordinates-layer.js';

// How long a press that newly selects an item must be held before dragging
// moves it. Pointer moves before then are remembered but not applied; once the
// hold is long enough the item catches up to wherever the pointer is.
const UNSELECTED_ITEM_DRAG_HOLD_MILLISECONDS = 300;

// The in-progress drag, or null: { layer, itemId, part, vertexIndex,
// lastLocalPoint, beforeSnapshot, moved, unlockTimeoutId, pendingWorldPoint }.
// unlockTimeoutId is non-null while the hold that unlocks moving is still
// running; pendingWorldPoint is the latest pointer position seen during that
// hold, or null. Only one drag can exist at a time across all tools, so
// module-level state is safe.
let dragState = null;

/** Hit-test one annotation layer at a world-space point. */
export function hitTestLayer(app, layer, worldPoint) {
  const localPoint = app.localFromWorld(layer, worldPoint);
  const { scaleX, scaleY, offsetX, offsetY } = app.viewer.stageTransformForLayer(layer);
  return layer.hitTest(localPoint, {
    frame: app.currentFrame,
    pixelsPerLocalUnit: Math.min(scaleX, scaleY),
    stageFromLocal: (point) => ({ x: point.x * scaleX + offsetX, y: point.y * scaleY + offsetY }),
    document: app.annotationDocument,
  });
}

// Selecting with the s key only picks a vertex this many times closer to the
// cursor than every other vertex, so a press between two candidates
// deselects instead of guessing.
const SELECT_NEAREST_DISTANCE_RATIO = 0.5;
// ...and only one at most this far from the cursor, in screen pixels (so the
// reach is the same at every zoom), so whatever gets selected is close enough
// to the cursor for the eye to catch it.
const SELECT_NEAREST_MAXIMUM_SCREEN_PIXELS = 60;

/**
 * Select the vertex nearest to worldPoint, as clicking it would, or deselect
 * when none is clearly nearest: it must be within
 * SELECT_NEAREST_MAXIMUM_SCREEN_PIXELS of the cursor and less than half as far
 * as the next-nearest vertex. The current frame's items (and frame-agnostic
 * ones) are searched first; only when none of their vertices is within range
 * are other frames' visible items searched the same way, so the faint copies
 * of a point labeled on neighboring frames never make the current frame's own
 * point ambiguous. Items at zero opacity are never candidates. Distances are
 * measured on screen, and vertices outside the visible canvas are ignored
 * entirely, so they can neither be picked nor make a visible one ambiguous.
 * Returns true if something was selected.
 */
export function selectNearestVertex(app, layer, worldPoint) {
  const isOnCurrentFrame = (item) => item.frame === null || item.frame === app.currentFrame;
  let candidate = nearestVertexAmong(app, layer, worldPoint, isOnCurrentFrame);
  if (!candidate || candidate.distance > SELECT_NEAREST_MAXIMUM_SCREEN_PIXELS) {
    candidate = nearestVertexAmong(app, layer, worldPoint, (item) => !isOnCurrentFrame(item));
  }
  if (!candidate
      || candidate.distance > SELECT_NEAREST_MAXIMUM_SCREEN_PIXELS
      || candidate.distance >= SELECT_NEAREST_DISTANCE_RATIO * candidate.secondNearestDistance) {
    app.setSelection(null);
    return false;
  }
  app.setSelection({ layerId: layer.id, itemId: candidate.itemId, vertexIndex: candidate.vertexIndex });
  return true;
}

/** The on-canvas vertex nearest worldPoint, in screen pixels, among the
    layer's shown items that pass itemFilter: { itemId, vertexIndex, distance,
    secondNearestDistance }, or null when there is none. A closed polyline's
    closing duplicate of vertex 0 is skipped, or the two would always tie. */
function nearestVertexAmong(app, layer, worldPoint, itemFilter) {
  const { scaleX, scaleY, offsetX, offsetY } = app.viewer.stageTransformForLayer(layer);
  const { width: stageWidth, height: stageHeight } = app.viewer.stageCanvas.getBoundingClientRect();
  const localPoint = app.localFromWorld(layer, worldPoint);
  const cursorX = localPoint.x * scaleX + offsetX;
  const cursorY = localPoint.y * scaleY + offsetY;
  let nearest = null;
  for (const item of layer.items) {
    if (!itemFilter(item) || !layer.isItemShown(item, app.currentFrame)) continue;
    const vertexCount = isClosedPolyline(item) ? item.vertices.length - 1 : item.vertices.length;
    for (let index = 0; index < vertexCount; index++) {
      const stageX = item.vertices[index][0] * scaleX + offsetX;
      const stageY = item.vertices[index][1] * scaleY + offsetY;
      if (stageX < 0 || stageX > stageWidth || stageY < 0 || stageY > stageHeight) continue;
      const distance = Math.hypot(stageX - cursorX, stageY - cursorY);
      if (!nearest || distance < nearest.distance) {
        nearest = { itemId: item.id, vertexIndex: index, distance,
                    secondNearestDistance: nearest ? nearest.distance : Infinity };
      } else if (distance < nearest.secondNearestDistance) {
        nearest.secondNearestDistance = distance;
      }
    }
  }
  return nearest;
}

/** Select the hit item and arm a drag on it (vertex drags move that vertex;
    body/segment drags translate the whole item). If this press newly selects
    the item, the drag only starts moving it once the press has been held for
    UNSELECTED_ITEM_DRAG_HOLD_MILLISECONDS. */
export function beginDragOnExistingItem(app, layer, hitResult, worldPoint) {
  const wasAlreadySelected = app.selection?.layerId === layer.id
    && app.selection?.itemId === hitResult.itemId;
  app.setSelection({
    layerId: layer.id,
    itemId: hitResult.itemId,
    vertexIndex: hitResult.part === 'vertex' ? hitResult.vertexIndex : null,
  });
  const newDragState = {
    layer,
    itemId: hitResult.itemId,
    part: hitResult.part,
    vertexIndex: hitResult.vertexIndex,
    lastLocalPoint: app.localFromWorld(layer, worldPoint),
    beforeSnapshot: layer.snapshotItemGeometry(hitResult.itemId),
    moved: false,
    unlockTimeoutId: null,
    pendingWorldPoint: null,
  };
  if (!wasAlreadySelected) {
    newDragState.unlockTimeoutId = setTimeout(() => {
      newDragState.unlockTimeoutId = null;
      if (dragState !== newDragState || !newDragState.pendingWorldPoint) return;
      moveDraggedItemTo(app, newDragState.pendingWorldPoint);
      newDragState.pendingWorldPoint = null;
    }, UNSELECTED_ITEM_DRAG_HOLD_MILLISECONDS);
  }
  dragState = newDragState;
}

/** Advance an armed drag. Returns true when a drag consumed this move (which
    includes a move held back because the hold hasn't unlocked moving yet). */
export function updateDragOnExistingItem(app, worldPoint) {
  if (!dragState) return false;
  if (dragState.unlockTimeoutId !== null) {
    dragState.pendingWorldPoint = worldPoint;
    return true;
  }
  moveDraggedItemTo(app, worldPoint);
  return true;
}

/** Move the dragged vertex, or translate the dragged item, to follow the
    pointer to worldPoint. */
function moveDraggedItemTo(app, worldPoint) {
  const { layer, itemId, part, vertexIndex } = dragState;
  const localPoint = app.localFromWorld(layer, worldPoint);
  if (part === 'vertex') {
    layer.moveVertexTo(itemId, vertexIndex, localPoint);
  } else {
    layer.moveItemBy(itemId, {
      x: localPoint.x - dragState.lastLocalPoint.x,
      y: localPoint.y - dragState.lastLocalPoint.y,
    });
  }
  dragState.lastLocalPoint = localPoint;
  dragState.moved = true;
  app.viewer.requestRender();
}

/** Finish an armed drag, committing it as one undo command if it actually
    moved. Returns true when a drag consumed this pointer-up. */
export function endDragOnExistingItem(app) {
  if (!dragState) return false;
  clearTimeout(dragState.unlockTimeoutId);
  if (dragState.moved) {
    const { layer, itemId, beforeSnapshot } = dragState;
    // A plugin layer may adjust what was dropped (the line fitter re-snaps it
    // onto the edge). It runs before the after-snapshot, so the drag and the
    // adjustment undo together as the one move they look like.
    layer.afterItemDragged?.(app, itemId);
    const afterSnapshot = layer.snapshotItemGeometry(itemId);
    app.undoHistory.execute({
      label: 'Move',
      apply: () => layer.restoreItemGeometry(itemId, afterSnapshot),
      revert: () => layer.restoreItemGeometry(itemId, beforeSnapshot),
    });
  }
  dragState = null;
  return true;
}

/** Drop any armed drag without committing (tool deactivation, or a second
    finger turning the gesture into a pinch), putting a moved item back where
    the drag found it. */
export function cancelDragOnExistingItem() {
  clearTimeout(dragState?.unlockTimeoutId);
  if (dragState?.moved) {
    dragState.layer.restoreItemGeometry(dragState.itemId, dragState.beforeSnapshot);
  }
  dragState = null;
}

/**
 * Update app.hover from a hit-test of the given layer (skipped when the layer
 * is missing or hidden). itemFilter, when given, restricts hover to matching
 * items (the line/polyline tools only grab shapes of their own kind). Returns
 * the accepted hit, or null.
 */
export function updateHover(app, layer, worldPoint, itemFilter = null) {
  let hit = null;
  if (layer && layer.visible) {
    hit = hitTestLayer(app, layer, worldPoint);
    if (hit && itemFilter && !itemFilter(layer.getItem(hit.itemId))) hit = null;
  }
  const newHover = hit
    ? { layerId: layer.id, itemId: hit.itemId,
        vertexIndex: hit.part === 'vertex' ? hit.vertexIndex : null }
    : null;
  if (JSON.stringify(newHover) !== JSON.stringify(app.hover)) {
    app.hover = newHover;
    app.viewer.requestRender();
  }
  return hit;
}

export function clearHover(app) {
  if (!app.hover) return;
  app.hover = null;
  app.viewer.requestRender();
}
