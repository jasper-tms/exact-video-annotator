---
name: exact-video-annotator-deployment-infrastructure
description: Load when working on how exact-video-annotator (Video Examiner) is built, deployed or hosted, when something works locally but not on the live site, or when you need its live or preview URLs.
---

# Deployment infrastructure

There is no deploy step to run: **Cloudflare Pages** builds and deploys
automatically on every push to GitHub. (The only GitHub workflow,
`.github/workflows/release.yml`, cuts release tags; it does not deploy.)

## Cloudflare Pages project settings

- **Name:** `exact-video-annotator`
- **Build command:** `node build.mjs --dist`
- **Build output directory:** `dist`
- **Production branch:** `main`, with automatic production branch deployments
  enabled
- **Preview branches:** all non-production branches

## URLs

- Production (`main`): https://exact-video-annotator.pages.dev/, also served at
  the custom domain https://examine.video/
- Any other branch: `https://<branch>.exact-video-annotator.pages.dev/`, e.g.
  https://dev.exact-video-annotator.pages.dev/ for `dev`

A new deploy domain must also be added to Firebase's authorized domains, or
Google sign-in fails on it (see the `exact-video-annotator-firebase` skill).

## What the build ships

`build.mjs` (plain Node, so it also runs on Windows) copies an allowlist into
`dist/`: `index.html`, `style.css`, `css/` and `js/`. Anything else in the
repository is not public; to ship a new file or folder, add it to
`DIST_FILES` / `DIST_FOLDERS` in `build.mjs`. It also writes the version stamp
served at `/version` and `/version.json` (see the README's "What is live right
now").

A failed build does not take the site down: Cloudflare keeps the last
successful deploy live.

## Checking whether a push has deployed

The version stamp names the commit being served:

```bash
curl -s https://<branch>.exact-video-annotator.pages.dev/version
```

When its `commit` matches the pushed commit, the deploy is live. A build
usually finishes within a minute or two.

## Local preview

`python http_server.py` runs the same build and serves `dist/` the way
Cloudflare Pages does, rebuilding on each page load. It is kept byte-identical
with copies in other repositories, so ask Jasper before editing it here.
