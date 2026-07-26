// The line fitter's settings, shown in the layer detail panel below the canvas
// whenever a line-fitter layer is selected. Built with the same plain DOM style
// as the rest of the panels: no framework, and no innerHTML wipes over inputs
// the user might be typing in.

import { refitSelectedItem } from '../refit.js';

export function buildLineFitterSettings(app, layer) {
  const section = document.createElement('div');
  section.className = 'plugin-settings';

  const heading = document.createElement('h3');
  heading.textContent = 'Line fitter';
  section.appendChild(heading);

  const explanation = document.createElement('p');
  explanation.className = 'plugin-settings-explanation';
  explanation.textContent = 'Drop two points near an edge and the line snaps onto it. '
    + 'Points only move perpendicular to the line, so its length barely changes.';
  section.appendChild(explanation);

  /* ---- What to lock onto ---- */

  const modeRow = document.createElement('div');
  modeRow.className = 'layer-detail-row';
  for (const choice of [
    { value: 'edge', label: 'lock to edge',
      title: 'Sit on the sharpest change in brightness under the line' },
    { value: 'stripe', label: 'lock to stripe center',
      title: 'Sit in the middle of a bright or dark stripe, away from both of its edges' },
  ]) {
    const choiceLabel = document.createElement('label');
    choiceLabel.title = choice.title;
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = `line-fitter-mode-${layer.id}`;
    radio.value = choice.value;
    radio.checked = layer.options.mode === choice.value;
    radio.addEventListener('change', () => {
      if (radio.checked) layer.setOption('mode', choice.value);
    });
    choiceLabel.append(radio, ` ${choice.label}`);
    modeRow.appendChild(choiceLabel);
  }
  section.appendChild(modeRow);

  /* ---- What stripe widths to consider (stripe mode only; there is no
          movement limit to configure — the fit travels as far as the image
          keeps rewarding it) ---- */

  if (layer.options.mode === 'stripe') {
    const numbersRow = document.createElement('div');
    numbersRow.className = 'layer-detail-row';
    const numberFields = [
      { key: 'minimumStripeWidthPixels', label: 'narrowest stripe (px)', step: '0.5', minimum: 0.5,
        title: 'Narrowest stripe width to scan for' },
      { key: 'maximumStripeWidthPixels', label: 'widest stripe (px)', step: '0.5', minimum: 0.5,
        title: 'Widest stripe width to scan for' },
    ];
    for (const field of numberFields) {
      const fieldLabel = document.createElement('label');
      fieldLabel.className = 'layer-detail-transform-field';
      fieldLabel.title = field.title;
      const input = document.createElement('input');
      input.type = 'number';
      input.step = field.step;
      input.min = String(field.minimum);
      input.value = String(layer.options[field.key]);
      input.addEventListener('keydown', (event) => event.stopPropagation());
      input.addEventListener('change', () => {
        const value = Number(input.value);
        if (Number.isFinite(value) && value >= field.minimum) layer.setOption(field.key, value);
        else input.value = String(layer.options[field.key]);
      });
      fieldLabel.append(`${field.label} `, input);
      numbersRow.appendChild(fieldLabel);
    }
    section.appendChild(numbersRow);
  }

  /* ---- Re-fitting ---- */

  const refitRow = document.createElement('div');
  refitRow.className = 'layer-detail-row';

  const dragLabel = document.createElement('label');
  dragLabel.title = 'Re-run the fit whenever a line or one of its points is dragged. '
    + 'Turn this off if you want a drag to be the last word.';
  const dragCheckbox = document.createElement('input');
  dragCheckbox.type = 'checkbox';
  dragCheckbox.checked = layer.options.refitAfterDragging !== false;
  dragCheckbox.addEventListener('change', () =>
    layer.setOption('refitAfterDragging', dragCheckbox.checked));
  dragLabel.append(dragCheckbox, ' re-fit after dragging');
  refitRow.appendChild(dragLabel);

  const refitButton = document.createElement('button');
  refitButton.type = 'button';
  refitButton.textContent = 'Re-fit selected (r)';
  refitButton.title = 'Re-run the fit on the selected annotation, against the current frame';
  refitButton.disabled = app.selection?.layerId !== layer.id;
  refitButton.addEventListener('click', () => {
    if (!refitSelectedItem(app)) {
      app.showToast('Select an annotation on this layer first.', { kind: 'warning' });
    }
  });
  refitRow.appendChild(refitButton);

  section.appendChild(refitRow);

  /* ---- What the last fit did ---- */

  const status = document.createElement('p');
  status.className = 'plugin-settings-status';
  status.textContent = layer.lastFitDescription
    ? `Last fit: ${layer.lastFitDescription}`
    : 'No fit yet on this layer.';
  section.appendChild(status);

  return section;
}
