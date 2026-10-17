// The annotations table: the annotations of the layer selected in the tab bar,
// with columns that suit its type — kind, class, coordinates and frame for a
// coordinates layer; event type and frames for a frames layer — sortable,
// with click-to-select / jump-to-frame and a per-row delete button. It hides
// itself for layers that hold no annotations (video, image, segmentation).
// An item's class (or an event's type) is changed by clicking it, which opens
// a picker of the layer's classes (or event types). Each row shows the item's
// metadata (key-value pairs of text that plugins or people attach to it) in a
// box that opens the metadata editor dialog when clicked. The table holds no
// text inputs (the metadata editor is its own dialog), so it is safe to
// rebuild wholesale on document/layer/selection changes — except while one of
// its pickers is focused, when the rebuild waits until focus leaves it. Only
// the per-frame highlight is updated cheaply (toggling a class) as playback
// moves, never a full rebuild.

const COLUMNS_BY_LAYER_TYPE = {
  coordinates: [
    { key: 'kind', label: 'Kind', sortable: true },
    { key: 'label', label: 'Class', sortable: true },
    { key: 'data', label: 'Coordinates (x, y)', sortable: false },
    { key: 'frame', label: 'Frame', sortable: true },
    { key: 'metadata', label: 'Metadata', sortable: true },
  ],
  frames: [
    { key: 'label', label: 'Event type', sortable: true },
    { key: 'frame', label: 'Frames', sortable: true },
    { key: 'metadata', label: 'Metadata', sortable: true },
  ],
};

