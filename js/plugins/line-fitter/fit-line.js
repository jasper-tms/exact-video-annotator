// The line fitter's math: given a polyline in video-pixel coordinates and a
// way to read the image's luminance at any (fractional) position, nudge the
// vertices by a few pixels so each segment lands on the edge — or on the
// middle of the stripe — the user was aiming at.
//
// Two rules shape the whole search:
//
//  * A free endpoint may only move PERPENDICULAR to its segment, so fitting
//    never meaningfully changes the drawn length (moving both ends by up to a
//    few pixels sideways changes the length only to second order).
//  * An endpoint that already belongs to a segment fitted earlier may only
//    slide ALONG that fitted segment, so locking segment 1→2 onto its edge
//    cannot drag vertex 1 off the edge that segment 0→1 was locked to.
//
// No DOM and no app object in here: test/line-fitter-test.mjs drives these
// functions with synthetic images.

/** Luminance is 0..255, so every score below is in luminance units. */
export const DEFAULT_LINE_FITTER_OPTIONS = {
  // 'edge'   — sit on the sharpest change in intensity.
  // 'stripe' — sit in the middle of a bright or dark stripe, as far as
  //            possible from the two edges that bound it.
  mode: 'edge',
  // Stripe mode scans this range of stripe widths and keeps the best.
  minimumStripeWidthPixels: 1,
  maximumStripeWidthPixels: 20,
  refitAfterDragging: true,
};

// Neither mode searches an area for the best placement: that would find the
// STRONGEST feature in range, which is how a fit jumps off the faint edge the
// user aimed at and onto a bolder one nearby. Instead the placement starts
// exactly where the points were dropped and walks uphill in score, step by
// shrinking step, settling into the NEAREST local optimum — it can never
// cross a valley to a better feature further away. There is deliberately no
// cap on how far the walk may travel: as long as every step keeps improving
// the score, the line is still riding one continuous feature (a wide soft
// edge, say) and may follow it as far as it goes. What it cannot do is start:
// the score only feels a feature within the profile's reach, so a line placed
// further off than that from anything at all stays put.
const DESCENT_INITIAL_STEP_PIXELS = 0.5;
const DESCENT_MINIMUM_STEP_PIXELS = 0.01;
// The only bound on the walk, and purely a runaway backstop — it allows some
// sixty pixels of travel, far beyond what any intended fit does.
const DESCENT_EVALUATION_LIMIT = 1000;

// A fitted coordinate this close to a half-integer becomes exactly it. The
// descent stops within 0.01 px, and the places edges and stripe centers
// actually live — pixel borders and pixel centers — are integers and
// half-integers, so a landing this close almost certainly means exactly that.
const FITTED_COORDINATE_SNAP_TOLERANCE_PIXELS = 0.01;

// How many places along a segment are scored. One per pixel of length, within
// these bounds — a 6-pixel segment still gets enough samples to average over,
// and a 4000-pixel one does not cost 4000 taps per candidate placement.
const MINIMUM_SAMPLE_COUNT = 8;
const MAXIMUM_SAMPLE_COUNT = 160;

// Both scores read a PERPENDICULAR PROFILE of the image across the candidate
// line — the luminance at each distance out from it, averaged along its length
// — sampled at this spacing.
const PROFILE_STEP_PIXELS = 0.5;

// Edge mode differentiates that profile with a Gaussian derivative of this
// width, over this reach. A plain two-tap difference would do as well on a
// clean step, but its response is FLAT across a band as wide as the tap
// spacing, and a flat score is a fit that stops wherever it entered the band
// instead of on the edge. A smooth kernel has one peak, exactly on the edge.
const EDGE_KERNEL_WIDTH_PIXELS = 0.8;
const EDGE_PROFILE_REACH_PIXELS = 2;

// Stripe mode compares a band of the profile centered on the line against the
// background just outside it, on both sides. The flanks are this wide.
const STRIPE_FLANK_PIXELS = 2;

// How hard a difference BETWEEN the two flanks counts against a placement.
// Being centered on a stripe means being surrounded by the same background on
// both sides, so the flanks of a true center match — while the score's one
// imposter, a band parked NEXT to the stripe with the whole stripe caught in
// one flank, has all of its signal in that flank. At this weight the imposter
// cancels exactly (|0 − m/2| − 0.5·|m − 0| = 0), which is what makes the
// stripe score unimodal enough for the descent to trust: the grid search
// could skip over that spurious local maximum, a descent walks into it.
const STRIPE_FLANK_ASYMMETRY_WEIGHT = 0.5;

