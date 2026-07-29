// Reading the pixels of the frame on screen right now, for plugins whose
// annotation logic looks at the image (the line fitter snapping onto an edge,
// for example).
//
// The engine's display element — a canvas on the WebCodecs tier, a <video> on
// the native one — always presents the current frame upright, which is exactly
// what the video layer composites onto the stage. So a patch of it, copied
// into a scratch canvas, is a patch of upright source-video pixels: the same
// space annotation geometry is stored in.

/** Reused across calls; resized as needed. Reading it back every frame is the
    whole point, hence willReadFrequently. */
let scratchCanvas = null;
let scratchContext = null;

function scratchContextOfSize(width, height) {
  if (scratchCanvas === null) {
    scratchCanvas = document.createElement('canvas');
    scratchContext = scratchCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (scratchCanvas.width < width) scratchCanvas.width = width;
  if (scratchCanvas.height < height) scratchCanvas.height = height;
  return scratchContext;
}

/**
 * Copy a rectangle of the current frame out of the engine and turn it into
 * luminance values.
 *
 * @param {object} app
 * @param {{minX: number, minY: number, maxX: number, maxY: number}} boundsInVideoPixels
 * @param {number} marginPixels  Grown around those bounds before reading.
 * @returns {{left: number, top: number, width: number, height: number,
 *            luminance: Float32Array}}
 * @throws {Error} when there is no readable frame (no video open yet, or a
 *   cross-origin video the browser refuses to let the page read back).
 */
export function readFrameLuminancePatch(app, boundsInVideoPixels, marginPixels) {
  const engine = videoLayerOf(app).engine;
  const element = engine?.displayElement;
  if (!element) throw new Error('no video frame is on screen');

  const videoWidth = engine.videoWidth;
  const videoHeight = engine.videoHeight;
  const elementWidth = element.videoWidth ?? element.width;
  const elementHeight = element.videoHeight ?? element.height;
  if (!videoWidth || !videoHeight || !elementWidth || !elementHeight) {
    throw new Error('the video has not decoded a frame yet');
  }

  const left = Math.max(0, Math.floor(boundsInVideoPixels.minX - marginPixels));
  const top = Math.max(0, Math.floor(boundsInVideoPixels.minY - marginPixels));
  const right = Math.min(videoWidth, Math.ceil(boundsInVideoPixels.maxX + marginPixels));
  const bottom = Math.min(videoHeight, Math.ceil(boundsInVideoPixels.maxY + marginPixels));
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) throw new Error('that annotation is outside the frame');

  // The display element may not be the video's own pixel size (the native tier
  // presents whatever the <video> decoded to), and the video layer draws it
  // stretched into the upright rectangle; read it the same way.
  const scaleX = elementWidth / videoWidth;
  const scaleY = elementHeight / videoHeight;
  const context = scratchContextOfSize(width, height);
  context.clearRect(0, 0, width, height);
  context.drawImage(element,
    left * scaleX, top * scaleY, width * scaleX, height * scaleY,
    0, 0, width, height);

  let imageData;
  try {
    imageData = context.getImageData(0, 0, width, height);
  } catch {
    // A canvas tainted by a cross-origin video cannot be read back.
    throw new Error('this video came from another origin, so its pixels cannot be read');
  }

  const pixels = imageData.data;
  const luminance = new Float32Array(width * height);
  for (let index = 0; index < luminance.length; index++) {
    const offset = index * 4;
    luminance[index] = 0.2126 * pixels[offset]
      + 0.7152 * pixels[offset + 1]
      + 0.0722 * pixels[offset + 2];
  }
  return { left, top, width, height, luminance };
}

/**
 * Bilinear luminance lookup in video-pixel coordinates. Positions outside the
 * patch clamp to its border, which reads as flat (no gradient) rather than as
 * an edge the fit could latch onto.
 *
 * Video-pixel coordinates put INTEGERS AT PIXEL CORNERS — the video layer
 * draws pixel k across [k, k + 1), so the boundary between two pixel rows is
 * an exact integer and pixel k's own sample point (its center) is k + 0.5.
 * The half-pixel shift below converts that into the array's index space,
 * where luminance[k] is the value AT k + 0.5. Without it every fit lands half
 * a pixel away from where the image is actually drawn.
 */
export function createLuminanceSampler(patch) {
  const { left, top, width, height, luminance } = patch;
  return function sampleLuminance(videoX, videoY) {
    const x = Math.min(width - 1, Math.max(0, videoX - left - 0.5));
    const y = Math.min(height - 1, Math.max(0, videoY - top - 0.5));
    const columnLow = Math.floor(x);
    const rowLow = Math.floor(y);
    const columnHigh = Math.min(width - 1, columnLow + 1);
    const rowHigh = Math.min(height - 1, rowLow + 1);
    const columnFraction = x - columnLow;
    const rowFraction = y - rowLow;
    const topLeft = luminance[rowLow * width + columnLow];
    const topRight = luminance[rowLow * width + columnHigh];
    const bottomLeft = luminance[rowHigh * width + columnLow];
    const bottomRight = luminance[rowHigh * width + columnHigh];
    const topValue = topLeft + (topRight - topLeft) * columnFraction;
    const bottomValue = bottomLeft + (bottomRight - bottomLeft) * columnFraction;
    return topValue + (bottomValue - topValue) * rowFraction;
  };
}

/* ---------- Layer-local ↔ video-pixel coordinates ---------- */

/** The video a fit reads its pixels from: the TOPMOST VISIBLE video layer —
    the one whose picture is actually in front of the user — falling back to
    the topmost video when every video is hidden. Both the pixels read and the
    layer-local ↔ video-pixel conversions below go through this same layer, so
    a fit is always against the image it appears on top of. */
function videoLayerOf(app) {
  const videoLayers = app.viewer.layers.filter((layer) => layer.type === 'video');
  if (videoLayers.length === 0) throw new Error('no video is open, so there is nothing to fit to');
  return [...videoLayers].reverse().find((layer) => layer.visible && layer.opacity > 0)
    ?? videoLayers[videoLayers.length - 1];
}

/** Layer-local point → the upright source video's pixel grid. */
export function videoPixelFromLayerPoint(app, layer, localPoint) {
  const world = app.worldFromLocal(layer, localPoint);
  return app.localFromWorld(videoLayerOf(app), world);
}

/** The inverse of videoPixelFromLayerPoint. */
export function layerPointFromVideoPixel(app, layer, videoPoint) {
  const world = app.worldFromLocal(videoLayerOf(app), videoPoint);
  return app.localFromWorld(layer, world);
}

/** Bounding box of [x, y] pairs, as readFrameLuminancePatch wants it. */
export function boundsOfPoints(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}