export function initializeAnnotationsTable(app, containerElement) {
  containerElement.innerHTML = `
    <h2 class="annotations-heading">Annotations</h2>
    <div class="annotations-scroll">
      <table class="annotations-table">
        <thead><tr></tr></thead>
        <tbody></tbody>
      </table>
    </div>
  `;

  const heading = containerElement.querySelector('.annotations-heading');
  const headerRow = containerElement.querySelector('.annotations-table thead tr');
  const tableBody = containerElement.querySelector('.annotations-table tbody');

  // Multi-key sort with recency, in the spirit of the reference tool: the most
  // recently clicked column is primary, earlier clicks act as tiebreakers.
  // Default: frame ascending. Kept per layer type, since their columns differ.
  const sortStateByLayerType = {};
  for (const [layerType, columns] of Object.entries(COLUMNS_BY_LAYER_TYPE)) {
    const sortableKeys = columns.filter((column) => column.sortable).map((column) => column.key);
    sortStateByLayerType[layerType] = {
      recency: ['frame', ...sortableKeys.filter((key) => key !== 'frame')],
      direction: Object.fromEntries(sortableKeys.map((key) => [key, 1])),
    };
  }

  // Rows currently rendered, kept so 'frame-changed' can re-highlight and
  // 'annotation-dragged' can refresh one Data cell cheaply, without
  // rebuilding: each entry pairs a <tr> with its row descriptor.
  let renderedRows = [];
  let renderedCoordinatePadWidth = 0;
  let renderedLayerType = null;

  /** Rebuild the header cells when the selected layer's type changes. */
  function buildHeader(layerType) {
    if (renderedLayerType === layerType) return;
    renderedLayerType = layerType;
    headerRow.replaceChildren();
    for (const column of COLUMNS_BY_LAYER_TYPE[layerType]) {
      const headerCell = document.createElement('th');
      headerCell.textContent = column.label;
      if (column.sortable) {
        headerCell.dataset.column = column.key;
        headerCell.className = 'sortable';
        headerCell.addEventListener('click', () => {
          const { recency, direction } = sortStateByLayerType[layerType];
          if (recency[0] === column.key) {
            direction[column.key] *= -1;   // re-click the primary column: flip it
          } else {
            recency.splice(recency.indexOf(column.key), 1);
            recency.unshift(column.key);
          }
          rebuild();
        });
      }
      headerRow.appendChild(headerCell);
    }
    const deleteHeader = document.createElement('th');
    deleteHeader.className = 'delete-column';
    headerRow.appendChild(deleteHeader);
  }

  // A rebuild would close a class or event type picker the user has open, so
  // while one has focus, rebuilds wait until focus leaves it.
  let rebuildPending = false;
  containerElement.addEventListener('focusout', () => {
    // Focus has not moved on yet during focusout; look once it has.
    setTimeout(() => {
      if (rebuildPending && !isPickerFocused()) rebuild();
    });
  });

  function isPickerFocused() {
    const activeElement = document.activeElement;
    return Boolean(activeElement) && containerElement.contains(activeElement)
      && activeElement.tagName === 'SELECT';
  }

  function rebuild() {
    if (isPickerFocused()) {
      rebuildPending = true;
      return;
    }
    rebuildPending = false;
    const layer = app.selectedLayer;
    const hasTable = Boolean(layer) && layer.type in COLUMNS_BY_LAYER_TYPE;
    containerElement.hidden = !hasTable;
    renderedRows = [];
    if (!hasTable) return;

    buildHeader(layer.type);
    const { recency, direction } = sortStateByLayerType[layer.type];
    const rows = layer.items.map((item) => describeItem(layer, item));
    rows.sort((a, b) => {
      for (const column of recency) {
        const result = compareByColumn(column, a, b) * direction[column];
        if (result !== 0) return result;
      }
      return 0;
    });
    const coordinatePadWidth = computeCoordinatePadWidth(rows);

    const noun = layer.type === 'frames' ? 'event' : 'annotation';
    heading.textContent = `${rows.length} ${noun}${rows.length === 1 ? '' : 's'}`;

    for (const headerCell of headerRow.querySelectorAll('th[data-column]')) {
      const column = headerCell.dataset.column;
      const isPrimary = recency[0] === column;
      headerCell.classList.toggle('sorted', isPrimary);
      headerCell.dataset.direction = isPrimary
        ? (direction[column] > 0 ? 'ascending' : 'descending')
        : '';
    }

    tableBody.textContent = '';
    renderedCoordinatePadWidth = coordinatePadWidth;

    const columns = COLUMNS_BY_LAYER_TYPE[layer.type];
    if (rows.length === 0) {
      const emptyRow = document.createElement('tr');
      const cell = document.createElement('td');
      cell.className = 'empty-message';
      cell.colSpan = columns.length + 1;
      cell.textContent = layer.type === 'frames'
        ? 'No events on this layer yet. Press an event type\'s add key to record one.'
        : 'No annotations on this layer yet.';
      emptyRow.appendChild(cell);
      tableBody.appendChild(emptyRow);
      return;
    }

    const currentFrame = app.currentFrame;
    for (const rowData of rows) {
      const tableRow = buildTableRow(app, layer, columns, rowData, coordinatePadWidth);
      if (isRowSelected(app, rowData)) tableRow.classList.add('selected');
      tableRow.classList.toggle('at-current-frame', rowData.includesFrame(currentFrame));
      tableBody.appendChild(tableRow);
      renderedRows.push({ element: tableRow, rowData });
    }
  }

  function updateCurrentFrameHighlight() {
    const currentFrame = app.currentFrame;
    for (const { element, rowData } of renderedRows) {
      element.classList.toggle('at-current-frame', rowData.includesFrame(currentFrame));
    }
  }

  /** Follow a drag by rewriting only the dragged item's Data cell: a full
      rebuild on every pointer move lags on long lists. The padding may only
      widen here, to fit the dragged item; the rebuild that the drop triggers
      settles every row's padding again. */
  function updateDraggedItemCoordinates(event) {
    const { layerId, itemId } = event.detail;
    const renderedRow = renderedRows.find(({ rowData }) =>
      rowData.layerId === layerId && rowData.itemId === itemId);
    if (!renderedRow) return;
    const vertices = renderedRow.rowData.item.vertices;
    renderedCoordinatePadWidth = Math.max(renderedCoordinatePadWidth,
      computeCoordinatePadWidth([{ vertices }]));
    renderedRow.element.querySelector('.data-cell').textContent =
      formatCoordinatesCell(vertices, renderedCoordinatePadWidth);
  }

  app.addEventListener('document-changed', rebuild);
  app.addEventListener('annotation-dragged', updateDraggedItemCoordinates);
  app.addEventListener('layers-changed', rebuild);
  app.addEventListener('selection-changed', rebuild);
  app.addEventListener('frame-changed', updateCurrentFrameHighlight);

  rebuild();
}

/* ---------- Row model ---------- */

/**
 * Flatten a single item into a table-row descriptor, resolving its human-facing
 * text and a predicate for whether it occupies a given frame.
 */
