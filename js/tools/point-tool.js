// The point tool: double-click empty space (or an annotation of a different
// kind) to place a new point annotation, committed as one undoable "Add
// point" command. A single click there instead deselects (or, if it turns
// into a drag, pans the view instead). Pressing an existing annotation of ANY
// kind selects it, and dragging then moves it — the shared behavior in
// annotation-dragging.js, unfiltered by kind, so there is no separate select
// tool and no tool is blind to another kind's annotations. A double-click on
// an existing point does nothing; it was already selected by the two
// preceding pointer-downs.

import { newId } from '../document.js';
import {
  hitTestLayer, beginDragOnExistingItem, updateDragOnExistingItem,
  endDragOnExistingItem, cancelDragOnExistingItem, updateHover, clearHover,
} from './annotation-dragging.js';

// How far a press on empty space has to move before it's treated as a pan
// instead of a click that deselects.
const DRAG_THRESHOLD_SCREEN_PIXELS = 4;

// A press on empty space, not yet resolved as a click (deselect on release)
// or a drag (pan instead): { downClientX, downClientY }, or null.
let pendingEmptyPress = null;

export const pointTool = {
  id: 'point',
  name: 'Add points',
  cursor: 'crosshair',

  activate(app) {},
  deactivate(app) {
    pendingEmptyPress = null;
    cancelDragOnExistingItem();
    clearHover(app);
  },

  onPointerDown(app, worldPoint, event) {
    const layer = app.targetLayerForType('coordinates');
    // Pressing an existing annotation of any kind selects it, and dragging
    // then moves it. Placing a new point takes a double-click, so a press
    // anywhere else defers: a click deselects, a drag pans.
    const hit = layer.visible ? hitTestLayer(app, layer, worldPoint) : null;
    if (hit) {
      beginDragOnExistingItem(app, layer, hit, worldPoint);
      app.viewer.requestRender();
      return;
    }
    pendingEmptyPress = { downClientX: event.clientX, downClientY: event.clientY };
  },

  onPointerMove(app, worldPoint, event) {
    if (updateDragOnExistingItem(app, worldPoint)) return;
    if (pendingEmptyPress) {
      const deltaX = event.clientX - pendingEmptyPress.downClientX;
      const deltaY = event.clientY - pendingEmptyPress.downClientY;
      if (Math.hypot(deltaX, deltaY) > DRAG_THRESHOLD_SCREEN_PIXELS) {
        pendingEmptyPress = null;
        app.viewer.beginPanFromPointerEvent(event);
      }
      return;
    }
    const layer = app.findAnnotationLayerForType('coordinates');
    const hit = updateHover(app, layer, worldPoint);
    app.viewer.stageCanvas.style.cursor = hit ? 'move' : this.cursor;
  },

  onPointerUp(app, worldPoint, event) {
    if (endDragOnExistingItem(app)) return;
    if (pendingEmptyPress) {
      pendingEmptyPress = null;
      app.setSelection(null);
    }
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
