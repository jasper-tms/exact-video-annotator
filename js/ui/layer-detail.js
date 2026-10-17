// The layer settings panel, below the canvas: settings for whichever layer is
// selected in the tab bar, as titled sections with one setting per line — the
// layer's name, its display and position, drawing options for a coordinates
// layer, the follow-the-primary link for a follower video, and the facts about
// a video or image file. (Stack order is changed by dragging tabs in the tab
// bar, visibility by a tab's eye, and layers are deleted with the tab bar's ✕
// button.) A layer's classes or event types are edited in the panel below this
// one (class-manager.js), and its annotations are listed in the table beside it.
// This deliberately lives in the sliding panel below the canvas: the wheel zooms
// over the canvas, and slides the panel up over it everywhere else.

function layerTypeDisplayName(type) {
  return `${type[0].toUpperCase()}${type.slice(1)}`;
}

/** "0.544 wide per 1 tall (anamorphic; meant to be seen at 801 × 1080)" for a
    video with non-square pixels, or null (row omitted) for square ones. */
function pixelShapeText(engine) {
  const pixelAspectRatio = engine.pixelAspectRatio || 1;
  if (pixelAspectRatio === 1) return null;
  const shownWidth = Math.round(engine.videoWidth * pixelAspectRatio);
  return `${Number(pixelAspectRatio.toFixed(3))} wide per 1 tall (anamorphic; meant to be `
    + `seen at ${shownWidth} × ${engine.videoHeight})`;
}

let nextControlNumber = 1;

/** A fresh id, so a setting's label can name its control (clicking the label
    then focuses or toggles it). */
function newControlId() {
  return `layer-setting-${nextControlNumber++}`;
}

/** A titled section whose rows are a two-column grid: label, then control. */
function createSection(title) {
  const section = document.createElement('section');
  section.className = 'settings-section';
  const heading = document.createElement('h3');
  heading.textContent = title;
  const grid = document.createElement('div');
  grid.className = 'settings-grid';
  section.append(heading, grid);
  return { section, grid };
}

/** One setting: its label in the left column, its control (and any trailing
    unit) in the right. `title` explains the setting on hover; `labelTarget`
    is the input the label names when the control is a group of elements. */
function addSettingRow(grid, labelText, control, { title = '', unit = null, labelTarget = control } = {}) {
  const label = document.createElement('label');
  label.className = 'setting-label';
  label.textContent = labelText;
  if (labelTarget.id) label.htmlFor = labelTarget.id;
  if (title) label.title = title;
  const controlCell = document.createElement('div');
  controlCell.className = 'setting-control';
  if (title) controlCell.title = title;
  controlCell.appendChild(control);
  if (unit) {
    const unitElement = document.createElement('span');
    unitElement.className = 'setting-unit';
    unitElement.textContent = unit;
    controlCell.appendChild(unitElement);
  }
  grid.append(label, controlCell);
}

/** A read-only fact: dim label, plain value. */
function addFactRow(grid, labelText, value) {
  if (value === null || value === undefined) return;
  const label = document.createElement('span');
  label.className = 'setting-label';
  label.textContent = labelText;
  const valueElement = document.createElement('span');
  valueElement.className = 'setting-control setting-fact';
  valueElement.textContent = String(value);
  grid.append(label, valueElement);
}

/** A number box that applies its value when committed (Enter or leaving it). */
function createNumberInput(value, step, onCommit) {
  const input = document.createElement('input');
  input.type = 'number';
  input.id = newControlId();
  input.step = step;
  input.value = String(value);
  input.addEventListener('keydown', (event) => event.stopPropagation());
  input.addEventListener('change', () => {
    const number = Number(input.value);
    if (Number.isFinite(number)) onCommit(number);
  });
  return input;
}

/** A 0–100% slider paired with a number box that can be typed into; both
    stay in step and apply the opacity (as 0–1) live. */
function createPercentControl(fraction, onChange) {
  const wrapper = document.createElement('div');
  wrapper.className = 'percent-control';
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.id = newControlId();
  slider.min = '0';
  slider.max = '100';
  slider.value = String(Math.round(fraction * 100));
  const box = document.createElement('input');
  box.type = 'number';
  box.min = '0';
  box.max = '100';
  box.step = '1';
  box.value = slider.value;
  box.setAttribute('aria-label', 'percent');
  slider.addEventListener('input', () => {
    box.value = slider.value;
    onChange(Number(slider.value) / 100);
  });
  box.addEventListener('keydown', (event) => event.stopPropagation());
  box.addEventListener('change', () => {
    const percent = Math.min(100, Math.max(0, Math.round(Number(box.value))));
    if (!Number.isFinite(percent)) return;
    box.value = String(percent);
    slider.value = String(percent);
    onChange(percent / 100);
  });
  const unit = document.createElement('span');
  unit.className = 'setting-unit';
  unit.textContent = '%';
  wrapper.append(slider, box, unit);
  return { wrapper, slider };
}

