// Global settings modal, opened from the toolbar's Settings button. Holds
// preferences that apply across the whole application rather than to any one
// layer or tool: the integer-coordinate convention (a document field) and
// pixel-grid visibility (a localStorage-backed preference, see pixel-grid.js).
// Built once, as a native <dialog>, and reused for every open.

import { isPixelGridEnabled, setPixelGridEnabled } from '../pixel-grid.js';
import { getSecondVideoBehavior, setSecondVideoBehavior } from '../second-video-preference.js';
import { getSyncedPlaybackPacing, setSyncedPlaybackPacing } from '../synced-playback-preference.js';
import { isLoadedFramesHighlightEnabled, setLoadedFramesHighlightEnabled }
  from '../loaded-frames-highlight-preference.js';
import {
  getInstalledPlugins, addInstalledPlugin, removeInstalledPlugin, subscribeInstalledPlugins,
} from '../sync/installed-plugins-preference.js';

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

  /* ---- Second video behavior ---- */

  const secondVideoRow = document.createElement('div');
  secondVideoRow.className = 'settings-row';
  const secondVideoLabel = document.createElement('label');
  secondVideoLabel.htmlFor = 'second-video-select';
  secondVideoLabel.textContent = 'Second video:';
  const secondVideoSelect = document.createElement('select');
  secondVideoSelect.id = 'second-video-select';
  secondVideoSelect.title =
    'What to do when a second video is loaded while one is already open';
  for (const [value, text] of [['prompt', 'Prompt'], ['replace', 'Replace'], ['new-layer', 'New layer']]) {
    const optionElement = document.createElement('option');
    optionElement.value = value;
    optionElement.textContent = text;
    secondVideoSelect.appendChild(optionElement);
  }
  secondVideoSelect.value = getSecondVideoBehavior();
  secondVideoSelect.addEventListener('change', () => {
    setSecondVideoBehavior(secondVideoSelect.value);
  });
  secondVideoRow.append(secondVideoLabel, secondVideoSelect);
  dialogElement.appendChild(secondVideoRow);
  // The second-video prompt dialog can persist a fresh choice while this modal
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
  // flash on this section) via its "New…" entry. Fetching and running a plugin
  // from its URL is not wired up yet — for now the list is simply persisted and
  // synced across devices when signed in.
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
    'Add a plugin by its URL (typically a GitHub URL). Loading plugins from '
    + 'their URL is coming soon; for now the list is saved to your account.';
  pluginsSection.appendChild(pluginsHint);

  const pluginsList = document.createElement('ul');
  pluginsList.className = 'plugins-url-list';
  pluginsSection.appendChild(pluginsList);

  function renderPluginsList() {
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
      const urlText = document.createElement('span');
      urlText.className = 'plugins-url-text';
      urlText.textContent = url;
      urlText.title = url;
      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'plugins-url-remove';
      removeButton.textContent = 'Remove';
      removeButton.title = `Remove ${url}`;
      removeButton.addEventListener('click', () => removeInstalledPlugin(url));
      item.append(urlText, removeButton);
      pluginsList.appendChild(item);
    }
  }

  const pluginsAddRow = document.createElement('div');
  pluginsAddRow.className = 'plugins-url-add-row';
  const pluginUrlInput = document.createElement('input');
  pluginUrlInput.type = 'url';
  pluginUrlInput.className = 'plugins-url-input';
  pluginUrlInput.placeholder = 'https://…/plugin.js';
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
    secondVideoSelect.value = getSecondVideoBehavior();
    renderPluginsList();
    dialogElement.showModal();
    if (flashPlugins) {
      pluginsSection.classList.remove('settings-flash');
      void pluginsSection.offsetWidth; // reflow so the animation restarts
      pluginsSection.classList.add('settings-flash');
      pluginUrlInput.focus();
    }
  }
  app.openSettings = openSettings;

  triggerButtonElement.addEventListener('click', () => openSettings());
}
