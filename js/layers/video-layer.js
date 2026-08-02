// The video layer composites whichever element the engine presents into
// (canvas for WebCodecs, <video> for the native tier) onto the stage. Both
// present upright with rotation already applied, so drawing the whole element
// into the video's upright pixel rectangle is correct for either tier.
//
// With several videos open at once, each VideoLayer owns everything about its
// clip: the engine, the offscreen host holding that engine's canvas/<video>
// pair, the source (kept for decode recovery), and the clip's facts. One video
// layer is the PRIMARY — its engine drives the transport bar and the meaning
// of every annotation frame index — and the rest are followers that are seeked
// to match it (see "Multiple videos" in ARCHITECTURE.md). The link settings
// below say how a follower's frames correspond to the primary's.

import { Layer } from './layer.js';

export class VideoLayer extends Layer {
  /**
   * @param {object} engine  An exact-video-engine.js engine (either tier).
   * @param {HTMLElement} hostElement  The offscreen container holding this
   *   engine's canvas/<video>; it is sized here so the engine's canvas gets a
   *   backing store at the video's native resolution.
   */
  constructor(engine, hostElement, { name = 'Video' } = {}) {
    super({ type: 'video', name });
    this.engine = engine;
    this.hostElement = hostElement;
    hostElement.style.width = `${engine.videoWidth}px`;
    hostElement.style.height = `${engine.videoHeight}px`;

    // Set by main.js when the video is loaded:
    this.videoSource = null;        // File/Blob or URL string, kept for decode recovery
    this.videoInformation = null;   // { name, sizeBytes, numberOfFrames, frameRate, ... }
    this.loadIdentifier = null;     // ties indexing progress and toasts to this video

    // How this video follows the primary when it is not the primary itself:
    //   'timestamp'   (the default) — follower frame = frameAtTime(primary time
    //     + temporalOffset (seconds)), through this engine's own frame↔time
    //     table. Right for independent recordings of the same scene, even at
    //     different frame rates — the common case, so it leads.
    //   'frame-index' — follower frame = primary frame + temporalOffset (frames).
    //     Right when the files correspond frame for frame regardless of what
    //     their timestamps claim (trigger-synchronized camera rigs, processed
    //     renditions of the same clip).
    // temporalOffset's unit follows the mode. Switching modes keeps whatever
    // value is in the box (0 unless the user has typed one) rather than
    // computing an alignment-preserving offset — see app.setVideoLinkMode.
    // Session-only: never written into the document.
    this.linkMode = 'timestamp';
    this.temporalOffset = 0;

    // Session-only render flag: true when the shared timeline is asking this
    // follower for a position it has no frame for — before its first frame,
    // past its last, or inside a leading empty edit's void. draw() then paints
    // just a grey placement outline instead of a picture. Set by
    // app.applyFollowerTarget; always false for the primary and a single video.
    // Past-the-end has no engine sentinel (the engine clamps to [0, duration]),
    // so this app-owned flag is the single source of truth, covering every
    // out-of-content case uniformly rather than reading the engine's -1.
    this.inVoid = false;
  }

  setLinkMode(linkMode, temporalOffset) {
    this.linkMode = linkMode;
    this.temporalOffset = temporalOffset;
    this.dispatchEvent(new CustomEvent('layer-changed'));
  }

  setTemporalOffset(temporalOffset) {
    this.temporalOffset = temporalOffset;
    this.dispatchEvent(new CustomEvent('layer-changed'));
  }

  /** Swap in a replacement engine presenting into the same host (the
      fatal-decode recovery path rebuilds on the native tier; the layer itself
      — id, name, transform, tab — stays put). */
  replaceEngine(engine) {
    this.engine = engine;
    this.hostElement.style.width = `${engine.videoWidth}px`;
    this.hostElement.style.height = `${engine.videoHeight}px`;
    this.dispatchEvent(new CustomEvent('layer-changed'));
  }

  draw(context, renderState) {
    const { engine } = this;
    const integerCoordinateOffset = renderState.document?.integerCoordinateOffset ?? 0;
    // No frame for this position — a follower before its first frame, past its
    // last, or in a leading empty edit's void (see app.applyFollowerTarget).
    // Show no picture (a native <video> would render the void black, which
    // drawing would composite onto the stage), but trace a thin grey outline
    // around where the video sits so it is clear the video is present, just
    // without a frame at this time. Sizing the stroke by pixelsPerLocalUnit
    // keeps it ~1 CSS pixel wide at any zoom.
    if (this.inVoid) {
      context.lineWidth = 1 / (renderState.pixelsPerLocalUnit || 1);
      context.strokeStyle = 'rgba(140, 140, 140, 0.8)';
      context.strokeRect(-integerCoordinateOffset, -integerCoordinateOffset,
        engine.videoWidth, engine.videoHeight);
      return;
    }
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
    // afterward, so there is nothing to reset here. Only the primary dims:
    // the flag describes the transport's seek, which followers trail anyway.
    if (renderState.isSeekPendingDisplay && this === renderState.primaryVideoLayer) {
      context.filter = 'brightness(0.4)';
    }
    // Integer (x, y) names a pixel's top-left corner by default (offset 0); an
    // offset of 0.5 instead names its center, which draws the image shifted up
    // and left by half a pixel so that convention holds without touching any
    // stored annotation coordinates (integerCoordinateOffset, read above).
    context.drawImage(element, -integerCoordinateOffset, -integerCoordinateOffset,
      engine.videoWidth, engine.videoHeight);
  }

  contentBounds() {
    return { x: 0, y: 0, width: this.engine.videoWidth, height: this.engine.videoHeight };
  }
}