function addPercentRow(grid, labelText, fraction, onChange, { title = '' } = {}) {
  const { wrapper, slider } = createPercentControl(fraction, onChange);
  addSettingRow(grid, labelText, wrapper, { title, labelTarget: slider });
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

  // Whether "Technical details" is expanded, kept across rebuilds (which come
  // often while a clip is still being indexed).
  let technicalDetailsOpen = false;

  let observedLayer = null;
  const observedLayerHandler = () => rebuildIfIdle();

  function rebuild() {
    if (observedLayer) {
      observedLayer.removeEventListener('layer-changed', observedLayerHandler);
      observedLayer = null;
    }
    containerElement.replaceChildren();

    const layer = app.selectedLayer;
    if (!layer) {
      const heading = document.createElement('h2');
      heading.textContent = 'Layer';
      const empty = document.createElement('p');
      empty.className = 'layer-detail-empty';
      empty.textContent = 'Select a layer in the tab bar under the canvas.';
      containerElement.append(heading, empty);
      return;
    }

    observedLayer = layer;
    layer.addEventListener('layer-changed', observedLayerHandler);

    containerElement.appendChild(buildHeader(layer));

    // Events have no spatial presence (frames layers never draw), so there is
    // nothing to show for how they look or where they sit.
    const isSpatial = layer.type !== 'frames';

    /* ---- Display ---- */

    const display = createSection('Display');
    if (layer.type === 'coordinates') {
      // Points, lines and polylines layers have a second opacity for the
      // annotations marked on other frames, so the first is the current frame's.
      addPercentRow(display.grid, 'Opacity on this frame', layer.opacity,
        (value) => layer.setOpacity(value),
        { title: 'The opacity of annotations marked on the current frame, and of frame-agnostic ones.' });
      addPercentRow(display.grid, 'Opacity on other frames', layer.offFrameOpacity,
        (value) => layer.setOffFrameOpacity(value),
        { title: 'The opacity of annotations marked on other frames. At 0% '
          + "they are hidden and can't be clicked or selected with s." });
    } else {
      addPercentRow(display.grid, 'Opacity', layer.opacity, (value) => layer.setOpacity(value));
    }
    if (isSpatial) containerElement.appendChild(display.section);

    /* ---- Position (scale/offset into world coordinates) ---- */

    const position = createSection('Position');
    addSettingRow(position.grid, 'Scale',
      createNumberInput(layer.transform.scale, '0.01', (value) => layer.setTransform({ scale: value })),
      { title: 'How many canvas pixels one of this layer\'s pixels covers.' });
    addSettingRow(position.grid, 'Offset x',
      createNumberInput(layer.transform.offsetX, '1', (value) => layer.setTransform({ offsetX: value })),
      { unit: 'pixels', title: 'How far right this layer is shifted.' });
    addSettingRow(position.grid, 'Offset y',
      createNumberInput(layer.transform.offsetY, '1', (value) => layer.setTransform({ offsetY: value })),
      { unit: 'pixels', title: 'How far down this layer is shifted.' });
    if (isSpatial) containerElement.appendChild(position.section);

    /* ---- Coordinates layer: drawing options ---- */

    if (layer.type === 'coordinates') {
      const drawing = createSection('Drawing');
      const fractionalCheckbox = document.createElement('input');
      fractionalCheckbox.type = 'checkbox';
      fractionalCheckbox.id = newControlId();
      fractionalCheckbox.checked = layer.allowFractionalCoordinates;
      fractionalCheckbox.addEventListener('change', () =>
        layer.setAllowFractionalCoordinates(fractionalCheckbox.checked));
      addSettingRow(drawing.grid, 'Fractional coordinates', fractionalCheckbox, {
        title: 'When off, every new or moved coordinate snaps to '
          + "the document's integer-coordinate convention (floored for pixel "
          + 'top-left corner, rounded for pixel center). Freely togglable — '
          + 'mixing fractional and whole-pixel annotations on one layer is fine.',
      });
      containerElement.appendChild(drawing.section);
    }

    /* ---- Video layer: primary/follower link ---- */

    if (layer.type === 'video' && app.videoLayers.length >= 2) {
      const sync = createSection('Playback sync');
      if (layer === app.primaryVideoLayer) {
        const primaryNote = document.createElement('p');
        primaryNote.className = 'settings-note';
        primaryNote.textContent = 'Primary video — its clock drives the timeline, '
          + 'and annotation frame numbers mean its frames. Other videos follow it.';
        sync.section.replaceChildren(sync.section.firstChild, primaryNote);
      } else {
        const modeSelect = document.createElement('select');
        modeSelect.id = newControlId();
        for (const [value, text] of [
          ['timestamp', 'Timestamp'],
          ['frame-index', 'Frame index'],
        ]) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = text;
          modeSelect.appendChild(option);
        }
        modeSelect.value = layer.linkMode;
        modeSelect.addEventListener('change', () => app.setVideoLinkMode(layer, modeSelect.value));
        addSettingRow(sync.grid, 'Follow the primary by', modeSelect, {
          title: 'How this video follows the primary.\n'
            + 'Timestamp (the default): equal playback times correspond (plus the offset, '
            + "in seconds), through this clip's own frame↔time table — right for independent "
            + 'recordings at different frame rates.\n'
            + 'Frame index: equal frame numbers correspond (plus the offset, in frames) — '
            + 'right for trigger-synchronized cameras and processed renditions of the same clip.\n'
            + 'Switching keeps the offset already in the box.',
        });
        const isTimestamp = layer.linkMode === 'timestamp';
        addSettingRow(sync.grid, 'Offset',
          createNumberInput(layer.temporalOffset, isTimestamp ? '0.001' : '1',
            (value) => app.setVideoTemporalOffset(layer, value)),
          {
            unit: isTimestamp ? 'seconds' : 'frames',
            title: isTimestamp
              ? "Added to the primary's time to find this video's matching time."
              : "Added to the primary's frame number to find this video's matching frame.",
          });
      }
      containerElement.appendChild(sync.section);
    }

    /* ---- Video layer: the clip's facts ---- */

    if (layer.type === 'video' && layer.engine) {
      const information = layer.mediaInformation ?? {};
      const engine = layer.engine;
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

      const file = createSection('File');
      addFactRow(file.grid, 'Name', information.name);
      addFactRow(file.grid, 'Dimensions', `${engine.videoWidth} × ${engine.videoHeight} pixels`);
      // Only an anamorphic video has anything to say here; its dimensions
      // (and annotation coordinates) count stored pixels, shown non-square.
      addFactRow(file.grid, 'Pixel shape', pixelShapeText(engine));
      addFactRow(file.grid, 'Frames', framesText);
      addFactRow(file.grid, 'Duration', durationText);
      addFactRow(file.grid, 'Mean frame rate',
        information.frameRate ? `${information.frameRate} frames/second` : null);
      addFactRow(file.grid, 'Frame indices',
        engine.frameIndexIsExact === false ? 'APPROXIMATE (clip could not be indexed)' : 'Exact');
      containerElement.appendChild(file.section);

      const technical = document.createElement('details');
      technical.className = 'settings-section technical-details';
      technical.open = technicalDetailsOpen;
      technical.addEventListener('toggle', () => { technicalDetailsOpen = technical.open; });
      const summary = document.createElement('summary');
      summary.textContent = 'Technical details';
      const technicalGrid = document.createElement('div');
      technicalGrid.className = 'settings-grid';
      addFactRow(technicalGrid, 'Engine tier', engine.tier);
      addFactRow(technicalGrid, 'Codec', engine.codecString);
      technical.append(summary, technicalGrid);
      containerElement.appendChild(technical);
    }

    /* ---- Image layer: the picture's facts ---- */

    if (layer.type === 'image' && layer.bitmap) {
      const information = layer.mediaInformation ?? {};
      const file = createSection('File');
      addFactRow(file.grid, 'Name', information.name);
      addFactRow(file.grid, 'Dimensions', `${layer.bitmap.width} × ${layer.bitmap.height} pixels`);
      addFactRow(file.grid, 'Shown on', 'Every frame (no timeline)');
      containerElement.appendChild(file.section);
    }

    /* ---- Segmentation: not built yet ---- */

    if (layer.type === 'segmentation') {
      const note = document.createElement('p');
      note.className = 'settings-note';
      note.textContent = 'Pixel-wise segmentation is not implemented yet.';
      containerElement.appendChild(note);
    }

    /* ---- Plugin layers: the plugin's own settings ---- */

    if (layer.plugin?.buildSettings) {
      containerElement.appendChild(layer.plugin.buildSettings(app, layer));
    }
  }

  /** The layer's name, editable in place, above a badge naming its type (and
      its plugin, for a plugin layer). */
  function buildHeader(layer) {
    const header = document.createElement('div');
    header.className = 'layer-detail-header';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'layer-name-input';
    nameInput.value = layer.name;
    nameInput.title = 'Layer name (click to rename)';
    nameInput.setAttribute('aria-label', 'Layer name');
    const commitName = () => {
      const newName = nameInput.value.trim();
      if (newName && newName !== layer.name) layer.setName(newName);
      else nameInput.value = layer.name;
    };
    nameInput.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); nameInput.blur(); }
      else if (event.key === 'Escape') { event.preventDefault(); nameInput.value = layer.name; nameInput.blur(); }
    });
    nameInput.addEventListener('change', commitName);

    const badge = document.createElement('span');
    badge.className = `layer-type-badge layer-type-${layer.type}`;
    badge.textContent = layer.plugin
      ? `${layer.plugin.name} · ${layerTypeDisplayName(layer.type)} layer`
      : `${layerTypeDisplayName(layer.type)} layer`;

    header.append(nameInput, badge);
    return header;
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
