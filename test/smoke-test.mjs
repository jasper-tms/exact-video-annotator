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
import net from 'node:net';
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
  // A server left over on the port (say, from another worktree) would make
  // ours fail to start while the test quietly ran against whatever that one
  // serves, so refuse to run instead.
  if (await portIsAcceptingConnections(port)) {
    console.error(`Port ${port} is already in use, so the smoke test cannot start its own `
      + `server there. Find what is listening with: lsof -nP -iTCP:${port} -sTCP:LISTEN`);
    process.exit(2);
  }
  server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'],
    { cwd: repositoryRoot, stdio: 'ignore' });
  // Stop the server however this process ends — a crash before the finally
  // block below, Ctrl+C, or a kill from a timeout — so it never outlives the
  // test.
  process.on('exit', () => server.kill());
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => process.exit(1));
  }
  await waitForServerToStart(server, port);
}

function portIsAcceptingConnections(portToCheck) {
  return new Promise((resolve) => {
    const socket = net.connect(portToCheck, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

async function waitForServerToStart(serverProcess, portToCheck) {
  let exitCode = null;
  serverProcess.once('exit', (code) => { exitCode = code; });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (exitCode !== null) {
      console.error(`The local server exited (code ${exitCode}) before it started serving.`);
      process.exit(2);
    }
    if (await portIsAcceptingConnections(portToCheck)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.error(`The local server did not start serving on port ${portToCheck} within 10 seconds.`);
  process.exit(2);
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
  // Only a built deployment has one: build.mjs writes it into dist/, so a local
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
  await page.setInputFiles('#media-file-input',
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

  // ---- A quick press that selects a point doesn't drag it ----
  const stageCenterX = stageBox.x + stageBox.width / 2;
  const stageCenterY = stageBox.y + stageBox.height / 2;
  await page.mouse.click(stageBox.x + 10, stageBox.y + 10);
  const deselected = await page.evaluate(() => window.exactVideoAnnotator.selection === null);
  check(deselected, 'clicking empty space deselects the new point');
  const undoLabelBeforeQuickDrag =
    await page.evaluate(() => window.exactVideoAnnotator.undoHistory.nextUndoLabel);
  await page.mouse.move(stageCenterX, stageCenterY);
  await page.mouse.down();
  await page.mouse.move(stageCenterX + 40, stageCenterY + 25, { steps: 5 });
  await page.mouse.up();
  const selectingPressFacts = await page.evaluate(() => {
    const application = window.exactVideoAnnotator;
    const coordinatesLayer =
      application.annotationDocument.layers.find((layer) => layer.type === 'coordinates');
    const point = coordinatesLayer.items.find((item) => item.kind === 'point');
    return { vertex: [...point.vertices[0]], selectedItemId: application.selection?.itemId ?? null,
             undoLabel: application.undoHistory.nextUndoLabel };
  });
  check(selectingPressFacts.selectedItemId === pointFacts.item.id,
        'pressing an unselected point selects it');
  check(selectingPressFacts.vertex[0] === pointFacts.item.vertices[0][0]
        && selectingPressFacts.vertex[1] === pointFacts.item.vertices[0][1],
        'a quick drag on the press that selects a point does not move it');
  check(selectingPressFacts.undoLabel === undoLabelBeforeQuickDrag,
        'a quick drag that moves nothing adds no undo entry');

  // ---- Drag the now-selected point with the same tool (there is no
  // separate select tool) ----
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

  // ---- Holding the press that selects a point long enough lets it drag ----
  await page.mouse.click(stageBox.x + 10, stageBox.y + 10);
  await page.mouse.move(stageCenterX, stageCenterY);
  await page.mouse.down();
  await page.mouse.move(stageCenterX + 40, stageCenterY + 25, { steps: 5 });
  const vertexBeforeHoldUnlocks = await readFirstPointVertex();
  await page.waitForTimeout(800);
  const vertexAfterHoldUnlocks = await readFirstPointVertex();
  await page.mouse.up();
  check(vertexBeforeHoldUnlocks[0] === originalVertex[0]
        && vertexBeforeHoldUnlocks[1] === originalVertex[1],
        'a newly selected point does not move before the hold unlocks dragging');
  check(vertexAfterHoldUnlocks[0] !== originalVertex[0]
        || vertexAfterHoldUnlocks[1] !== originalVertex[1],
        'a newly selected point catches up to the pointer once held long enough');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  const restoredAfterHeldDrag = await readFirstPointVertex();
  check(restoredAfterHeldDrag[0] === originalVertex[0] && restoredAfterHeldDrag[1] === originalVertex[1],
        'undo restores the point dragged after a hold');

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

  // ---- s selects the vertex nearest the cursor, when it is clearly nearest ----
  const readSelection = () => page.evaluate(() => {
    const selection = window.exactVideoAnnotator.selection;
    return selection ? { itemId: selection.itemId, vertexIndex: selection.vertexIndex } : null;
  });
  await page.keyboard.press('Escape');
  await page.mouse.move(stageBox.x + stageBox.width * 0.45, stageBox.y + stageBox.height * 0.3);
  await page.keyboard.press('s');
  check(await readSelection() === null,
        's halfway between two triangle corners selects nothing');
  await page.mouse.move(stageBox.x + stageBox.width * 0.6 - 6, stageBox.y + stageBox.height * 0.3 + 4);
  await page.keyboard.press('s');
  let selectionAfterS = await readSelection();
  check(selectionAfterS?.itemId === polygonFacts.item.id && selectionAfterS?.vertexIndex === 1,
        's near a triangle corner selects that corner');
  await page.mouse.move(triangleFirstVertex.x + 5, triangleFirstVertex.y + 5);
  await page.keyboard.press('s');
  selectionAfterS = await readSelection();
  check(selectionAfterS?.itemId === polygonFacts.item.id && selectionAfterS?.vertexIndex === 0,
        "s near a closed polyline's first corner selects it, despite its closing duplicate");
  await page.mouse.move(stageCenterX + 8, stageCenterY - 5);
  await page.keyboard.press('s');
  selectionAfterS = await readSelection();
  check(selectionAfterS?.itemId === pointFacts.item.id, 's near the point selects the point');
  await page.mouse.move(stageBox.x + stageBox.width * 0.45, stageBox.y + stageBox.height * 0.3);
  await page.keyboard.press('s');
  check(await readSelection() === null, 's in an ambiguous spot deselects');
  await page.mouse.move(stageCenterX + 8, stageCenterY - 5);
  await page.keyboard.press('s');
  await page.mouse.move(stageCenterX + 80, stageCenterY);
  await page.keyboard.press('s');
  check(await readSelection() === null,
        's deselects when the nearest vertex is more than 60 screen pixels away');
  // Pan the view so the point sits just past the canvas's left edge, with the
  // cursor just inside it: that point is no longer a candidate.
  const savedViewTransform = await page.evaluate(() => {
    const viewer = window.exactVideoAnnotator.viewer;
    const saved = { ...viewer.viewTransform };
    viewer.viewTransform.offsetX -= viewer.stageCanvas.getBoundingClientRect().width / 2 + 10;
    viewer.requestRender();
    return saved;
  });
  await page.mouse.move(stageBox.x + 5, stageCenterY);
  await page.keyboard.press('s');
  check(await readSelection() === null, 's never selects a vertex outside the visible canvas');
  await page.evaluate((saved) => {
    const viewer = window.exactVideoAnnotator.viewer;
    Object.assign(viewer.viewTransform, saved);
    viewer.requestRender();
  }, savedViewTransform);
  // A click on empty canvas deselects with the pan tool too.
  await page.mouse.move(stageCenterX + 8, stageCenterY - 5);
  await page.keyboard.press('s');
  await page.keyboard.press('1');
  await page.mouse.click(stageCenterX + 80, stageCenterY);
  check(await readSelection() === null, 'clicking empty canvas with the pan tool deselects');
  await page.keyboard.press('2');

  // ---- Items drawn at zero strength can't be clicked or picked with s ----
  const setCoordinatesLayerOpacities = (opacities) => page.evaluate(({ opacity, offFrameOpacity }) => {
    const layer = window.exactVideoAnnotator.findAnnotationLayerForType('coordinates');
    if (opacity !== undefined) layer.setOpacity(opacity);
    if (offFrameOpacity !== undefined) layer.setOffFrameOpacity(offFrameOpacity);
  }, opacities);
  await page.keyboard.press('ArrowRight');   // the point is now on another frame
  await page.mouse.click(stageCenterX, stageCenterY);
  check((await readSelection())?.itemId === pointFacts.item.id,
        "another frame's point, drawn dimmed, can still be clicked");
  await page.keyboard.press('Escape');
  await page.mouse.move(stageCenterX + 8, stageCenterY - 5);
  await page.keyboard.press('s');
  check((await readSelection())?.itemId === pointFacts.item.id,
        "s picks another frame's point when this frame has nothing in range");
  // A point on this frame 20 pixels away: with the cursor halfway between it
  // and the other frame's point, this frame's point wins rather than tying.
  await page.mouse.dblclick(stageCenterX + 20, stageCenterY);
  const currentFramePointId = await page.evaluate(() => window.exactVideoAnnotator.selection?.itemId);
  await page.mouse.move(stageCenterX + 10, stageCenterY);
  await page.keyboard.press('Escape');
  await page.keyboard.press('s');
  check((await readSelection())?.itemId === currentFramePointId
        && currentFramePointId !== pointFacts.item.id,
        "s prefers this frame's point over an equally near point on another frame");
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await page.keyboard.press('Escape');
  await setCoordinatesLayerOpacities({ offFrameOpacity: 0 });
  await page.mouse.click(stageCenterX, stageCenterY);
  check(await readSelection() === null,
        "another frame's point can't be clicked once other frames are at 0%");
  const savedOffFrameOpacity = await page.evaluate(() => window.exactVideoAnnotator
    .annotationDocument.layers.find((layer) => layer.type === 'coordinates').offFrameOpacity);
  check(savedOffFrameOpacity === 0, "the layer's other-frames opacity is saved in the document");
  await setCoordinatesLayerOpacities({ offFrameOpacity: 0.25 });
  await page.keyboard.press('ArrowLeft');    // back to the point's own frame
  await setCoordinatesLayerOpacities({ opacity: 0 });
  await page.mouse.click(stageCenterX, stageCenterY);
  check(await readSelection() === null, "a point on a 0%-opacity layer can't be clicked");
  await page.mouse.move(stageCenterX + 8, stageCenterY - 5);
  await page.keyboard.press('s');
  check(await readSelection() === null, "s doesn't pick a point on a 0%-opacity layer");
  await page.keyboard.press('ArrowRight');
  await page.mouse.click(stageCenterX, stageCenterY);
  check((await readSelection())?.itemId === pointFacts.item.id,
        "another frame's point stays clickable when only the current frame's opacity is 0%");
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowLeft');
  await setCoordinatesLayerOpacities({ opacity: 1 });

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
      conventions: exported.conventions,
      itemCounts: reparsed.layers.map((layer) => layer.items.length),
    };
  });
  check(roundTrip.videoName === 'frame_numbered_vfr.mp4', 'export records video provenance');
  check(typeof roundTrip.conventions === 'string' && roundTrip.conventions.includes('[x, y]'),
        'export states the coordinate/frame conventions in prose');
  check(roundTrip.itemCounts.reduce((total, count) => total + count, 0) === 3,
        'export/import round-trip preserves all items');

  // ---- Item metadata: edited in the annotations table, kept on export ----
  await page.locator('.show-all-annotations-checkbox').check();
  await page.locator('.edit-metadata-button').first().click();
  await page.locator('.metadata-dialog .metadata-text').fill('table: 2\nkeypoint: +-\nnote: "7"');
  await page.locator('.metadata-dialog .metadata-save').click();
  const metadataFacts = await page.evaluate(async () => {
    const documentModule = await import('./js/document.js');
    const application = window.exactVideoAnnotator;
    const edited = application.annotationDocument.layers.flatMap((layer) => layer.items)
      .find((item) => Object.keys(item.metadata ?? {}).length > 0);
    const exported = documentModule.documentToJson(
      application.annotationDocument, application.videoInformation);
    const reparsed = documentModule.documentFromJson(JSON.parse(JSON.stringify(exported)));
    const reparsedItem = reparsed.layers.flatMap((layer) => layer.items)
      .find((item) => item.id === edited?.id);
    const cellText = [...document.querySelectorAll('.metadata-cell')].map((cell) => cell.textContent).join(' ');
    const editedMetadata = { ...edited?.metadata };
    application.undoHistory.undo();
    return { edited: editedMetadata, reparsed: reparsedItem?.metadata, cellText,
             afterUndo: edited?.metadata };
  });
  check(JSON.stringify(metadataFacts.edited) === JSON.stringify({ table: 2, keypoint: '+-', note: '7' }),
        'the metadata editor stores numbers as numbers and quoted values as text');
  check(JSON.stringify(metadataFacts.reparsed) === JSON.stringify(metadataFacts.edited),
        'export/import round-trip preserves item metadata');
  check(metadataFacts.cellText.includes('table: 2'), 'the annotations table shows item metadata');
  check(JSON.stringify(metadataFacts.afterUndo) === '{}', 'undo restores the previous metadata');
  // Leave the panel as it was, with focus off the checkbox so Space plays.
  await page.locator('.show-all-annotations-checkbox').uncheck();
  await page.evaluate(() => document.activeElement?.blur());

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

  // ---- Open a still image alongside the video ----
  // Generate a tiny PNG in the browser rather than committing a fixture, then
  // feed its bytes through the same file input videos use.
  const pngBase64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 6;
    const context = canvas.getContext('2d');
    context.fillStyle = '#3355ff';
    context.fillRect(0, 0, 8, 6);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const buffer = await blob.arrayBuffer();
    let binary = '';
    for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
    return btoa(binary);
  });
  // A video is already open, so this is the "second media" path. Choose
  // "new layer" up front so it stacks without the prompt dialog blocking. The
  // preference is read through the shared preference store, which caches its
  // value at module load, so set it through the live module rather than by
  // writing localStorage after the page has loaded.
  await page.evaluate(async () => {
    const preference = await import('./js/second-media-preference.js');
    preference.setSecondMediaBehavior('new-layer');
  });
  await page.setInputFiles('#media-file-input', {
    name: 'swatch.png', mimeType: 'image/png', buffer: Buffer.from(pngBase64, 'base64'),
  });
  await page.waitForFunction(
    () => window.exactVideoAnnotator.imageLayers.length === 1, undefined, { timeout: 8000 });
  const imageFacts = await page.evaluate(() => {
    const application = window.exactVideoAnnotator;
    const [imageLayer] = application.imageLayers;
    const mediaLayers = application.viewer.layers.filter((layer) => layer.isMedia);
    return {
      layerTypes: application.viewer.layers.map((layer) => layer.type),
      width: imageLayer.bitmap.width,
      height: imageLayer.bitmap.height,
      // Media are treated identically: the new image stacks like a second video
      // would — directly above the video in the array, painting BEHIND it, so
      // the video (leftmost = frontmost media) stays on top.
      frontmostMediaIsVideo: mediaLayers[0]?.type === 'video',
      imageIsSecondMedia: mediaLayers[1]?.type === 'image',
      imageDimmed: imageLayer.opacity === 0.75,
      videoDimmed: application.primaryVideoLayer.opacity === 0.75,
      videoStillPrimary: application.primaryVideoLayer?.type === 'video',
      engineUnchanged: application.engine !== null,
    };
  });
  check(imageFacts.width === 8 && imageFacts.height === 6,
        'image loaded at its native dimensions');
  check(imageFacts.frontmostMediaIsVideo && imageFacts.imageIsSecondMedia,
        'the new image stacks behind the video, treated like any second media layer');
  check(imageFacts.imageDimmed && imageFacts.videoDimmed,
        'a second media layer dims both it and the one already open to 75%');
  check(imageFacts.videoStillPrimary && imageFacts.engineUnchanged,
        'opening an image leaves the video primary and the timeline intact');

  // The image draws on every frame regardless of the scrubber: stepping frames
  // must not disturb the image layer (it has no frame binding to disturb).
  await page.keyboard.press('ArrowLeft');
  const imageSurvivesFrameStep = await page.evaluate(() =>
    window.exactVideoAnnotator.imageLayers.length === 1
    && window.exactVideoAnnotator.imageLayers[0].bitmap !== null);
  check(imageSurvivesFrameStep, 'image stays present when the frame changes');

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
