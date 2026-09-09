// The shared base for the two media layers — video and image. A media layer is
// anything that composites a picture onto the stage, as opposed to an
// annotation layer that draws marks. Both kinds present upright at their native
// source resolution, so they share how they draw a source into their pixel
// rectangle, how they report their content bounds, and — crucially for the app
// — the fact that they are MEDIA: insertion order, paint precedence, opacity
// dimming, and the "a video/image is already loaded" prompt all treat every
// media layer the same way (see main.js and viewer.js), keying off `isMedia`
// rather than testing for a specific type.
//
// The one thing that does NOT generalize is the timeline: only a video carries
// frames and an engine, so only a video can be the timeline primary. That lives
// on VideoLayer, not here.

import { Layer } from './layer.js';

export class MediaLayer extends Layer {
  /** @param {{ id?: string, type: string, name?: string }} options */
  constructor(options) {
    super(options);
    // The File/Blob or URL string the media was opened from. Kept for reload
    // and, for video, decode recovery. Set by main.js once the media loads.
    this.mediaSource = null;
    // { name, sizeBytes, width, height, ... } — provenance the same shape for
    // both kinds, so autosave keys, the export's `video` field, and the layer
    // detail panel read it uniformly. Video adds frame/duration facts on top.
    this.mediaInformation = null;
  }

  get isMedia() { return true; }

  /** The media's native pixel dimensions, in source pixels. Subclasses answer
      from their own backing (the engine's frame size, the bitmap's size); 0
      before the media is ready, which contentBounds reads as "no bounds yet". */
  get sourceWidth() { return 0; }
  get sourceHeight() { return 0; }

  contentBounds() {
    const width = this.sourceWidth;
    const height = this.sourceHeight;
    if (!width || !height) return null;
    return { x: 0, y: 0, width, height };
  }

  /** Composite one already-upright source (a bitmap, a <canvas>, or a <video>)
      into this layer's native pixel rectangle, under the two conventions both
      media layers share:

      - the document's integer-coordinate convention: an integer (x, y) names a
        pixel's top-left corner (offset 0, the default) or its center (0.5).
        Drawing at -offset shifts the picture so the convention holds without
        touching any stored annotation coordinate.
      - a zoom-aware smoothing threshold: smoothing stays on until each source
        pixel covers at least a 4×4 block of BACKING-store pixels (CSS pixels
        further multiplied by devicePixelRatio), past which each source pixel
        should render as one crisp, solid square rather than a blurred one.

      The caller has already set any per-frame state it needs (a seek-pending
      brightness filter, say) on the context before calling. */
  drawSource(context, renderState, source, sourceWidth = this.sourceWidth, sourceHeight = this.sourceHeight) {
    const integerCoordinateOffset = renderState.document?.integerCoordinateOffset ?? 0;
    const backingPixelsPerSourcePixel = renderState.pixelsPerLocalUnit
      * (renderState.devicePixelRatio ?? 1);
    context.imageSmoothingEnabled = backingPixelsPerSourcePixel < 4;
    context.drawImage(source, -integerCoordinateOffset, -integerCoordinateOffset,
      sourceWidth, sourceHeight);
  }
}