// Stripe half-widths are scanned in this step.
const STRIPE_HALF_WIDTH_STEP_PIXELS = 0.5;

// Breaks ties toward leaving the user's points where they put them: a flat
// image scores the same everywhere, and should then move nothing at all.
// Small enough that it never outvotes a real difference in image evidence.
const SMALLEST_MOVEMENT_PREFERENCE = 1e-3;

/* ---------- Small vector helpers ---------- */

function unitVector(x, y) {
  const length = Math.hypot(x, y);
  if (!(length > 0)) return null;
  return { x: x / length, y: y / length };
}

function perpendicularOf(direction) {
  return { x: -direction.y, y: direction.x };
}

/** How one endpoint may move: a unit direction (there is no distance cap —
    the descent travels only as far as the score keeps improving). */
function movement(direction) {
  if (!direction) return null;
  return { direction };
}

/* ---------- Scoring one candidate placement ---------- */

function sampleCountForLength(lengthPixels) {
  return Math.max(MINIMUM_SAMPLE_COUNT,
    Math.min(MAXIMUM_SAMPLE_COUNT, Math.round(lengthPixels)));
}

/**
 * The image across a candidate line: mean luminance at each perpendicular
 * distance in `offsets`, averaged over `sampleCount` places along the line.
 * Averaging along the line first is what makes a faint edge that runs the
 * length of the line beat a strong one that merely crosses it.
 */
function perpendicularProfile(ax, ay, bx, by, normal, sampleCount, sampleLuminance, offsets) {
  const profile = new Float64Array(offsets.length);
  for (let index = 0; index < sampleCount; index++) {
    const alongFraction = (index + 0.5) / sampleCount;
    const x = ax + (bx - ax) * alongFraction;
    const y = ay + (by - ay) * alongFraction;
    for (let offsetIndex = 0; offsetIndex < offsets.length; offsetIndex++) {
      const distance = offsets[offsetIndex];
      profile[offsetIndex] += sampleLuminance(x + normal.x * distance, y + normal.y * distance);
    }
  }
  for (let offsetIndex = 0; offsetIndex < profile.length; offsetIndex++) {
    profile[offsetIndex] /= sampleCount;
  }
  return profile;
}

/**
 * Edge mode: the profile's slope right at the line, measured with a Gaussian
 * derivative. Weights are normalized so that an ideal step of height H scores
 * H — the score is readable as "how many luminance levels the image steps
 * across this line".
 */
function edgeKernelWeights(offsets) {
  const weights = new Float64Array(offsets.length);
  let positiveTotal = 0;
  for (let index = 0; index < offsets.length; index++) {
    const distance = offsets[index];
    weights[index] = distance
      * Math.exp(-(distance * distance) / (2 * EDGE_KERNEL_WIDTH_PIXELS * EDGE_KERNEL_WIDTH_PIXELS));
    if (weights[index] > 0) positiveTotal += weights[index];
  }
  if (positiveTotal > 0) {
    for (let index = 0; index < weights.length; index++) weights[index] /= positiveTotal;
  }
  return weights;
}

function scoreEdgeProfile(profile, weights) {
  let response = 0;
  for (let index = 0; index < profile.length; index++) response += weights[index] * profile[index];
  return { score: Math.abs(response), stripeHalfWidthPixels: null };
}

/**
 * Stripe mode: a band of the profile centered on the line against the
 * background in the flanks just outside it. A band that matches the stripe and
 * is centered on it is the only placement where the whole band is stripe and
 * both flanks are background, so this peaks once, at the middle of the stripe
 * — where the earlier "line versus two probes" score was flat right across it.
 *
 * The stripe's width is unknown up front, so every half-width in range is
 * scored and the best kept; that winner is also a genuine measurement of the
 * width, which is what the settings panel reports.
 */
