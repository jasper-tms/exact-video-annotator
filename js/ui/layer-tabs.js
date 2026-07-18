// The layer tab bar: one horizontal row of tabs along the bottom of the
// canvas (neuroglancer's layer bar, relocated), never wrapping — when there
// are more tabs than fit, ◀ ▶ buttons scroll the strip sideways, like
// spreadsheet sheet tabs. Leftmost tab is the bottom of the layer stack.
// Clicking a tab selects that layer (its details appear below the canvas,
// scroll down to see them); the eye toggles visibility; double-click renames.

export function initializeLayerTabs(app, containerElement) {
  containerElement.innerHTML = `
    <button type="button" class="layer-tabs-scroll-button" data-scroll="-1" title="Scroll tabs left">◀</button>
    <div class="layer-tabs-strip"></div>
    <button type="button" class="layer-tabs-scroll-button" data-scroll="1" title="Scroll tabs right">▶</button>
    <button type="button" class="layer-tab-add" title="Add an annotation layer">＋</button>
  `;

  const strip = containerElement.querySelector('.layer-tabs-strip');
  const addButton = containerElement.querySelector('.layer-tab-add');
  const scrollButtons = [...containerElement.querySelectorAll('.layer-tabs-scroll-button')];

  let installedLayerListeners = [];

  /* ---------- Sideways scrolling ---------- */

  const SCROLL_STEP_PIXELS = 180;

  for (const button of scrollButtons) {
    button.addEventListener('click', () => {
      strip.scrollBy({ left: Number(button.dataset.scroll) * SCROLL_STEP_PIXELS, behavior: 'smooth' });
    });
  }

  function updateScrollButtons() {
    const overflowing = strip.scrollWidth > strip.clientWidth + 1;
    scrollButtons[0].disabled = !overflowing || strip.scrollLeft <= 0;
    scrollButtons[1].disabled = !overflowing
      || strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1;
  }
  strip.addEventListener('scroll', updateScrollButtons);
  new ResizeObserver(updateScrollButtons).observe(strip);

  /* ---------- Add-layer menu ---------- */

  addButton.addEventListener('click', () => {
    const existingMenu = containerElement.querySelector('.layer-tab-add-menu');
    if (existingMenu) { existingMenu.remove(); return; }
    const menu = document.createElement('div');
    menu.className = 'layer-tab-add-menu';
    for (const type of ['points', 'shapes', 'events']) {
      const option = document.createElement('button');
      option.type = 'button';
      option.textContent = `New ${type} layer`;
      option.addEventListener('click', () => {
        menu.remove();
        const layer = app.addAnnotationLayer(type);
        app.setActiveLayer(layer.id);
      });
      menu.appendChild(option);
    }
    addButton.appendChild(menu);
    const dismiss = (event) => {
      if (!menu.contains(event.target) && event.target !== addButton) {
        menu.remove();
        window.removeEventListener('pointerdown', dismiss, true);
      }
    };
    window.addEventListener('pointerdown', dismiss, true);
  });

  /* ---------- Tabs ---------- */

  function isUserEditingHere() {
    const activeElement = document.activeElement;
    return activeElement instanceof HTMLInputElement && containerElement.contains(activeElement);
  }

  function rebuildIfIdle() {
    if (isUserEditingHere()) return;
    rebuild();
  }

  function detachLayerListeners() {
    for (const { layer, handler } of installedLayerListeners) {
      layer.removeEventListener('layer-changed', handler);
    }
    installedLayerListeners = [];
  }

  function rebuild() {
    detachLayerListeners();
    strip.replaceChildren();
    const selectedLayerId = app.selectedLayer?.id ?? null;
    // Leftmost tab = bottom of the stack, matching viewer.layers order.
    for (const layer of app.viewer.layers) {
      strip.appendChild(buildTab(layer, layer.id === selectedLayerId));
    }
    updateScrollButtons();
    strip.querySelector('.layer-tab.active')
      ?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }

  function buildTab(layer, isSelected) {
    const tab = document.createElement('div');
    tab.className = 'layer-tab';
    if (isSelected) tab.classList.add('active');
    tab.title = `${layer.name} — click to select, double-click to rename`;

    const eyeButton = document.createElement('button');
    eyeButton.type = 'button';
    eyeButton.className = 'layer-tab-eye';
    applyVisibilityAppearance(eyeButton, layer.visible);
    eyeButton.addEventListener('click', (event) => {
      event.stopPropagation();
      layer.setVisible(!layer.visible);
    });
    tab.appendChild(eyeButton);

    const nameElement = document.createElement('span');
    nameElement.className = 'layer-tab-name';
    nameElement.textContent = layer.name;
    tab.appendChild(nameElement);

    const typeBadge = document.createElement('span');
    typeBadge.className = `layer-tab-type layer-type-${layer.type}`;
    typeBadge.textContent = layer.type;
    tab.appendChild(typeBadge);

    tab.addEventListener('click', () => app.setActiveLayer(layer.id));
    tab.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      beginRename(layer, nameElement);
    });

    const handler = () => {
      applyVisibilityAppearance(eyeButton, layer.visible);
      if (!isUserEditingHere()) nameElement.textContent = layer.name;
    };
    layer.addEventListener('layer-changed', handler);
    installedLayerListeners.push({ layer, handler });

    return tab;
  }

  function applyVisibilityAppearance(button, visible) {
    button.textContent = '👁';
    button.title = visible ? 'Hide layer' : 'Show layer';
    button.classList.toggle('layer-hidden', !visible);
  }

  function beginRename(layer, nameElement) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'layer-tab-rename';
    input.value = layer.name;
    let finished = false;
    const commit = () => {
      if (finished) return;
      finished = true;
      const newName = input.value.trim();
      if (newName && newName !== layer.name) layer.setName(newName);
      rebuild();
    };
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); commit(); }
      else if (event.key === 'Escape') { event.preventDefault(); finished = true; rebuild(); }
    });
    input.addEventListener('blur', commit);
    input.addEventListener('click', (event) => event.stopPropagation());
    nameElement.replaceWith(input);
    input.focus();
    input.select();
  }

  app.addEventListener('layers-changed', rebuildIfIdle);
  app.viewer.addEventListener('layers-changed', rebuildIfIdle);
  app.addEventListener('document-changed', rebuildIfIdle);
  app.addEventListener('video-loaded', rebuildIfIdle);

  rebuild();
}
