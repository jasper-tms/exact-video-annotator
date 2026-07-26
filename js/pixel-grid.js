// A 1-screen-pixel-thick grid marking the borders between whole-number
// coordinates. It's a property of the canvas's own coordinate system, not of
// any particular layer, so it is drawn as part of the overlay (world
// coordinates, scaled by the view transform only) and appears whether or not
// a video — or anything else — is loaded. Invisible until the user has
// zoomed in enough to actually distinguish individual units, then fades in,
// capping at a still-subtle maximum opacity.

const FADE_START_PIXELS_PER_UNIT = 8;
const FADE_END_PIXELS_PER_UNIT = 64;
const MAXIMUM_OPACITY = 0.5;
const LINE_WIDTH_SCREEN_PIXELS = 1;
const GRID_COLOR = '#ffffff';

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
  const pixelsPerLocalUnit = renderState.pixelsPerLocalUnit;
  const opacity = opacityForScale(pixelsPerLocalUnit);
  if (opacity <= 0) return;

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
  for (let x = Math.ceil(minX); x <= Math.floor(maxX); x++) {
    context.moveTo(x, minY);
    context.lineTo(x, maxY);
  }
  for (let y = Math.ceil(minY); y <= Math.floor(maxY); y++) {
    context.moveTo(minX, y);
    context.lineTo(maxX, y);
  }
  context.stroke();
  context.restore();
}
