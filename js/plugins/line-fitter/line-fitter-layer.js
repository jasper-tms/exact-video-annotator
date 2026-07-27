// The line-fitter plugin's layer: a coordinates layer whose freshly drawn
// (and, optionally, freshly dragged) geometry is snapped onto the edge or the
// stripe under it. It is a plain CoordinatesLayer in every other respect —
// same items, same drawing, same editing contract — so everything that
// already works on coordinates keeps working here, and the annotations it
// produces are ordinary coordinates items in the exported JSON.
//
// The hooks below are the optional "annotation logic" contract that the
// drawing tools and the drag helpers call when a layer implements them; see
// ARCHITECTURE.md under "Plugins".

import { CoordinatesLayer } from '../../layers/coordinates-layer.js';
import {
  readFrameLuminancePatch, createLuminanceSampler, boundsOfPoints,
  videoPixelFromLayerPoint, layerPointFromVideoPixel,
} from '../frame-pixels.js';
import {
  DEFAULT_LINE_FITTER_OPTIONS, fitNewestSegment, fitClosingSegment, fitWholeShape,
  verticesFormClosedLoop, readMarginPixels, profileReachPixels,
} from './fit-line.js';

// The fit's travel is unbounded, but each pixel read is not: when a fit ends
// with its profile pressed against the border of the patch it was reading —
// where clamped, flat pixels stall the descent artificially — the fit is run
// again against a fresh patch read around where it got to. This many rounds
// corresponds to several dozen pixels of travel, far beyond any intended fit.
const MAXIMUM_FIT_ROUNDS = 8;

export class LineFitterLayer extends CoordinatesLayer {
  /**
   * @param {object} documentLayer  A `type: 'coordinates'` layer carrying
   *   `plugin: { id: 'line-fitter', options }`.
   * @param {object} plugin  The plugin descriptor this layer belongs to.
   * @param {object} app  The Application instance, forwarded to CoordinatesLayer.
   */
  constructor(documentLayer, plugin, app) {
    super(documentLayer, app);
    this.plugin = plugin;
    // The fit computes fractional positions on purpose (an edge lands on an
    // integer, a stripe center on a half-integer, but a diagonal edge lands
    // wherever it actually falls) — snapping the drawn point to the integer
    // grid before the fit runs would only start it half a pixel off. Default
    // on for a freshly added layer; still overridable per the base class
    // (including by a document that explicitly saved it off).
    this.allowFractionalCoordinates = documentLayer.allowFractionalCoordinates ?? true;
    this.options = { ...DEFAULT_LINE_FITTER_OPTIONS, ...(documentLayer.plugin?.options ?? {}) };
    // What the last fit did, for the settings panel to report. Purely
    // informational; never exported.
    this.lastFitDescription = null;
  }

  // The last "the fit could not run" message announced, so the same one is not
  // announced again for every point dropped.
  #lastFitProblemMessage = null;

  setOption(key, value) {
    if (this.options[key] === value) return;
    this.options = { ...this.options, [key]: value };
    this.dispatchEvent(new CustomEvent('layer-changed'));
  }

  /* ---------- Annotation-logic hooks ---------- */

