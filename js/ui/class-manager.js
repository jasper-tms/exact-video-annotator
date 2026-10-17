// The class manager edits the label registry of the layer selected in the tab
// bar: a coordinates layer's `classes` (labels for its points and shapes, one
// of which may be chosen for newly drawn items as `layer.activeClassId`, with
// "no class" a valid choice) or a frames layer's `eventTypes` (temporal events,
// each with a kind and add/remove hotkeys). Other layers have no labels, so the
// panel hides itself for them.
//
// Structural changes (adding or deleting a class or event type) are undoable
// commands. In-place edits (typing a name, picking a color/kind/hotkey) mutate
// the document directly and call `app.markDocumentChanged()`; fine-grained undo
// for individual keystrokes is intentionally out of scope.
//
// Rebuilding the panel wipes and recreates its rows, so — per ARCHITECTURE.md
// — we must never rebuild while the user is typing into one of its text boxes.
// Rebuilds triggered from elsewhere wait until focus leaves them; structural
// handlers rebuild directly (their buttons are never typed into).

import { newId, nextUnusedColor } from '../document.js';
import { hotkeyClashes } from '../tools/event-hotkeys.js';

export function initializeClassManager(app, containerElement) {
  function isUserTypingHere() {
    const activeElement = document.activeElement;
    return Boolean(activeElement) && containerElement.contains(activeElement)
      && activeElement.tagName === 'INPUT' && activeElement.type === 'text';
  }

  function rebuild() {
    const layer = app.selectedLayer;
    containerElement.replaceChildren();
    const hasRegistry = layer?.type === 'coordinates' || layer?.type === 'frames';
    containerElement.hidden = !hasRegistry;
    if (!hasRegistry) return;
    if (layer.type === 'coordinates') buildClassesPanel(app, layer, containerElement, rebuild);
    else buildEventTypesPanel(app, layer, containerElement, rebuild);
  }

  function rebuildIfIdle() {
    if (!isUserTypingHere()) rebuild();
  }

  // Rebuild when the change came from elsewhere (import, undo/redo, another
  // panel, selecting another layer), but not while the user is typing here.
  app.addEventListener('document-changed', rebuildIfIdle);
  app.addEventListener('layers-changed', rebuildIfIdle);
  app.viewer.addEventListener('layers-changed', rebuildIfIdle);

  rebuild();
}

/* ---------- Shared pieces ---------- */

function buildPanelHeading(title, explanation) {
  const heading = document.createElement('h2');
  heading.textContent = title;
  const hint = document.createElement('p');
  hint.className = 'registry-hint';
  hint.textContent = explanation;
  return [heading, hint];
}

function buildSwatch(entry, title, app) {
  const swatch = document.createElement('input');
  swatch.type = 'color';
  swatch.className = 'swatch';
  swatch.value = normalizeColor(entry.color);
  swatch.title = title;
  swatch.addEventListener('input', () => {
    entry.color = swatch.value;
    app.markDocumentChanged();
  });
  return swatch;
}

function buildNameInput(entry, title, app) {
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'name-input';
  nameInput.value = entry.name;
  nameInput.title = title;
  nameInput.setAttribute('aria-label', title);
  nameInput.addEventListener('input', () => {
    entry.name = nameInput.value;
    app.markDocumentChanged();
  });
  return nameInput;
}

function buildDeleteButton(title, onClick) {
  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'delete-button';
  deleteButton.title = title;
  deleteButton.textContent = '✕';
  deleteButton.addEventListener('click', onClick);
  return deleteButton;
}

function buildAddButton(text, onClick) {
  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'add-registry-entry';
  addButton.textContent = text;
  addButton.addEventListener('click', onClick);
  return addButton;
}

/* ---------- Classes ---------- */

function buildClassesPanel(app, layer, containerElement, rebuild) {
  containerElement.append(...buildPanelHeading('Classes',
    'Labels for this layer\'s annotations. New annotations get the chosen class.'));

  const list = document.createElement('div');
  list.className = 'registry-list';
  list.setAttribute('role', 'radiogroup');
  list.setAttribute('aria-label', 'Class for new annotations');
  const radioName = `active-class-${layer.id}`;
  const activeId = layer.activeClass?.id ?? null;

  list.appendChild(buildClassRow(app, layer, null, radioName, activeId === null, rebuild));
  for (const classEntry of layer.classes) {
    list.appendChild(buildClassRow(app, layer, classEntry, radioName, activeId === classEntry.id, rebuild));
  }
  containerElement.appendChild(list);
  containerElement.appendChild(buildAddButton('+ Add class', () => addClass(app, layer, rebuild)));
}

