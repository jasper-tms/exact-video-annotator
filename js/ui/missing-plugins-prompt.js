// The box shown when a document about to open (an imported file, or
// annotations restored from this browser) has layers made by plugins that are
// not loaded. Instead of opening those layers as plain layers straight away, it
// names the plugins and offers the one next step that can bring them in:
//
//   1. Reconnect GitHub  — a private-repository plugin in the plugins list is
//                          waiting for the GitHub connection (never made here,
//                          expired, or refused).
//   2. Log in            — signed out, and a plugin is not in this browser's
//                          plugins list: the list is saved to the account, so
//                          logging in may bring it (and its plugins).
//   3. Add plugin        — the document names where the plugin comes from but
//                          it is not in the plugins list (adding a private one
//                          leads back to step 1 if GitHub is not connected).
//   4. Open Settings     — none of the above applies (for example the plugin
//                          is in the list but failed to load).
//
// After each step it waits for the plugins to load and looks again, moving on
// to the next step that still applies, and resolves once every plugin is here.
// Cancelling at any point — the "Open as plain layers" button, Escape, or
// backing out of the login or GitHub popup, or closing Settings with a plugin
// still missing — resolves too, and the caller opens the document as it always
// has: the missing plugins' layers become plain layers of their storage type.
//
// resolveMissingPlugins(app, { findMissing, waitForPluginLoads }) where
//   findMissing()         -> [{ id, url, layerNames, error }] for the
//                            document's plugins not registered (url may be
//                            null; error is the last load failure, if any)
//   waitForPluginLoads()  -> a promise settling once no plugin is mid-load

import { isFirebaseConfigured } from '../firebase-config.js';
import { onUserChanged, signInWithGoogle, currentUser } from '../sync/firebase.js';
import { whenPreferencesSynced } from '../sync/sync-engine.js';
import { getInstalledPlugins, addInstalledPlugin } from '../sync/installed-plugins-preference.js';
import { rememberedPluginName } from '../plugins/plugin-loader.js';
import {
  displayPluginAddress, hadSession, hasSession, parsePrivatePluginUrl,
} from '../plugins/private-github-loader.js';

/** The step that can bring in the missing plugins next. */
function nextStep(missing) {
  const installed = getInstalledPlugins();
  const notInstalled = missing.filter((plugin) => !installed.includes(plugin.url));
  // A private plugin already in the list only needs the GitHub connection. So
  // may one whose source is unknown, when private plugins in the list are
  // waiting for it.
  if (!hasSession() && missing.some((plugin) => (plugin.url
    ? installed.includes(plugin.url) && parsePrivatePluginUrl(plugin.url)
    : installed.some((url) => parsePrivatePluginUrl(url))))) return 'reconnect';
  if (notInstalled.length > 0 && isFirebaseConfigured() && !currentUser()) return 'log-in';
  if (notInstalled.some((plugin) => plugin.url)) return 'add';
  if (!hasSession() && missing.some((plugin) => parsePrivatePluginUrl(plugin.url ?? ''))) {
    return 'reconnect';
  }
  return 'settings';
}

function pluginLabel(plugin) {
  return rememberedPluginName({ url: plugin.url, id: plugin.id }) ?? plugin.id;
}

/** Resolves once the signed-in user's preferences (the plugins list among
    them) have been merged in. */
function whenSignedInAndSynced() {
  return new Promise((resolve) => {
    let unsubscribe = null;
    let done = false;
    unsubscribe = onUserChanged((user) => {
      if (!user || done) return;
      done = true;
      // onUserChanged calls back before returning on an already signed-in user.
      queueMicrotask(() => unsubscribe?.());
      resolve(whenPreferencesSynced());
    });
  });
}

