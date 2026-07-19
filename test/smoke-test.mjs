// End-to-end smoke test: serves the app, opens it in headless Chromium, loads
// the frame-numbered VFR fixture, and exercises the core flows — playback,
// frame stepping, placing a point, drawing a polygon, an event hotkey, undo,
// and export. Fails on any page error or console error.
//
// Run:  node test/smoke-test.mjs
// Needs Playwright; resolved from the exact-video-engine.js sibling repo's
// node_modules so this repo stays dependency-free.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const playwrightPath =
  '/Users/jasper/repos/jasper-tms/exact-video-engine.js/node_modules/playwright/index.mjs';
const { chromium } = await import(playwrightPath);

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = 8797;

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
  check(engineFacts.layerTypes.includes('points')
     && engineFacts.layerTypes.includes('shapes')
     && engineFacts.layerTypes.includes('events'), 'default annotation layers exist');

  // ---- Frame stepping (ArrowRight twice → frame 2) ----
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => window.exactVideoAnnotator.currentFrame === 2);
  check(true, 'stepped to frame 2 with ArrowRight');

  // ---- Tool hotkeys toggle: pressing the active tool's key deselects it ----
  await page.keyboard.press('o');   // the point tool is active at startup
  let activeToolId = await page.evaluate(() => window.exactVideoAnnotator.activeTool?.id ?? null);
  check(activeToolId === null, "pressing the active tool's hotkey deselects it");
  await page.keyboard.press('o');
  activeToolId = await page.evaluate(() => window.exactVideoAnnotator.activeTool?.id ?? null);
  check(activeToolId === 'point', 'pressing o again reselects the point tool');

  // ---- Place a point with the point tool ----
  const stageBox = await page.locator('#stage-canvas').boundingBox();
  await page.mouse.click(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
  const pointFacts = await page.evaluate(() => {
    const application = window.exactVideoAnnotator;
    const pointsLayer = application.annotationDocument.layers.find((layer) => layer.type === 'points');
    return { itemCount: pointsLayer.items.length, item: pointsLayer.items[0] ?? null };
  });
  check(pointFacts.itemCount === 1, 'point tool created one point');
  check(pointFacts.item?.frame === 2, 'point is bound to the current frame (2)');
  check(Number.isFinite(pointFacts.item?.x) && Number.isFinite(pointFacts.item?.y),
        'point has finite source-pixel coordinates');

  // ---- Drag the point with the same tool (there is no separate select tool) ----
  const stageCenterX = stageBox.x + stageBox.width / 2;
  const stageCenterY = stageBox.y + stageBox.height / 2;
  await page.mouse.move(stageCenterX, stageCenterY);
  await page.mouse.down();
  await page.mouse.move(stageCenterX + 40, stageCenterY + 25, { steps: 5 });
  await page.mouse.up();
  const readFirstPoint = () => page.evaluate(() => {
    const application = window.exactVideoAnnotator;
    const pointsLayer = application.annotationDocument.layers.find((layer) => layer.type === 'points');
    return { ...pointsLayer.items[0] };
  });
  const movedPoint = await readFirstPoint();
  check(movedPoint.x !== pointFacts.item.x || movedPoint.y !== pointFacts.item.y,
        'dragging an existing point with the point tool moves it');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  const restoredPoint = await readFirstPoint();
  check(restoredPoint.x === pointFacts.item.x && restoredPoint.y === pointFacts.item.y,
        'undo restores the dragged point');

  // ---- Draw a triangle with the polygon tool ----
  await page.keyboard.press('g');
  await page.mouse.click(stageBox.x + stageBox.width * 0.3, stageBox.y + stageBox.height * 0.3);
  await page.mouse.click(stageBox.x + stageBox.width * 0.6, stageBox.y + stageBox.height * 0.3);
  await page.mouse.click(stageBox.x + stageBox.width * 0.45, stageBox.y + stageBox.height * 0.6);
  await page.keyboard.press('Enter');
  const polygonFacts = await page.evaluate(() => {
    const application = window.exactVideoAnnotator;
    const shapesLayer = application.annotationDocument.layers.find((layer) => layer.type === 'shapes');
    return { itemCount: shapesLayer.items.length, item: shapesLayer.items[0] ?? null };
  });
  check(polygonFacts.itemCount === 1, 'polygon tool created one shape');
  check(polygonFacts.item?.kind === 'polygon' && polygonFacts.item?.vertices.length === 3,
        'polygon has 3 vertices');

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
    const eventsLayer = application.annotationDocument.layers.find((layer) => layer.type === 'events');
    return { itemCount: eventsLayer.items.length, item: eventsLayer.items[0] ?? null };
  });
  check(eventFacts.itemCount === 1, 'event hotkey created one event');
  check(eventFacts.item?.startFrame === 2 && eventFacts.item?.endFrame === 2,
        'point event bound to the current frame');

  // ---- Undo unwinds the event, polygon, then point ----
  for (let undoCount = 0; undoCount < 3; undoCount++) {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  }
  const afterUndo = await page.evaluate(() => {
    const application = window.exactVideoAnnotator;
    return application.annotationDocument.layers
      .map((layer) => layer.items.length)
      .reduce((total, count) => total + count, 0);
  });
  check(afterUndo === 0, 'three undos removed all three annotations');

  // ---- Redo restores them ----
  for (let redoCount = 0; redoCount < 3; redoCount++) {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z');
  }
  const afterRedo = await page.evaluate(() =>
    window.exactVideoAnnotator.annotationDocument.layers
      .map((layer) => layer.items.length)
      .reduce((total, count) => total + count, 0));
  check(afterRedo === 3, 'three redos restored all three annotations');

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
  const anchorBefore = await page.evaluate(() => {
    const application = window.exactVideoAnnotator;
    const pointsLayer = application.annotationDocument.layers.find((layer) => layer.type === 'points');
    return { ...pointsLayer.items[0] };
  });
  await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
  await page.mouse.wheel(0, -400);   // zoom in
  await page.mouse.wheel(0, 200);    // zoom out a bit
  const anchorAfter = await page.evaluate(() => {
    const application = window.exactVideoAnnotator;
    const pointsLayer = application.annotationDocument.layers.find((layer) => layer.type === 'points');
    return { ...pointsLayer.items[0] };
  });
  check(anchorBefore.x === anchorAfter.x && anchorBefore.y === anchorAfter.y,
        'zooming does not disturb stored annotation coordinates');

  // ---- Playback runs ----
  await page.keyboard.press('Space');
  await page.waitForFunction((frameBefore) =>
    window.exactVideoAnnotator.currentFrame !== frameBefore, 2, { timeout: 8000 });
  await page.keyboard.press('Space');
  check(true, 'playback advances frames and pauses again');

} finally {
  await browser.close();
  server.kill();
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