/** A class's row, or with classEntry null the "No class" row. */
function buildClassRow(app, layer, classEntry, radioName, isActive, rebuild) {
  const row = document.createElement('div');
  row.className = classEntry ? 'registry-row class-row' : 'registry-row no-class-row';

  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = radioName;
  radio.className = 'active-class-radio';
  radio.checked = isActive;
  radio.title = classEntry ? 'Use this class for new annotations' : 'Create new annotations without a class';
  radio.addEventListener('change', () => {
    // The active class is UI state, not part of the document: no rebuild.
    if (radio.checked) layer.activeClassId = classEntry?.id ?? null;
  });
  row.appendChild(radio);

  if (!classEntry) {
    const label = document.createElement('span');
    label.className = 'no-class-label';
    label.textContent = 'No class';
    label.addEventListener('click', () => radio.click());
    row.appendChild(label);
    return row;
  }

  row.appendChild(buildSwatch(classEntry, 'Class color', app));
  row.appendChild(buildNameInput(classEntry, 'Class name', app));
  row.appendChild(buildDeleteButton('Delete class', () => deleteClass(app, layer, classEntry, rebuild)));
  return row;
}

function addClass(app, layer, rebuild) {
  const classes = layer.classes;
  const classEntry = {
    id: newId(),
    name: `class ${classes.length + 1}`,
    color: nextUnusedColor(classes),
  };
  app.undoHistory.execute({
    label: 'Add class',
    apply: () => classes.push(classEntry),
    revert: () => removeById(classes, classEntry.id),
  });
  rebuild();
}

function deleteClass(app, layer, classEntry, rebuild) {
  if (layer.items.some((item) => item.classId === classEntry.id)
      && !window.confirm(`Delete class "${classEntry.name}"? Annotations already labelled with it keep the label but will render in a fallback color.`)) {
    return;
  }
  const classes = layer.classes;
  const originalIndex = classes.indexOf(classEntry);
  if (originalIndex === -1) return;
  app.undoHistory.execute({
    label: 'Delete class',
    apply: () => removeById(classes, classEntry.id),
    revert: () => classes.splice(originalIndex, 0, classEntry),
  });
  rebuild();
}

/* ---------- Event types ---------- */

function buildEventTypesPanel(app, layer, containerElement, rebuild) {
  containerElement.append(...buildPanelHeading('Event types',
    'Press an event type\'s add key to record it on the current frame (a range takes '
    + 'two presses: start and end), and its remove key to delete it there. Keys are case-sensitive.'));

  const list = document.createElement('div');
  list.className = 'registry-list';
  const warningUpdaters = [];
  const refreshWarnings = () => warningUpdaters.forEach((update) => update());
  for (const eventType of layer.eventTypes) {
    const { card, updateWarnings } = buildEventTypeCard(app, layer, eventType, rebuild, refreshWarnings);
    warningUpdaters.push(updateWarnings);
    list.appendChild(card);
  }
  refreshWarnings();
  containerElement.appendChild(list);
  containerElement.appendChild(buildAddButton('+ Add event type', () => addEventType(app, layer, rebuild)));
}

