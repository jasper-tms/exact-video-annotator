// Re-fitting on demand: the layer panel's button and the `r` key both land
// here. Any layer that implements `refitItem` (plugins do; plain annotation
// layers do not) can be re-fitted this way.

/**
 * Re-run the active plugin's fit on the selected annotation, as one undoable
 * step. Returns true when a re-fit actually happened.
 */
export function refitSelectedItem(app) {
  const selection = app.selection;
  if (!selection) return false;
  const layer = app.viewer.layers.find((candidate) => candidate.id === selection.layerId);
  return refitItem(app, layer, selection.itemId);
}

/** Re-fit one item of one layer, as one undoable step. */
export function refitItem(app, layer, itemId) {
  if (!layer?.refitItem) return false;
  const beforeSnapshot = layer.snapshotItemGeometry(itemId);
  if (!layer.refitItem(app, itemId)) return false;
  const afterSnapshot = layer.snapshotItemGeometry(itemId);
  app.undoHistory.execute({
    label: 'Re-fit',
    apply: () => layer.restoreItemGeometry(itemId, afterSnapshot),
    revert: () => layer.restoreItemGeometry(itemId, beforeSnapshot),
  });
  return true;
}