function describeItem(layer, item) {
  if (layer.type === 'frames') return describeEvent(layer, item);
  return describeSpatialItem(layer, item);
}

function describeSpatialItem(layer, item) {
  const classEntry = layer.findClass(item.classId);
  // A frame-agnostic item (frame === null) applies to every frame.
  const isFrameAgnostic = item.frame === null;
  return {
    layerId: layer.id,
    itemId: item.id,
    isEvent: false,
    frame: item.frame,
    kindText: item.kind,
    vertices: item.vertices,
    labelText: classEntry?.name ?? item.name ?? '',
    labelColor: classEntry?.color ?? null,
    item,
    metadataText: formatMetadata(item.metadata),
    framesText: isFrameAgnostic ? 'all' : String(item.frame),
    includesFrame: isFrameAgnostic ? () => true : (frame) => frame === item.frame,
    selectable: true,
  };
}

function describeEvent(layer, item) {
  const eventType = layer.findEventType(item.eventTypeId);
  const inProgress = item.endFrame === null;
  return {
    layerId: layer.id,
    itemId: item.id,
    isEvent: true,
    frame: item.startFrame,
    kindText: '',
    vertices: [],
    labelText: eventType?.name ?? '(unknown event type)',
    labelColor: eventType?.color ?? null,
    item,
    metadataText: formatMetadata(item.metadata),
    framesText: formatEventFrames(item),
    includesFrame: (frame) => frame >= item.startFrame
      && (inProgress || frame <= item.endFrame),
    selectable: false,
  };
}

function roundToOneDecimal(value) {
  return Math.round(value * 10) / 10;
}

/**
 * The longest formatted coordinate value across every row currently shown, so
 * that every row's parentheses and commas line up in the monospaced column.
 * Recomputed on every rebuild, so it grows the moment a wider value appears
 * and shrinks back once it's gone.
 */
function computeCoordinatePadWidth(rows) {
  let maxWidth = 0;
  for (const row of rows) {
    for (const [x, y] of row.vertices) {
      maxWidth = Math.max(maxWidth, String(roundToOneDecimal(x)).length, String(roundToOneDecimal(y)).length);
    }
  }
  return maxWidth;
}

/** One "(x, y)" pair per line, both numbers right-padded to padWidth so the
    punctuation lines up down the column. */
function formatCoordinatesCell(vertices, padWidth) {
  return vertices
    .map(([x, y]) => `(${padNumber(x, padWidth)}, ${padNumber(y, padWidth)})`)
    .join('\n');
}

function padNumber(value, padWidth) {
  return String(roundToOneDecimal(value)).padStart(padWidth, ' ');
}

function formatEventFrames(item) {
  if (item.endFrame === null) return `${item.startFrame} – recording…`;
  if (item.endFrame === item.startFrame) return String(item.startFrame);
  return `${item.startFrame}–${item.endFrame}`;
}

/* ---------- Row rendering ---------- */

function buildTableRow(app, layer, columns, rowData, coordinatePadWidth) {
  const tableRow = document.createElement('tr');

  for (const column of columns) {
    switch (column.key) {
      case 'kind':
        tableRow.appendChild(textCell(rowData.kindText, 'kind-cell'));
        break;
      case 'label':
        tableRow.appendChild(buildLabelCell(app, layer, rowData));
        break;
      case 'data':
        tableRow.appendChild(textCell(formatCoordinatesCell(rowData.vertices, coordinatePadWidth), 'data-cell'));
        break;
      case 'frame':
        tableRow.appendChild(textCell(rowData.framesText, 'frame-cell'));
        break;
      case 'metadata': {
        const metadataCell = document.createElement('td');
        metadataCell.className = 'metadata-cell';
        const metadataBox = document.createElement('button');
        metadataBox.type = 'button';
        metadataBox.className = 'metadata-box';
        metadataBox.title = 'Click to edit metadata';
        metadataBox.textContent = rowData.metadataText;
        metadataBox.addEventListener('click', (event) => {
          event.stopPropagation();   // editing must not also select / jump
          openMetadataEditor(app, rowData.item);
        });
        metadataCell.appendChild(metadataBox);
        tableRow.appendChild(metadataCell);
        break;
      }
    }
  }

  const deleteCell = document.createElement('td');
  deleteCell.className = 'delete-cell';
  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'delete-button';
  deleteButton.title = 'Delete annotation';
  deleteButton.textContent = '✕';
  deleteButton.addEventListener('click', (event) => {
    event.stopPropagation();   // a delete must not also select / jump
    deleteRow(app, rowData);
  });
  deleteCell.appendChild(deleteButton);
  tableRow.appendChild(deleteCell);

  tableRow.addEventListener('click', () => activateRow(app, rowData));
  return tableRow;
}

