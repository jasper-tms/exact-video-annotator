// The class manager edits the two label registries the document carries: the
// spatial `classes` (labels for points and shapes) and the `eventTypes`
// (temporal events, each with a kind and add/remove hotkeys). It also lets the
// user pick which class newly created spatial items are labelled with
// (`app.activeClassId`, with "no class" as a valid choice).
//
// Structural changes (adding or deleting a class or event type) are undoable
// commands. In-place edits (typing a name, picking a color/kind/hotkey) mutate
// the document directly and call `app.markDocumentChanged()`; fine-grained undo
// for individual keystrokes is intentionally out of scope.
//
// Rebuilding a list wipes and recreates its rows, so — per ARCHITECTURE.md — we
// must never rebuild while the user is focused inside this panel typing into an
// input. The document-changed listener therefore rebuilds only when focus is
// elsewhere; structural handlers rebuild the affected list directly (their
// button keeps focus, but the buttons live outside the rebuilt lists).

import { newId, nextUnusedColor } from '../document.js';

export function initializeClassManager(app, containerElement) {
  containerElement.innerHTML = `
    <h2>Classes</h2>
    <div class="registry-list class-list"></div>
    <button type="button" class="add-registry-entry add-class-button">+ Add class</button>
    <h2 class="event-types-heading">Event types</h2>
    <div class="registry-list event-type-list"></div>
    <button type="button" class="add-registry-entry add-event-type-button">+ Add event type</button>
  `;

  const classList = containerElement.querySelector('.class-list');
  const eventTypeList = containerElement.querySelector('.event-type-list');

  containerElement.querySelector('.add-class-button')
    .addEventListener('click', () => addClass(app, rebuildClasses));
  containerElement.querySelector('.add-event-type-button')
    .addEventListener('click', () => addEventType(app, rebuildEventTypes));

  function rebuildClasses() {
    buildClassList(app, classList);
  }
  function rebuildEventTypes() {
    buildEventTypeList(app, eventTypeList);
  }
  function rebuildAll() {
    rebuildClasses();
    rebuildEventTypes();
  }

  // Rebuild when the change came from elsewhere (import, undo/redo, another
  // panel), but not while the user is typing into one of our own inputs.
  app.addEventListener('document-changed', () => {
    if (!containerElement.contains(document.activeElement)) rebuildAll();
  });

  rebuildAll();
}

/* ---------- Classes ---------- */

function buildClassList(app, listElement) {
  listElement.textContent = '';
  const classes = app.annotationDocument.classes;

  listElement.appendChild(buildNoClassRow(app, listElement));

  for (const classEntry of classes) {
    listElement.appendChild(buildClassRow(app, listElement, classEntry));
  }
}

function buildNoClassRow(app, listElement) {
  const row = document.createElement('div');
  row.className = 'registry-row no-class-row';

  const selector = document.createElement('button');
  selector.type = 'button';
  selector.className = 'active-selector';
  selector.title = 'Create new items without a class';
  selector.classList.toggle('active', app.activeClassId === null || app.activeClassId === undefined);
  selector.addEventListener('click', () => setActiveClass(app, listElement, null));
  row.appendChild(selector);

  const label = document.createElement('span');
  label.className = 'no-class-label';
  label.textContent = 'No class';
  label.addEventListener('click', () => setActiveClass(app, listElement, null));
  row.appendChild(label);

  return row;
}

function buildClassRow(app, listElement, classEntry) {
  const row = document.createElement('div');
  row.className = 'registry-row class-row';

  const selector = document.createElement('button');
  selector.type = 'button';
  selector.className = 'active-selector';
  selector.title = 'Use this class for newly created items';
  selector.classList.toggle('active', app.activeClassId === classEntry.id);
  selector.addEventListener('click', () => setActiveClass(app, listElement, classEntry.id));
  row.appendChild(selector);

  const swatch = document.createElement('input');
  swatch.type = 'color';
  swatch.className = 'swatch';
  swatch.value = normalizeColor(classEntry.color);
  swatch.title = 'Class color';
  swatch.addEventListener('input', () => {
    classEntry.color = swatch.value;
    app.markDocumentChanged();
  });
  row.appendChild(swatch);

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'name-input';
  nameInput.value = classEntry.name;
  nameInput.title = 'Class name';
  nameInput.addEventListener('input', () => {
    classEntry.name = nameInput.value;
    app.markDocumentChanged();
  });
  row.appendChild(nameInput);

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'delete-button';
  deleteButton.title = 'Delete class';
  deleteButton.textContent = '✕';
  deleteButton.addEventListener('click', () =>
    deleteClass(app, classEntry, () => buildClassList(app, listElement)));
  row.appendChild(deleteButton);

  return row;
}

function setActiveClass(app, listElement, classId) {
  app.activeClassId = classId;
  // Reflect the choice immediately without a rebuild (the active class is UI
  // state, not part of the document).
  markActiveClass(app, listElement);
}

