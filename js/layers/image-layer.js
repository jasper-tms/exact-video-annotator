// A still-image layer composites one decoded bitmap onto the stage. It is a
// MediaLayer (see media-layer.js) and, unlike a video layer, that is nearly all
// it is: it has no engine, no frames, and no timeline, so it paints the same
// picture on every frame. An image opened alongside a video therefore stays on
// screen no matter where the time scrubber sits, and an image opened on its own
// needs no timeline at all. It shares insertion, paint order, opacity, and
// provenance with the video layer through MediaLayer, so the app treats the two
// identically wherever those behaviors apply.
//
// Formats are whatever the browser decodes natively through createImageBitmap
// (PNG, JPEG, WebP, GIF, BMP); the bitmap is held fully in memory (images are
// small next to the byte-range videos, so there is nothing to read lazily).

import { MediaLayer } from './media-layer.js';

export class ImageLayer extends MediaLayer {
  /**
   * @param {ImageBitmap} bitmap  The decoded image, drawn at its native size.
   * @param {object} options
   * @param {string} [options.name]  Layer name (defaults to the file name).
   */
  constructor(bitmap, { name = 'Image' } = {}) {
    super({ type: 'image', name });
    // mediaSource / mediaInformation (from MediaLayer) are set by main.js.
    this.bitmap = bitmap;
  }

  get sourceWidth() { return this.bitmap?.width ?? 0; }
  get sourceHeight() { return this.bitmap?.height ?? 0; }

  draw(context, renderState) {
    if (!this.bitmap) return;
    this.drawSource(context, renderState, this.bitmap);
  }
}
