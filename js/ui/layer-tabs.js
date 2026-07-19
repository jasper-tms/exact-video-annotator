// The layer tab bar: one horizontal row of tabs along the bottom of the
// canvas (neuroglancer's layer bar, relocated), never wrapping — when there
// are more tabs than fit, ◀ ▶ buttons scroll the strip sideways, like
// spreadsheet sheet tabs. Leftmost tab is the bottom of the layer stack.
// Clicking a tab selects that layer (its details appear below the canvas,
// scroll down to see them); the eye icon on the tab's right edge toggles
// visibility; double-click renames; dragging a tab left or right re-orders
// the layer stack. The ＋ button adds an annotation layer and the ✕ button
// beside it deletes the selected one (confirming when it holds annotations).

const DRAG_START_THRESHOLD_PIXELS = 5;

const EYE_VISIBLE_SVG = `
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
       stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"></path>
    <circle cx="12" cy="12" r="2.8"></circle>
  </svg>`;

const EYE_HIDDEN_SVG = `
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
       stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"></path>
    <circle cx="12" cy="12" r="2.8"></circle>
    <line x1="4" y1="20" x2="20" y2="4"></line>
  </svg>`;

export function initializeLayerTabs(app, containerElement) {
  containerElement.innerHTML = `
    <button type="button" class="layer-tabs-scroll-button" data-scroll="-1" title="Scroll tabs left">◀</button>
    <div class="layer-tabs-strip"></div>
    <button type="button" class="layer-tabs-scroll-button" data-scroll="1" title="Scroll tabs right">▶</button>
    <button type="button" class="layer-tab-add" title="Add an annotation layer">＋</button>
    <button type="button" class="layer-tab-delete-current" title="Delete the selected layer">✕</button>
  `;

  const strip = containerElement.querySelector('.layer-tabs-strip');
  const addButton = containerElement.querySelector('.layer-tab-add');
  const deleteButton = containerElement.querySelector('.layer-tab-delete-current');
  const scrollButtons = [...containerElement.querySelectorAll('.layer-tabs-scroll-button')];

  let installedLayerListeners = [];

  /* ---------- Sideways scrolling ---------- */

  const SCROLL_STEP_PIXELS = 180;

  for (const button of scrollButtons) {
    button.addEventListener('click', () => {
      strip.scrollBy({ left: Number(button.dataset.scroll) * SCROLL_STEP_PIXELS, behavior: 'smooth' });
    });
  }

  // Each arrow appears only when there is actually something to scroll to in
  // its direction; with few layers neither arrow is shown at all.
  function updateScrollButtons() {
    const overflowing = strip.scrollWidth > strip.clientWidth + 1;
    scrollButtons[0].hidden = !overflowing || strip.scrollLeft <= 0;
    scrollButtons[1].hidden = !overflowing
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

  /* ---------- Delete the selected layer ---------- */

  deleteButton.addEventListener('click', () => {
    const layer = app.selectedLayer;
    if (!layer || layer.type === 'video') return;
    const itemCount = Array.isArray(layer.items) ? layer.items.length : 0;
    if (itemCount > 0) {
      const warning = `⚠️ DELETE the layer "${layer.name}" and the `
        + `${itemCount} annotation${itemCount === 1 ? '' : 's'} on it?\n\n`
        + '(Cmd/Ctrl+Z undoes this if you change your mind.)';
      if (!window.confirm(warning)) return;
    }
    app.removeAnnotationLayer(layer.id);
  });

  function updateDeleteButton() {
    const layer = app.selectedLayer;
    const deletable = layer && layer.type !== 'video';
    deleteButton.disabled = !deletable;
    deleteButton.title = deletable
      ? `Delete the layer "${layer.name}"`
      : 'Select an annotation layer to delete it (the video layer cannot be deleted)';
  }

  /* ---------- Drag a tab sideways to re-order the layer stack ---------- */

  // The pending or active tab drag, or null: { layer, tabElement, pointerId,
  // startX, isDragging, grabOffsetX, translationX }. grabOffsetX is where
  // inside the tab it was grabbed, so the tab tracks the pointer from that
  // spot; translationX is the transform currently applied on top of the tab's
  // natural layout position.
  let tabDrag = null;
  // Swallow the click that the browser fires right after a drag's pointer-up,
  // so dropping a tab does not also count as clicking (selecting) it.
  let suppressNextTabClick = false;

  function beginTabDrag(event, layer, tabElement) {
    if (event.button !== 0) return;
    if (event.target.closest('.layer-tab-eye')) return;
    if (event.target instanceof HTMLInputElement) return;   // renaming
    suppressNextTabClick = false;
    tabDrag = { layer, tabElement, pointerId: event.pointerId, startX: event.clientX, isDragging: false };
    tabElement.setPointerCapture(event.pointerId);
  }

  // The dragged tab glides with the pointer: a transform offsets it from its
  // (possibly just re-slotted) layout position so its grabbed spot stays
  // under the cursor's x coordinate, clamped to the strip so it never
  // disappears under the clipped edges.
  function updateDraggedTabTransform(event) {
    const tabElement = tabDrag.tabElement;
    const tabRectangle = tabElement.getBoundingClientRect();
    const naturalLeft = tabRectangle.left - tabDrag.translationX;
    const stripRectangle = strip.getBoundingClientRect();
    const desiredLeft = Math.min(
      Math.max(event.clientX - tabDrag.grabOffsetX, stripRectangle.left),
      stripRectangle.right - tabRectangle.width);
    tabDrag.translationX = desiredLeft - naturalLeft;
    tabElement.style.transform = `translateX(${tabDrag.translationX}px)`;
  }

  const TAB_SLIDE_TRANSITION = 'transform 0.1s ease';

  /** The x translation an element currently carries (from the drag transform
      or a mid-flight slide animation); 0 when untransformed. */
  function currentTranslationX(element) {
    const computedTransform = getComputedStyle(element).transform;
    return computedTransform === 'none' ? 0 : new DOMMatrixReadOnly(computedTransform).e;
  }

  /** The element's layout (untransformed) left edge in screen coordinates. */
  function naturalLeftOf(element) {
    return element.getBoundingClientRect().left - currentTranslationX(element);
  }

  // Overtake rule: the dragged tab passes a neighbor once its leading edge
  // crosses that neighbor's midpoint — for equal-width tabs, exactly when the
  // dragged tab's own midpoint is more than halfway toward the neighbor's.
  // The other tabs stay put until such a crossing re-slots the DOM (DOM order
  // = stack order); the passed tabs then dart to their new slot with a short
  // slide animation instead of teleporting. Returns true when the order
  // changed. Midpoints use natural (untransformed) positions so a tab still
  // mid-slide is judged by where it belongs, not where it happens to be.
  function reSlotDraggedTab() {
    const tabElement = tabDrag.tabElement;
    const allTabs = [...strip.querySelectorAll('.layer-tab')];
    const draggedIndex = allTabs.indexOf(tabElement);
    const draggedRectangle = tabElement.getBoundingClientRect();
    const midpointOf = (element) =>
      naturalLeftOf(element) + element.getBoundingClientRect().width / 2;
    let targetIndex = draggedIndex;
    while (targetIndex > 0
           && draggedRectangle.left < midpointOf(allTabs[targetIndex - 1])) {
      targetIndex--;
    }
    if (targetIndex === draggedIndex) {
      while (targetIndex < allTabs.length - 1
             && draggedRectangle.right > midpointOf(allTabs[targetIndex + 1])) {
        targetIndex++;
      }
    }
    if (targetIndex === draggedIndex) return false;

    const previousNaturalLefts = new Map(
      allTabs.map((element) => [element, naturalLeftOf(element)]));
    if (targetIndex < draggedIndex) strip.insertBefore(tabElement, allTabs[targetIndex]);
    else strip.insertBefore(tabElement, allTabs[targetIndex].nextSibling);

    // Slide the passed tabs from their old visual position into the new slot:
    // start each at its previous position via a transform (keeping any
    // mid-flight offset so nothing jumps), then transition the offset away.
    const slidingTabs = [];
    for (const otherTab of allTabs) {
      if (otherTab === tabElement) continue;
      const startOffset = previousNaturalLefts.get(otherTab) - naturalLeftOf(otherTab)
        + currentTranslationX(otherTab);
      if (Math.abs(startOffset) < 0.5) continue;
      otherTab.style.transition = 'none';
      otherTab.style.transform = `translateX(${startOffset}px)`;
      slidingTabs.push(otherTab);
    }
    strip.getBoundingClientRect();   // flush styles so the offsets take hold
    for (const otherTab of slidingTabs) {
      otherTab.style.transition = TAB_SLIDE_TRANSITION;
      otherTab.style.transform = '';
      otherTab.addEventListener('transitionend', () => {
        otherTab.style.transition = '';
      }, { once: true });
    }
    return true;
  }

  // The move/up listeners live on window (not the tab bar) so the drag keeps
  // tracking the pointer's x coordinate even when the pointer drifts
  // vertically over the canvas, the transport bar, or the details panels.
  window.addEventListener('pointermove', (event) => {
    if (!tabDrag || event.pointerId !== tabDrag.pointerId) return;
    if (!tabDrag.isDragging) {
      if (Math.abs(event.clientX - tabDrag.startX) < DRAG_START_THRESHOLD_PIXELS) return;
      tabDrag.isDragging = true;
      tabDrag.grabOffsetX = tabDrag.startX - tabDrag.tabElement.getBoundingClientRect().left;
      tabDrag.translationX = 0;
      tabDrag.tabElement.classList.add('dragging');
    }
    updateDraggedTabTransform(event);
    if (reSlotDraggedTab()) {
      updateDraggedTabTransform(event);
      // Moving the node in the DOM briefly removes it from the document,
      // which drops pointer capture in some browsers; re-arm it so the drag
      // also survives the pointer leaving the browser window.
      try { tabDrag.tabElement.setPointerCapture(event.pointerId); } catch { /* pointer gone */ }
    }
  });

  function endTabDrag(event) {
    if (!tabDrag || event.pointerId !== tabDrag.pointerId) return;
    const { layer, tabElement, isDragging } = tabDrag;
    tabDrag = null;
    if (!isDragging) return;
    tabElement.style.transform = '';
    tabElement.classList.remove('dragging');
    suppressNextTabClick = true;
    // The browser dispatches that click synchronously after pointer-up, so the
    // flag can be dropped on the next tick in case no click arrives at all.
    setTimeout(() => { suppressNextTabClick = false; }, 0);
    const newIndex = [...strip.querySelectorAll('.layer-tab')].indexOf(tabElement);
    app.viewer.moveLayerToIndex(layer, newIndex);
    app.synchronizeDocumentLayerOrder();
  }
  window.addEventListener('pointerup', endTabDrag);
  window.addEventListener('pointercancel', endTabDrag);

  /* ---------- Tabs ---------- */

  function isUserEditingHere() {
    const activeElement = document.activeElement;
    return activeElement instanceof HTMLInputElement && containerElement.contains(activeElement);
  }

  function rebuildIfIdle() {
    if (isUserEditingHere()) return;
    if (tabDrag?.isDragging) return;   // never yank the tab out from under a drag
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
    updateDeleteButton();
    updateScrollButtons();
    strip.querySelector('.layer-tab.active')
      ?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }

  function buildTab(layer, isSelected) {
    const tab = document.createElement('div');
    tab.className = 'layer-tab';
    if (isSelected) tab.classList.add('active');
    tab.title = `${layer.name} — click to select, double-click to rename, drag to re-order`;

    const nameElement = document.createElement('span');
    nameElement.className = 'layer-tab-name';
    nameElement.textContent = layer.name;
    tab.appendChild(nameElement);

    const typeBadge = document.createElement('span');
    typeBadge.className = `layer-tab-type layer-type-${layer.type}`;
    typeBadge.textContent = layer.type;
    tab.appendChild(typeBadge);

    const eyeButton = document.createElement('button');
    eyeButton.type = 'button';
    eyeButton.className = 'layer-tab-eye';
    applyVisibilityAppearance(eyeButton, layer.visible);
    eyeButton.addEventListener('click', (event) => {
      event.stopPropagation();
      layer.setVisible(!layer.visible);
    });
    tab.appendChild(eyeButton);

    tab.addEventListener('pointerdown', (event) => beginTabDrag(event, layer, tab));
    tab.addEventListener('click', () => {
      if (suppressNextTabClick) { suppressNextTabClick = false; return; }
      app.setActiveLayer(layer.id);
    });
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
    button.innerHTML = visible ? EYE_VISIBLE_SVG : EYE_HIDDEN_SVG;
    button.title = visible ? 'Hide layer (v)' : 'Show layer (v)';
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