export async function resolveMissingPlugins(app, { findMissing, waitForPluginLoads }) {
  if (findMissing().length === 0) return;
  // Plugins still loading from the installed list are not missing; wait for them.
  await waitForPluginLoads();
  let missing = findMissing();
  if (missing.length === 0) return;

  const dialogElement = document.createElement('dialog');
  dialogElement.className = 'settings-dialog missing-plugins-dialog';
  const heading = document.createElement('h2');
  const list = document.createElement('ul');
  list.className = 'missing-plugins-list';
  const stepMessage = document.createElement('p');
  stepMessage.className = 'missing-plugins-step';
  const buttonRow = document.createElement('div');
  buttonRow.className = 'second-media-buttons';
  const plainButton = document.createElement('button');
  plainButton.type = 'button';
  plainButton.textContent = 'Open as plain layers';
  const stepButton = document.createElement('button');
  stepButton.type = 'button';
  stepButton.className = 'second-media-ok';
  buttonRow.append(plainButton, stepButton);
  dialogElement.append(heading, list, stepMessage, buttonRow);
  document.body.appendChild(dialogElement);

  let step = null;
  function render() {
    heading.textContent = missing.length === 1 ? 'Plugin not loaded' : 'Plugins not loaded';
    list.replaceChildren();
    for (const plugin of missing) {
      const item = document.createElement('li');
      const name = document.createElement('strong');
      name.textContent = pluginLabel(plugin);
      item.append(name);
      if (name.textContent !== plugin.id) item.append(` (${plugin.id})`);
      const layers = plugin.layerNames.map((layerName) => `“${layerName}”`).join(', ');
      item.append(` — needed by layer${plugin.layerNames.length === 1 ? '' : 's'} ${layers}`);
      if (plugin.url) {
        const source = document.createElement('div');
        source.className = 'missing-plugins-source';
        source.textContent = `from ${displayPluginAddress(plugin.url)}`;
        item.append(source);
      }
      list.appendChild(item);
    }

    step = nextStep(missing);
    const them = missing.length === 1 ? 'it' : 'them';
    if (step === 'log-in') {
      stepMessage.textContent = 'Your plugins list is saved to your account. '
        + `Log in to bring it here and load ${them}.`;
      stepButton.textContent = 'Log in';
    } else if (step === 'add') {
      stepMessage.textContent = `${missing.length === 1 ? 'It is' : 'They are'} not in your `
        + 'plugins list. Adding a plugin lets it run its own code here, with access to your '
        + 'annotations, so only add one from a source you trust.';
      stepButton.textContent = missing.length === 1 ? 'Add plugin' : 'Add plugins';
    } else if (step === 'reconnect') {
      stepMessage.textContent = hadSession()
        ? 'Your GitHub connection has expired. Reconnect to load your private plugins.'
        : 'Connect GitHub to load your private plugins.';
      stepButton.textContent = hadSession() ? 'Reconnect GitHub' : 'Connect GitHub';
    } else {
      const errors = missing.filter((plugin) => plugin.error)
        .map((plugin) => `${pluginLabel(plugin)}: ${plugin.error}`);
      stepMessage.textContent = (errors.length ? `It did not load (${errors.join('; ')}). ` : '')
        + 'Open Settings and check your plugins list.';
      stepButton.textContent = 'Open Settings';
    }
    stepButton.disabled = false;
    stepButton.focus();
  }

  /** Carry out the current step. Resolves to false if the user backed out. */
  async function runStep() {
    if (step === 'log-in') {
      try { await signInWithGoogle(); } catch { return false; }
      await whenSignedInAndSynced();
    } else if (step === 'add') {
      const installed = getInstalledPlugins();
      for (const plugin of missing) {
        if (plugin.url && !installed.includes(plugin.url)) addInstalledPlugin(plugin.url);
      }
    } else if (step === 'reconnect') {
      if (!await app.reconnectGitHub()) return false;
    } else {
      // Settings opens over this box; a plugin added or reconnected there loads
      // while it is open.
      app.openSettings({ flashPlugins: true });
      await app.whenSettingsClosed();
    }
    await waitForPluginLoads();
    return true;
  }

  render();
  await new Promise((resolve) => {
    const finish = () => {
      dialogElement.close();
      dialogElement.remove();
      resolve();
    };
    plainButton.addEventListener('click', finish);
    // Escape cancels, the same as the plain-layers button.
    dialogElement.addEventListener('cancel', (event) => { event.preventDefault(); finish(); });
    stepButton.addEventListener('click', async () => {
      const ranStep = step;
      stepButton.disabled = true;
      stepButton.textContent = 'Working…';
      const completed = await runStep();
      missing = findMissing();
      // Done, or backed out of a popup, or Settings closed without fixing it.
      if (missing.length === 0 || !completed || ranStep === 'settings') { finish(); return; }
      render();
    });
    dialogElement.showModal();
    stepButton.focus();
  });
}
