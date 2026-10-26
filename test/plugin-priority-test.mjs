// A plugin from a ?plugin= link wins over an installed plugin with the same id,
// whichever of the two finishes loading first: two copies of one plugin, an
// "installed" one (in the installed list) and a "link" one (in the page's
// ?plugin= parameter), are served with one of them held back, and the link
// copy must be the registered one either way, with a message naming both.
//
// Run:  node test/plugin-priority-test.mjs

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const playwrightPath =
  '/Users/jasper/repos/jasper-tms/exact-video-engine.js/node_modules/playwright/index.mjs';
const { chromium } = await import(playwrightPath);

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const annotatorPort = 8874;
const pluginPort = 8875;
const pluginId = 'test.same-id';

const annotatorServer = spawn('python3', ['-m', 'http.server', String(annotatorPort), '--bind', '127.0.0.1'],
  { cwd: repositoryRoot, stdio: 'ignore' });

// Serves /installed/ and /link/, each a plugin with the same id and its own
// name, holding back each folder's responses by delays[folder] milliseconds.
const delays = { installed: 0, link: 0 };
const pluginServer = createServer((request, response) => {
  const [, folder, file] = new URL(request.url, 'http://localhost').pathname.split('/');
  const name = folder === 'link' ? 'Link copy' : 'Installed copy';
  const files = {
    'plugin.json': ['application/json', JSON.stringify({
      manifestVersion: 1, id: pluginId, name, version: '0.0.0', entry: './index.js', hostApiVersion: 1 })],
    'index.js': ['text/javascript', `export default function createPlugin(host) {
      return { id: '${pluginId}', name: '${name}', layerType: 'coordinates', preferredToolId: 'point',
        createViewLayer: (documentLayer, app) => new host.layers.CoordinatesLayer(documentLayer, app),
        buildSettings: () => document.createElement('div') };
    }`],
  };
  setTimeout(() => {
    if (!(folder in delays) || !(file in files)) {
      response.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': files[file][0], 'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store' });
    response.end(files[file][1]);
  }, delays[folder] ?? 0);
}).listen(pluginPort, 'localhost');
await new Promise((resolve) => setTimeout(resolve, 800));

const failures = [];
function check(condition, description) {
  if (condition) console.log(`  ok: ${description}`);
  else { console.error(`FAIL: ${description}`); failures.push(description); }
}

const installedUrl = `http://localhost:${pluginPort}/installed/`;
const linkUrl = `http://localhost:${pluginPort}/link/`;
const browser = await chromium.launch();

/** Open the app with the installed copy in the installed list (and the link
    copy in ?plugin= when `withLink`), and report which copy is registered once
    both have loaded, and the page's messages. */
async function openApp({ withLink }) {
  const context = await browser.newContext();
  await context.addInitScript(({ installedUrl, linkUrl }) => {
    localStorage.setItem('exact-video-annotator.installedPlugins', JSON.stringify([installedUrl]));
    localStorage.setItem('exact-video-annotator.approvedPluginUrls', JSON.stringify([linkUrl]));
  }, { installedUrl, linkUrl });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  const query = withLink ? `?plugin=${encodeURIComponent(linkUrl)}` : '';
  await page.goto(`http://127.0.0.1:${annotatorPort}/index.html${query}`);
  await page.waitForFunction(() => window.exactVideoAnnotator !== undefined);
  await page.waitForTimeout(Math.max(delays.installed, delays.link) * 2 + 1500);
  const result = await page.evaluate(async (pluginId) => {
    const registry = await import('/js/plugins/registry.js');
    return { name: registry.findPlugin(pluginId)?.name ?? null, url: registry.pluginUrl(pluginId),
      text: document.body.innerText };
  }, pluginId);
  await context.close();
  return { ...result, pageErrors };
}

try {
  for (const [slow, description] of [['installed', 'the installed copy finishes last'],
    ['link', 'the link copy finishes last']]) {
    delays.installed = slow === 'installed' ? 1500 : 0;
    delays.link = slow === 'link' ? 1500 : 0;
    const { name, url, text, pageErrors } = await openApp({ withLink: true });
    check(name === 'Link copy' && url === linkUrl, `the link copy is used when ${description} (got ${name})`);
    check(text.includes('Using the') && text.includes(`localhost:${pluginPort}/link/`)
      && text.includes(`localhost:${pluginPort}/installed/`), `and a message names both copies`);
    check(pageErrors.length === 0, `and there are no page errors (${pageErrors.join('; ')})`);
  }
  delays.installed = 0;
  delays.link = 0;
  const { name, text } = await openApp({ withLink: false });
  check(name === 'Installed copy' && !text.includes('Using the'),
    'without a link the installed copy loads, with no message');
} finally {
  await browser.close();
  annotatorServer.kill();
  pluginServer.close();
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll plugin priority checks passed.');
