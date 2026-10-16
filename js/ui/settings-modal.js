// Global settings modal, opened from the toolbar's Settings button. Holds
// preferences that apply across the whole application rather than to any one
// layer or tool: the integer-coordinate convention (a document field) and
// pixel-grid visibility (a localStorage-backed preference, see pixel-grid.js).
// Built once, as a native <dialog>, and reused for every open.

import { isPixelGridEnabled, setPixelGridEnabled } from '../pixel-grid.js';
import { getSecondMediaBehavior, setSecondMediaBehavior } from '../second-media-preference.js';
import { getSyncedPlaybackPacing, setSyncedPlaybackPacing } from '../synced-playback-preference.js';
import { isLoadedFramesHighlightEnabled, setLoadedFramesHighlightEnabled }
  from '../loaded-frames-highlight-preference.js';
import {
  getInstalledPlugins, addInstalledPlugin, removeInstalledPlugin, subscribeInstalledPlugins,
} from '../sync/installed-plugins-preference.js';
import {
  connectPrivateGitHub, installUrl, canonicalPluginUrl, hasSession, hadSession,
  listRepositoryPlugins, parsePrivatePluginUrl, gitHubWebUrl,
} from '../plugins/private-github-loader.js';
import { rememberedPluginName } from '../plugins/plugin-loader.js';
import { pluginRegistryEvents } from '../plugins/registry.js';