  /** A vertex was just dropped: fit the segment it completed. */
  afterVertexPlaced(app, vertices, kind) {  // eslint-disable-line no-unused-vars
    if (vertices.length < 2) return;
    this.#fitInVideoPixels(app, vertices,
      (videoVertices, sampleLuminance) =>
        [fitNewestSegment(videoVertices, sampleLuminance, this.options)]);
  }

  /** The shape is about to be committed: a closed polyline still needs its
      closing segment fitted (an open one has no segment left to fit). */
  beforeShapeCommitted(app, vertices, kind) {
    if (kind !== 'polyline' || !verticesFormClosedLoop(vertices)) return;
    this.#fitInVideoPixels(app, vertices,
      (videoVertices, sampleLuminance) =>
        [fitClosingSegment(videoVertices, sampleLuminance, this.options)]);
  }

  /** A drag just ended. Re-fitting here is a preference, since a drag is also
      how you overrule a fit you did not want. */
  afterItemDragged(app, itemId) {
    if (!this.options.refitAfterDragging) return false;
    return this.refitItem(app, itemId);
  }

  /** Re-fit a whole shape from scratch. Returns true if anything moved. */
  refitItem(app, itemId) {
    const item = this.getItem(itemId);
    if (!item || !Array.isArray(item.vertices) || item.vertices.length < 2) return false;
    const before = item.vertices.map((vertex) => [vertex[0], vertex[1]]);
    this.#fitInVideoPixels(app, item.vertices,
      (videoVertices, sampleLuminance) =>
        fitWholeShape(videoVertices, item.kind, sampleLuminance, this.options));
    return item.vertices.some(
      (vertex, index) => vertex[0] !== before[index][0] || vertex[1] !== before[index][1]);
  }

  /* ---------- Running a fit ---------- */

  /**
   * Convert layer-local vertices into video pixels, run `fit` on them, and
   * write the result back in place. Everything the fit reasons about — the
   * descent's steps, the stripe widths, the sampling — is in image pixels,
   * which is what "moved 2 pixels" is supposed to mean regardless of the
   * layer's transform or the current zoom.
   *
   * @param {Array<[number, number]>} localVertices  Mutated in place.
   * @param {(videoVertices: Array<[number, number]>, sampleLuminance: Function) => Array<object|null>} fit
   */
  #fitInVideoPixels(app, localVertices, fit) {
    let summaries;
    let videoVertices;
    let largestMovePixels = 0;
    try {
      videoVertices = localVertices.map((vertex) => {
        const point = videoPixelFromLayerPoint(app, this, { x: vertex[0], y: vertex[1] });
        return [point.x, point.y];
      });
      const initialVideoVertices = videoVertices.map((vertex) => [vertex[0], vertex[1]]);
      const marginPixels = readMarginPixels(this.options);
      // The fit needs true pixels this far around wherever it ends up; being
      // closer than this to the patch border means it may have been stalled
      // by the border's clamped, flat pixels rather than by the image.
      const borderClearancePixels = profileReachPixels(this.options) + 2;
      for (let round = 0; round < MAXIMUM_FIT_ROUNDS; round++) {
        const patch = readFrameLuminancePatch(
          app, boundsOfPoints(videoVertices), marginPixels);
        const beforeRound = videoVertices.map((vertex) => [vertex[0], vertex[1]]);
        summaries = fit(videoVertices, createLuminanceSampler(patch));
        const moved = videoVertices.some((vertex, index) =>
          vertex[0] !== beforeRound[index][0] || vertex[1] !== beforeRound[index][1]);
        if (!moved) break;
        const bounds = boundsOfPoints(videoVertices);
        const clearOfBorder =
          bounds.minX - borderClearancePixels >= patch.left
          && bounds.minY - borderClearancePixels >= patch.top
          && bounds.maxX + borderClearancePixels <= patch.left + patch.width
          && bounds.maxY + borderClearancePixels <= patch.top + patch.height;
        if (clearOfBorder) break;
      }
      largestMovePixels = Math.max(...videoVertices.map((vertex, index) =>
        Math.hypot(vertex[0] - initialVideoVertices[index][0],
          vertex[1] - initialVideoVertices[index][1])));
    } catch (error) {
      // The panel is below the fold, so a fit that cannot run at all (no video
      // open, cross-origin pixels) also says so where the drawing is happening
      // — but only once per problem, since every point dropped would hit it.
      const message = `Line fitter: ${error.message ?? error}.`;
      if (message !== this.#lastFitProblemMessage) {
        this.#lastFitProblemMessage = message;
        app.showToast(message, { kind: 'warning' });
      }
      this.#reportFit(app, `could not fit: ${error.message ?? error}`);
      return;
    }
    this.#lastFitProblemMessage = null;
    for (let index = 0; index < localVertices.length; index++) {
      const local = layerPointFromVideoPixel(
        app, this, { x: videoVertices[index][0], y: videoVertices[index][1] });
      localVertices[index][0] = local.x;
      localVertices[index][1] = local.y;
    }
    this.#reportFit(app,
      describeFit(summaries.filter(Boolean), largestMovePixels, this.options));
    app.viewer.requestRender();
  }

  #reportFit(app, description) {
    this.lastFitDescription = description;
    this.dispatchEvent(new CustomEvent('layer-changed'));
  }
}

/** One line of plain English about what the fit just did. */
function describeFit(summaries, largestMovePixels, options) {
  if (summaries.length === 0) return 'nothing to fit';
  const segmentText = summaries.length === 1 ? '1 segment' : `${summaries.length} segments`;
  const parts = [
    `${segmentText} fitted, largest move ${largestMovePixels.toFixed(2)} px`,
    `strength ${summaries[0].score.toFixed(1)}`,
  ];
  if (options.mode === 'stripe' && summaries[0].stripeHalfWidthPixels !== null) {
    parts.push(`stripe half-width about ${summaries[0].stripeHalfWidthPixels.toFixed(1)} px`);
  }
  return parts.join(' · ');
}