function markActiveClass(app, listElement) {
  const rows = listElement.querySelectorAll('.registry-row');
  const classes = app.annotationDocument.classes;
  rows.forEach((row, index) => {
    const selector = row.querySelector('.active-selector');
    if (!selector) return;
    if (row.classList.contains('no-class-row')) {
      selector.classList.toggle('active', app.activeClassId === null || app.activeClassId === undefined);
    } else {
      // Row index 0 is the "no class" row, so class rows start at index 1.
      const classEntry = classes[index - 1];
      selector.classList.toggle('active', !!classEntry && app.activeClassId === classEntry.id);
    }
  });
}

function addClass(app, rebuild) {
  const classes = app.annotationDocument.classes;
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

function deleteClass(app, classEntry, rebuild) {
  if (isClassReferenced(app, classEntry.id)
      && !window.confirm(`Delete class "${classEntry.name}"? Items already labelled with it keep the label but will render in a fallback color.`)) {
    return;
  }
  const classes = app.annotationDocument.classes;
  const originalIndex = classes.indexOf(classEntry);
  if (originalIndex === -1) return;
  app.undoHistory.execute({
    label: 'Delete class',
    apply: () => removeById(classes, classEntry.id),
    revert: () => classes.splice(originalIndex, 0, classEntry),
  });
  rebuild();
}

function isClassReferenced(app, classId) {
  return app.annotationDocument.layers.some((layer) =>
    (layer.type === 'points' || layer.type === 'shapes')
    && layer.items.some((item) => item.classId === classId));
}

/* ---------- Event types ---------- */

function buildEventTypeList(app, listElement) {
  listElement.textContent = '';
  for (const eventType of app.annotationDocument.eventTypes) {
    listElement.appendChild(buildEventTypeRow(app, listElement, eventType));
  }
}

function buildEventTypeRow(app, listElement, eventType) {
  const row = document.createElement('div');
  row.className = 'registry-row event-type-row';

  const swatch = document.createElement('input');
  swatch.type = 'color';
  swatch.className = 'swatch';
  swatch.value = normalizeColor(eventType.color);
  swatch.title = 'Event color';
  swatch.addEventListener('input', () => {
    eventType.color = swatch.value;
    app.markDocumentChanged();
  });
  row.appendChild(swatch);

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'name-input';
  nameInput.value = eventType.name;
  nameInput.title = 'Event type name';
  nameInput.addEventListener('input', () => {
    eventType.name = nameInput.value;
    app.markDocumentChanged();
  });
  row.appendChild(nameInput);

  const kindSelect = document.createElement('select');
  kindSelect.className = 'kind-select';
  kindSelect.title = 'Point (single frame) or range (a span of frames)';
  for (const kind of ['point', 'range']) {
    const option = document.createElement('option');
    option.value = kind;
    option.textContent = kind;
    kindSelect.appendChild(option);
  }
  kindSelect.value = eventType.kind;
  kindSelect.addEventListener('change', () => {
    eventType.kind = kindSelect.value;
    app.markDocumentChanged();
  });
  row.appendChild(kindSelect);

  row.appendChild(buildHotkeyInput(app, eventType, 'addHotkey', 'Add hotkey (case-sensitive)'));
  row.appendChild(buildHotkeyInput(app, eventType, 'removeHotkey', 'Remove hotkey (case-sensitive)'));

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'delete-button';
  deleteButton.title = 'Delete event type';
  deleteButton.textContent = '✕';
  deleteButton.addEventListener('click', () =>
    deleteEventType(app, eventType, () => buildEventTypeList(app, listElement)));
  row.appendChild(deleteButton);

  return row;
}

function buildHotkeyInput(app, eventType, propertyName, title) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'hotkey-input';
  input.maxLength = 1;
  input.title = title;
  input.value = eventType[propertyName] ?? '';
  input.addEventListener('input', () => {
    // A single character, matched case-sensitively; empty clears the binding.
    eventType[propertyName] = input.value.length > 0 ? input.value : null;
    app.markDocumentChanged();
  });
  return input;
}

function addEventType(app, rebuild) {
  const eventTypes = app.annotationDocument.eventTypes;
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

function deleteEventType(app, eventType, rebuild) {
  if (isEventTypeReferenced(app, eventType.id)
      && !window.confirm(`Delete event type "${eventType.name}"? Existing events of this type will remain in the annotations table.`)) {
    return;
  }
  const eventTypes = app.annotationDocument.eventTypes;
  const originalIndex = eventTypes.indexOf(eventType);
  if (originalIndex === -1) return;
  app.undoHistory.execute({
    label: 'Delete event type',
    apply: () => removeById(eventTypes, eventType.id),
    revert: () => eventTypes.splice(originalIndex, 0, eventType),
  });
  rebuild();
}

function isEventTypeReferenced(app, eventTypeId) {
  return app.annotationDocument.layers.some((layer) =>
    layer.type === 'events'
    && layer.items.some((item) => item.eventTypeId === eventTypeId));
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
