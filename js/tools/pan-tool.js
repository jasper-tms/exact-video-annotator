// The pan tool: a left-drag translates the view. It has no drawing or
// selection behavior of its own — pressing anywhere hands off straight to the
// viewer's own pan handling, the same behavior a left-drag has always had
// with no tool selected. It exists as an explicit tool (rather than "no
// tool") so it can be the automatic fallback whenever the active tool is
// deselected — see main.js's tool button and hotkey handlers.

export const panTool = {
  id: 'pan',
  name: 'Pan',
  hotkey: 'p',
  cursor: 'grab',

  activate(app) {},    // eslint-disable-line no-unused-vars
  deactivate(app) {},  // eslint-disable-line no-unused-vars

  onPointerDown(app, worldPoint, event) { // eslint-disable-line no-unused-vars
    app.viewer.beginPanFromPointerEvent(event);
  },
};
