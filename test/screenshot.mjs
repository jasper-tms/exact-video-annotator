// Loads the app with the test fixture, draws a few annotations, and captures
// screenshots (viewport and full page) for visual inspection.
// Run:  node test/screenshot.mjs [output-directory]

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const playwrightPath =
  '/Users/jasper/repos/jasper-tms/exact-video-engine.js/node_modules/playwright/index.mjs';
const { chromium } = await import(playwrightPath);

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outputDirectory = process.argv[2] ?? repositoryRoot;
const port = 8798;

const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'],
  { cwd: repositoryRoot, stdio: 'ignore' });
await new Promise((resolve) => setTimeout(resolve, 800));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

try {
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.waitForFunction(() => window.exactVideoAnnotator !== undefined);
  await page.setInputFiles('#video-file-input',
    path.join(repositoryRoot, 'test', 'frame_numbered_vfr.mp4'));
  await page.waitForFunction(
    () => window.exactVideoAnnotator.engine?.numFrames > 0, undefined, { timeout: 20000 });
  await page.keyboard.press('ArrowRight');

  // A point, a polygon, and a class so the canvas has content.
  await page.evaluate(() => {
    const application = window.exactVideoAnnotator;
    application.annotationDocument.classes.push(
      { id: 'class-demonstration', name: 'ball', color: '#e6194b' });
    application.markDocumentChanged();
    application.activeClassId = 'class-demonstration';
  });
  const stageBox = await page.locator('#stage-canvas').boundingBox();
  // The point tool is active at startup; this click places the point.
  await page.mouse.click(stageBox.x + stageBox.width * 0.55, stageBox.y + stageBox.height * 0.35);
  await page.keyboard.press('g');
  await page.mouse.click(stageBox.x + stageBox.width * 0.25, stageBox.y + stageBox.height * 0.55);
  await page.mouse.click(stageBox.x + stageBox.width * 0.4, stageBox.y + stageBox.height * 0.5);
  await page.mouse.click(stageBox.x + stageBox.width * 0.35, stageBox.y + stageBox.height * 0.75);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);

  await page.screenshot({ path: path.join(outputDirectory, 'screenshot-viewport.png') });
  await page.screenshot({ path: path.join(outputDirectory, 'screenshot-full-page.png'), fullPage: true });
  console.log(`Saved screenshots to ${outputDirectory}`);
} finally {
  await browser.close();
  server.kill();
}
