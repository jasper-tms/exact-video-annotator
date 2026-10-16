// Loading plugins from a URL
// ==========================
//
// A plugin is a folder (in a git repository, on a static host, or on a local
// development server) holding a `plugin.json` manifest and an ES module entry:
//
//   plugin.json   { "manifestVersion": 1, "id": "…", "name": "…", "version": "…",
//                   "entry": "./index.js", "hostApiVersion": 1 }
//   index.js      export default function createPlugin(host) { return descriptor; }
//
// The entry's default export is a factory that receives the host API (below)
// and returns a plugin descriptor of the shape registry.js documents. Plugins
// get everything from the host through that object instead of importing the
// app's files, so they don't depend on its internal file layout; their own
// imports are only of their own sibling files, which resolve against the
// folder URL.
//
// Folder URLs of private GitHub repositories (canonical
// https://plugins.examine.video/gh/… URLs, see private-github-loader.js) are
// fetched through a fresh session-token URL; any other URL is used as is, so
// it must serve JavaScript with CORS headers allowing this app's origin. A
// private folder with no live GitHub connection fails with a
// GitHubConnectionNeededError, which the app answers by asking the user to
// reconnect rather than by reporting an error.

import { Layer } from '../layers/layer.js';
import { CoordinatesLayer } from '../layers/coordinates-layer.js';
import { SegmentationLayer } from '../layers/segmentation-layer.js';
import { FramesLayer } from '../layers/frames-layer.js';
import { newId } from '../document.js';
import { createFloatingWindow } from '../ui/floating-window.js';
import { registerPlugin } from './registry.js';
import {
  authorizedPluginBaseUrl, hasSession, markSessionRefused, parsePrivatePluginUrl,
} from './private-github-loader.js';

/** The host API's major version; a plugin's manifest names the one it was
    written against, and a mismatch is refused rather than half-loaded. */
export const HOST_API_VERSION = 1;

const PLUGIN_NAMES_KEY = 'exact-video-annotator.pluginNames';

/** Thrown for a private plugin when the GitHub connection is missing, expired
    or refused, so the caller can offer to reconnect instead of an error. */
export class GitHubConnectionNeededError extends Error {
  constructor(folderUrl) {
    super('the GitHub connection has expired or was never made here');
    this.name = 'GitHubConnectionNeededError';
    this.folderUrl = folderUrl;
  }
}

/** The display name of a plugin this browser has loaded before, looked up by
    its folder URL or its id; null if it never loaded here. Lets messages name a
    plugin that cannot be fetched right now. */
export function rememberedPluginName({ url = null, id = null } = {}) {
  let names = {};
  try { names = JSON.parse(localStorage.getItem(PLUGIN_NAMES_KEY)) ?? {}; } catch { /* none */ }
  const folderUrl = url ? normalizePluginFolderUrl(url) : null;
  return (folderUrl && names[`url:${folderUrl}`]) || (id && names[`id:${id}`]) || null;
}

/** The folder URL a plugin with this id last loaded from in this browser, or
    null — for a document that names a plugin's id but not where it comes from. */
export function rememberedPluginUrl(id) {
  try { return JSON.parse(localStorage.getItem(PLUGIN_NAMES_KEY))?.[`folder:${id}`] ?? null; } catch { return null; }
}

function rememberPluginName(folderUrl, id, name) {
  try {
    const names = JSON.parse(localStorage.getItem(PLUGIN_NAMES_KEY)) ?? {};
    names[`folder:${id}`] = folderUrl;
    if (typeof name === 'string' && name) {
      names[`url:${folderUrl}`] = name;
      names[`id:${id}`] = name;
    }
    localStorage.setItem(PLUGIN_NAMES_KEY, JSON.stringify(names));
  } catch { /* not remembered; messages fall back to the id */ }
}

/** A folder URL with exactly one trailing slash, so relative URLs resolve inside it. */
export function normalizePluginFolderUrl(url) {
  const trimmed = url.trim();
  // Accept a link to the manifest or entry file too, by dropping the file name.
  const folder = /\.(json|js|mjs)$/i.test(trimmed) ? trimmed.replace(/[^/]*$/, '') : trimmed;
  return folder.replace(/\/+$/, '') + '/';
}

/** Where to fetch a plugin folder's files from: a private-repository folder
    gets the current GitHub session token spliced in. */
function fetchableFolderUrl(folderUrl) {
  const privateParts = parsePrivatePluginUrl(folderUrl);
  if (!privateParts) return folderUrl;
  if (!hasSession()) throw new GitHubConnectionNeededError(folderUrl);
  return authorizedPluginBaseUrl(privateParts);
}

function makeHostApi(app, baseUrl) {
  return {
    hostApiVersion: HOST_API_VERSION,
    baseUrl,
    app,
    layers: { Layer, CoordinatesLayer, SegmentationLayer, FramesLayer },
    newId,
    ui: {
      createFloatingWindow: (options) => createFloatingWindow(app, options),
    },
  };
}

/**
 * Fetch, run and register the plugin in a folder. Resolves to its descriptor;
 * rejects with a readable message when the folder, manifest or entry is wrong.
 */
export async function loadPluginFromUrl(app, url) {
  const folderUrl = normalizePluginFolderUrl(url);
  const baseUrl = fetchableFolderUrl(folderUrl);

  const manifestResponse = await fetch(new URL('plugin.json', baseUrl));
  if (manifestResponse.status === 401 && baseUrl !== folderUrl) {
    markSessionRefused();
    throw new GitHubConnectionNeededError(folderUrl);
  }
  if (!manifestResponse.ok) {
    throw new Error(`no plugin.json at ${folderUrl} (HTTP ${manifestResponse.status})`);
  }
  const manifest = await manifestResponse.json();
  if (manifest.manifestVersion !== 1) {
    throw new Error(`unsupported manifestVersion ${manifest.manifestVersion}`);
  }
  if (manifest.hostApiVersion !== HOST_API_VERSION) {
    throw new Error(`written for host API version ${manifest.hostApiVersion}, `
      + `this app provides ${HOST_API_VERSION}`);
  }
  if (typeof manifest.id !== 'string' || !manifest.id) throw new Error('plugin.json has no id');

  const module = await import(new URL(manifest.entry ?? './index.js', baseUrl).href);
  if (typeof module.default !== 'function') {
    throw new Error('the entry module must default-export a createPlugin(host) function');
  }
  const descriptor = module.default(makeHostApi(app, baseUrl));
  if (descriptor?.id !== manifest.id) {
    throw new Error(`the descriptor's id "${descriptor?.id}" differs from plugin.json's "${manifest.id}"`);
  }
  rememberPluginName(folderUrl, manifest.id, descriptor.name ?? manifest.name);
  registerPlugin(descriptor, { url: folderUrl });
  return descriptor;
}