/**
 * The Class (or Event type) cell: the label's color, then a picker of the
 * layer's classes ("No class" included) or event types, which changes the
 * item's label as an undoable command. An id the layer no longer has stays
 * listed, as its own entry, until something else is picked.
 */
function buildLabelCell(app, layer, rowData) {
  const cell = document.createElement('td');
  cell.className = 'label-cell';
  const dot = document.createElement('span');
  dot.className = 'label-color-dot';
  const showColor = (color) => {
    dot.style.background = color ?? 'transparent';
    dot.classList.toggle('no-color', !color);
  };
  showColor(rowData.labelColor);

  const item = rowData.item;
  const isEvent = rowData.isEvent;
  const referenceKey = isEvent ? 'eventTypeId' : 'classId';
  const entries = isEvent ? layer.eventTypes : layer.classes;
  const picker = document.createElement('select');
  picker.className = 'label-picker';
  picker.title = isEvent ? 'Click to change the event type' : 'Click to change the class';
  picker.setAttribute('aria-label', isEvent ? 'Event type' : 'Class');
  const addOption = (value, text) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    picker.appendChild(option);
  };
  if (!isEvent) addOption('', 'No class');
  for (const entry of entries) addOption(entry.id, entry.name);
  const currentId = item[referenceKey] ?? '';
  if (currentId !== '' && !entries.some((entry) => entry.id === currentId)) {
    addOption(currentId, isEvent ? '(unknown event type)' : '(deleted class)');
  }
  picker.value = currentId;

  // Choosing from the picker must not also select the row and jump to its frame.
  picker.addEventListener('click', (event) => event.stopPropagation());
  picker.addEventListener('change', () => {
    const before = item[referenceKey] ?? null;
    const after = picker.value === '' ? null : picker.value;
    if (after === before) return;
    showColor(entries.find((entry) => entry.id === after)?.color ?? null);
    app.undoHistory.execute({
      label: isEvent ? 'Change event type' : 'Change class',
      apply: () => { item[referenceKey] = after; },
      revert: () => { item[referenceKey] = before; },
    });
  });
  cell.append(dot, picker);
  return cell;
}

function textCell(text, className) {
  const cell = document.createElement('td');
  cell.className = className;
  cell.textContent = text;
  return cell;
}

/* ---------- Row actions ---------- */

function activateRow(app, rowData) {
  if (rowData.selectable) {
    app.setSelection({ layerId: rowData.layerId, itemId: rowData.itemId, vertexIndex: null });
  }
  // A frame-agnostic item (frame === null) has no frame to jump to.
  if (rowData.frame !== null) app.seekToFrame(rowData.frame);
}

function deleteRow(app, rowData) {
  const layer = app.annotationLayers.find((candidate) => candidate.id === rowData.layerId);
  const command = layer?.commandDeleteItem?.(rowData.itemId);
  if (command) app.undoHistory.execute(command);
}

function isRowSelected(app, rowData) {
  const selection = app.selection;
  return !!selection
    && selection.layerId === rowData.layerId
    && selection.itemId === rowData.itemId;
}

/* ---------- Sorting ---------- */

function compareByColumn(column, a, b) {
  switch (column) {
    // Frame-agnostic items (frame === null) sort before frame 0.
    case 'frame': return (a.frame ?? -Infinity) - (b.frame ?? -Infinity);
    case 'kind': return compareText(a.kindText, b.kindText);
    case 'label': return compareText(a.labelText, b.labelText);
    case 'metadata': return compareText(a.metadataText, b.metadataText);
    default: return 0;
  }
}

