// End-to-end smoke test: serves the app, opens it in headless Chromium, loads
// the frame-numbered VFR fixture, and exercises the core flows — playback,
// frame stepping, placing a point, drawing a polyline, an event hotkey, undo,
// and export. Fails on any page error or console error.
//
// Run:  node test/smoke-test.mjs
//       node test/smoke-test.mjs --url https://exact-video-annotator.pages.dev/
//
// With --url the same checks run against an already-deployed app instead of a
// local server, plus the version-stamp checks below. Needs Playwright;
// resolved from the exact-video-engine.js sibling repo's node_modules so this
// repo stays dependency-free.

import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const playwrightPath =
  '/Users/jasper/repos/jasper-tms/exact-video-engine.js/node_modules/playwright/index.mjs';
const { chromium } = await import(playwrightPath);

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = 8797;

const urlFlagIndex = process.argv.indexOf('--url');
const deployedUrl = urlFlagIndex === -1 ? null : process.argv[urlFlagIndex + 1];
if (urlFlagIndex !== -1 && !deployedUrl) {
  console.error('--url needs a URL, for example --url https://exact-video-annotator.pages.dev/');
  process.exit(2);
}
const testingDeployedApp = deployedUrl !== null;
const applicationUrl = deployedUrl ?? `http://127.0.0.1:${port}/index.html`;

