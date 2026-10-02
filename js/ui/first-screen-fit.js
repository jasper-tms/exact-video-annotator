// Sizes the first screenful (tool rail, canvas, transport, layer tabs) so its
// bottom edge never hides under a mobile browser's bottom bar while the page
// is scrolled to the top, without making the page jump around once the user
// has scrolled down to the details below.
//
// Mobile Chrome's bottom bar slides in and out as the user scrolls. The
// "large" viewport height is the visible height with that bar hidden; the
// "dynamic" one is the visible height right now. The first screen ends at
//   min(large height, scroll position + dynamic height)
// from the top of the page. So:
//   - scrolled to the top, it ends exactly at the bottom of what is visible,
//     following the bar as it appears and disappears;
//   - scrolled down past the bar's height, it is at its full (large) size and
//     stays there, and the bar simply covers and uncovers a strip of the
//     details section below;
//   - in between, it keeps the layer tabs pinned just above the bar.
// On a desktop browser the two heights are equal, so it is always the full
// window height.

export function initializeFirstScreenFit(sectionElement) {
  // Fixed-position probes measure the two viewport heights in CSS pixels
  // (unaffected by page zoom, unlike window.innerHeight). 100vh is set first
  // as the fallback for browsers that do not support lvh/dvh.
  const largeViewportProbe = createViewportHeightProbe('100lvh');
  const dynamicViewportProbe = createViewportHeightProbe('100dvh');

  function fullBottom() {
    return largeViewportProbe.getBoundingClientRect().height;
  }

  function visibleBottom() {
    return Math.max(0, window.scrollY) + dynamicViewportProbe.getBoundingClientRect().height;
  }

  function fittedBottom() {
    return Math.min(fullBottom(), visibleBottom());
  }

  function update() {
    sectionElement.style.setProperty('--first-screen-bottom', `${fittedBottom()}px`);
  }

  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  window.visualViewport?.addEventListener('resize', update);
  update();

  return {
    /** How much taller the first screen will be once scrolled down past the
        browser's bottom bar (0 on desktop). Scrolling to something below it
        has to aim this much further down to land where intended. */
    pixelsLeftToGrow: () => fullBottom() - fittedBottom(),
    /** How much of the page below the first screen is in view (0 while the
        first screen fills the window, including while it is pinned above the
        browser's bottom bar a little way down the page). */
    pixelsScrolledPastFirstScreen: () => Math.max(0, visibleBottom() - fullBottom()),
  };
}

function createViewportHeightProbe(height) {
  const probe = document.createElement('div');
  probe.style.cssText = 'position: fixed; top: 0; left: 0; width: 0; height: 100vh;'
    + ' visibility: hidden; pointer-events: none;';
  probe.style.height = height;   // ignored (keeping 100vh) where unsupported
  probe.setAttribute('aria-hidden', 'true');
  document.body.appendChild(probe);
  return probe;
}
