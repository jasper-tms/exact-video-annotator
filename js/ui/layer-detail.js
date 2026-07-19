// The layer detail panel, below the canvas: settings for whichever layer is
// selected in the tab bar — visibility, opacity, and scale/offset transform;
// playback facts for the video layer. (Stack order is changed by dragging
// tabs in the tab bar, and layers are deleted with the tab bar's ✕ button.)
// This is deliberately below the fold: the wheel zooms over the canvas, and
// scrolls the page down to here everywhere else.

const ANNOTATION_LAYER_TYPES = new Set(['points', 'shapes', 'events']);

export function initializeLayerDetail(app, containerElement) {
  function isUserEditingHere() {
    const activeElement = document.activeElement;
    if (!activeElement || !containerElement.contains(activeElement)) return false;
    return activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA';
  }

  function rebuildIfIdle() {
    if (isUserEditingHere()) return;
    rebuild();
  }

  let observedLayer = null;
  const observedLayerHandler = () => rebuildIfIdle();

  function rebuild() {
    if (observedLayer) {
      observedLayer.removeEventListener('layer-changed', observedLayerHandler);
      observedLayer = null;
    }
    containerElement.replaceChildren();

    const layer = app.selectedLayer;
    const heading = document.createElement('h2');
    heading.textContent = layer ? `Layer: ${layer.name}` : 'Layer';
    containerElement.appendChild(heading);

    if (!layer) {
      const empty = document.createElement('p');
      empty.className = 'layer-detail-empty';
      empty.textContent = 'Select a layer in the tab bar under the canvas.';
      containerElement.appendChild(empty);
      return;
    }

    observedLayer = layer;
    layer.addEventListener('layer-changed', observedLayerHandler);

    /* ---- Common controls: visibility, opacity ---- */

    const controlsRow = document.createElement('div');
    controlsRow.className = 'layer-detail-row';

    const visibilityLabel = document.createElement('label');
    const visibilityCheckbox = document.createElement('input');
    visibilityCheckbox.type = 'checkbox';
    visibilityCheckbox.checked = layer.visible;
    visibilityCheckbox.addEventListener('change', () => layer.setVisible(visibilityCheckbox.checked));
    visibilityLabel.append(visibilityCheckbox, ' visible');
    controlsRow.appendChild(visibilityLabel);

    const opacityLabel = document.createElement('label');
    opacityLabel.className = 'layer-detail-opacity';
    const opacitySlider = document.createElement('input');
    opacitySlider.type = 'range';
    opacitySlider.min = '0';
    opacitySlider.max = '100';
    opacitySlider.value = String(Math.round(layer.opacity * 100));
    const opacityValue = document.createElement('span');
    opacityValue.textContent = `${Math.round(layer.opacity * 100)}%`;
    opacitySlider.addEventListener('input', () => {
      opacityValue.textContent = `${opacitySlider.value}%`;
      layer.setOpacity(Number(opacitySlider.value) / 100);
    });
    opacityLabel.append('opacity ', opacitySlider, opacityValue);
    controlsRow.appendChild(opacityLabel);

    containerElement.appendChild(controlsRow);

    /* ---- Transform (scale/offset into world coordinates) ---- */

    const transformRow = document.createElement('div');
    transformRow.className = 'layer-detail-row';
    for (const field of [
      { key: 'scale', label: 'scale', step: '0.01' },
      { key: 'offsetX', label: 'offset x', step: '1' },
      { key: 'offsetY', label: 'offset y', step: '1' },
    ]) {
      const fieldLabel = document.createElement('label');
      fieldLabel.className = 'layer-detail-transform-field';
      const input = document.createElement('input');
      input.type = 'number';
      input.step = field.step;
      input.value = String(layer.transform[field.key]);
      input.addEventListener('keydown', (event) => event.stopPropagation());
      input.addEventListener('change', () => {
        const value = Number(input.value);
        if (Number.isFinite(value)) layer.setTransform({ [field.key]: value });
      });
      fieldLabel.append(`${field.label} `, input);
      transformRow.appendChild(fieldLabel);
    }
    containerElement.appendChild(transformRow);

    /* ---- Video layer: playback facts ---- */

    if (layer.type === 'video' && app.engine) {
      const facts = document.createElement('dl');
      facts.className = 'layer-detail-facts';
      const information = app.videoInformation ?? {};
      const engine = app.engine;
      for (const [term, value] of [
        ['file', information.name],
        ['dimensions', `${engine.videoWidth} × ${engine.videoHeight}`],
        ['frames', engine.numFrames],
        ['duration', `${engine.duration?.toFixed(3)} s`],
        ['mean frame rate', information.frameRate ? `${information.frameRate} frames/second` : null],
        ['frame indices', engine.frameIndexIsExact === false ? 'APPROXIMATE (clip could not be indexed)' : 'exact'],
        ['engine tier', engine.tier],
        ['codec', engine.codecString],
      ]) {
        if (value === null || value === undefined) continue;
        const termElement = document.createElement('dt');
        termElement.textContent = term;
        const valueElement = document.createElement('dd');
        valueElement.textContent = String(value);
        facts.append(termElement, valueElement);
      }
      containerElement.appendChild(facts);
    }

    /* ---- Annotation layers: a one-line item count ---- */

    if (ANNOTATION_LAYER_TYPES.has(layer.type)) {
      const count = document.createElement('p');
      count.className = 'layer-detail-count';
      count.textContent = `${layer.items.length} item(s) on this layer — see the annotations table for the full list.`;
      containerElement.appendChild(count);
    }
  }

  app.addEventListener('layers-changed', rebuildIfIdle);
  app.viewer.addEventListener('layers-changed', rebuildIfIdle);
  app.addEventListener('document-changed', rebuildIfIdle);
  app.addEventListener('video-loaded', rebuildIfIdle);

  rebuild();
}
