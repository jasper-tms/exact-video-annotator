// The annotations table: the annotations of the layer selected in the tab bar,
// with columns that suit its type — kind, class, coordinates and frame for a
// coordinates layer; event type and frames for a frames layer — sortable,
// with click-to-select / jump-to-frame and a per-row delete button. It hides
// itself for layers that hold no annotations (video, image, segmentation).
// Each row shows the item's metadata (key-value pairs that plugins or people
// attach to it), edited through a dialog opened from the row's ✎ button. The
// table holds no text inputs (the metadata editor is its own dialog), so it is
// safe to rebuild wholesale on document/layer/selection changes; only the
// per-frame highlight is updated cheaply (toggling a class) as playback moves,
// never a full rebuild.

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

  function rebuild() {
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
      const tableRow = buildTableRow(app, columns, rowData, coordinatePadWidth);
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

function buildTableRow(app, columns, rowData, coordinatePadWidth) {
  const tableRow = document.createElement('tr');

  for (const column of columns) {
    switch (column.key) {
      case 'kind':
        tableRow.appendChild(textCell(rowData.kindText, 'kind-cell'));
        break;
      case 'label': {
        const labelCell = textCell(rowData.labelText, 'label-cell');
        if (rowData.labelColor) {
          const dot = document.createElement('span');
          dot.className = 'label-color-dot';
          dot.style.background = rowData.labelColor;
          labelCell.prepend(dot);
        }
        tableRow.appendChild(labelCell);
        break;
      }
      case 'data':
        tableRow.appendChild(textCell(formatCoordinatesCell(rowData.vertices, coordinatePadWidth), 'data-cell'));
        break;
      case 'frame':
        tableRow.appendChild(textCell(rowData.framesText, 'frame-cell'));
        break;
      case 'metadata': {
        const metadataCell = textCell(rowData.metadataText, 'metadata-cell');
        const editButton = document.createElement('button');
        editButton.type = 'button';
        editButton.className = 'edit-metadata-button';
        editButton.title = 'Edit metadata';
        editButton.textContent = '✎';
        editButton.addEventListener('click', (event) => {
          event.stopPropagation();   // editing must not also select / jump
          openMetadataEditor(app, rowData.item);
        });
        metadataCell.prepend(editButton);
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

/** "key: value" per line. Text that would read back as a number or true/false
    is quoted, so the editor round-trips it as text. */
export function formatMetadata(metadata) {
  return Object.entries(metadata ?? {})
    .map(([key, value]) => `${key}: ${typeof value === 'string' && typeof parseMetadataValue(value) !== 'string'
      ? JSON.stringify(value) : value}`)
    .join('\n');
}

/** A value typed in the editor: true/false, a number, "quoted text", or text. */
function parseMetadataValue(text) {
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text)) return Number(text);
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try { return JSON.parse(text); } catch { /* not a JSON string: keep as typed */ }
  }
  return text;
}

/** The editor's text as metadata; throws Error with a message for the user. */
export function parseMetadataText(text) {
  const metadata = {};
  for (const [index, rawLine] of text.split('\n').entries()) {
    const line = rawLine.trim();
    if (line === '') continue;
    const separator = line.indexOf(':');
    if (separator <= 0) throw new Error(`Line ${index + 1} needs the form "key: value".`);
    const key = line.slice(0, separator).trim();
    if (key in metadata) throw new Error(`"${key}" appears twice.`);
    metadata[key] = parseMetadataValue(line.slice(separator + 1).trim());
  }
  return metadata;
}

let metadataDialog = null;

function openMetadataEditor(app, item) {
  if (metadataDialog === null) {
    metadataDialog = document.createElement('dialog');
    metadataDialog.className = 'settings-dialog metadata-dialog';
    metadataDialog.innerHTML = `
      <h2>Metadata</h2>
      <p class="metadata-hint">One <code>key: value</code> per line. Numbers and true/false are
        stored as such; put a value in quotes to keep it as text.</p>
      <textarea class="metadata-text" rows="6" spellcheck="false"></textarea>
      <p class="metadata-error" hidden></p>
      <div class="metadata-buttons">
        <button type="button" class="metadata-cancel">Cancel</button>
        <button type="button" class="metadata-save">Save</button>
      </div>`;
    document.body.appendChild(metadataDialog);
    metadataDialog.querySelector('.metadata-cancel').addEventListener('click', () => metadataDialog.close());
  }
  const textArea = metadataDialog.querySelector('.metadata-text');
  const errorElement = metadataDialog.querySelector('.metadata-error');
  const saveButton = metadataDialog.querySelector('.metadata-save');
  textArea.value = formatMetadata(item.metadata);
  errorElement.hidden = true;
  const save = () => {
    let after;
    try {
      after = parseMetadataText(textArea.value);
    } catch (error) {
      errorElement.textContent = error.message;
      errorElement.hidden = false;
      return;
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
  // Command/Control+Enter saves without reaching for the mouse.
  textArea.onkeydown = (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); save(); }
  };
  metadataDialog.showModal();
  textArea.focus();
}