function scoreStripeProfile(profile, plan) {
  // Prefix sums make every band mean below a subtraction rather than a loop.
  const runningTotal = new Float64Array(profile.length + 1);
  for (let index = 0; index < profile.length; index++) {
    runningTotal[index + 1] = runningTotal[index] + profile[index];
  }
  const meanBetween = (lowIndex, highIndex) => (highIndex <= lowIndex)
    ? 0
    : (runningTotal[highIndex] - runningTotal[lowIndex]) / (highIndex - lowIndex);

  const centerIndex = plan.centerIndex;
  const stepsPerPixel = 1 / PROFILE_STEP_PIXELS;
  const flankSteps = Math.round(STRIPE_FLANK_PIXELS * stepsPerPixel);
  let bestScore = -Infinity;
  let bestHalfWidth = null;
  for (const halfWidth of plan.halfWidths) {
    const halfSteps = Math.max(1, Math.round(halfWidth * stepsPerPixel));
    const insideLow = centerIndex - halfSteps;
    const insideHigh = centerIndex + halfSteps + 1;
    const beforeLow = insideLow - flankSteps;
    const afterHigh = insideHigh + flankSteps;
    if (beforeLow < 0 || afterHigh > profile.length) continue;
    const inside = meanBetween(insideLow, insideHigh);
    const flankBefore = meanBetween(beforeLow, insideLow);
    const flankAfter = meanBetween(insideHigh, afterHigh);
    const score = Math.abs(inside - (flankBefore + flankAfter) / 2)
      - STRIPE_FLANK_ASYMMETRY_WEIGHT * Math.abs(flankBefore - flankAfter);
    if (score > bestScore) {
      bestScore = score;
      bestHalfWidth = halfWidth;
    }
  }
  // A best score below zero means no placement here looks like a stripe at
  // all; clamping to zero makes such ground read as flat, so the descent
  // stays put on it instead of drifting away in search of blander pixels.
  return { score: Math.max(0, bestScore === -Infinity ? 0 : bestScore),
    stripeHalfWidthPixels: bestHalfWidth };
}

/** Everything about scoring that depends only on the options, worked out once
    per fit rather than once per candidate placement. */
function createScoringPlan(options) {
  if (options.mode === 'stripe') {
    const smallest = Math.max(STRIPE_HALF_WIDTH_STEP_PIXELS, options.minimumStripeWidthPixels / 2);
    const largest = Math.max(smallest, options.maximumStripeWidthPixels / 2);
    const halfWidths = offsetsBetween(smallest, largest, STRIPE_HALF_WIDTH_STEP_PIXELS);
    const reach = largest + STRIPE_FLANK_PIXELS;
    const offsets = offsetsBetween(-reach, reach, PROFILE_STEP_PIXELS);
    const centerIndex = offsets.reduce(
      (closest, offset, index) =>
        (Math.abs(offset) < Math.abs(offsets[closest]) ? index : closest), 0);
    return { mode: 'stripe', offsets, halfWidths, centerIndex };
  }
  const offsets = offsetsBetween(
    -EDGE_PROFILE_REACH_PIXELS, EDGE_PROFILE_REACH_PIXELS, PROFILE_STEP_PIXELS);
  return { mode: 'edge', offsets, weights: edgeKernelWeights(offsets) };
}

/** The image evidence for placing a segment at exactly these two endpoints. */
function scorePlacement(ax, ay, bx, by, sampleCount, sampleLuminance, plan) {
  const tangent = unitVector(bx - ax, by - ay);
  if (!tangent) return { score: -Infinity, stripeHalfWidthPixels: null };
  const normal = perpendicularOf(tangent);
  const profile = perpendicularProfile(
    ax, ay, bx, by, normal, sampleCount, sampleLuminance, plan.offsets);
  return plan.mode === 'stripe'
    ? scoreStripeProfile(profile, plan)
    : scoreEdgeProfile(profile, plan.weights);
}

/* ---------- The offset search ---------- */

function offsetsBetween(lowest, highest, step) {
  const offsets = [];
  for (let offset = lowest; offset <= highest + 1e-9; offset += step) {
    offsets.push(Number(offset.toFixed(4)));
  }
  return offsets;
}

/**
 * The search, for both modes: hill-climbing with shrinking steps. From the
 * drawn placement, look at the neighboring placements one step away — each
 * endpoint nudged along its allowed direction, alone and together — and move
 * only while one of them STRICTLY beats the current score; when none does,
 * halve the step. Halving from 0.5 px down to 0.01 px gives sub-pixel
 * placement without ever being able to cross a dip in the score, so the fit
 * stays in the basin the user dropped it in. (Steps this shape are also why
 * this beats following a gradient: bilinear sampling makes the score kinked
 * at pixel borders, where a measured gradient misleads but a straight
 * comparison of placements never does.)
 * @returns {{offsetA: number, offsetB: number, score: number,
 *            stripeHalfWidthPixels: number|null}}
 */
