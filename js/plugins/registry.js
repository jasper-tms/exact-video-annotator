// The plugin registry: annotation layers that carry extra annotation logic.
//
// A plugin is a layer type with behavior bolted on. It reuses one of the built-
// in annotation layer types for its storage (so its annotations stay ordinary
// points/shapes/events in the exported JSON), adds hooks that the drawing tools
// and drag helpers call at the right moments, and contributes its own settings
// to the layer detail panel.
//
// A plugin descriptor:
//
//   {
//     id, name, description,
//     layerType: 'coordinates' | 'segmentation' | 'frames',  // storage and tool targeting
//     preferredToolId,                             // selected when a layer is added
//     createViewLayer(documentLayer, app) → Layer, // gets `plugin: {id, options}`
//     buildSettings(app, layer) → HTMLElement,     // shown in the layer panel
//   }
//
// The layer it builds may implement any of the optional annotation-logic hooks
// documented in ARCHITECTURE.md (shouldFinishAfterVertex, afterVertexPlaced,
// beforeShapeCommitted, afterItemDragged, refitItem).

import { lineFitterPlugin } from './line-fitter/plugin.js';

// Plugins that ship with the app. Uploaded plugins will join this list once
// the ＋ menu's "Upload…" entry is wired up.
const BUILT_IN_PLUGINS = [lineFitterPlugin];

/** Every plugin available in the ＋ menu, in listing order. */
export function listPlugins() {
  return [...BUILT_IN_PLUGINS];
}

/** The plugin with this id, or null when a document names one we do not have. */
export function findPlugin(pluginId) {
  return BUILT_IN_PLUGINS.find((plugin) => plugin.id === pluginId) ?? null;
}
