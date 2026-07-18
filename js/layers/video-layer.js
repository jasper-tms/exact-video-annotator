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
    context.imageSmoothingEnabled = renderState.pixelsPerLocalUnit < 4;
    context.drawImage(element, 0, 0, engine.videoWidth, engine.videoHeight);
  }

  contentBounds() {
    return { x: 0, y: 0, width: this.engine.videoWidth, height: this.engine.videoHeight };
  }
}