function descendToPlacement(pointA, pointB, movementA, movementB, sampleLuminance, options) {
  const sampleCount = sampleCountForLength(
    Math.hypot(pointB[0] - pointA[0], pointB[1] - pointA[1]));
  const plan = createScoringPlan(options);

  let evaluationCount = 0;
  const evaluate = (offsetA, offsetB) => {
    evaluationCount += 1;
    const ax = pointA[0] + (movementA ? movementA.direction.x * offsetA : 0);
    const ay = pointA[1] + (movementA ? movementA.direction.y * offsetA : 0);
    const bx = pointB[0] + (movementB ? movementB.direction.x * offsetB : 0);
    const by = pointB[1] + (movementB ? movementB.direction.y * offsetB : 0);
    const placement = scorePlacement(ax, ay, bx, by, sampleCount, sampleLuminance, plan);
    // The movement preference makes "stay" strictly better on a flat score, so
    // a featureless image (or a dead-flat plateau) moves nothing at all.
    const preference = placement.score
      - SMALLEST_MOVEMENT_PREFERENCE * (Math.abs(offsetA) + Math.abs(offsetB));
    return { offsetA, offsetB, preference, ...placement };
  };

  // The two diagonal directions are the ones where both endpoints move in
  // step — a plain sideways translation of the line — so leaving them out
  // would make the most common correction crawl in axis-by-axis zigzags.
  const stepDirections = [
    [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1],
  ].filter(([directionA, directionB]) =>
    (movementA || directionA === 0) && (movementB || directionB === 0)
    && (directionA !== 0 || directionB !== 0));

  let current = evaluate(0, 0);
  let stepPixels = DESCENT_INITIAL_STEP_PIXELS;
  while (stepPixels >= DESCENT_MINIMUM_STEP_PIXELS
      && evaluationCount < DESCENT_EVALUATION_LIMIT) {
    let bestNeighbor = null;
    for (const [directionA, directionB] of stepDirections) {
      const neighbor = evaluate(
        current.offsetA + directionA * stepPixels,
        current.offsetB + directionB * stepPixels);
      if (neighbor.preference > current.preference
          && (bestNeighbor === null || neighbor.preference > bestNeighbor.preference)) {
        bestNeighbor = neighbor;
      }
    }
    if (bestNeighbor) current = bestNeighbor;
    else stepPixels /= 2;
  }
  return current;
}

/* ---------- Fitting segments of a polyline ---------- */

/** A vertex the fit has not touched yet moves perpendicular to its segment. */
function freeMovement(pointA, pointB) {
  const tangent = unitVector(pointB[0] - pointA[0], pointB[1] - pointA[1]);
  if (!tangent) return null;
  return movement(perpendicularOf(tangent));
}

/** A vertex that already sits on a fitted segment may only slide along it. */
function slideMovement(vertices, fromIndex, toIndex) {
  const from = vertices[fromIndex];
  const to = vertices[toIndex];
  if (!from || !to) return null;
  return movement(unitVector(to[0] - from[0], to[1] - from[1]));
}

/** A coordinate a fit landed almost exactly on a pixel border or center is
    read as landing exactly there — edges and stripe centers live on the
    half-integer grid, and the near-miss is only the search's stopping
    tolerance. Never applied to an endpoint the fit did not move. */
function cleanFittedCoordinate(value) {
  const nearestHalfInteger = Math.round(value * 2) / 2;
  return Math.abs(value - nearestHalfInteger) <= FITTED_COORDINATE_SNAP_TOLERANCE_PIXELS
    ? nearestHalfInteger
    : value;
}

/**
 * Fit one segment in place.
 * @param {Array<[number, number]>} vertices  Video-pixel coordinates, mutated.
 * @returns {{movedA: number, movedB: number, score: number,
 *            stripeHalfWidthPixels: number|null} | null}
 */
function fitSegment(vertices, indexA, indexB, movementA, movementB, sampleLuminance, options) {
  const pointA = vertices[indexA];
  const pointB = vertices[indexB];
  if (!pointA || !pointB) return null;
  if (!movementA && !movementB) return null;
  const best = descendToPlacement(pointA, pointB, movementA, movementB, sampleLuminance, options);
  if (!best || !Number.isFinite(best.score)) return null;
  if (movementA && best.offsetA !== 0) {
    pointA[0] = cleanFittedCoordinate(pointA[0] + movementA.direction.x * best.offsetA);
    pointA[1] = cleanFittedCoordinate(pointA[1] + movementA.direction.y * best.offsetA);
  }
  if (movementB && best.offsetB !== 0) {
    pointB[0] = cleanFittedCoordinate(pointB[0] + movementB.direction.x * best.offsetB);
    pointB[1] = cleanFittedCoordinate(pointB[1] + movementB.direction.y * best.offsetB);
  }
  return {
    movedA: movementA ? best.offsetA : 0,
    movedB: movementB ? best.offsetB : 0,
    score: best.score,
    stripeHalfWidthPixels: best.stripeHalfWidthPixels,
  };
}

