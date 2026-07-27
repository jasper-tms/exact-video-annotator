// The point tool: double-click empty space (or an annotation of a different
// kind) to place a new point annotation, committed as one undoable "Add
// point" command. A single click there instead arms a potential pan, so
// dragging on empty space always pans the view. Pressing an existing point
// selects it, and dragging it moves it — the shared behavior in
// annotation-dragging.js — so there is no separate select tool. A
// double-click on an existing point does nothing; it was already selected by
// the two preceding pointer-downs.

import { newId } from '../document.js';
import {
  hitTestLayer, beginDragOnExistingItem, updateDragOnExistingItem,
  endDragOnExistingItem, cancelDragOnExistingItem, updateHover, clearHover,
} from './annotation-dragging.js';

export const pointTool = {
  id: 'point',
  name: 'Add points',
  hotkey: 'o',
  cursor: 'crosshair',

  activate(app) {},
  deactivate(app) {
    cancelDragOnExistingItem();
    clearHover(app);
  },

  onPointerDown(app, worldPoint, event) {
    const layer = app.targetLayerForType('coordinates');
    // Pressing an existing point selects it, and dragging then moves it.
    // Placing a new point takes a double-click, so a press anywhere else
    // just arms a potential pan.
    const hit = layer.visible ? hitTestLayer(app, layer, worldPoint) : null;
    if (hit) {
      beginDragOnExistingItem(app, layer, hit, worldPoint);
      app.viewer.requestRender();
      return;
    }
    app.viewer.beginPanFromPointerEvent(event);
  },

  onPointerMove(app, worldPoint, event) {
    if (updateDragOnExistingItem(app, worldPoint)) return;
    const layer = app.findAnnotationLayerForType('coordinates');
    const hit = updateHover(app, layer, worldPoint);
    app.viewer.stageCanvas.style.cursor = hit ? 'move' : this.cursor;
  },

  onPointerUp(app, worldPoint, event) {
    endDragOnExistingItem(app);
  },

  onDoubleClick(app, worldPoint, event) {
    const layer = app.targetLayerForType('coordinates');
    const hit = layer.visible ? hitTestLayer(app, layer, worldPoint) : null;
    if (hit && layer.getItem(hit.itemId)?.kind === 'point') return;

    const localPoint = layer.snapLocalPoint(app.localFromWorld(layer, worldPoint));
    const newItem = {
      id: newId(),
      frame: app.newItemFrame,
      kind: 'point',
      vertices: [[localPoint.x, localPoint.y]],
      classId: app.activeClassId,
      name: null,
    };
    app.undoHistory.execute({
      label: 'Add point',
      apply: () => { layer.items.push(newItem); },
      revert: () => {
        const index = layer.items.indexOf(newItem);
        if (index !== -1) layer.items.splice(index, 1);
      },
    });
    app.setSelection({ layerId: layer.id, itemId: newItem.id, vertexIndex: null });
  },
};