function compareText(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/* ---------- Metadata ---------- */

/** "key: value" per line. */
export function formatMetadata(metadata) {
  return Object.entries(metadata ?? {})
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}

let metadataDialog = null;

/**
 * Edit an item's metadata in a dialog with one key box and one value box per
 * entry. It always ends with an empty row: typing into the last row adds a
 * new empty one below it. Rows left with both boxes empty are dropped on save.
 * Every value is kept as text, exactly as typed.
 */
function openMetadataEditor(app, item) {
  if (metadataDialog === null) {
    metadataDialog = document.createElement('dialog');
    metadataDialog.className = 'settings-dialog metadata-dialog';
    metadataDialog.innerHTML = `
      <h2>Metadata</h2>
      <p class="metadata-hint">Text labels for this annotation, as key–value pairs.</p>
      <div class="metadata-grid">
        <span class="metadata-column-heading">Key</span>
        <span class="metadata-column-heading">Value</span>
        <span></span>
      </div>
      <p class="metadata-error" hidden></p>
      <div class="metadata-buttons">
        <button type="button" class="metadata-cancel">Cancel</button>
        <button type="button" class="metadata-save">Save</button>
      </div>`;
    document.body.appendChild(metadataDialog);
    metadataDialog.querySelector('.metadata-cancel').addEventListener('click', () => metadataDialog.close());
  }
  const grid = metadataDialog.querySelector('.metadata-grid');
  const errorElement = metadataDialog.querySelector('.metadata-error');
  const saveButton = metadataDialog.querySelector('.metadata-save');
  errorElement.hidden = true;

  // Drop the previous item's rows, keeping the three column headings.
  while (grid.children.length > 3) grid.lastElementChild.remove();
  const rows = [];

  function addRow(key = '', value = '') {
    const keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.className = 'metadata-key';
    keyInput.value = key;
    keyInput.setAttribute('aria-label', 'Key');
    keyInput.spellcheck = false;
    const valueInput = document.createElement('input');
    valueInput.type = 'text';
    valueInput.className = 'metadata-value';
    valueInput.value = value;
    valueInput.setAttribute('aria-label', 'Value');
    valueInput.spellcheck = false;
    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'delete-button metadata-remove';
    removeButton.title = 'Remove this entry';
    removeButton.textContent = '✕';
    const row = { keyInput, valueInput, removeButton };
    removeButton.addEventListener('click', () => {
      for (const element of [keyInput, valueInput, removeButton]) element.remove();
      rows.splice(rows.indexOf(row), 1);
      ensureTrailingEmptyRow();
    });
    for (const input of [keyInput, valueInput]) input.addEventListener('input', ensureTrailingEmptyRow);
    grid.append(keyInput, valueInput, removeButton);
    rows.push(row);
    updateRemoveButtons();
  }

  const isEmpty = (row) => row.keyInput.value === '' && row.valueInput.value === '';

  /** Keep exactly one way to add another entry: an empty row at the end. */
  function ensureTrailingEmptyRow() {
    if (rows.length === 0 || !isEmpty(rows[rows.length - 1])) addRow();
    updateRemoveButtons();
  }

  // The trailing empty row has nothing to remove.
  function updateRemoveButtons() {
    rows.forEach((row, index) => {
      row.removeButton.style.visibility = index === rows.length - 1 && isEmpty(row) ? 'hidden' : 'visible';
    });
  }

  for (const [key, value] of Object.entries(item.metadata ?? {})) addRow(key, String(value));
  ensureTrailingEmptyRow();

  const save = () => {
    const after = {};
    for (const [index, row] of rows.entries()) {
      if (isEmpty(row)) continue;
      const key = row.keyInput.value.trim();
      if (key === '') {
        errorElement.textContent = `Entry ${index + 1} has a value but no key.`;
        errorElement.hidden = false;
        row.keyInput.focus();
        return;
      }
      if (key in after) {
        errorElement.textContent = `The key "${key}" appears twice.`;
        errorElement.hidden = false;
        row.keyInput.focus();
        return;
      }
      after[key] = row.valueInput.value;
    }
    const before = { ...(item.metadata ?? {}) };
    metadataDialog.close();
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    app.undoHistory.execute({
      label: 'Edit metadata',
      apply: () => { item.metadata = { ...after }; },
      revert: () => { item.metadata = { ...before }; },
    });
  };
  saveButton.onclick = save;
  // Enter in any box saves without reaching for the mouse.
  grid.onkeydown = (event) => {
    if (event.key === 'Enter') { event.preventDefault(); save(); }
  };
  metadataDialog.showModal();
  rows[0].keyInput.focus();
}