function buildEventTypeCard(app, layer, eventType, rebuild, refreshWarnings) {
  const card = document.createElement('div');
  card.className = 'registry-card event-type-card';

  const topRow = document.createElement('div');
  topRow.className = 'registry-row';
  topRow.appendChild(buildSwatch(eventType, 'Event color', app));
  topRow.appendChild(buildNameInput(eventType, 'Event type name', app));

  const kindSelect = document.createElement('select');
  kindSelect.className = 'kind-select';
  kindSelect.title = 'Point (a single frame) or range (a span of frames)';
  for (const [value, text] of [['point', 'Point'], ['range', 'Range']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    kindSelect.appendChild(option);
  }
  kindSelect.value = eventType.kind;
  kindSelect.addEventListener('change', () => {
    eventType.kind = kindSelect.value;
    app.markDocumentChanged();
  });
  topRow.appendChild(kindSelect);
  topRow.appendChild(buildDeleteButton('Delete event type',
    () => deleteEventType(app, layer, eventType, rebuild)));

  const hotkeyRow = document.createElement('div');
  hotkeyRow.className = 'registry-row hotkey-row';
  const addKey = buildHotkeyField(app, eventType, 'addHotkey', 'Add key', refreshWarnings);
  const removeKey = buildHotkeyField(app, eventType, 'removeHotkey', 'Remove key', refreshWarnings);
  hotkeyRow.append(addKey.field, removeKey.field);

  const warning = document.createElement('p');
  warning.className = 'hotkey-warning';

  card.append(topRow, hotkeyRow, warning);

  /** Flag a key also bound by another event type, on this layer or another. */
  function updateWarnings() {
    const messages = [];
    let sharedWithOtherLayers = false;
    for (const { propertyName, input } of [addKey, removeKey]) {
      const clashes = hotkeyClashes(app, eventType, propertyName);
      input.classList.toggle('clashing', clashes.length > 0);
      if (clashes.length === 0) continue;
      const others = clashes.map(({ layer: otherLayer, eventType: other }) =>
        otherLayer === layer ? `"${other.name}"` : `"${other.name}" on ${otherLayer.name}`);
      messages.push(`"${eventType[propertyName]}" is also used by ${others.join(', ')}.`);
      if (clashes.some(({ layer: otherLayer }) => otherLayer !== layer)) sharedWithOtherLayers = true;
    }
    if (sharedWithOtherLayers) {
      messages.push("When layers share a key, the selected layer's wins, then the topmost's.");
    }
    warning.textContent = messages.join(' ');
    warning.hidden = messages.length === 0;
  }

  return { card, updateWarnings };
}

function buildHotkeyField(app, eventType, propertyName, labelText, onChange) {
  const field = document.createElement('label');
  field.className = 'hotkey-field';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'hotkey-input';
  input.maxLength = 1;
  input.placeholder = '–';
  input.value = eventType[propertyName] ?? '';
  input.addEventListener('input', () => {
    // A single character, matched case-sensitively; empty clears the binding.
    eventType[propertyName] = input.value.length > 0 ? input.value : null;
    app.markDocumentChanged();
    onChange();
  });
  field.append(`${labelText} `, input);
  return { field, input, propertyName };
}

function addEventType(app, layer, rebuild) {
  const eventTypes = layer.eventTypes;
  const eventType = {
    id: newId(),
    name: `event ${eventTypes.length + 1}`,
    kind: 'point',
    color: nextUnusedColor(eventTypes),
    addHotkey: null,
    removeHotkey: null,
  };
  app.undoHistory.execute({
    label: 'Add event type',
    apply: () => eventTypes.push(eventType),
    revert: () => removeById(eventTypes, eventType.id),
  });
  rebuild();
}

function deleteEventType(app, layer, eventType, rebuild) {
  if (layer.items.some((item) => item.eventTypeId === eventType.id)
      && !window.confirm(`Delete event type "${eventType.name}"? Existing events of this type will remain in the annotations table.`)) {
    return;
  }
  const eventTypes = layer.eventTypes;
  const originalIndex = eventTypes.indexOf(eventType);
  if (originalIndex === -1) return;
  app.undoHistory.execute({
    label: 'Delete event type',
    apply: () => removeById(eventTypes, eventType.id),
    revert: () => eventTypes.splice(originalIndex, 0, eventType),
  });
  rebuild();
}

/* ---------- Helpers ---------- */

function removeById(entries, id) {
  const index = entries.findIndex((entry) => entry.id === id);
  if (index !== -1) entries.splice(index, 1);
}

/**
 * A native <input type="color"> only accepts `#rrggbb`. Class/event colors are
 * arbitrary CSS color strings, so fall back to a neutral gray for anything the
 * swatch cannot represent, leaving the stored value untouched until edited.
 */
function normalizeColor(color) {
  return /^#[0-9a-fA-F]{6}$/.test(color ?? '') ? color : '#888888';
}
