// The select tool: click to select, drag to move items or vertices,
// double-click a segment to insert a vertex, Delete to remove. It is generic
// over every annotation layer through the editing contract in ARCHITECTURE.md
// (hitTest + snapshot/restore + moveItemBy/moveVertexTo + command methods).
// Drags mutate geometry live for preview and are committed as one undo
// command, built from before/after snapshots, on pointer up.

let dragState = null;

function topmostHit(app, worldPoint) {
  const layers = app.viewer.layers;
  for (let index = layers.length - 1; index >= 0; index--) {
    const layer = layers[index];
    if (!layer.isEditable || !layer.visible) continue;
    const localPoint = app.localFromWorld(layer, worldPoint);
    const renderState = {
      frame: app.currentFrame,
      pixelsPerLocalUnit: app.viewer.stageTransformForLayer(layer).scale,
      document: app.annotationDocument,
    };
    const result = layer.hitTest(localPoint, renderState);
    if (result) return { layer, result };
  }
  return null;
}

function commitDragAsCommand(app) {
  const { layer, itemId, beforeSnapshot } = dragState;
  const afterSnapshot = layer.snapshotItemGeometry(itemId);
  app.undoHistory.execute({
    label: 'Move',
    apply: () => layer.restoreItemGeometry(itemId, afterSnapshot),
    revert: () => layer.restoreItemGeometry(itemId, beforeSnapshot),
  });
}

export const selectTool = {
  id: 'select',
  name: 'Select',
  hotkey: 'v',
  cursor: 'default',

  activate(app) {},
  deactivate(app) {
    dragState = null;
    app.hover = null;
  },

  onPointerDown(app, worldPoint, event) {
    const hit = topmostHit(app, worldPoint);
    if (!hit) {
      app.setSelection(null);
      // Empty space: let this drag pan the view.
      app.viewer.beginPanFromPointerEvent(event);
      return;
    }
    const { layer, result } = hit;
    app.setSelection({
      layerId: layer.id,
      itemId: result.itemId,
      vertexIndex: result.part === 'vertex' ? result.vertexIndex : null,
    });
    dragState = {
      layer,
      itemId: result.itemId,
      part: result.part,
      vertexIndex: result.vertexIndex,
      lastLocalPoint: app.localFromWorld(layer, worldPoint),
      beforeSnapshot: layer.snapshotItemGeometry(result.itemId),
      moved: false,
    };
  },

  onPointerMove(app, worldPoint, event) {
    if (dragState) {
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
      return;
    }
    const hit = topmostHit(app, worldPoint);
    const newHover = hit
      ? { layerId: hit.layer.id, itemId: hit.result.itemId,
          vertexIndex: hit.result.part === 'vertex' ? hit.result.vertexIndex : null }
      : null;
    if (JSON.stringify(newHover) !== JSON.stringify(app.hover)) {
      app.hover = newHover;
      app.viewer.requestRender();
    }
    app.viewer.stageCanvas.style.cursor = hit
      ? (hit.result.part === 'vertex' ? 'move' : 'pointer')
      : 'default';
  },

  onPointerUp(app, worldPoint, event) {
    if (dragState?.moved) commitDragAsCommand(app);
    dragState = null;
  },

  onDoubleClick(app, worldPoint, event) {
    const hit = topmostHit(app, worldPoint);
    if (!hit || hit.result.part !== 'segment') return;
    const { layer, result } = hit;
    const localPoint = app.localFromWorld(layer, worldPoint);
    const command = layer.commandInsertVertex?.(result.itemId, result.vertexIndex, localPoint);
    if (!command) return;
    app.undoHistory.execute(command);
    // The inserted vertex sits after the segment's first vertex.
    app.setSelection({ layerId: layer.id, itemId: result.itemId, vertexIndex: result.vertexIndex + 1 });
  },

  onKeyDown(app, event) {
    if (event.key === 'Escape') {
      if (app.selection) { app.setSelection(null); return true; }
      return false;
    }
    if (event.key !== 'Delete' && event.key !== 'Backspace') return false;
    const selection = app.selection;
    if (!selection) return false;
    const layer = app.viewer.layers.find((candidate) => candidate.id === selection.layerId);
    if (!layer?.isEditable) return false;
    const command = (selection.vertexIndex !== null && layer.commandDeleteVertex)
      ? layer.commandDeleteVertex(selection.itemId, selection.vertexIndex)
      : layer.commandDeleteItem(selection.itemId);
    if (!command) return false;
    app.setSelection(null);
    app.undoHistory.execute(command);
    return true;
  },

  drawOverlay(context, renderState) {},
};
