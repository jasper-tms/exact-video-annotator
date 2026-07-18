// A single table of every annotation across all annotation layers — points,
// shapes, and temporal events — with sortable columns, click-to-select /
// jump-to-frame, and a per-row delete button. The table holds no text inputs,
// so it is safe to rebuild wholesale on document/layer/selection changes; only
// the per-frame highlight is updated cheaply (toggling a class) as playback
// moves, never a full rebuild.

const COLUMNS = [
  { key: 'layer', label: 'Layer' },
  { key: 'kind', label: 'Kind' },
  { key: 'label', label: 'Label' },
  { key: 'frame', label: 'Frame(s)' },
];

export function initializeAnnotationsTable(app, containerElement) {
  containerElement.innerHTML = `
    <h2 class="annotations-heading">0 annotations</h2>
    <div class="annotations-scroll">
      <table class="annotations-table">
        <thead>
          <tr>
            ${COLUMNS.map((column) =>
              `<th data-column="${column.key}" class="sortable">${column.label}</th>`).join('')}
            <th class="delete-column"></th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
  `;

  const heading = containerElement.querySelector('.annotations-heading');
  const headerCells = [...containerElement.querySelectorAll('th[data-column]')];
  const tableBody = containerElement.querySelector('.annotations-table tbody');

  // Multi-key sort with recency, in the spirit of the reference tool: the most
  // recently clicked column is primary, earlier clicks act as tiebreakers.
  // Default: frame ascending.
  const sortRecency = ['frame', 'layer', 'kind', 'label'];
  const sortDirection = { layer: 1, kind: 1, label: 1, frame: 1 };

  // Rows currently rendered, kept so 'frame-changed' can re-highlight cheaply
  // without rebuilding: each entry pairs a <tr> with a frame-membership test.
  let renderedRows = [];

  for (const headerCell of headerCells) {
    headerCell.addEventListener('click', () => {
      const column = headerCell.dataset.column;
      if (sortRecency[0] === column) {
        sortDirection[column] *= -1;   // re-click the primary column: flip it
      } else {
        sortRecency.splice(sortRecency.indexOf(column), 1);
        sortRecency.unshift(column);
      }
      rebuild();
    });
  }

  function collectRows() {
    const rows = [];
    for (const layer of app.annotationLayers) {
      for (const item of layer.items) {
        rows.push(describeItem(app, layer, item));
      }
    }
    return rows;
  }

  function compareRows(a, b) {
    for (const column of sortRecency) {
      const result = compareByColumn(column, a, b) * sortDirection[column];
      if (result !== 0) return result;
    }
    return 0;
  }

  function rebuild() {
    const rows = collectRows();
    rows.sort(compareRows);

    heading.textContent = `${rows.length} annotation${rows.length === 1 ? '' : 's'}`;

    for (const headerCell of headerCells) {
      const column = headerCell.dataset.column;
      const isPrimary = sortRecency[0] === column;
      headerCell.classList.toggle('sorted', isPrimary);
      headerCell.dataset.direction = isPrimary
        ? (sortDirection[column] > 0 ? 'ascending' : 'descending')
        : '';
    }

    tableBody.textContent = '';
    renderedRows = [];

    if (rows.length === 0) {
      const emptyRow = document.createElement('tr');
      const cell = document.createElement('td');
      cell.className = 'empty-message';
      cell.colSpan = COLUMNS.length + 1;
      cell.textContent = 'No annotations yet.';
      emptyRow.appendChild(cell);
      tableBody.appendChild(emptyRow);
      return;
    }

    const currentFrame = app.currentFrame;
    for (const rowData of rows) {
      const tableRow = buildTableRow(app, rowData);
      if (isRowSelected(app, rowData)) tableRow.classList.add('selected');
      tableRow.classList.toggle('at-current-frame', rowData.includesFrame(currentFrame));
      tableBody.appendChild(tableRow);
      renderedRows.push({ element: tableRow, includesFrame: rowData.includesFrame });
    }
  }

  function updateCurrentFrameHighlight() {
    const currentFrame = app.currentFrame;
    for (const { element, includesFrame } of renderedRows) {
      element.classList.toggle('at-current-frame', includesFrame(currentFrame));
    }
  }

  app.addEventListener('document-changed', rebuild);
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
function describeItem(app, layer, item) {
  if (layer.type === 'events') return describeEvent(app, layer, item);
  return describeSpatialItem(app, layer, item);
}

function describeSpatialItem(app, layer, item) {
  const kind = layer.type === 'shapes' ? item.kind : 'point';
  const className = findName(app.annotationDocument.classes, item.classId);
  return {
    layerId: layer.id,
    itemId: item.id,
    isEvent: false,
    frame: item.frame,
    layerName: layer.name,
    kindText: kind,
    labelText: className ?? item.name ?? '',
    framesText: String(item.frame),
    includesFrame: (frame) => frame === item.frame,
    selectable: true,
  };
}

function describeEvent(app, layer, item) {
  const eventType = app.annotationDocument.eventTypes.find((type) => type.id === item.eventTypeId);
  const eventTypeName = eventType?.name ?? '(unknown event type)';
  const inProgress = item.endFrame === null;
  return {
    layerId: layer.id,
    itemId: item.id,
    isEvent: true,
    frame: item.startFrame,
    layerName: layer.name,
    kindText: eventTypeName,
    labelText: '',
    framesText: formatEventFrames(item),
    includesFrame: (frame) => frame >= item.startFrame
      && (inProgress || frame <= item.endFrame),
    selectable: false,
  };
}

function formatEventFrames(item) {
  if (item.endFrame === null) return `${item.startFrame} – recording…`;
  if (item.endFrame === item.startFrame) return String(item.startFrame);
  return `${item.startFrame}–${item.endFrame}`;
}

/* ---------- Row rendering ---------- */

function buildTableRow(app, rowData) {
  const tableRow = document.createElement('tr');

  tableRow.appendChild(textCell(rowData.layerName, 'layer-cell'));
  tableRow.appendChild(textCell(rowData.kindText, 'kind-cell'));
  tableRow.appendChild(textCell(rowData.labelText, 'label-cell'));
  tableRow.appendChild(textCell(rowData.framesText, 'frame-cell'));

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
  app.seekToFrame(rowData.frame);
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
    case 'frame': return a.frame - b.frame;
    case 'layer': return compareText(a.layerName, b.layerName);
    case 'kind': return compareText(a.kindText, b.kindText);
    case 'label': return compareText(a.labelText, b.labelText);
    default: return 0;
  }
}

function compareText(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/* ---------- Helpers ---------- */

function findName(entries, id) {
  if (id === null || id === undefined) return null;
  return entries.find((entry) => entry.id === id)?.name ?? null;
}
