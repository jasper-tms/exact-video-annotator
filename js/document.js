// The annotation document: the single source of truth for every annotation,
// class, and event type. Each annotation layer carries its own label registry
// (a coordinates layer its `classes`, a frames layer its `eventTypes`), and
// view layers hold references INTO this structure (their `items` and registry
// arrays are the same objects), so serializing the document captures
// everything. See ARCHITECTURE.md for the full shape.

export const DOCUMENT_FORMAT = 'exact-video-annotator';
export const DOCUMENT_VERSION = 2;
// Version 1 kept one document-wide `classes` and `eventTypes` list; it is
// still read, by copying those lists into the layers (see migrateVersion1).
const READABLE_VERSIONS = [1, 2];

// A short prose note, written into every export, telling a reader who has only
// the file (and no knowledge of this format) the conventions they cannot
// recover from the data alone: the [x, y] axis order and how `frame` is
// indexed. Emitted fresh from this constant on each export, so it can never
// drift from the code. Kept deliberately terse — it ships in every file.
export const DOCUMENT_CONVENTIONS =
  "Vertices are [x, y] pixels (x from left, y from top). 'frame' is a 0-based frame index; null = all frames.";

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
    // Whether an integer (x, y) names a pixel's top-left corner (0, the
    // default) or its center (0.5) — see the video layer's draw(), the only
    // place this is consulted. Locked in the UI once any coordinates
    // annotation exists, since changing it after the fact would silently
    // re-register every stored (x, y) against a different pixel grid.
    integerCoordinateOffset: 0,
    layers: [
      { id: newId(), type: 'coordinates', name: 'Coordinates', visible: true, opacity: 1,
        transform: { scale: 1, offsetX: 0, offsetY: 0 }, allowFractionalCoordinates: false,
        classes: [], items: [] },
      { id: newId(), type: 'frames', name: 'Frames', visible: true, opacity: 1,
        transform: { scale: 1, offsetX: 0, offsetY: 0 }, eventTypes: [], items: [] },
    ],
  };
}

/* ---------- Serialization ---------- */

