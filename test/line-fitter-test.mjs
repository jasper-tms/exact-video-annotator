// The line-fitter plugin, in two halves:
//
//  1. The fitting math against synthetic images (a soft edge, a bright stripe,
//     a flat field), driven directly through the module's exports. It runs in
//     the browser rather than in Node because the app ships as plain ES
//     modules with no package.json, which Node would read as CommonJS.
//  2. The plugin end to end in the real app: the ＋ menu's Plugins page adds a
//     line-fitter layer, drawing two points on the fixture video commits one
//     fitted line, and the layer's settings and JSON round-trip carry it.
//
// Run:  node test/line-fitter-test.mjs

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const playwrightPath =
  '/Users/jasper/repos/jasper-tms/exact-video-engine.js/node_modules/playwright/index.mjs';
const { chromium } = await import(playwrightPath);

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = 8873;

const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'],
  { cwd: repositoryRoot, stdio: 'ignore' });
await new Promise((resolve) => setTimeout(resolve, 800));

const failures = [];
function check(condition, description) {
  if (condition) console.log(`  ok: ${description}`);
  else { console.error(`FAIL: ${description}`); failures.push(description); }
}

const browser = await chromium.launch();
const page = await browser.newPage();

const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') pageErrors.push(message.text());
});

try {
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.waitForFunction(() => window.exactVideoAnnotator !== undefined);

  /* ================= 1. The fitting math ================= */

  const mathResults = await page.evaluate(async () => {
    const fitModule = await import('/js/plugins/line-fitter/fit-line.js');
    const { DEFAULT_LINE_FITTER_OPTIONS, fitNewestSegment, fitWholeShape } = fitModule;

    // Real edges are a pixel or two wide, not step functions, so these
    // synthetic images use soft transitions — which is also what makes the
    // best placement unique rather than a plateau.
    const softStep = (value, softness) => 1 / (1 + Math.exp(-value / softness));
    const edgeImage = (x, y) => 200 * softStep(y - 20.4, 0.8);
    const stripeImage = (x, y) =>
      200 * (softStep(y - 27.5, 0.6) - softStep(y - 32.5, 0.6));
    const flatImage = () => 100;

    const lengthOf = (vertices) =>
      Math.hypot(vertices[1][0] - vertices[0][0], vertices[1][1] - vertices[0][1]);
    const options = (overrides) => ({ ...DEFAULT_LINE_FITTER_OPTIONS, ...overrides });

    /* -- A tilted line a few pixels off a horizontal edge locks onto it -- */
    const edgeVertices = [[10, 17], [100, 23]];
    const lengthBefore = lengthOf(edgeVertices);
    const edgeSummary = fitNewestSegment(edgeVertices, edgeImage, options({ mode: 'edge' }));

    /* -- The same, in stripe mode, onto the middle of a 5-pixel stripe -- */
    const stripeVertices = [[10, 28.2], [100, 31.6]];
    const stripeSummary = fitNewestSegment(stripeVertices, stripeImage, options({ mode: 'stripe' }));

    /* -- A flat image has nothing to lock onto, so nothing should move -- */
    const flatVertices = [[10, 17], [100, 23]];
    const flatSummary = fitNewestSegment(flatVertices, flatImage, options({ mode: 'edge' }));

    /* -- A third point may only slide the shared vertex ALONG the segment
          already fitted, never off it -- */
    const cornerVertices = [[10, 17], [100, 23]];
    fitNewestSegment(cornerVertices, edgeImage, options({ mode: 'edge' }));
    const fittedFirst = cornerVertices[0].slice();
    const fittedSecond = cornerVertices[1].slice();
    cornerVertices.push([120, 60]);
    fitNewestSegment(cornerVertices, edgeImage, options({ mode: 'edge' }));
    const alongX = fittedSecond[0] - fittedFirst[0];
    const alongY = fittedSecond[1] - fittedFirst[1];
    const movedX = cornerVertices[1][0] - fittedFirst[0];
    const movedY = cornerVertices[1][1] - fittedFirst[1];
    const distanceOffFittedLine = Math.abs(movedX * alongY - movedY * alongX)
      / Math.hypot(alongX, alongY);

    /* -- The two cases a real clip is full of, and that a two-tap score got
          wrong: a HARD step (whose score is flat across a band unless the
          measurement is smooth) and a ONE-PIXEL stripe. Fitted from every
          starting offset in range, from both sides: a fit that reads the image
          rather than its own starting point must land in the same place every
          time. Bilinear sampling of real pixels ramps over one pixel, so these
          images do too — the step's true edge is at y = 19.5. Edge mode is a
          local descent now, so its starts stay within the profile's reach;
          stripe mode still searches the whole radius. -- */
    const hardStepImage = (x, y) => 255 * Math.min(1, Math.max(0, y - 19));
    const onePixelStripeImage = (x, y) => 255 * Math.max(0, 1 - Math.abs(y - 30.3));
    const convergence = (image, mode, trueY, startOffsets) => {
      const landings = [];
      for (const startOffset of startOffsets) {
        for (const tilt of [0, 1]) {
          const vertices = [[10, trueY + startOffset - tilt / 2], [70, trueY + startOffset + tilt / 2]];
          fitNewestSegment(vertices, image, options({ mode }));
          landings.push(vertices[0][1] - trueY, vertices[1][1] - trueY);
        }
      }
      return {
        worstError: Math.max(...landings.map(Math.abs)),
        spread: Math.max(...landings) - Math.min(...landings),
      };
    };
    const hardStepConvergence = convergence(
      hardStepImage, 'edge', 19.5, [-1.5, -1, -0.5, 0.5, 1, 1.5]);
    const onePixelStripeConvergence = convergence(
      onePixelStripeImage, 'stripe', 30.3, [-4, -3, -2, -1, -0.5, 0.5, 1, 2, 3, 4]);

    /* -- What the descent buys: LOCALITY. A faint edge right under the line
          must win over a bold edge a few pixels away — the grid search took
          the bold one every time. And a line placed beyond the profile's
          reach of the only edge around must not move at all: better to
          visibly not snap than to leap. -- */
    const weakNearStrongImage = (x, y) =>
      60 * softStep(y - 20, 0.5) + 200 * softStep(y - 24.5, 0.5);
    const localityVertices = [[10, 19.6], [70, 19.6]];
    fitNewestSegment(localityVertices, weakNearStrongImage, options({ mode: 'edge' }));

    const farVertices = [[10, 16], [70, 16]];   // 3.5 px above the hard step
    const farSummary = fitNewestSegment(farVertices, hardStepImage, options({ mode: 'edge' }));

    /* -- And the other side of that coin: travel is UNBOUNDED as long as the
          score keeps improving. A wide, soft edge rewards every step of a
          long walk, so a line seven pixels off it still crawls all the way
          onto it — there is no search radius to stop at. -- */
    const wideSoftEdgeImage = (x, y) => 200 * softStep(y - 40, 2);
    const crawlVertices = [[10, 33], [70, 33]];
    fitNewestSegment(crawlVertices, wideSoftEdgeImage, options({ mode: 'edge' }));

    /* -- The landing cleanup: a straight line fitted onto the hard step must
          come out at EXACTLY y = 19.5, not 19.49-something — coordinates
          within 0.01 px of a half-integer are rounded to it. -- */
    const exactVertices = [[10, 18.7], [70, 18.7]];
    fitNewestSegment(exactVertices, hardStepImage, options({ mode: 'edge' }));

    /* -- The sampler's coordinate convention. Annotation coordinates put
          integers at pixel CORNERS (the video layer draws pixel k across
          [k, k + 1)), so a fit against real pixels must land on integer
          borders and half-integer stripe centers — not half a pixel off,
          which is what an index-as-position sampler silently produces. -- */
    const { createLuminanceSampler } = await import('/js/plugins/frame-pixels.js');
    const patchWidth = 24, patchHeight = 48;
    const patchLuminance = new Float32Array(patchWidth * patchHeight);
    for (let row = 0; row < patchHeight; row++) {
      for (let column = 0; column < patchWidth; column++) {
        // A bright stripe filling pixel columns 12..14: borders at x = 12
        // and x = 15, center at x = 13.5.
        patchLuminance[row * patchWidth + column] = (column >= 12 && column <= 14) ? 255 : 0;
      }
    }
    const patchSample = createLuminanceSampler(
      { left: 0, top: 0, width: patchWidth, height: patchHeight, luminance: patchLuminance });
    const patchEdgeVertices = [[11, 4], [11, 44]];
    fitNewestSegment(patchEdgeVertices, patchSample, options({ mode: 'edge' }));
    const patchStripeVertices = [[12.4, 4], [14.8, 44]];
    fitNewestSegment(patchStripeVertices, patchSample, options({ mode: 'stripe' }));

    /* -- Re-fitting an already fitted shape leaves it where it is -- */
    const stableVertices = [[10, 17], [100, 23]];
    fitWholeShape(stableVertices, 'line', edgeImage, options({ mode: 'edge' }));
    const afterFirstFit = stableVertices.map((vertex) => vertex.slice());
    fitWholeShape(stableVertices, 'line', edgeImage, options({ mode: 'edge' }));
    const secondFitDrift = Math.max(
      ...stableVertices.map((vertex, index) =>
        Math.hypot(vertex[0] - afterFirstFit[index][0], vertex[1] - afterFirstFit[index][1])));

    return {
      edge: {
        vertices: edgeVertices,
        summary: edgeSummary,
        lengthChange: Math.abs(lengthOf(edgeVertices) - lengthBefore),
      },
      stripe: { vertices: stripeVertices, summary: stripeSummary },
      flat: { vertices: flatVertices, summary: flatSummary },
      hardStepConvergence,
      onePixelStripeConvergence,
      locality: {
        landedYs: [localityVertices[0][1], localityVertices[1][1]],
        farMovedA: farSummary.movedA,
        farMovedB: farSummary.movedB,
        crawlYs: [crawlVertices[0][1], crawlVertices[1][1]],
        exactYs: [exactVertices[0][1], exactVertices[1][1]],
      },
      patchConvention: {
        edgeXs: [patchEdgeVertices[0][0], patchEdgeVertices[1][0]],
        stripeXs: [patchStripeVertices[0][0], patchStripeVertices[1][0]],
      },
      corner: { distanceOffFittedLine, firstVertexMoved: Math.hypot(
        cornerVertices[0][0] - fittedFirst[0], cornerVertices[0][1] - fittedFirst[1]) },
      stability: { secondFitDrift },
    };
  });

  console.log('edge fit:', JSON.stringify(mathResults.edge));
  check(Math.abs(mathResults.edge.vertices[0][1] - 20.4) < 0.35
     && Math.abs(mathResults.edge.vertices[1][1] - 20.4) < 0.35,
        'edge mode pulls both endpoints onto the edge at y = 20.4');
  check(mathResults.edge.lengthChange < 0.25,
        'fitting barely changes the drawn length (points move perpendicular only)');

  console.log('stripe fit:', JSON.stringify(mathResults.stripe));
  check(Math.abs(mathResults.stripe.vertices[0][1] - 30) < 0.4
     && Math.abs(mathResults.stripe.vertices[1][1] - 30) < 0.4,
        'stripe mode centers the line in a 5-pixel stripe at y = 30');
  check(mathResults.stripe.summary.stripeHalfWidthPixels >= 2.5
     && mathResults.stripe.summary.stripeHalfWidthPixels <= 5,
        'stripe mode recovers roughly the right stripe half-width (2.5 px)');

  check(mathResults.flat.summary.movedA === 0 && mathResults.flat.summary.movedB === 0,
        'a flat image moves nothing');

  console.log('hard step:', JSON.stringify(mathResults.hardStepConvergence),
              'one-pixel stripe:', JSON.stringify(mathResults.onePixelStripeConvergence));
  check(mathResults.hardStepConvergence.worstError < 0.25
     && mathResults.hardStepConvergence.spread < 0.25,
        'a hard step edge is found from every start, always in the same place');
  check(mathResults.onePixelStripeConvergence.worstError < 0.3
     && mathResults.onePixelStripeConvergence.spread < 0.3,
        'a one-pixel-wide stripe is centered on from every start');

  console.log('locality:', JSON.stringify(mathResults.locality));
  check(mathResults.locality.landedYs.every((y) => Math.abs(y - 20) < 0.35),
        'a faint edge under the line beats a bold edge a few pixels away');
  check(mathResults.locality.farMovedA === 0 && mathResults.locality.farMovedB === 0,
        'a line beyond the score\'s reach of the only edge around stays put');
  check(mathResults.locality.crawlYs.every((y) => Math.abs(y - 40) < 0.5),
        'a wide soft edge pulls a line in from seven pixels away — travel is unbounded');
  check(mathResults.locality.exactYs.every((y) => y === 19.5),
        'a fit onto a pixel border lands on EXACTLY the half-integer');

  console.log('pixel-corner convention:', JSON.stringify(mathResults.patchConvention));
  check(mathResults.patchConvention.edgeXs.every((x) => Math.abs(x - 12) < 0.11),
        'against real pixels, an edge fit lands on the border between two pixel columns');
  check(mathResults.patchConvention.stripeXs.every((x) => Math.abs(x - 13.5) < 0.11),
        'against real pixels, a stripe fit lands on the center of the stripe as drawn');

  console.log('corner rule:', JSON.stringify(mathResults.corner));
  check(mathResults.corner.distanceOffFittedLine < 1e-6,
        'a later segment only slides the shared vertex along the segment fitted before it');
  check(mathResults.corner.firstVertexMoved === 0,
        'a later segment never moves the vertices before the shared one');

  check(mathResults.stability.secondFitDrift < 0.05,
        're-fitting an already fitted line leaves it in place');

  /* ================= 2. The plugin in the app ================= */

  await page.setInputFiles('#video-file-input',
    path.join(repositoryRoot, 'test', 'frame_numbered_vfr.mp4'));
  await page.waitForFunction(
    () => window.exactVideoAnnotator.engine?.numFrames > 0, undefined, { timeout: 20000 });

  // Add the layer the way a user would: ＋ → ‹ Plugins → line-fitter.
  await page.click('.layer-tab-add');
  await page.click('.layer-tab-add-menu button:text("Plugins ›")');
  const uploadDisabled = await page.isDisabled('.layer-tab-add-menu button:text("Upload…")');
  check(uploadDisabled, 'the Upload… entry is listed but not yet functional');
  await page.click('.layer-tab-add-menu button:text-is("Line fitter")');

  const layerFacts = await page.evaluate(() => {
    const application = window.exactVideoAnnotator;
    const layer = application.activeLayer;
    return {
      pluginId: layer?.plugin?.id ?? null,
      type: layer?.type ?? null,
      activeToolId: application.activeTool?.id ?? null,
      documentPlugin: application.annotationDocument.layers
        .find((documentLayer) => documentLayer.id === layer?.id)?.plugin ?? null,
    };
  });
  console.log('plugin layer:', JSON.stringify(layerFacts));
  check(layerFacts.pluginId === 'line-fitter', 'the Plugins menu added a line-fitter layer');
  check(layerFacts.type === 'coordinates', 'it stores its annotations as an ordinary coordinates layer');
  check(layerFacts.activeToolId === 'line', 'adding it selects the line tool');
  check(layerFacts.documentPlugin?.id === 'line-fitter',
        'the document layer records which plugin it belongs to');

  check(await page.locator('.plugin-settings h3').innerText() === 'Line fitter',
        "the layer panel shows the plugin's settings");

  // Two clicks finish and fit a line — no Enter, no double-click.
  const stageBox = await page.locator('#stage-canvas').boundingBox();
  const firstClick = { x: stageBox.x + stageBox.width * 0.35, y: stageBox.y + stageBox.height * 0.45 };
  const secondClick = { x: stageBox.x + stageBox.width * 0.65, y: stageBox.y + stageBox.height * 0.5 };
  await page.mouse.click(firstClick.x, firstClick.y);
  await page.mouse.click(secondClick.x, secondClick.y);

  const lineFacts = await page.evaluate((clicks) => {
    const application = window.exactVideoAnnotator;
    const layer = application.activeLayer;
    const item = layer.items[0] ?? null;
    const clickedVertices = clicks.map((click) => {
      const stage = application.viewer.stageCanvas.getBoundingClientRect();
      const world = application.viewer.worldFromStagePoint(
        { x: click.x - stage.left, y: click.y - stage.top });
      const local = application.localFromWorld(layer, world);
      return [local.x, local.y];
    });
    const distances = item
      ? item.vertices.map((vertex, index) =>
          Math.hypot(vertex[0] - clickedVertices[index][0], vertex[1] - clickedVertices[index][1]))
      : [];
    const lengthOf = (vertices) =>
      Math.hypot(vertices[1][0] - vertices[0][0], vertices[1][1] - vertices[0][1]);
    return {
      itemCount: layer.items.length,
      vertexCount: item?.vertices.length ?? 0,
      kind: item?.kind ?? null,
      inProgressAfterTwoClicks: application.activeTool?.id === 'line',
      distances,
      lengthChange: item ? Math.abs(lengthOf(item.vertices) - lengthOf(clickedVertices)) : null,
      lastFitDescription: layer.lastFitDescription,
    };
  }, [firstClick, secondClick]);

  console.log('drawn line:', JSON.stringify(lineFacts));
  check(lineFacts.itemCount === 1 && lineFacts.vertexCount === 2 && lineFacts.kind === 'line',
        'two clicks committed one two-point line, with no key press to finish it');
  check(typeof lineFacts.lastFitDescription === 'string'
     && !lineFacts.lastFitDescription.startsWith('could not fit'),
        `the fit ran against the frame's pixels (${lineFacts.lastFitDescription})`);
  check(lineFacts.lengthChange < 0.5, 'the committed line kept the length that was drawn');

  // Undo puts the whole thing back in one step, fit included.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  const afterUndo = await page.evaluate(() => window.exactVideoAnnotator.activeLayer.items.length);
  check(afterUndo === 0, 'one undo removes the fitted line');
  await page.keyboard.press(process.platform === 'darwin' ? 'Shift+Meta+z' : 'Control+Shift+z');

  // The plugin survives an export/import round trip.
  const roundTripFacts = await page.evaluate(async () => {
    const application = window.exactVideoAnnotator;
    const documentModule = await import('/js/document.js');
    const json = documentModule.documentToJson(
      application.annotationDocument, application.videoInformation);
    const reparsed = documentModule.documentFromJson(JSON.parse(JSON.stringify(json)));
    const layer = reparsed.layers.find((candidate) => candidate.plugin?.id === 'line-fitter');
    return {
      pluginId: layer?.plugin?.id ?? null,
      mode: layer?.plugin?.options?.mode ?? null,
      itemCount: layer?.items.length ?? 0,
    };
  });
  console.log('round trip:', JSON.stringify(roundTripFacts));
  check(roundTripFacts.pluginId === 'line-fitter' && roundTripFacts.itemCount === 1,
        'export/import keeps the plugin layer and its annotation');
  check(roundTripFacts.mode === 'edge', "export/import keeps the plugin's options");

  /* ---- A polygon on the same layer is fitted segment by segment ---- */

  await page.keyboard.press('g');
  await page.mouse.click(stageBox.x + stageBox.width * 0.3, stageBox.y + stageBox.height * 0.3);
  await page.mouse.click(stageBox.x + stageBox.width * 0.6, stageBox.y + stageBox.height * 0.3);
  await page.mouse.click(stageBox.x + stageBox.width * 0.45, stageBox.y + stageBox.height * 0.6);
  await page.keyboard.press('Enter');
  const polygonFacts = await page.evaluate(() => {
    const layer = window.exactVideoAnnotator.activeLayer;
    const polygon = layer.items.find((item) => item.kind === 'polygon') ?? null;
    return {
      itemCount: layer.items.length,
      vertexCount: polygon?.vertices.length ?? 0,
      lastFitDescription: layer.lastFitDescription,
    };
  });
  console.log('drawn polygon:', JSON.stringify(polygonFacts));
  check(polygonFacts.itemCount === 2 && polygonFacts.vertexCount === 3,
        'a polygon on a fitter layer still needs Enter, and keeps its three vertices');
  check(!String(polygonFacts.lastFitDescription).startsWith('could not fit'),
        `the closing segment was fitted too (${polygonFacts.lastFitDescription})`);

  /* ---- Re-fitting: the r key, and the after-a-drag preference ---- */

  const refitFacts = await page.evaluate(() => {
    const application = window.exactVideoAnnotator;
    const layer = application.activeLayer;
    const line = layer.items.find((item) => item.kind === 'line');
    application.setSelection({ layerId: layer.id, itemId: line.id, vertexIndex: null });
    // Shove it off its fit, then let the two re-fit paths pull it back.
    layer.moveItemBy(line.id, { x: 0, y: 3 });
    const displaced = line.vertices.map((vertex) => vertex.slice());

    layer.setOption('refitAfterDragging', false);
    const refitWhenTurnedOff = layer.afterItemDragged(application, line.id);
    const unchangedAfterDrag = line.vertices.every(
      (vertex, index) => vertex[0] === displaced[index][0] && vertex[1] === displaced[index][1]);

    layer.setOption('refitAfterDragging', true);
    layer.afterItemDragged(application, line.id);
    const movedByDragRefit = line.vertices.some(
      (vertex, index) => vertex[0] !== displaced[index][0] || vertex[1] !== displaced[index][1]);
    return { refitWhenTurnedOff, unchangedAfterDrag, movedByDragRefit };
  });
  console.log('re-fit paths:', JSON.stringify(refitFacts));
  check(refitFacts.refitWhenTurnedOff === false && refitFacts.unchangedAfterDrag,
        'with "re-fit after dragging" off, a drag is the last word');
  check(refitFacts.movedByDragRefit, 'with it on, a drag is followed by a fit');

  await page.evaluate(() => {
    const application = window.exactVideoAnnotator;
    const layer = application.activeLayer;
    const line = layer.items.find((item) => item.kind === 'line');
    layer.moveItemBy(line.id, { x: 0, y: 3 });
    application.viewer.requestRender();
  });
  // Keys are ignored while a panel input holds focus, and the settings panel
  // above was just clicked through, so hand focus back to the page first.
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('r');
  const keyRefitFacts = await page.evaluate(() => ({
    undoLabel: window.exactVideoAnnotator.undoHistory.nextUndoLabel,
    selectionKept: window.exactVideoAnnotator.selection !== null,
  }));
  console.log('r key:', JSON.stringify(keyRefitFacts));
  check(keyRefitFacts.undoLabel === 'Re-fit' && keyRefitFacts.selectionKept,
        'r re-fits the selected annotation as one undoable step');

  /* ---- Clicking the mode radio must immediately reveal the stripe fields
          (the panel's rebuild guard protects typing, not radio clicks) ---- */

  await page.click('.plugin-settings input[type="radio"][value="stripe"]');
  const stripeFieldCount = await page
    .locator('.plugin-settings label', { hasText: 'narrowest stripe' }).count();
  check(stripeFieldCount === 1,
        'switching to stripe mode immediately shows the stripe-width fields');
  await page.click('.plugin-settings input[type="radio"][value="edge"]');
  const stripeFieldCountBack = await page
    .locator('.plugin-settings label', { hasText: 'narrowest stripe' }).count();
  check(stripeFieldCountBack === 0,
        'switching back to edge mode immediately hides them again');

  check(pageErrors.length === 0, `no page errors (${pageErrors.length})`);
  if (pageErrors.length > 0) for (const error of pageErrors) console.error(`       ${error}`);
} finally {
  await browser.close();
  server.kill();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll line-fitter checks passed.');
