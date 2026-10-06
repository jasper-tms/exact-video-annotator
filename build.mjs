#!/usr/bin/env node
// Cloudflare Pages build: there is no compile step; stage the static app in
// dist/ and write the version stamp served at /version.
//
// Usage:
//   node build.mjs --dist    stage the deploy into dist/ (what Cloudflare Pages
//                            and http_server.py run)
//
// Staging dist/ is this build's only job, so it happens with or without
// --dist; the flag is accepted so every repository's build is invoked the same
// way by the shared http_server.py.
//
// Written in plain Node with no shell commands, so the build works the same on
// Windows (PowerShell, Command Prompt) as on macOS and Linux.

import { readFile, writeFile, cp, mkdir, rm, readdir } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repositoryRoot = dirname(fileURLToPath(import.meta.url));
const dist = join(repositoryRoot, 'dist');

// The deploy allowlist: exactly what goes into dist/, which Cloudflare Pages
// serves. A new stray file in the repository will NOT leak onto the site
// unless it is added here on purpose.
const DIST_FILES = ['index.html', 'style.css'];
const DIST_FOLDERS = ['css', 'js'];

// Retries ride out Windows briefly locking a file (e.g. an antivirus scan).
await rm(dist, { recursive: true, force: true, maxRetries: 5 });
await mkdir(dist, { recursive: true });
for (const file of DIST_FILES) {
  await cp(join(repositoryRoot, file), join(dist, file));
}
for (const folder of DIST_FOLDERS) {
  await cp(join(repositoryRoot, folder), join(dist, folder), { recursive: true });
}

// ---------- Version stamp ----------
// The deployed app is static, so "what is live right now" has to be baked in at
// build time and served as a file. Cloudflare Pages exports CF_PAGES_* for the
// commit it is building; prefer those, since its checkout is shallow and may
// carry no tags or branch name. Every lookup degrades to "unknown" rather than
// failing the build — a missing version stamp must never cost us a deploy.

const repositoryUrl = 'https://github.com/jasper-tms/exact-video-annotator';

function readGit(command) {
  try {
    return execSync(command, { cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

async function readTextOrEmpty(file) {
  try {
    return await readFile(join(repositoryRoot, file), 'utf8');
  } catch {
    return '';
  }
}

const commit = process.env.CF_PAGES_COMMIT_SHA || readGit('git rev-parse HEAD');
const branch = process.env.CF_PAGES_BRANCH || readGit('git rev-parse --abbrev-ref HEAD');

// The VERSION file, not `git describe`: VERSION is checked in, so it survives
// the shallow tagless clone a host builds from, and it is the same value the
// release workflow cuts the vX.Y.Z tag from. Bare, with no leading "v".
const annotatorVersion = (await readTextOrEmpty('VERSION')).replace(/\s/g, '');

// Read the engine pin out of index.html so this stays a single source of truth:
// the whole point of the stamp is telling which engine the live app is running.
// The pin names a tag, so it carries a leading "v"; strip it so both versions in
// the stamp read the same way.
const enginePin = /exact-video-engine\.js@v?([^/]*)\/exact-video-engine\.js/
  .exec(await readTextOrEmpty('index.html'));

// Second precision, like `date -u '+%Y-%m-%dT%H:%M:%SZ'`.
const buildTimestamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

const stamp = {
  annotatorVersion: annotatorVersion || 'unknown',
  commit: commit || 'unknown',
  commitUrl: commit ? `${repositoryUrl}/commit/${commit}` : 'unknown',
  branch: branch || 'unknown',
  buildTimestamp,
  videoEngineVersion: (enginePin && enginePin[1]) || 'unknown',
};
const stampJson = JSON.stringify(stamp, null, 2) + '\n';

// Serve the same bytes at the extensionless /version too, so either URL works.
await writeFile(join(dist, 'version.json'), stampJson);
await writeFile(join(dist, 'version'), stampJson);

// Extensionless files are not served as JSON by default, and a version stamp
// that can be answered from cache defeats its own purpose.
await writeFile(join(dist, '_headers'), `/version
  Content-Type: application/json; charset=utf-8
  Cache-Control: no-store

/version.json
  Cache-Control: no-store
`);

async function countFiles(folder) {
  let count = 0;
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    count += entry.isDirectory() ? await countFiles(join(folder, entry.name)) : 1;
  }
  return count;
}

console.log(`Staged ${await countFiles(dist)} files into dist/`);
console.log(`Version stamp: ${stamp.annotatorVersion} (engine ${stamp.videoEngineVersion}) built ${buildTimestamp}`);
