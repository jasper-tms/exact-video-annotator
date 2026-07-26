// Growing-index UI test: checks what the app shows while a clip is still being
// indexed (engine option `playWhileIndexing`, engine README's "Playing while
// the index is still being built").
//
// Run:  node test/growing-index-test.mjs
//
// Provoking real growth needs a WebM big enough for the engine's pass to
// publish several certified prefixes, which is a large fixture to carry for a
// UI check. The engine's own tests cover that the index grows correctly; what
// is under test here is what THIS app does with a growing one. So the real
// engine is wrapped in a proxy that reports a prefix of its (already exact)
// frame table and then extends it on cue, which also exercises states the
// pinned engine build cannot produce on demand — truncation, and the pause at
// the end of the indexed range. Needs Playwright; resolved from the
// exact-video-engine.js sibling repo's node_modules so this repo stays
// dependency-free.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const playwrightPath =
  '/Users/jasper/repos/jasper-tms/exact-video-engine.js/node_modules/playwright/index.mjs';
const { chromium } = await import(playwrightPath);

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Not adjacent to the smoke test's 8797, and clear of the engine repo's own
// test servers, which sit in the 8798+ range.
const port = 8871;

const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'],
  { cwd: repositoryRoot, stdio: 'ignore' });

// A port already taken by someone else's server answers 404 for every path,
// which otherwise shows up as an inscrutable timeout much further down.
const applicationUrl = `http://127.0.0.1:${port}/index.html`;
let serverIsReady = false;
for (let attempt = 0; attempt < 40 && !serverIsReady; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  serverIsReady = await fetch(applicationUrl).then((response) => response.ok).catch(() => false);
}
if (!serverIsReady) {
  server.kill();
  console.error(`Nothing is serving this repository at ${applicationUrl} — port ${port} may be `
    + 'held by another process.');
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

/** Read everything the transport and detail panel are currently saying. */
function readDisplays() {
  return page.evaluate(() => {
    const scrubber = document.querySelector('.transport-scrubber');
    const readout = document.querySelector('.transport-readout');
    return {
      readout: readout.textContent,
      readoutClasses: [...readout.classList],
      scrubberMaximum: Number(scrubber.max),
      indexedFraction: scrubber.style.getPropertyValue('--indexed-fraction'),
      waitingVisible: !document.querySelector('.index-waiting').hidden,
      indexingStatusVisible: !document.getElementById('indexing-status').hidden,
      indexingStatusText: document.getElementById('indexing-status').textContent,
      detailFacts: document.getElementById('layer-detail-container').textContent,
    };
  });
}

try {
  await page.goto(applicationUrl);
  await page.waitForFunction(() => window.exactVideoAnnotator !== undefined);

  // Wrap createBestEngine before any video is opened. main.js resolves the
  // identifier from global scope at call time, so replacing the property here
  // is enough — the engine bundle has already run.
  await page.evaluate(() => {
    const realCreateBestEngine = window.createBestEngine;
    window.createBestEngine = async (source, options) => {
      const realEngine = await realCreateBestEngine(source, options);
      const wholeClipFrames = realEngine.numFrames;
      const wholeClipDuration = realEngine.duration;
      const simulation = {
        // Start with a fifth of the clip named, as an early publish would.
        indexedFrames: Math.round(wholeClipFrames / 5),
        state: 'growing',
        waiting: false,
      };
      const proxy = new Proxy(realEngine, {
        get(target, key, receiver) {
          if (key === 'numFrames') return simulation.indexedFrames;
          if (key === 'duration') {
            return wholeClipDuration * simulation.indexedFrames / wholeClipFrames;
          }
          // The container's declared total: what the engine reads out of
          // Matroska's Info/Duration and what the scrubber sizes itself by.
          if (key === 'expectedDuration') return wholeClipDuration;
          if (key === 'frameIndexState') return simulation.state;
          if (key === 'waitingForIndex') return simulation.waiting;
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      window.growingIndexSimulation = {
        wholeClipFrames,
        wholeClipDuration,
        extendTo(frames) {
          simulation.indexedFrames = frames;
          realEngine.dispatchEvent(new Event('indexextended'));
        },
        setWaiting(waiting) { simulation.waiting = waiting; },
        complete() {
          simulation.indexedFrames = wholeClipFrames;
          simulation.state = 'complete';
          realEngine.dispatchEvent(new Event('indexcomplete'));
        },
        truncate() {
          simulation.state = 'truncated';
          realEngine.dispatchEvent(new Event('indextruncated'));
          realEngine.dispatchEvent(new CustomEvent('errormessage', {
            detail: {
              message: `Only the first ${simulation.indexedFrames} frames of this clip `
                + 'could be indexed. Those frames are exact; the rest of the clip is '
                + 'unavailable.',
              fatal: true,
              incomplete: true,
            },
          }));
        },
      };
      return proxy;
    };
  });

  await page.setInputFiles('#video-file-input', path.join(repositoryRoot, 'test/frame_numbered_vfr.mp4'));
  await page.waitForFunction(() => window.exactVideoAnnotator.engine !== null);
  await page.waitForTimeout(300);

  const wholeClipFrames = await page.evaluate(() => window.growingIndexSimulation.wholeClipFrames);
  const growing = await readDisplays();

  check(/frame \d+ \/ \d+\+ ·/.test(growing.readout),
    `the frame total is marked as a floor while growing (${growing.readout})`);
  check(growing.readout.includes('/ ~'),
    'the clip duration is marked as the container\'s claim while growing');
  check(growing.readoutClasses.includes('index-growing'),
    'the readout is dimmed while the index grows');

  // The track is sized against the whole clip, not the indexed prefix, so it
  // does not stretch under the cursor as frames are published.
  check(Math.abs(growing.scrubberMaximum - (wholeClipFrames - 1)) <= 1,
    `the scrubber is sized against the whole clip (max ${growing.scrubberMaximum}, `
    + `clip ${wholeClipFrames - 1})`);
  const growingFraction = Number.parseFloat(growing.indexedFraction);
  check(growingFraction > 15 && growingFraction < 25,
    `the indexed share of the track is about a fifth (${growing.indexedFraction})`);
  check(growing.detailFacts.includes('indexed so far'),
    'the detail panel calls the frame count a running total');

  // Seeking cannot enter the un-indexed remainder, whatever the track shows.
  await page.evaluate(() => window.exactVideoAnnotator.seekToFrame(1e6));
  const clamped = await page.evaluate(() => window.exactVideoAnnotator.currentFrame);
  const indexedFrames = await page.evaluate(() => window.exactVideoAnnotator.engine.numFrames);
  check(clamped === indexedFrames - 1,
    `seeking past the indexed range clamps to the last indexed frame (${clamped})`);

  // An export taken mid-pass must not present a floor as a total.
  const exported = await page.evaluate(() => window.exactVideoAnnotator.videoInformation);
  check(exported.frameIndexState === 'growing',
    'videoInformation records that the index was still growing');
  check(exported.numberOfFrames === indexedFrames,
    'videoInformation carries the frames indexed so far');

  // Playback pinned at the end of the indexed range: not paused, not the end.
  await page.evaluate(() => window.growingIndexSimulation.setWaiting(true));
  await page.waitForFunction(() => !document.querySelector('.index-waiting').hidden,
    null, { timeout: 3000 }).catch(() => {});
  check((await readDisplays()).waitingVisible,
    'waiting at the end of the indexed range is labelled');
  await page.evaluate(() => window.growingIndexSimulation.setWaiting(false));

  // More frames published: the counter rises, the grey shrinks.
  await page.evaluate(() => window.growingIndexSimulation
    .extendTo(Math.round(window.growingIndexSimulation.wholeClipFrames * 0.6)));
  await page.waitForTimeout(400);
  const extended = await readDisplays();
  check(Number.parseFloat(extended.indexedFraction) > 55
    && Number.parseFloat(extended.indexedFraction) < 65,
    `the indexed share follows the publish (${extended.indexedFraction})`);
  check(extended.readout.includes(`/ ${Math.round(wholeClipFrames * 0.6) - 1}+`),
    `the frame count follows the publish (${extended.readout})`);

  // Finished: the marks come off and the numbers are the clip's.
  await page.evaluate(() => window.growingIndexSimulation.complete());
  await page.waitForTimeout(300);
  const complete = await readDisplays();
  check(!complete.readout.includes('+') && !complete.readout.includes('~'),
    `a complete index reports plain totals (${complete.readout})`);
  check(!complete.readoutClasses.includes('index-growing'),
    'the readout comes up to full weight when the index completes');
  check(complete.scrubberMaximum === wholeClipFrames - 1,
    'the scrubber snaps to the true frame count');
  check(Number.parseFloat(complete.indexedFraction) === 100,
    'the whole track is indexed once the pass finishes');
  check(!complete.indexingStatusVisible, 'the indexing badge goes away when the pass finishes');
  check((await page.evaluate(() => window.exactVideoAnnotator.videoInformation)).frameIndexState
    === 'complete', 'videoInformation records the finished index');

  // A truncated index is fatal-flagged but must not be treated as a dead
  // decoder — the engine keeps playing the frames it has.
  const tierBeforeTruncation = await page.evaluate(() => window.exactVideoAnnotator.engine.tier);
  await page.evaluate(() => window.growingIndexSimulation.truncate());
  await page.waitForTimeout(500);
  const truncated = await readDisplays();
  check(truncated.readout.includes('(partial)'),
    `a truncated index is reported as final and short (${truncated.readout})`);
  check(truncated.readoutClasses.includes('index-truncated'),
    'a truncated index takes the warning color');
  check(await page.evaluate(() => window.exactVideoAnnotator.engine.tier) === tierBeforeTruncation,
    'a truncated index does not rebuild the engine on the native tier');
  const toastText = await page.evaluate(() => document.getElementById('toast-container').textContent);
  check(toastText.includes('could be indexed'),
    `the truncation is explained in a toast (${toastText.trim()})`);

  check(pageErrors.length === 0, `no page or console errors (${pageErrors.join(' | ')})`);
} catch (error) {
  console.error(error);
  if (pageErrors.length) console.error(`page errors:\n  ${pageErrors.join('\n  ')}`);
  failures.push(`threw: ${error.message}`);
} finally {
  await browser.close();
  server.kill();
}

if (failures.length) {
  console.error(`\n${failures.length} growing-index check(s) failed.`);
  process.exit(1);
}
console.log('\nAll growing-index checks passed.');