export function documentToJson(annotationDocument, videoInformation = null) {
  return {
    format: DOCUMENT_FORMAT,
    version: DOCUMENT_VERSION,
    conventions: DOCUMENT_CONVENTIONS,
    video: videoInformation ?? annotationDocument.video ?? null,
    integerCoordinateOffset: annotationDocument.integerCoordinateOffset ?? 0,
    layers: annotationDocument.layers.map(({ items, ...settings }) => ({
      // The layer's settings and label registry first, its items last.
      ...settings,
      // Never export an in-progress range event (endFrame === null).
      items: settings.type === 'frames'
        ? items.filter((item) => item.endFrame !== null)
        : items,
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
  if (!READABLE_VERSIONS.includes(jsonObject.version)) {
    throw new Error(`Unsupported document version ${jsonObject.version} `
      + `(this app reads versions ${READABLE_VERSIONS.join(' and ')}).`);
  }
  if (jsonObject.version === 1) jsonObject = migrateVersion1(jsonObject);

  const integerCoordinateOffset = jsonObject.integerCoordinateOffset ?? 0;
  if (integerCoordinateOffset !== 0 && integerCoordinateOffset !== 0.5) {
    throw new Error(`Unsupported integerCoordinateOffset ${integerCoordinateOffset} (expected 0 or 0.5).`);
  }

  const annotationDocument = {
    video: jsonObject.video ?? null,
    integerCoordinateOffset,
    layers: [],
  };

  for (const layer of asArray(jsonObject.layers, 'layers')) {
    if (!['coordinates', 'segmentation', 'frames'].includes(layer.type)) {
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
    if (layer.type === 'coordinates') {
      parsedLayer.classes = asArray(layer.classes ?? [], `classes of layer "${parsedLayer.name}"`)
        .map(parseClass);
      parsedLayer.allowFractionalCoordinates = layer.allowFractionalCoordinates === true;
      // Left out when the file doesn't say, so the layer (or its plugin) picks
      // the default rather than this parser.
      if (layer.offFrameOpacity !== undefined) {
        parsedLayer.offFrameOpacity = clampNumber(layer.offFrameOpacity, 0, 1);
      }
    }
    if (layer.type === 'frames') {
      parsedLayer.eventTypes = asArray(layer.eventTypes ?? [], `event types of layer "${parsedLayer.name}"`)
        .map(parseEventType);
    }
    // A plugin layer stores its annotations as the plain type above and names
    // its plugin here, so a build without that plugin can still read the file.
    if (layer.plugin !== undefined && layer.plugin !== null) {
      parsedLayer.plugin = {
        id: asString(layer.plugin.id, 'layer plugin id'),
        // The folder the plugin was loaded from (absent for built-in plugins),
        // so a reader that lacks the plugin can say where to get it.
        ...(typeof layer.plugin.url === 'string' ? { url: layer.plugin.url } : {}),
        options: (typeof layer.plugin.options === 'object' && layer.plugin.options !== null)
          ? { ...layer.plugin.options }
          : {},
      };
    }
    for (const item of asArray(layer.items ?? [], `items of layer "${parsedLayer.name}"`)) {
      parsedLayer.items.push(parseItem(layer.type, item));
    }
    annotationDocument.layers.push(parsedLayer);
  }

  return annotationDocument;
}

function parseClass(entry) {
  return {
    id: asString(entry.id, 'class id'),
    name: asString(entry.name, 'class name'),
    color: asString(entry.color, 'class color'),
  };
}

function parseEventType(entry) {
  if (entry.kind !== 'point' && entry.kind !== 'range') {
    throw new Error(`Event type "${entry.name}" has kind "${entry.kind}"; expected "point" or "range".`);
  }
  return {
    id: asString(entry.id, 'event type id'),
    name: asString(entry.name, 'event type name'),
    kind: entry.kind,
    color: asString(entry.color, 'event type color'),
    addHotkey: entry.addHotkey ?? null,
    removeHotkey: entry.removeHotkey ?? null,
  };
}

/** A version 1 file as version 2, with the document-wide classes copied into
    the coordinates layers and the event types into the frames layers. The
    only layer of its type gets the whole list. When there are several, each
    gets the entries its own items use, or the whole list if it uses none, so
    an empty layer keeps the labels it was set up with. */
function migrateVersion1(jsonObject) {
  const { classes = [], eventTypes = [], ...rest } = jsonObject;
  const layers = asArray(jsonObject.layers, 'layers');
  const registryFor = (layer, entries, referenceKey) => {
    const isOnlyLayerOfItsType = layers.filter((other) => other.type === layer.type).length === 1;
    const usedIds = new Set((Array.isArray(layer.items) ? layer.items : [])
      .map((item) => item[referenceKey]));
    const used = asArray(entries, `version 1 ${referenceKey} registry`)
      .filter((entry) => usedIds.has(entry.id));
    return (isOnlyLayerOfItsType || used.length === 0 ? entries : used).map((entry) => ({ ...entry }));
  };
  return {
    ...rest,
    version: 2,
    layers: layers.map((layer) => {
      if (layer.type === 'coordinates') {
        return { ...layer, classes: registryFor(layer, classes, 'classId') };
      }
      if (layer.type === 'frames') {
        return { ...layer, eventTypes: registryFor(layer, eventTypes, 'eventTypeId') };
      }
      return layer;
    }),
  };
}

function parseItem(layerType, item) {
  const id = asString(item.id ?? newId(), 'item id');
  if (layerType === 'coordinates') {
    if (item.kind !== 'point' && item.kind !== 'line' && item.kind !== 'polyline') {
      throw new Error(`Coordinates item has kind "${item.kind}"; expected "point", "line", or "polyline".`);
    }
    const vertices = asArray(item.vertices, 'coordinates vertices').map((vertex, index) => {
      if (!Array.isArray(vertex) || vertex.length !== 2) {
        throw new Error(`Vertex ${index} is not an [x, y] pair.`);
      }
      return [finiteNumber(vertex[0], 'vertex x'), finiteNumber(vertex[1], 'vertex y')];
    });
    // A polyline may be as short as a line (2 vertices, open); whether it is
    // closed is read from the vertices themselves (see isClosedPolyline), not
    // enforced here.
    const minimumVertices = item.kind === 'point' ? 1 : 2;
    if (vertices.length < minimumVertices) {
      throw new Error(`A ${item.kind} needs at least ${minimumVertices} vertices; found ${vertices.length}.`);
    }
    return {
      id,
      frame: integerOrNull(item.frame, 'coordinates frame'),
      kind: item.kind,
      vertices,
      classId: item.classId ?? null,
      name: item.name ?? null,
      metadata: parseMetadata(item.metadata),
    };
  }
  if (layerType === 'segmentation') {
    // Nothing produces segmentation items yet — this stub layer type should
    // never actually be handed any.
    throw new Error('Segmentation layer items are not yet supported.');
  }
  // frames
  return {
    id,
    eventTypeId: asString(item.eventTypeId, 'event type id reference'),
    startFrame: integerNumber(item.startFrame, 'event startFrame'),
    endFrame: integerNumber(item.endFrame, 'event endFrame'),
    metadata: parseMetadata(item.metadata),
  };
}

/** An item's metadata: key → text. Missing means none. Every value is text;
    a number or true/false (which files and plugins once wrote) is read as
    its text, so `court: 2` becomes `court: "2"`. */
export function parseMetadata(metadata) {
  if (metadata === undefined || metadata === null) return {};
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Expected item metadata to be an object of key-value pairs.');
  }
  const parsed = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!(typeof value === 'string' || typeof value === 'boolean'
          || (typeof value === 'number' && Number.isFinite(value)))) {
      throw new Error(`Metadata "${key}" must be text.`);
    }
    parsed[key] = String(value);
  }
  return parsed;
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

/* ---------- Saving in the browser (localStorage, on the Save button) ---------- */

// The names keep "autosave" so annotations saved before saving became manual
// still restore.

const AUTOSAVE_PREFIX = 'exact-video-annotator.autosave.';

/** Key an autosave to the video's identity: name plus byte size. */
export function autosaveKey(videoInformation) {
  return `${AUTOSAVE_PREFIX}${videoInformation.name}.${videoInformation.sizeBytes ?? 'unknown-size'}`;
}

/** Returns whether the save succeeded (false when storage is full or disabled). */
export function saveAutosave(key, annotationDocument, videoInformation) {
  try {
    localStorage.setItem(key, JSON.stringify({
      savedAt: new Date().toISOString(),
      document: documentToJson(annotationDocument, videoInformation),
    }));
    return true;
  } catch {
    return false;
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
