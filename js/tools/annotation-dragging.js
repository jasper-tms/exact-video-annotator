// Shared "grab what's already there" behavior for the point, line, and polygon
// tools — there is no separate select tool; each drawing tool selects, drags,
// and edits annotations of its own kind. Pressing an existing item selects it,
// dragging moves the whole item or the grabbed vertex, and hovering highlights
// what a press would grab. Drags mutate geometry live for preview (bypassing
// undo on purpose) and are committed as one undo command, built from
// before/after snapshots, on pointer up. It is generic over every annotation
// layer through the editing contract in ARCHITECTURE.md (hitTest +
// snapshot/restore + moveItemBy/moveVertexTo).

// The in-progress drag, or null: { layer, itemId, part, vertexIndex,
// lastLocalPoint, beforeSnapshot, moved }. Only one drag can exist at a time
// across all tools, so module-level state is safe.
let dragState = null;

/** Hit-test one annotation layer at a world-space point. */
export function hitTestLayer(app, layer, worldPoint) {
  const localPoint = app.localFromWorld(layer, worldPoint);
  return layer.hitTest(localPoint, {
    frame: app.currentFrame,
    pixelsPerLocalUnit: app.viewer.stageTransformForLayer(layer).scale,
    document: app.annotationDocument,
  });
}

/** Select the hit item and arm a drag on it (vertex drags move that vertex;
    body/segment drags translate the whole item). */
export function beginDragOnExistingItem(app, layer, hitResult, worldPoint) {
  app.setSelection({
    layerId: layer.id,
    itemId: hitResult.itemId,
    vertexIndex: hitResult.part === 'vertex' ? hitResult.vertexIndex : null,
  });
  dragState = {
    layer,
    itemId: hitResult.itemId,
    part: hitResult.part,
    vertexIndex: hitResult.vertexIndex,
    lastLocalPoint: app.localFromWorld(layer, worldPoint),
    beforeSnapshot: layer.snapshotItemGeometry(hitResult.itemId),
    moved: false,
  };
}

/** Advance an armed drag. Returns true when a drag consumed this move. */
export function updateDragOnExistingItem(app, worldPoint) {
  if (!dragState) return false;
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
  return true;
}

/** Finish an armed drag, committing it as one undo command if it actually
    moved. Returns true when a drag consumed this pointer-up. */
export function endDragOnExistingItem(app) {
  if (!dragState) return false;
  if (dragState.moved) {
    const { layer, itemId, beforeSnapshot } = dragState;
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

/** Drop any armed drag without committing (tool deactivation). */
export function cancelDragOnExistingItem() {
  dragState = null;
}

/**
 * Update app.hover from a hit-test of the given layer (skipped when the layer
 * is missing or hidden). itemFilter, when given, restricts hover to matching
 * items (the line/polygon tools only grab shapes of their own kind). Returns
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
