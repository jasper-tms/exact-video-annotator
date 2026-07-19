// The annotation document: the single source of truth for every annotation,
// class, and event type. Annotation layers hold references INTO this
// structure (their `items` arrays are the same objects), so serializing the
// document captures everything. See ARCHITECTURE.md for the full shape.

export const DOCUMENT_FORMAT = 'exact-video-annotator';
export const DOCUMENT_VERSION = 1;

let nextIdNumber = 1;

/** Unique, collision-resistant id for items, classes, layers. */
export function newId() {
  return `${Date.now().toString(36)}-${(nextIdNumber++).toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

const DEFAULT_CLASS_COLORS = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
  '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990',
];

/** Pick a color not yet used by the given classes/event types, cycling. */
export function nextUnusedColor(existingEntries) {
  const used = new Set(existingEntries.map((entry) => entry.color));
  return DEFAULT_CLASS_COLORS.find((color) => !used.has(color))
    ?? DEFAULT_CLASS_COLORS[existingEntries.length % DEFAULT_CLASS_COLORS.length];
}

export function createEmptyDocument() {
  return {
    video: null,   // provenance, filled at export time
    classes: [],
    eventTypes: [],
    layers: [
      { id: newId(), type: 'points', name: 'Points', visible: true, opacity: 1,
        transform: { scale: 1, offsetX: 0, offsetY: 0 }, items: [] },
      { id: newId(), type: 'shapes', name: 'Shapes', visible: true, opacity: 1,
        transform: { scale: 1, offsetX: 0, offsetY: 0 }, items: [] },
      { id: newId(), type: 'events', name: 'Events', visible: true, opacity: 1,
        transform: { scale: 1, offsetX: 0, offsetY: 0 }, items: [] },
    ],
  };
}

/* ---------- Serialization ---------- */

export function documentToJson(annotationDocument, videoInformation = null) {
  return {
    format: DOCUMENT_FORMAT,
    version: DOCUMENT_VERSION,
    video: videoInformation ?? annotationDocument.video ?? null,
    classes: annotationDocument.classes,
    eventTypes: annotationDocument.eventTypes,
    layers: annotationDocument.layers.map((layer) => ({
      ...layer,
      // Never export an in-progress range event (endFrame === null).
      items: layer.type === 'events'
        ? layer.items.filter((item) => item.endFrame !== null)
        : layer.items,
    })),
  };
}

/** Parse and validate; throws Error with a human-readable message on bad input. */
export function documentFromJson(jsonObject) {
  if (typeof jsonObject !== 'object' || jsonObject === null) {
    throw new Error('Not a JSON object.');
  }
  if (jsonObject.format !== DOCUMENT_FORMAT) {
    throw new Error(`Not an ${DOCUMENT_FORMAT} file (format: ${jsonObject.format ?? 'missing'}).`);
  }
  if (jsonObject.version !== DOCUMENT_VERSION) {
    throw new Error(`Unsupported document version ${jsonObject.version} (this app reads version ${DOCUMENT_VERSION}).`);
  }

  const annotationDocument = {
    video: jsonObject.video ?? null,
    classes: [],
    eventTypes: [],
    layers: [],
  };

  for (const entry of asArray(jsonObject.classes, 'classes')) {
    annotationDocument.classes.push({
      id: asString(entry.id, 'class id'),
      name: asString(entry.name, 'class name'),
      color: asString(entry.color, 'class color'),
    });
  }

  for (const entry of asArray(jsonObject.eventTypes, 'eventTypes')) {
    if (entry.kind !== 'point' && entry.kind !== 'range') {
      throw new Error(`Event type "${entry.name}" has kind "${entry.kind}"; expected "point" or "range".`);
    }
    annotationDocument.eventTypes.push({
      id: asString(entry.id, 'event type id'),
      name: asString(entry.name, 'event type name'),
      kind: entry.kind,
      color: asString(entry.color, 'event type color'),
      addHotkey: entry.addHotkey ?? null,
      removeHotkey: entry.removeHotkey ?? null,
    });
  }

  for (const layer of asArray(jsonObject.layers, 'layers')) {
    if (!['points', 'shapes', 'events'].includes(layer.type)) {
      throw new Error(`Unknown layer type "${layer.type}".`);
    }
    const parsedLayer = {
      id: asString(layer.id ?? newId(), 'layer id'),
      type: layer.type,
      name: asString(layer.name ?? layer.type, 'layer name'),
      visible: layer.visible !== false,
      opacity: clampNumber(layer.opacity ?? 1, 0, 1),
      transform: {
        scale: finiteNumber(layer.transform?.scale ?? 1, 'layer transform scale'),
        offsetX: finiteNumber(layer.transform?.offsetX ?? 0, 'layer transform offsetX'),
        offsetY: finiteNumber(layer.transform?.offsetY ?? 0, 'layer transform offsetY'),
      },
      items: [],
    };
    for (const item of asArray(layer.items ?? [], `items of layer "${parsedLayer.name}"`)) {
      parsedLayer.items.push(parseItem(layer.type, item));
    }
    annotationDocument.layers.push(parsedLayer);
  }

  return annotationDocument;
}

function parseItem(layerType, item) {
  const id = asString(item.id ?? newId(), 'item id');
  if (layerType === 'points') {
    return {
      id,
      frame: integerOrNull(item.frame, 'point frame'),
      x: finiteNumber(item.x, 'point x'),
      y: finiteNumber(item.y, 'point y'),
      classId: item.classId ?? null,
      name: item.name ?? null,
    };
  }
  if (layerType === 'shapes') {
    if (item.kind !== 'polygon' && item.kind !== 'line') {
      throw new Error(`Shape has kind "${item.kind}"; expected "polygon" or "line".`);
    }
    const vertices = asArray(item.vertices, 'shape vertices').map((vertex, index) => {
      if (!Array.isArray(vertex) || vertex.length !== 2) {
        throw new Error(`Shape vertex ${index} is not an [x, y] pair.`);
      }
      return [finiteNumber(vertex[0], 'vertex x'), finiteNumber(vertex[1], 'vertex y')];
    });
    const minimumVertices = item.kind === 'polygon' ? 3 : 2;
    if (vertices.length < minimumVertices) {
      throw new Error(`A ${item.kind} needs at least ${minimumVertices} vertices; found ${vertices.length}.`);
    }
    return {
      id,
      frame: integerOrNull(item.frame, 'shape frame'),
      kind: item.kind,
      vertices,
      classId: item.classId ?? null,
      name: item.name ?? null,
    };
  }
  // events
  return {
    id,
    eventTypeId: asString(item.eventTypeId, 'event type id reference'),
    startFrame: integerNumber(item.startFrame, 'event startFrame'),
    endFrame: integerNumber(item.endFrame, 'event endFrame'),
  };
}

/* ---------- Validation helpers ---------- */

function asArray(value, description) {
  if (!Array.isArray(value)) throw new Error(`Expected ${description} to be an array.`);
  return value;
}
function asString(value, description) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Expected ${description} to be a non-empty string.`);
  }
  return value;
}
function finiteNumber(value, description) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Expected ${description} to be a finite number.`);
  }
  return value;
}
function integerNumber(value, description) {
  if (!Number.isInteger(value)) throw new Error(`Expected ${description} to be an integer.`);
  return value;
}
/** An integer frame index, or null for a frame-agnostic (all-frames) item. */
function integerOrNull(value, description) {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value)) {
    throw new Error(`Expected ${description} to be an integer or null.`);
  }
  return value;
}
function clampNumber(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

/* ---------- Autosave (localStorage) ---------- */

const AUTOSAVE_PREFIX = 'exact-video-annotator.autosave.';

/** Key an autosave to the video's identity: name plus byte size. */
export function autosaveKey(videoInformation) {
  return `${AUTOSAVE_PREFIX}${videoInformation.name}.${videoInformation.sizeBytes ?? 'unknown-size'}`;
}

export function saveAutosave(key, annotationDocument, videoInformation) {
  try {
    localStorage.setItem(key, JSON.stringify({
      savedAt: new Date().toISOString(),
      document: documentToJson(annotationDocument, videoInformation),
    }));
  } catch {
    // Quota exceeded or storage disabled — autosave is best-effort by design.
  }
}

export function loadAutosave(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return { savedAt: parsed.savedAt, document: documentFromJson(parsed.document) };
  } catch {
    return null;
  }
}

export function clearAutosave(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}
