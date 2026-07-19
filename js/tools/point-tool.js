// The point tool: press empty space to place a new point annotation (a live
// preview follows the cursor while the pointer is down; releasing commits one
// undoable "Add point" command). Pressing an existing point selects it, and
// dragging it moves it — the shared behavior in annotation-dragging.js — so
// there is no separate select tool. Like the drawing tools it keeps its
// transient state in a module-level variable (drawOverlay's signature has no
// `app`, so the pressed state also captures the app for the overlay).

import { newId } from '../document.js';
import {
  hitTestLayer, beginDragOnExistingItem, updateDragOnExistingItem,
  endDragOnExistingItem, cancelDragOnExistingItem, updateHover, clearHover,
} from './annotation-dragging.js';

const FALLBACK_COLOR = '#4f9cf9';
const PREVIEW_RADIUS_SCREEN_PIXELS = 5;
const PREVIEW_OUTLINE_WIDTH_SCREEN_PIXELS = 1.5;
const PREVIEW_OUTLINE_COLOR = '#101014';

// While the pointer is pressed: { app, layer, localPoint } — localPoint is in
// the target layer's local space and updates as the cursor moves. Null when no
// press is in progress.
let pendingPress = null;

function colorForActiveClass(app) {
  const classId = app.activeClassId;
  if (classId === null || classId === undefined) return FALLBACK_COLOR;
  const matchingClass = app.annotationDocument.classes.find((entry) => entry.id === classId);
  return matchingClass ? matchingClass.color : FALLBACK_COLOR;
}

export const pointTool = {
  id: 'point',
  name: 'Add points',
  hotkey: 'o',
  cursor: 'crosshair',

  activate(app) {},
  deactivate(app) {
    pendingPress = null;
    cancelDragOnExistingItem();
    clearHover(app);
  },

  onPointerDown(app, worldPoint, event) {
    const layer = app.targetLayerForType('points');
    // Pressing an existing point selects it, and dragging then moves it;
    // only empty space places a new point.
    const hit = layer.visible ? hitTestLayer(app, layer, worldPoint) : null;
    if (hit) {
      pendingPress = null;
      beginDragOnExistingItem(app, layer, hit, worldPoint);
      app.viewer.requestRender();
      return;
    }
    pendingPress = { app, layer, localPoint: app.localFromWorld(layer, worldPoint) };
    app.viewer.requestRender();
  },

  onPointerMove(app, worldPoint, event) {
    if (updateDragOnExistingItem(app, worldPoint)) return;
    if (pendingPress) {
      pendingPress.localPoint = app.localFromWorld(pendingPress.layer, worldPoint);
      app.viewer.requestRender();
      return;
    }
    const layer = app.findAnnotationLayerForType('points');
    const hit = updateHover(app, layer, worldPoint);
    app.viewer.stageCanvas.style.cursor = hit ? 'move' : this.cursor;
  },

  onPointerUp(app, worldPoint, event) {
    if (endDragOnExistingItem(app)) return;
    if (!pendingPress) return;
    const { layer, localPoint } = pendingPress;
    pendingPress = null;

    const newItem = {
      id: newId(),
      frame: app.newItemFrame,
      x: localPoint.x,
      y: localPoint.y,
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

  onKeyDown(app, event) {
    if (event.key === 'Escape' && pendingPress) {
      pendingPress = null;
      app.viewer.requestRender();
      return true;
    }
    return false;
  },

  // drawOverlay runs in WORLD coordinates, so convert the pending local point
  // back to world for drawing. Screen-constant sizes divide by
  // renderState.pixelsPerLocalUnit (world→stage scale for the overlay).
  drawOverlay(context, renderState) {
    if (!pendingPress) return;
    const { app, layer, localPoint } = pendingPress;
    const worldPoint = app.worldFromLocal(layer, localPoint);
    const radius = PREVIEW_RADIUS_SCREEN_PIXELS / renderState.pixelsPerLocalUnit;

    context.beginPath();
    context.arc(worldPoint.x, worldPoint.y, radius, 0, Math.PI * 2);
    context.fillStyle = colorForActiveClass(app);
    context.fill();
    context.lineWidth = PREVIEW_OUTLINE_WIDTH_SCREEN_PIXELS / renderState.pixelsPerLocalUnit;
    context.strokeStyle = PREVIEW_OUTLINE_COLOR;
    context.stroke();
  },
};
