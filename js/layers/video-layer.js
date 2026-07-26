// The video layer composites whichever element the engine presents into
// (canvas for WebCodecs, <video> for the native tier) onto the stage. Both
// present upright with rotation already applied, so drawing the whole element
// into the video's upright pixel rectangle is correct for either tier.

import { Layer } from './layer.js';

export class VideoLayer extends Layer {
  /**
   * @param {object} engine  An exact-video-engine.js engine (either tier).
   * @param {HTMLElement} hostElement  The offscreen container holding the
   *   engine's canvas/<video>; it is sized here so the engine's canvas gets a
   *   backing store at the video's native resolution.
   */
  constructor(engine, hostElement, { name = 'Video' } = {}) {
    super({ type: 'video', name });
    this.engine = engine;
    this.hostElement = hostElement;
    hostElement.style.width = `${engine.videoWidth}px`;
    hostElement.style.height = `${engine.videoHeight}px`;
  }

  draw(context, renderState) {
    const { engine } = this;
    const element = engine.displayElement;
    if (!element) return;
    // Draw the element's full content into the upright pixel rectangle.
    // For the native tier the <video> may not have decoded a frame yet;
    // drawImage would throw on a zero-sized source, so guard.
    const sourceWidth = element.videoWidth ?? element.width;
    const sourceHeight = element.videoHeight ?? element.height;
    if (!sourceWidth || !sourceHeight) return;
    // pixelsPerLocalUnit is CSS pixels per source pixel; smoothing must key off
    // the actual backing-store density (CSS pixels are further multiplied by
    // devicePixelRatio there), or a retina screen keeps smoothing on past the
    // point where each source pixel should render as one crisp, solid square.
    const backingPixelsPerSourcePixel = renderState.pixelsPerLocalUnit
      * (renderState.devicePixelRatio ?? 1);
    context.imageSmoothingEnabled = backingPixelsPerSourcePixel < 4;
    // A seek that is taking a moment to land dims the picture, cueing that
    // the pixels on screen are not the requested frame yet (see
    // app.isSeekPendingDisplay in main.js for the timing). context.restore()
    // in viewer.js's per-layer draw loop clears this back to 'none'
    // afterward, so there is nothing to reset here.
    if (renderState.isSeekPendingDisplay) context.filter = 'brightness(0.4)';
    // Integer (x, y) names a pixel's top-left corner by default (offset 0); an
    // offset of 0.5 instead names its center, which draws the image shifted up
    // and left by half a pixel so that convention holds without touching any
    // stored annotation coordinates.
    const integerCoordinateOffset = renderState.document?.integerCoordinateOffset ?? 0;
    context.drawImage(element, -integerCoordinateOffset, -integerCoordinateOffset,
      engine.videoWidth, engine.videoHeight);
  }

  contentBounds() {
    return { x: 0, y: 0, width: this.engine.videoWidth, height: this.engine.videoHeight };
  }
}
