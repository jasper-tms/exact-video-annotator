// The point tool: press to place a new point annotation on the current frame.
// While the pointer is down it shows a live preview that follows the cursor;
// releasing commits one undoable "Add point" command. Like the select tool it
// keeps its transient state in a module-level variable (drawOverlay's signature
// has no `app`, so the pressed state also captures the app for the overlay).

import { newId } from '../document.js';

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
  hotkey: 'p',
  cursor: 'crosshair',

  activate(app) {},
  deactivate(app) { pendingPress = null; },

  onPointerDown(app, worldPoint, event) {
    const layer = app.targetLayerForType('points');
    const localPoint = app.localFromWorld(layer, worldPoint);
    // Clicking an existing point selects it rather than stacking a new one on
    // top; only empty space places a new point.
    const hit = layer.hitTest(localPoint, {
      frame: app.currentFrame,
      pixelsPerLocalUnit: app.viewer.stageTransformForLayer(layer).scale,
    });
    if (hit) {
      pendingPress = null;
      app.setSelection({ layerId: layer.id, itemId: hit.itemId, vertexIndex: null });
      app.viewer.requestRender();
      return;
    }
    pendingPress = { app, layer, localPoint };
    app.viewer.requestRender();
  },

  onPointerMove(app, worldPoint, event) {
    if (!pendingPress) return;
    pendingPress.localPoint = app.localFromWorld(pendingPress.layer, worldPoint);
    app.viewer.requestRender();
  },

  onPointerUp(app, worldPoint, event) {
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
