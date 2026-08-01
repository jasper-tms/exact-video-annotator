// Global settings modal, opened from the toolbar's Settings button. Holds
// preferences that apply across the whole application rather than to any one
// layer or tool: the integer-coordinate convention (a document field) and
// pixel-grid visibility (a localStorage-backed preference, see pixel-grid.js).
// Built once, as a native <dialog>, and reused for every open.

import { isPixelGridEnabled, setPixelGridEnabled } from '../pixel-grid.js';
import { getSecondVideoBehavior, setSecondVideoBehavior } from '../second-video-preference.js';

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

  // The prompt dialog can persist a fresh choice while this modal is closed;
  // re-read it each time Settings opens so the select is never stale.
  triggerButtonElement.addEventListener('click', () => {
    secondVideoSelect.value = getSecondVideoBehavior();
  });

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
  triggerButtonElement.addEventListener('click', () => dialogElement.showModal());
}
