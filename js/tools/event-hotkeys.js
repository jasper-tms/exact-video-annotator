// Global keyboard handling for temporal event types, in the spirit of
// simple-html-tools/video-annotator but rebuilt on this architecture. Every
// event type may define a single-character, case-sensitive "add" hotkey and a
// separate "remove" hotkey:
//
//   - Point event type, add key: record a one-frame event at the current frame.
//   - Range event type, add key: the first press starts an in-progress range at
//     the current frame; the second press ends it (the smaller frame becomes the
//     start, the larger the end).
//   - Remove key: delete the most recently added event of that type that
//     overlaps the current frame.
//
// Every frames layer has its own event types, and all of their hotkeys are
// live at once: each records into (or removes from) the layer that defines
// it. When two layers bind the same key, the selected layer wins, then the
// topmost; the layer panel warns about such clashes (see hotkeyClashes).
// Every mutation goes through the undo history.

import { newId } from '../document.js';

export function initializeEventHotkeys(app) {
  app.addKeyHandler((event) => handleKey(app, event));
}

/** Frames layers in the order their hotkeys take precedence: the selected
    one, then the rest from the top of the stack down. */
function framesLayersByPrecedence(app) {
  const framesLayers = app.annotationLayers.filter((layer) => layer.type === 'frames').reverse();
  const selected = app.selectedLayer;
  return selected?.type === 'frames'
    ? [selected, ...framesLayers.filter((layer) => layer !== selected)]
    : framesLayers;
}

/** The event type bound to this key, and its layer, or null. */
function findBinding(app, key, propertyName) {
  for (const layer of framesLayersByPrecedence(app)) {
    const eventType = layer.eventTypes.find((type) => type[propertyName] && type[propertyName] === key);
    if (eventType) return { layer, eventType };
  }
  return null;
}

/** The other event types (on any frames layer) bound to the same key as this
    event type's add or remove key, each as { layer, eventType }. */
export function hotkeyClashes(app, eventType, propertyName) {
  const key = eventType[propertyName];
  if (!key) return [];
  const clashes = [];
  for (const layer of app.annotationLayers.filter((candidate) => candidate.type === 'frames')) {
    for (const other of layer.eventTypes) {
      if (other === eventType) continue;
      if (other.addHotkey === key || other.removeHotkey === key) clashes.push({ layer, eventType: other });
    }
  }
  return clashes;
}

function handleKey(app, event) {
  // Case-sensitive matching lets an add key (for example "f") and a remove key
  // (for example "F", i.e. Shift+f) be told apart. Add keys win over remove
  // keys when, unusually, a single key is bound to both.
  const addBinding = findBinding(app, event.key, 'addHotkey');
  if (addBinding) {
    handleAdd(app, addBinding.layer, addBinding.eventType);
    return true;
  }

  const removeBinding = findBinding(app, event.key, 'removeHotkey');
  if (removeBinding) {
    handleRemove(app, removeBinding.layer, removeBinding.eventType);
    return true;
  }

  return false;
}

/* ---------- Adding ---------- */

function handleAdd(app, layer, eventType) {
  const frame = app.currentFrame;
  const items = layer.items;

  if (eventType.kind === 'point') {
    addPointEvent(app, eventType, items, frame);
  } else {
    addOrCompleteRangeEvent(app, eventType, items, frame);
  }
}

function addPointEvent(app, eventType, items, frame) {
  const alreadyRecorded = items.some((item) =>
    item.eventTypeId === eventType.id
    && item.startFrame === frame
    && item.endFrame === frame);
  if (alreadyRecorded) {
    app.showToast(`${eventType.name} is already recorded at frame ${frame}`, { kind: 'warning' });
    return;
  }

  const item = { id: newId(), eventTypeId: eventType.id, startFrame: frame, endFrame: frame, metadata: {} };
  app.undoHistory.execute({
    label: `Add ${eventType.name}`,
    apply: () => items.push(item),
    revert: () => removeItem(items, item),
  });
  app.showToast(`${eventType.name} @ frame ${frame}`);
}

function addOrCompleteRangeEvent(app, eventType, items, frame) {
  const inProgress = findLast(items, (item) =>
    item.eventTypeId === eventType.id && item.endFrame === null);

  if (inProgress) {
    // Second press: complete the range. The earlier of the two marked frames
    // becomes the start and the later becomes the end, whichever was marked
    // first. Revert restores the in-progress (recording) state.
    const recordingStart = inProgress.startFrame;
    const startFrame = Math.min(recordingStart, frame);
    const endFrame = Math.max(recordingStart, frame);
    app.undoHistory.execute({
      label: `Complete ${eventType.name}`,
      apply: () => { inProgress.startFrame = startFrame; inProgress.endFrame = endFrame; },
      revert: () => { inProgress.startFrame = recordingStart; inProgress.endFrame = null; },
    });
    app.showToast(`${eventType.name} @ frames ${startFrame}–${endFrame}`);
    return;
  }

  // First press: start recording an in-progress range (endFrame stays null
  // until it is completed, and such items are never exported).
  const item = { id: newId(), eventTypeId: eventType.id, startFrame: frame, endFrame: null, metadata: {} };
  app.undoHistory.execute({
    label: `Start ${eventType.name}`,
    apply: () => items.push(item),
    revert: () => removeItem(items, item),
  });
  app.showToast(`${eventType.name}: recording from frame ${frame} (press ${eventType.addHotkey} again to end)`);
}

/* ---------- Removing ---------- */

function handleRemove(app, layer, eventType) {
  const frame = app.currentFrame;
  const items = layer.items;

  const target = findLast(items, (item) => overlapsFrame(eventType, item, frame));
  if (!target) {
    app.showToast(`No ${eventType.name} at frame ${frame} to remove`, { kind: 'warning' });
    return;
  }

  const originalIndex = items.indexOf(target);
  app.undoHistory.execute({
    label: `Remove ${eventType.name}`,
    apply: () => removeItem(items, target),
    revert: () => items.splice(originalIndex, 0, target),
  });
  app.showToast(`Removed ${eventType.name} at ${describeSpan(target)}`);
}

/**
 * Whether an event of the given type overlaps the current frame. Points match
 * only their exact frame; ranges match anywhere between start and end, treating
 * a null end (still recording) as open-ended.
 */
function overlapsFrame(eventType, item, frame) {
  if (item.eventTypeId !== eventType.id) return false;
  if (eventType.kind === 'point') return item.startFrame === frame;
  if (item.startFrame > frame) return false;
  return item.endFrame === null || frame <= item.endFrame;
}

/* ---------- Helpers ---------- */

function describeSpan(item) {
  if (item.endFrame === null) return `frame ${item.startFrame} (recording)`;
  if (item.endFrame === item.startFrame) return `frame ${item.startFrame}`;
  return `frames ${item.startFrame}–${item.endFrame}`;
}

function removeItem(items, item) {
  const index = items.indexOf(item);
  if (index !== -1) items.splice(index, 1);
}

/** The last element satisfying the predicate (most recently added), or null. */
function findLast(items, predicate) {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index])) return items[index];
  }
  return null;
}