// Testing a deployed app means testing whatever is already served; a local run
// needs its own static server first.
let server = null;
if (!testingDeployedApp) {
  server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'],
    { cwd: repositoryRoot, stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 800));
}

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
  await page.goto(applicationUrl);
  await page.waitForFunction(() => window.exactVideoAnnotator !== undefined);

  // ---- The version stamp describes the code actually being served ----
  // Only a built deployment has one: build.sh writes it into dist/, so a local
  // run serving the repository root has no /version to ask.
  if (testingDeployedApp) {
    const versionFacts = await page.evaluate(async () => {
      const response = await fetch('/version');
      const stamp = await response.json();
      const engineScript = [...document.querySelectorAll('script')]
        .map((element) => element.src)
        .find((source) => source.includes('exact-video-engine.js@'));
      return { stamp, engineScript };
    });
    console.log('version:', JSON.stringify(versionFacts.stamp));
    // The stamp reports the engine version bare; the CDN URL pins a tag, which
    // carries the leading "v". Put it back rather than matching loosely.
    check(versionFacts.engineScript?.includes(
            `exact-video-engine.js@v${versionFacts.stamp.videoEngineVersion}/`),
          'the engine the page loads matches the version stamp');

    // The trap this guards: run this straight after a push, while the host is
    // still building, and every check below passes against the PREVIOUS deploy.
    const localHead = execSync('git rev-parse HEAD',
      { cwd: repositoryRoot, encoding: 'utf8' }).trim();
    const deployedCommitIsLocalHead = versionFacts.stamp.commit === localHead;
    check(deployedCommitIsLocalHead, 'the deployed commit is the local HEAD commit');
    if (!deployedCommitIsLocalHead) {
      console.error(`       deployed ${versionFacts.stamp.commit}`);
      console.error(`       local    ${localHead}`);
      console.error('       (still building, or HEAD is not what was pushed —'
                  + ' everything below tested the older deploy)');
    }
  }

  // ---- Load the fixture through the real file input ----
  await page.setInputFiles('#video-file-input',
    path.join(repositoryRoot, 'test', 'frame_numbered_vfr.mp4'));
  await page.waitForFunction(
    () => window.exactVideoAnnotator.engine !== null
       && window.exactVideoAnnotator.engine.numFrames > 0,
    undefined, { timeout: 20000 });

  const engineFacts = await page.evaluate(() => {
    const application = window.exactVideoAnnotator;
    return {
      numberOfFrames: application.engine.numFrames,
      tier: application.engine.tier,
      frameIndexIsExact: application.engine.frameIndexIsExact,
      layerCount: application.viewer.layers.length,
      layerTypes: application.viewer.layers.map((layer) => layer.type),
    };
  });
  console.log('engine:', JSON.stringify(engineFacts));
  check(engineFacts.numberOfFrames > 0, 'video loaded with a frame count');
  check(engineFacts.frameIndexIsExact !== false, 'frame indices are exact for the MP4 fixture');
  check(engineFacts.layerTypes[0] === 'video', 'video layer sits at the bottom of the stack');
  // The default annotation layers are 'coordinates' (points and polylines share
  // it, distinguished by each item's `kind`) and 'frames' (temporal events).
  check(engineFacts.layerTypes.includes('coordinates')
     && engineFacts.layerTypes.includes('frames'), 'default annotation layers exist');

  // ---- Frame stepping (ArrowRight twice → frame 2) ----
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => window.exactVideoAnnotator.currentFrame === 2);
  check(true, 'stepped to frame 2 with ArrowRight');

  // ---- Tool hotkeys select a tool; pressing the active tool's key again no
  // longer deselects it (every tool pans on its own now) — it just blinks the
  // button. Number keys are assigned by tool-rail position — point is the 2nd
  // button, so '2'. ----
  await page.keyboard.press('2');   // pan is active at startup
  let activeToolId = await page.evaluate(() => window.exactVideoAnnotator.activeTool?.id ?? null);
  check(activeToolId === 'point', "pressing '2' selects the point tool");
  await page.keyboard.press('2');
  activeToolId = await page.evaluate(() => window.exactVideoAnnotator.activeTool?.id ?? null);
  check(activeToolId === 'point', "pressing the active tool's hotkey again leaves it active");

  // ---- Place a point with the point tool (a double-click starts it; a
  // single click only selects or pans) ----
  const stageBox = await page.locator('#stage-canvas').boundingBox();
  await page.mouse.dblclick(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
  // A point lives in the 'coordinates' layer as a single-vertex item (kind
  // 'point'); coordinates are held in a `vertices` array, not flat x/y.
  const pointFacts = await page.evaluate(() => {
    const application = window.exactVideoAnnotator;
    const coordinatesLayer =
      application.annotationDocument.layers.find((layer) => layer.type === 'coordinates');
    const point = coordinatesLayer.items.find((item) => item.kind === 'point') ?? null;
    return { itemCount: coordinatesLayer.items.length, item: point };
  });
  check(pointFacts.itemCount === 1, 'point tool created one point');
  check(pointFacts.item?.frame === 2, 'point is bound to the current frame (2)');
  check(Array.isArray(pointFacts.item?.vertices) && pointFacts.item.vertices.length === 1
        && Number.isFinite(pointFacts.item.vertices[0][0])
        && Number.isFinite(pointFacts.item.vertices[0][1]),
        'point has one finite source-pixel vertex');

  // ---- Drag the point with the same tool (there is no separate select tool) ----
  const stageCenterX = stageBox.x + stageBox.width / 2;
  const stageCenterY = stageBox.y + stageBox.height / 2;
  await page.mouse.move(stageCenterX, stageCenterY);
  await page.mouse.down();
  await page.mouse.move(stageCenterX + 40, stageCenterY + 25, { steps: 5 });
  await page.mouse.up();
  const readFirstPointVertex = () => page.evaluate(() => {
    const application = window.exactVideoAnnotator;
    const coordinatesLayer =
      application.annotationDocument.layers.find((layer) => layer.type === 'coordinates');
    const point = coordinatesLayer.items.find((item) => item.kind === 'point');
    return [...point.vertices[0]];
  });
  const originalVertex = pointFacts.item.vertices[0];
  const movedVertex = await readFirstPointVertex();
  check(movedVertex[0] !== originalVertex[0] || movedVertex[1] !== originalVertex[1],
        'dragging an existing point with the point tool moves it');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  const restoredVertex = await readFirstPointVertex();
  check(restoredVertex[0] === originalVertex[0] && restoredVertex[1] === originalVertex[1],
        'undo restores the dragged point');

  // ---- Draw a closed triangle with the polyline tool (a double-click places
  // the first vertex; single clicks place the rest once the shape is
  // started; clicking back on the first vertex closes it). Polyline is the
  // 4th tool-rail button, so its hotkey is '4'. ----
  await page.keyboard.press('4');
  const triangleFirstVertex =
    { x: stageBox.x + stageBox.width * 0.3, y: stageBox.y + stageBox.height * 0.3 };
  await page.mouse.dblclick(triangleFirstVertex.x, triangleFirstVertex.y);
  await page.mouse.click(stageBox.x + stageBox.width * 0.6, stageBox.y + stageBox.height * 0.3);
  await page.mouse.click(stageBox.x + stageBox.width * 0.45, stageBox.y + stageBox.height * 0.6);
  await page.mouse.click(triangleFirstVertex.x, triangleFirstVertex.y);
  // The polyline lands in the same 'coordinates' layer as the point, told apart
  // by kind — so that layer now holds two items.
  const polygonFacts = await page.evaluate(() => {
    const application = window.exactVideoAnnotator;
    const coordinatesLayer =
      application.annotationDocument.layers.find((layer) => layer.type === 'coordinates');
    const polyline = coordinatesLayer.items.find((item) => item.kind === 'polyline') ?? null;
    return { itemCount: coordinatesLayer.items.length, item: polyline };
  });
  check(polygonFacts.itemCount === 2, 'polyline tool added a second coordinates item');
  check(polygonFacts.item?.kind === 'polyline' && polygonFacts.item?.vertices.length === 4,
        'closing near the first vertex creates a 4-vertex closed polyline');

  // ---- Event hotkey (create an event type, press its key) ----
  await page.evaluate(() => {
    const application = window.exactVideoAnnotator;
    application.annotationDocument.eventTypes.push({
      id: 'test-event-type', name: 'test event', kind: 'point', color: '#e6194b',
      addHotkey: 'e', removeHotkey: 'E',
    });
    application.markDocumentChanged();
  });
  await page.locator('#stage-canvas').click({ position: { x: 10, y: 10 } });  // focus off inputs
  await page.keyboard.press('e');
  const eventFacts = await page.evaluate(() => {
    const application = window.exactVideoAnnotator;
    const framesLayer = application.annotationDocument.layers.find((layer) => layer.type === 'frames');
    return { itemCount: framesLayer.items.length, item: framesLayer.items[0] ?? null };
  });
  check(eventFacts.itemCount === 1, 'event hotkey created one event');
  check(eventFacts.item?.startFrame === 2 && eventFacts.item?.endFrame === 2,
        'point event bound to the current frame');

  // ---- Undo unwinds every command, then redo restores them ----
  // Three annotations are on screen (a point, a closed polyline, and an event),
  // but they took more than three commands to make: a polyline commits one
  // command per vertex ('Add polyline' then an 'Extend polyline' each), so drive
  // undo/redo off the history's own canUndo/canRedo rather than a fixed count.
  const totalItems = () => page.evaluate(() =>
    window.exactVideoAnnotator.annotationDocument.layers
      .map((layer) => layer.items.length)
      .reduce((total, count) => total + count, 0));
  const undoKey = process.platform === 'darwin' ? 'Meta+z' : 'Control+z';
  const redoKey = process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z';
  check(await totalItems() === 3, 'point, polyline, and event are all present');

  const HISTORY_STEP_LIMIT = 50;  // guards against an undo that never empties
  for (let step = 0; step < HISTORY_STEP_LIMIT
       && await page.evaluate(() => window.exactVideoAnnotator.undoHistory.canUndo); step++) {
    await page.keyboard.press(undoKey);
  }
  check(await totalItems() === 0, 'undoing the whole history removes every annotation');

  for (let step = 0; step < HISTORY_STEP_LIMIT
       && await page.evaluate(() => window.exactVideoAnnotator.undoHistory.canRedo); step++) {
    await page.keyboard.press(redoKey);
  }
  check(await totalItems() === 3, 'redoing the whole history restores all three annotations');

  // ---- v toggles the selected layer's visibility ----
  await page.keyboard.press('v');
  let selectedLayerVisible = await page.evaluate(() =>
    window.exactVideoAnnotator.selectedLayer.visible);
  check(selectedLayerVisible === false, 'v hides the selected layer');
  await page.keyboard.press('v');
  selectedLayerVisible = await page.evaluate(() =>
    window.exactVideoAnnotator.selectedLayer.visible);
  check(selectedLayerVisible === true, 'v shows the selected layer again');

  // ---- Export round-trip through the document serializer ----
  const roundTrip = await page.evaluate(async () => {
    const documentModule = await import('./js/document.js');
    const application = window.exactVideoAnnotator;
    const exported = documentModule.documentToJson(
      application.annotationDocument, application.videoInformation);
    const reparsed = documentModule.documentFromJson(JSON.parse(JSON.stringify(exported)));
    return {
      videoName: exported.video?.name,
      itemCounts: reparsed.layers.map((layer) => layer.items.length),
    };
  });
  check(roundTrip.videoName === 'frame_numbered_vfr.mp4', 'export records video provenance');
  check(roundTrip.itemCounts.reduce((total, count) => total + count, 0) === 3,
        'export/import round-trip preserves all items');

  // ---- Zoom and pan leave annotations anchored to source pixels ----
  const anchorBefore = await readFirstPointVertex();
  await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
  await page.mouse.wheel(0, -400);   // zoom in
  await page.mouse.wheel(0, 200);    // zoom out a bit
  const anchorAfter = await readFirstPointVertex();
  check(anchorBefore[0] === anchorAfter[0] && anchorBefore[1] === anchorAfter[1],
        'zooming does not disturb stored annotation coordinates');

  // ---- Playback runs ----
  await page.keyboard.press('Space');
  await page.waitForFunction((frameBefore) =>
    window.exactVideoAnnotator.currentFrame !== frameBefore, 2, { timeout: 8000 });
  await page.keyboard.press('Space');
  check(true, 'playback advances frames and pauses again');

} finally {
  await browser.close();
  server?.kill();
}

if (pageErrors.length > 0) {
  console.error('\nPage errors:');
  for (const error of pageErrors) console.error(`  ${error}`);
}
if (failures.length > 0 || pageErrors.length > 0) {
  console.error(`\n${failures.length} failed checks, ${pageErrors.length} page errors`);
  process.exit(1);
}
console.log('\nAll smoke checks passed.');
