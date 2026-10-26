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
// beforeShapeCommitted, afterItemDragged, refitItem, handleCanvasDoubleClick).
//
// Built-in plugins are registered at startup; plugins loaded from a URL (see
// plugin-loader.js) join them at runtime through registerPlugin, which
// announces each arrival on `pluginRegistryEvents` so open documents can
// rebuild layers that were waiting for it.

import { lineFitterPlugin } from './line-fitter/plugin.js';

// Plugins that ship with the app.
const BUILT_IN_PLUGINS = [lineFitterPlugin];

// id → { descriptor, url, fromLink }, in registration order. `url` is the
// folder a plugin was loaded from, or null for a built-in; `fromLink` marks
// one loaded from the page's ?plugin= parameter.
const registeredPlugins = new Map(
  BUILT_IN_PLUGINS.map((plugin) => [plugin.id, { descriptor: plugin, url: null, fromLink: false }]));

/** Fires 'plugin-registered' (detail: { descriptor, url }) when a plugin joins. */
export const pluginRegistryEvents = new EventTarget();

/**
 * Add (or replace, when reloaded) a plugin. A plugin from a ?plugin= link
 * (`fromLink`) wins over one with the same id from anywhere else, whichever
 * finishes loading first, so a link can try out another copy of an installed
 * plugin.
 * @returns {{ registered: boolean, replaced: string | null, kept: string | null }}
 *   whether this plugin is now the one with its id, the folder of the plugin
 *   it replaced (when loaded from another folder), and the folder of the link
 *   plugin kept instead of it.
 */
export function registerPlugin(descriptor, { url = null, fromLink = false } = {}) {
  const existing = registeredPlugins.get(descriptor.id);
  if (existing?.fromLink && !fromLink) return { registered: false, replaced: null, kept: existing.url };
  registeredPlugins.set(descriptor.id, { descriptor, url, fromLink });
  pluginRegistryEvents.dispatchEvent(
    new CustomEvent('plugin-registered', { detail: { descriptor, url } }));
  return { registered: true, replaced: existing && existing.url !== url ? existing.url : null, kept: null };
}

/** Every plugin available in the ＋ menu, in listing order. */
export function listPlugins() {
  return [...registeredPlugins.values()].map((entry) => entry.descriptor);
}

/** The plugin with this id, or null when a document names one we do not have. */
export function findPlugin(pluginId) {
  return registeredPlugins.get(pluginId)?.descriptor ?? null;
}

/** The folder URL a plugin was loaded from, or null (built-in or unknown). */
export function pluginUrl(pluginId) {
  return registeredPlugins.get(pluginId)?.url ?? null;
}