/**
 * Fit the segment the user just completed by dropping a vertex: the last two
 * vertices of an in-progress shape. The new vertex is free (perpendicular);
 * the one before it slides along the segment fitted just before, if any.
 */
export function fitNewestSegment(vertices, sampleLuminance, options) {
  const count = vertices.length;
  if (count < 2) return null;
  const indexA = count - 2;
  const indexB = count - 1;
  const movementA = count === 2
    ? freeMovement(vertices[indexA], vertices[indexB])
    : slideMovement(vertices, indexA - 1, indexA);
  const movementB = freeMovement(vertices[indexA], vertices[indexB]);
  return fitSegment(vertices, indexA, indexB, movementA, movementB, sampleLuminance, options);
}

/**
 * Whether a polyline's stored vertices already encode a closed loop: its last
 * vertex is a literal duplicate of its first. The sole source of truth for
 * "is this shape closed" — see coordinates-layer.js's `isClosedPolyline` for
 * the item-level equivalent.
 */
export function verticesFormClosedLoop(vertices) {
  return vertices.length >= 2
    && vertices[0][0] === vertices[vertices.length - 1][0]
    && vertices[0][1] === vertices[vertices.length - 1][1];
}

/**
 * Fit the segment that closes a polyline: the last real corner back to the
 * duplicate vertex that marks the shape closed. Both of its endpoints already
 * belong to fitted segments, so both may only slide along those — the duplicate
 * slides along the first segment, standing in for the real first vertex, which
 * is then written to match: the duplicate and the first vertex must always
 * stay identical, or the shape would silently spring open.
 */
export function fitClosingSegment(vertices, sampleLuminance, options) {
  const count = vertices.length;
  if (count < 4) return null;
  const movementA = slideMovement(vertices, count - 3, count - 2);
  const movementB = slideMovement(vertices, 1, 0);
  const summary = fitSegment(vertices, count - 2, count - 1, movementA, movementB, sampleLuminance, options);
  if (summary) {
    vertices[0][0] = vertices[count - 1][0];
    vertices[0][1] = vertices[count - 1][1];
  }
  return summary;
}

/**
 * Re-fit an entire shape from scratch, segment by segment in drawing order —
 * exactly the sequence the shape went through as it was drawn, so a re-fit and
 * a fresh drawing of the same points land in the same place.
 * @returns {Array<object>} one summary per fitted segment (nulls dropped).
 */
export function fitWholeShape(vertices, kind, sampleLuminance, options) {
  const summaries = [];
  const closed = kind === 'polyline' && verticesFormClosedLoop(vertices);
  // A closed shape's last segment (the closing one) needs the special
  // slide-both-ends handling below, not the generic per-vertex fit.
  const lastOrdinaryIndex = closed ? vertices.length - 2 : vertices.length - 1;
  for (let index = 1; index <= lastOrdinaryIndex; index++) {
    const movementA = index === 1
      ? freeMovement(vertices[index - 1], vertices[index])
      : slideMovement(vertices, index - 2, index - 1);
    const movementB = freeMovement(vertices[index - 1], vertices[index]);
    const summary = fitSegment(vertices, index - 1, index, movementA, movementB, sampleLuminance, options);
    if (summary) summaries.push(summary);
  }
  if (closed) {
    const summary = fitClosingSegment(vertices, sampleLuminance, options);
    if (summary) summaries.push(summary);
  }
  return summaries;
}

/** How far out from the candidate line the score reads pixels. */
export function profileReachPixels(options) {
  return options.mode === 'stripe'
    ? Math.max(options.minimumStripeWidthPixels, options.maximumStripeWidthPixels) / 2
      + STRIPE_FLANK_PIXELS
    : EDGE_PROFILE_REACH_PIXELS;
}

// Extra patch margin beyond the profile's reach, so a typical few-pixel walk
// completes against one read. The walk itself is unbounded: a fit that
// travels far enough to press its profile against the patch border is re-run
// against a freshly read patch (see LineFitterLayer), as many times as it
// keeps moving.
const PATCH_TRAVEL_HEADROOM_PIXELS = 4;

/**
 * How far outside the drawn shape one pixel read extends: the profile's
 * reach, travel headroom, and a couple of pixels of slack for bilinear
 * sampling and the descent's probing steps.
 */
export function readMarginPixels(options) {
  return Math.ceil(profileReachPixels(options) + PATCH_TRAVEL_HEADROOM_PIXELS + 2);
}
