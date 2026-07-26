// A 1-screen-pixel-thick grid marking the borders between whole pixels. It's
// a property of the canvas's own coordinate system, not of any particular
// layer, so it is drawn as part of the overlay (world coordinates, scaled by
// the view transform only) and appears whether or not a video — or anything
// else — is loaded. Invisible until the user has zoomed in enough to
// actually distinguish individual units, then fades in, capping at a still-
// subtle maximum opacity. Can be turned off entirely from the settings modal;
// that preference is global (not per-document), so it's kept in localStorage.

const FADE_START_PIXELS_PER_UNIT = 4;
const FADE_END_PIXELS_PER_UNIT = 32;
const MAXIMUM_OPACITY = 0.15;
const LINE_WIDTH_SCREEN_PIXELS = 1;
const GRID_COLOR = '#ffffff';
const ENABLED_STORAGE_KEY = 'exact-video-annotator.pixelGridEnabled';

function loadEnabled() {
  try {
    const raw = localStorage.getItem(ENABLED_STORAGE_KEY);
    return raw === null ? true : raw === 'true';
  } catch {
    return true;
  }
}

let pixelGridEnabled = loadEnabled();

export function isPixelGridEnabled() {
  return pixelGridEnabled;
}

export function setPixelGridEnabled(enabled) {
  pixelGridEnabled = enabled;
  try { localStorage.setItem(ENABLED_STORAGE_KEY, String(enabled)); } catch { /* ignore */ }
}

/** 0 at and below the start threshold, ramping linearly to MAXIMUM_OPACITY
    at and above the end threshold. */
function opacityForScale(pixelsPerLocalUnit) {
  if (pixelsPerLocalUnit <= FADE_START_PIXELS_PER_UNIT) return 0;
  const fadeFraction = Math.min(1, (pixelsPerLocalUnit - FADE_START_PIXELS_PER_UNIT)
    / (FADE_END_PIXELS_PER_UNIT - FADE_START_PIXELS_PER_UNIT));
  return fadeFraction * MAXIMUM_OPACITY;
}

/**
 * Draws grid lines across whatever part of the world is currently visible on
 * screen. Called from the overlay painter, so context is already transformed
 * into world coordinates and renderState.pixelsPerLocalUnit is the view
 * transform's scale (screen pixels per world unit).
 */
export function drawPixelGrid(context, renderState) {
  if (!pixelGridEnabled) return;

  const pixelsPerLocalUnit = renderState.pixelsPerLocalUnit;
  const opacity = opacityForScale(pixelsPerLocalUnit);
  if (opacity <= 0) return;

  // Integer coordinates mark pixel boundaries under the top-left-corner
  // convention but pixel centers under the pixel-center convention (see
  // video-layer.js, which shifts the drawn image by the same offset) — so
  // the grid lines are shifted here too, keeping them on actual pixel
  // boundaries regardless of which convention the document uses.
  const integerCoordinateOffset = renderState.document?.integerCoordinateOffset ?? 0;

  // The context's current transform already maps world coordinates to device
  // pixels; inverting it recovers which world rectangle the visible canvas
  // backing store corresponds to.
  const inverseTransform = context.getTransform().invertSelf();
  const corner1 = inverseTransform.transformPoint({ x: 0, y: 0 });
  const corner2 = inverseTransform.transformPoint({ x: context.canvas.width, y: context.canvas.height });
  const minX = Math.min(corner1.x, corner2.x);
  const maxX = Math.max(corner1.x, corner2.x);
  const minY = Math.min(corner1.y, corner2.y);
  const maxY = Math.max(corner1.y, corner2.y);
  if (minX >= maxX || minY >= maxY) return;

  context.save();
  context.globalAlpha = opacity;
  context.strokeStyle = GRID_COLOR;
  context.lineWidth = LINE_WIDTH_SCREEN_PIXELS / pixelsPerLocalUnit;
  context.beginPath();
  for (let n = Math.ceil(minX + integerCoordinateOffset); n <= Math.floor(maxX + integerCoordinateOffset); n++) {
    const x = n - integerCoordinateOffset;
    context.moveTo(x, minY);
    context.lineTo(x, maxY);
  }
  for (let n = Math.ceil(minY + integerCoordinateOffset); n <= Math.floor(maxY + integerCoordinateOffset); n++) {
    const y = n - integerCoordinateOffset;
    context.moveTo(minX, y);
    context.lineTo(maxX, y);
  }
  context.stroke();
  context.restore();
}