export function initializeSettingsModal(app, triggerButtonElement) {
  const dialogElement = document.createElement('dialog');
  dialogElement.className = 'settings-dialog';

  const headingElement = document.createElement('h2');
  headingElement.textContent = 'Settings';
  dialogElement.appendChild(headingElement);

  /* ---- Integer coordinate convention ---- */

  const coordinateRow = document.createElement('div');
  coordinateRow.className = 'settings-row';
  const coordinateLabel = document.createElement('label');
  coordinateLabel.htmlFor = 'integer-coordinate-select';
  coordinateLabel.textContent = 'Integer coordinates are:';
  const coordinateSelect = document.createElement('select');
  coordinateSelect.id = 'integer-coordinate-select';
  for (const [value, text] of [['0', 'Pixel top-left corner'], ['0.5', 'Pixel center']]) {
    const optionElement = document.createElement('option');
    optionElement.value = value;
    optionElement.textContent = text;
    coordinateSelect.appendChild(optionElement);
  }
  coordinateSelect.addEventListener('change', () => {
    app.annotationDocument.integerCoordinateOffset = Number(coordinateSelect.value);
    app.markDocumentChanged();
  });

  // A disabled <select> doesn't reliably dispatch pointer events across
  // browsers, so it can't explain itself when clicked — this transparent
  // overlay sits on top of it (only while locked) purely to catch that click
  // and show why nothing happened.
  const coordinateSelectWrapper = document.createElement('span');
  coordinateSelectWrapper.className = 'coordinate-select-wrapper';
  const coordinateSelectLockOverlay = document.createElement('div');
  coordinateSelectLockOverlay.className = 'coordinate-select-lock-overlay';
  coordinateSelectLockOverlay.addEventListener('click', () => {
    app.showToast("Can't change when coordinate annotations have already been made", { kind: 'warning' });
  });
  coordinateSelectWrapper.append(coordinateSelect, coordinateSelectLockOverlay);

  coordinateRow.append(coordinateLabel, coordinateSelectWrapper);
  dialogElement.appendChild(coordinateRow);

  function reflectIntegerCoordinateSelect() {
    const hasCoordinateAnnotations = app.annotationDocument.layers.some((layer) =>
      layer.type === 'coordinates' && layer.items.length > 0);
    coordinateSelect.value = String(app.annotationDocument.integerCoordinateOffset ?? 0);
    coordinateSelect.disabled = hasCoordinateAnnotations;
    coordinateSelect.title = hasCoordinateAnnotations
      ? 'Locked: delete every coordinates annotation to change this.'
      : 'Whether an integer (x, y) names a pixel\'s top-left corner or its center';
    coordinateSelectLockOverlay.style.display = hasCoordinateAnnotations ? 'block' : 'none';
  }
  app.addEventListener('document-changed', reflectIntegerCoordinateSelect);
  app.addEventListener('layers-changed', reflectIntegerCoordinateSelect);
  reflectIntegerCoordinateSelect();

  /* ---- Second media behavior ---- */

  const secondMediaRow = document.createElement('div');
  secondMediaRow.className = 'settings-row';
  const secondMediaLabel = document.createElement('label');
  secondMediaLabel.htmlFor = 'second-media-select';
  secondMediaLabel.textContent = 'Second media:';
  const secondMediaSelect = document.createElement('select');
  secondMediaSelect.id = 'second-media-select';
  secondMediaSelect.title =
    'What to do when a second video or image is loaded while one is already open';
  for (const [value, text] of [['prompt', 'Prompt'], ['replace', 'Replace'], ['new-layer', 'New layer']]) {
    const optionElement = document.createElement('option');
    optionElement.value = value;
    optionElement.textContent = text;
    secondMediaSelect.appendChild(optionElement);
  }
  secondMediaSelect.value = getSecondMediaBehavior();
  secondMediaSelect.addEventListener('change', () => {
    setSecondMediaBehavior(secondMediaSelect.value);
  });
  secondMediaRow.append(secondMediaLabel, secondMediaSelect);
  dialogElement.appendChild(secondMediaRow);
  // The second-media prompt dialog can persist a fresh choice while this modal
  // is closed, so openSettings() below re-reads this select every time Settings
  // opens (from the toolbar button or the ＋ menu) — it is never left stale.

  /* ---- Synchronized playback pacing ---- */

  const syncedPlaybackRow = document.createElement('div');
  syncedPlaybackRow.className = 'settings-row';
  const syncedPlaybackLabel = document.createElement('label');
  syncedPlaybackLabel.htmlFor = 'synced-playback-select';
  syncedPlaybackLabel.textContent = 'Multi-video playback:';
  const syncedPlaybackSelect = document.createElement('select');
  syncedPlaybackSelect.id = 'synced-playback-select';
  syncedPlaybackSelect.title =
    'When several videos play in sync and the decoders cannot quite keep up, '
    + 'whether to skip frames to hold real-time speed or slow down to show every frame';
  for (const [value, text] of [
    ['realtime', 'Keep real-time speed'], ['every-frame', 'Show every frame']]) {
    const optionElement = document.createElement('option');
    optionElement.value = value;
    optionElement.textContent = text;
    syncedPlaybackSelect.appendChild(optionElement);
  }
  syncedPlaybackSelect.value = getSyncedPlaybackPacing();
  syncedPlaybackSelect.addEventListener('change', () => {
    setSyncedPlaybackPacing(syncedPlaybackSelect.value);
  });
  syncedPlaybackRow.append(syncedPlaybackLabel, syncedPlaybackSelect);
  dialogElement.appendChild(syncedPlaybackRow);

  /* ---- Pixel grid visibility ---- */

  const pixelGridRow = document.createElement('div');
  pixelGridRow.className = 'settings-row';
  const pixelGridLabel = document.createElement('label');
  const pixelGridCheckbox = document.createElement('input');
  pixelGridCheckbox.type = 'checkbox';
  pixelGridCheckbox.checked = isPixelGridEnabled();
  pixelGridCheckbox.addEventListener('change', () => {
    setPixelGridEnabled(pixelGridCheckbox.checked);
    app.viewer.requestRender();
  });
  pixelGridLabel.append(pixelGridCheckbox, ' Show pixel grid when zoomed in');
  pixelGridRow.appendChild(pixelGridLabel);
  dialogElement.appendChild(pixelGridRow);

  /* ---- Loaded-frames timeline highlight ---- */

  const loadedFramesRow = document.createElement('div');
  loadedFramesRow.className = 'settings-row';
  const loadedFramesLabel = document.createElement('label');
  loadedFramesLabel.title =
    'Shade the scrubber where frames are currently held decoded in memory — '
    + 'the range that seeks to instantly. Only meaningful on the WebCodecs engine.';
  const loadedFramesCheckbox = document.createElement('input');
  loadedFramesCheckbox.type = 'checkbox';
  loadedFramesCheckbox.checked = isLoadedFramesHighlightEnabled();
  loadedFramesCheckbox.addEventListener('change', () => {
    setLoadedFramesHighlightEnabled(loadedFramesCheckbox.checked);
  });
  loadedFramesLabel.append(loadedFramesCheckbox, ' Highlight loaded frames on timeline');
  loadedFramesRow.appendChild(loadedFramesLabel);
  dialogElement.appendChild(loadedFramesRow);

  /* ---- Plugins list ---- */

  // The list of "installed" plugins, by URL. This is the authoritative place a
  // user adds or removes one; the ＋ menu's Plugins page sends them here (with a
  // flash on this section) via its "New…" entry. main.js loads every plugin in
  // the list at startup and whenever it changes.
  const pluginsSection = document.createElement('div');
  pluginsSection.className = 'settings-section';
  pluginsSection.id = 'settings-plugins-section';

  const pluginsHeading = document.createElement('h3');
  pluginsHeading.className = 'settings-section-heading';
  pluginsHeading.textContent = 'Plugins';
  pluginsSection.appendChild(pluginsHeading);

  const pluginsHint = document.createElement('p');
  pluginsHint.className = 'settings-section-hint';
  pluginsHint.textContent =
    'Add a plugin by the URL of its folder (the one holding plugin.json). '
    + 'Plugins in this list load whenever the app starts, and the list is saved to '
    + 'your account.';
  pluginsSection.appendChild(pluginsHint);

  // Shown while the list holds private-repository plugins but there is no live
  // GitHub connection (never made in this browser, expired, or refused). A
  // browser blocks a GitHub popup that no click started, so reconnecting waits
  // for this button.
  const gitHubReconnectBanner = document.createElement('div');
  gitHubReconnectBanner.className = 'plugins-github-reconnect';
  gitHubReconnectBanner.hidden = true;
  const gitHubReconnectMessage = document.createElement('span');
  const gitHubReconnectButton = document.createElement('button');
  gitHubReconnectButton.type = 'button';
  gitHubReconnectButton.addEventListener('click', () => reconnectGitHub());
  gitHubReconnectBanner.append(gitHubReconnectMessage, gitHubReconnectButton);
  pluginsSection.appendChild(gitHubReconnectBanner);

  function reflectGitHubReconnectBanner() {
    const needsConnection = getInstalledPlugins().some((url) => parsePrivatePluginUrl(url))
      && !hasSession();
    gitHubReconnectBanner.hidden = !needsConnection;
    if (!needsConnection) return;
    gitHubReconnectMessage.textContent = hadSession()
      ? 'Your GitHub connection has expired. Reconnect to load your private plugins.'
      : 'Connect GitHub to load your private plugins.';
    if (!gitHubReconnectButton.disabled) {
      gitHubReconnectButton.textContent = hadSession() ? 'Reconnect GitHub' : 'Connect GitHub';
    }
  }

  /** Run the GitHub popup to renew the connection, then load the private
      plugins that were waiting for it. Must be called from a click. Resolves to
      the installations, or null if it failed or was cancelled. */
  async function reconnectGitHub() {
    gitHubReconnectButton.disabled = true;
    gitHubReconnectButton.textContent = 'Connecting to GitHub…';
    try {
      const { installations } = await connectPrivateGitHub();
      app.dispatchEvent(new CustomEvent('plugin-sources-changed'));
      app.showToast('Connected to GitHub.');
      return installations;
    } catch (error) {
      app.showToast(error.message || 'GitHub connection failed.', { kind: 'warning' });
      return null;
    } finally {
      gitHubReconnectButton.disabled = false;
      reflectGitHubReconnectBanner();
    }
  }
  app.reconnectGitHub = reconnectGitHub;

  const pluginsList = document.createElement('ul');
  pluginsList.className = 'plugins-url-list';
  pluginsSection.appendChild(pluginsList);

  function renderPluginsList() {
    reflectGitHubReconnectBanner();
    pluginsList.replaceChildren();
    const urls = getInstalledPlugins();
    if (urls.length === 0) {
      const emptyItem = document.createElement('li');
      emptyItem.className = 'plugins-url-empty';
      emptyItem.textContent = 'No plugins installed yet.';
      pluginsList.appendChild(emptyItem);
      return;
    }
    for (const url of urls) {
      const item = document.createElement('li');
      item.className = 'plugins-url-item';

      // A private plugin shows (and links to) its github.com folder rather
      // than the plugins.examine.video URL the list stores for it.
      const description = document.createElement('span');
      description.className = 'plugins-url-description';
      const name = rememberedPluginName({ url });
      if (name) {
        const nameElement = document.createElement('span');
        nameElement.className = 'plugins-url-name';
        nameElement.textContent = name;
        description.appendChild(nameElement);
      }
      const privateParts = parsePrivatePluginUrl(url);
      const { href, text } = privateParts
        ? gitHubWebUrl(privateParts) : { href: url, text: url };
      const link = document.createElement('a');
      link.className = 'plugins-url-text';
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = text;
      link.title = href;
      description.appendChild(link);
      if (privateParts) {
        const privateTag = document.createElement('span');
        privateTag.className = 'plugins-url-private';
        privateTag.textContent = 'private';
        description.appendChild(privateTag);
      }

      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'plugins-url-remove';
      removeButton.textContent = 'Remove';
      removeButton.title = `Remove ${name ?? text}`;
      removeButton.addEventListener('click', () => removeInstalledPlugin(url));
      item.append(description, removeButton);
      pluginsList.appendChild(item);
    }
  }
  // A plugin that loads for the first time teaches the list its name.
  pluginRegistryEvents.addEventListener('plugin-registered', () => {
    if (dialogElement.open) renderPluginsList();
  });

  const pluginsAddRow = document.createElement('div');
  pluginsAddRow.className = 'plugins-url-add-row';
  const pluginUrlInput = document.createElement('input');
  pluginUrlInput.type = 'url';
  pluginUrlInput.className = 'plugins-url-input';
  pluginUrlInput.placeholder = 'https://…/my-plugin/';
  const pluginAddButton = document.createElement('button');
  pluginAddButton.type = 'button';
  pluginAddButton.textContent = 'Add';
  function submitPluginUrl() {
    const added = addInstalledPlugin(pluginUrlInput.value);
    if (added) {
      pluginUrlInput.value = '';
    } else if (pluginUrlInput.value.trim()) {
      app.showToast('That plugin is already in your list.', { kind: 'warning' });
    }
    pluginUrlInput.focus();
  }
  pluginAddButton.addEventListener('click', submitPluginUrl);
  pluginUrlInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); submitPluginUrl(); }
  });
  pluginsAddRow.append(pluginUrlInput, pluginAddButton);
  pluginsSection.appendChild(pluginsAddRow);

  /* ---- Add from a private GitHub repository ---- */

  // Loads plugins from the user's PRIVATE repos via the "Video Examiner" GitHub
  // App (see the github-app-integration-for-private-plugin-access skill).
  // Connecting opens a GitHub popup; each repository it comes back with gets a
  // dropdown of the plugins found in it (at its top level or one folder down)
  // and an "Add" that stores the chosen plugin's canonical tokenless
  // plugins.examine.video URL in the list above.
  const privateGitHubRow = document.createElement('div');
  privateGitHubRow.className = 'plugins-github-row';
  const privateGitHubButton = document.createElement('button');
  privateGitHubButton.type = 'button';
  privateGitHubButton.className = 'plugins-github-connect';
  privateGitHubButton.textContent = 'Add from private GitHub repository…';
  privateGitHubButton.title =
    'Connect the Video Examiner GitHub App to load plugins from your private repositories';
  privateGitHubRow.appendChild(privateGitHubButton);
  pluginsSection.appendChild(privateGitHubRow);

  const privateGitHubPicker = document.createElement('div');
  privateGitHubPicker.className = 'plugins-github-picker';
  privateGitHubPicker.hidden = true;
  pluginsSection.appendChild(privateGitHubPicker);

  function pluginOptionLabel(plugin) {
    const place = plugin.folder ? `${plugin.folder}/` : 'whole repository';
    return plugin.name ? `${plugin.name} (${place})` : place;
  }

  /** Fill one repository's dropdown with the plugins found in it; "None" (and a
      disabled Add) when there are none. Plugins already in the list are shown
      but cannot be picked again. */
  async function fillRepositoryPluginSelect(repository, select, addButton) {
    const setOnlyOption = (text) => {
      const option = document.createElement('option');
      option.textContent = text;
      select.replaceChildren(option);
      select.disabled = true;
      addButton.disabled = true;
    };
    setOnlyOption('Looking for plugins…');
    let plugins;
    try {
      plugins = await listRepositoryPlugins({
        installationId: repository.installationId, owner: repository.owner, repo: repository.name,
      });
    } catch (error) {
      setOnlyOption(`Could not list plugins (${error.message ?? error})`);
      return;
    }
    if (plugins.length === 0) { setOnlyOption('None'); return; }

    const installed = new Set(getInstalledPlugins());
    select.replaceChildren();
    for (const plugin of plugins) {
      const url = canonicalPluginUrl({
        installationId: repository.installationId,
        owner: repository.owner,
        repo: repository.name,
        folder: plugin.folder,
      });
      const option = document.createElement('option');
      option.value = url;
      option.dataset.label = pluginOptionLabel(plugin);
      const alreadyAdded = installed.has(url);
      option.textContent = option.dataset.label + (alreadyAdded ? ' — already added' : '');
      option.disabled = alreadyAdded;
      select.appendChild(option);
    }
    const firstAvailable = [...select.options].find((option) => !option.disabled);
    select.disabled = false;
    if (firstAvailable) select.value = firstAvailable.value;
    addButton.disabled = !firstAvailable;
  }

  function addPrivatePlugin(repository, select, addButton) {
    const option = select.selectedOptions[0];
    if (!option || option.disabled || !option.value) return;
    if (!addInstalledPlugin(option.value)) {
      app.showToast('That plugin is already in your list.', { kind: 'warning' });
      return;
    }
    app.showToast(`Added ${option.dataset.label} from ${repository.fullName}.`);
    option.textContent = `${option.dataset.label} — already added`;
    option.disabled = true;
    const nextAvailable = [...select.options].find((candidate) => !candidate.disabled);
    if (nextAvailable) select.value = nextAvailable.value;
    addButton.disabled = !nextAvailable;
  }

  function renderPrivateGitHubPicker(installations) {
    privateGitHubPicker.replaceChildren();

    const repositories = [];
    for (const installation of installations) {
      for (const repository of installation.repositories ?? []) {
        const [ownerFromFullName, nameFromFullName] = (repository.full_name ?? '/').split('/');
        repositories.push({
          installationId: installation.id,
          owner: repository.owner ?? ownerFromFullName,
          name: repository.name ?? nameFromFullName,
          fullName: repository.full_name ?? `${repository.owner}/${repository.name}`,
        });
      }
    }

    if (repositories.length === 0) {
      // Authorized, but the app isn't installed on any repositories yet. A
      // window.open() here would be popup-blocked — this runs after an await, so
      // it has lost the button's user activation — so show a link the user
      // clicks (their click carries activation) instead of opening it for them.
      const message = document.createElement('p');
      message.className = 'settings-section-hint';
      message.textContent =
        'Authorized, but Video Examiner has no repositories yet. Install it on '
        + 'the repositories you want to load plugins from, then click '
        + '“Add from private GitHub repository…” again.';
      const installLink = document.createElement('a');
      installLink.className = 'plugins-github-install-link';
      installLink.href = installUrl;
      installLink.target = '_blank';
      installLink.rel = 'noopener';
      installLink.textContent = 'Install Video Examiner on GitHub →';
      privateGitHubPicker.append(message, installLink);
      privateGitHubPicker.hidden = false;
      return;
    }

    const pickerHint = document.createElement('p');
    pickerHint.className = 'settings-section-hint';
    pickerHint.textContent = 'Repositories shared with Video Examiner. Pick a plugin in one to add it:';
    privateGitHubPicker.appendChild(pickerHint);

    for (const repository of repositories) {
      const repoRow = document.createElement('div');
      repoRow.className = 'plugins-github-repo';

      const { href, text } = gitHubWebUrl({ owner: repository.owner, repo: repository.name });
      const nameElement = document.createElement('a');
      nameElement.className = 'plugins-github-repo-name';
      nameElement.href = href;
      nameElement.target = '_blank';
      nameElement.rel = 'noopener';
      nameElement.textContent = repository.fullName;
      nameElement.title = text;

      const pluginSelect = document.createElement('select');
      pluginSelect.className = 'plugins-github-plugin-select';
      pluginSelect.title = 'Plugins found at the top of this repository or one folder down';

      const addButton = document.createElement('button');
      addButton.type = 'button';
      addButton.className = 'plugins-github-add';
      addButton.textContent = 'Add';
      addButton.addEventListener('click', () => addPrivatePlugin(repository, pluginSelect, addButton));

      repoRow.append(nameElement, pluginSelect, addButton);
      privateGitHubPicker.appendChild(repoRow);
      fillRepositoryPluginSelect(repository, pluginSelect, addButton);
    }

    const doneButton = document.createElement('button');
    doneButton.type = 'button';
    doneButton.className = 'plugins-github-done';
    doneButton.textContent = 'Done';
    doneButton.addEventListener('click', () => { privateGitHubPicker.hidden = true; });
    privateGitHubPicker.appendChild(doneButton);

    privateGitHubPicker.hidden = false;
  }

  privateGitHubButton.addEventListener('click', async () => {
    const originalText = privateGitHubButton.textContent;
    privateGitHubButton.disabled = true;
    privateGitHubButton.textContent = 'Connecting to GitHub…';
    try {
      const { installations } = await connectPrivateGitHub();
      renderPrivateGitHubPicker(installations);
      // Private plugins that could not load without a session can load now.
      app.dispatchEvent(new CustomEvent('plugin-sources-changed'));
    } catch (error) {
      app.showToast(error.message || 'GitHub connection failed.', { kind: 'warning' });
    } finally {
      privateGitHubButton.disabled = false;
      privateGitHubButton.textContent = originalText;
      reflectGitHubReconnectBanner();
    }
  });

  dialogElement.appendChild(pluginsSection);

  // Keep the list live: local edits and updates synced from another device both
  // flow through the preference's subscribe.
  renderPluginsList();
  subscribeInstalledPlugins(renderPluginsList);

  /* ---- Close ---- */

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'settings-dialog-close';
  closeButton.textContent = 'Close';
  closeButton.addEventListener('click', () => dialogElement.close());
  dialogElement.appendChild(closeButton);

  // A click that lands on the dialog element itself (rather than one of its
  // children) is a click on the backdrop area outside the panel's content box.
  dialogElement.addEventListener('click', (event) => {
    if (event.target === dialogElement) dialogElement.close();
  });

  document.body.appendChild(dialogElement);

  // The single entry point for opening the modal, exposed on the app so other
  // surfaces (the ＋ menu's Plugins page "New…" entry) can open it and draw the
  // eye to a section with a brief flash.
  function openSettings({ flashPlugins } = {}) {
    secondMediaSelect.value = getSecondMediaBehavior();
    renderPluginsList();
    if (!dialogElement.open) dialogElement.showModal();
    if (flashPlugins) {
      pluginsSection.classList.remove('settings-flash');
      void pluginsSection.offsetWidth; // reflow so the animation restarts
      pluginsSection.classList.add('settings-flash');
      pluginUrlInput.focus();
    }
  }
  app.openSettings = openSettings;
  /** Resolves when Settings next closes (at once if it is not open). */
  app.whenSettingsClosed = () => new Promise((resolve) => {
    if (!dialogElement.open) { resolve(); return; }
    dialogElement.addEventListener('close', () => resolve(), { once: true });
  });

  triggerButtonElement.addEventListener('click', () => openSettings());
}
