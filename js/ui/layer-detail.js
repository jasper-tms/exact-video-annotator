// The layer detail panel, below the canvas: settings for whichever layer is
// selected in the tab bar — visibility, opacity, and scale/offset transform;
// playback facts for the video layer. (Stack order is changed by dragging
// tabs in the tab bar, and layers are deleted with the tab bar's ✕ button.)
// This is deliberately below the fold: the wheel zooms over the canvas, and
// scrolls the page down to here everywhere else.

const ANNOTATION_LAYER_TYPES = new Set(['coordinates', 'segmentation', 'frames']);

function layerTypeDisplayName(type) {
  return `${type[0].toUpperCase()}${type.slice(1)}`;
}

export function initializeLayerDetail(app, containerElement) {
  function isUserEditingHere() {
    const activeElement = document.activeElement;
    if (!activeElement || !containerElement.contains(activeElement)) return false;
    if (activeElement.tagName === 'TEXTAREA') return true;
    // Only TYPING must be protected from a rebuild. Radios and checkboxes are
    // click-and-done, yet keep focus after the click — and their clicks often
    // need the rebuild they would otherwise block (switching the line fitter
    // to stripe mode is what reveals its stripe-width fields).
    return activeElement.tagName === 'INPUT'
      && activeElement.type !== 'radio' && activeElement.type !== 'checkbox';
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

    const typeLine = document.createElement('p');
    typeLine.className = 'layer-detail-type';
    typeLine.textContent = layer.plugin
      ? `Type: ${layer.plugin.name} (${layerTypeDisplayName(layer.type)} layer)`
      : `Type: ${layerTypeDisplayName(layer.type)}`;
    containerElement.appendChild(typeLine);

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

    /* ---- Coordinates layer: fractional-coordinate policy ---- */

    if (layer.type === 'coordinates') {
      const fractionalRow = document.createElement('div');
      fractionalRow.className = 'layer-detail-row';
      const fractionalLabel = document.createElement('label');
      const fractionalCheckbox = document.createElement('input');
      fractionalCheckbox.type = 'checkbox';
      fractionalCheckbox.checked = layer.allowFractionalCoordinates;
      fractionalCheckbox.addEventListener('change', () =>
        layer.setAllowFractionalCoordinates(fractionalCheckbox.checked));
      fractionalLabel.title = 'When off, every new or moved coordinate snaps to '
        + "the document's integer-coordinate convention (floored for pixel "
        + 'top-left corner, rounded for pixel center). Freely togglable — '
        + 'mixing fractional and whole-pixel annotations on one layer is fine.';
      fractionalLabel.append(fractionalCheckbox, ' allow fractional coordinates');
      fractionalRow.appendChild(fractionalLabel);
      containerElement.appendChild(fractionalRow);
    }

    /* ---- Video layer: playback facts ---- */

    if (layer.type === 'video' && app.engine) {
      const facts = document.createElement('dl');
      facts.className = 'layer-detail-facts';
      const information = app.videoInformation ?? {};
      const engine = app.engine;
      // While the index is still being built, the frame count and the duration
      // describe the part of the clip indexed so far, so they are labelled as
      // the floor they are rather than presented as totals.
      const indexState = engine.frameIndexState ?? 'complete';
      const declaredDuration = engine.expectedDuration ?? 0;
      const framesText = indexState === 'growing'
        ? `${engine.numFrames} indexed so far (still indexing)`
        : indexState === 'truncated'
          ? `${engine.numFrames} (indexing stopped early; the rest of the clip is unavailable)`
          : String(engine.numFrames);
      const durationText = indexState === 'growing' && declaredDuration > 0
        ? `${engine.duration?.toFixed(3)} s indexed of ${declaredDuration.toFixed(3)} s declared`
        : `${engine.duration?.toFixed(3)} s`;
      for (const [term, value] of [
        ['file', information.name],
        ['dimensions', `${engine.videoWidth} × ${engine.videoHeight}`],
        ['frames', framesText],
        ['duration', durationText],
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

    /* ---- Plugin layers: the plugin's own settings ---- */

    if (layer.plugin?.buildSettings) {
      containerElement.appendChild(layer.plugin.buildSettings(app, layer));
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
  // Plugin settings can depend on what is selected (the line fitter's "re-fit
  // selected" button is only live with one of its own annotations selected).
  app.addEventListener('selection-changed', rebuildIfIdle);
  app.viewer.addEventListener('layers-changed', rebuildIfIdle);
  app.addEventListener('document-changed', rebuildIfIdle);
  app.addEventListener('video-loaded', rebuildIfIdle);
  app.addEventListener('index-changed', rebuildIfIdle);

  rebuild();
}
