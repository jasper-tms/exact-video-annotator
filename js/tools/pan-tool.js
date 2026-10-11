// The pan tool: a left-drag on empty canvas translates the view — handed off
// straight to the viewer's own pan handling, the same behavior a left-drag
// has always had with no tool selected. Pressing an existing annotation
// selects it and dragging then moves it, exactly as with the drawing tools
// (the shared behavior in annotation-dragging.js), so annotations can be
// picked and adjusted without leaving pan mode; the pan tool just never draws
// anything new. It exists as an explicit tool (rather than "no tool") so it
// can be the automatic fallback whenever the active tool is deselected — see
// main.js's tool button and hotkey handlers.

import {
  hitTestLayer, beginDragOnExistingItem, updateDragOnExistingItem,
  endDragOnExistingItem, cancelDragOnExistingItem, updateHover, clearHover,
} from './annotation-dragging.js';

export const panTool = {
  id: 'pan',
  name: 'Pan',
  cursor: 'grab',

  activate(app) {},    // eslint-disable-line no-unused-vars
  deactivate(app) {
    cancelDragOnExistingItem();
    clearHover(app);
  },

  onPointerDown(app, worldPoint, event) {
    // Never creates a layer: with no coordinates layer there is nothing to grab.
    const layer = app.findAnnotationLayerForType('coordinates');
    const hit = layer?.visible ? hitTestLayer(app, layer, worldPoint) : null;
    if (hit) {
      beginDragOnExistingItem(app, layer, hit, worldPoint);
      app.viewer.requestRender();
      return;
    }
    app.viewer.beginPanFromPointerEvent(event);
  },

  onPointerMove(app, worldPoint, event) { // eslint-disable-line no-unused-vars
    if (updateDragOnExistingItem(app, worldPoint)) return;
    const layer = app.findAnnotationLayerForType('coordinates');
    const hit = layer ? updateHover(app, layer, worldPoint) : null;
    app.viewer.stageCanvas.style.cursor = hit ? 'move' : this.cursor;
  },

  onPointerUp(app, worldPoint, event) { // eslint-disable-line no-unused-vars
    endDragOnExistingItem(app);
  },

  // The press was taken over (a second finger began a pinch).
  onPointerCancel(app, worldPoint, event) { // eslint-disable-line no-unused-vars
    cancelDragOnExistingItem();
    app.viewer.requestRender();
  },
};
