---
name: github-app-integration-for-private-plugin-access
description: How the public exact-video-annotator (Video Examiner) app loads plugins from PRIVATE GitHub repos via a GitHub App plus a small token-minting/proxy backend. Load when working on private plugin hosting, the Video Examiner GitHub App, GitHub installation tokens, or the plugin-loader auth backend.
---

# Loading plugins from private GitHub repos

The exact-video-annotator (public app, deployed at examine.video) loads plugins
from a URL to a plugin folder in a git repo. Public plugin repos are served
straight off a CDN. This skill covers the harder case: serving plugins from a
**private** repo (proprietary company plugins) to the public browser app.

## Why a GitHub App plus a backend is required

A private repo's files need an access token, and two hard browser constraints
force the shape of the solution:

- A public browser app cannot hold any long-lived secret (token or key) —
  anyone can read it out of the shipped code.
- Public CDNs don't serve private repos (`cdn.jsdelivr.net/gh/...` 404s), and
  the GitHub Contents API returns base64 JSON, not an importable ES module.

A **GitHub App** is the right primitive: the repo owner installs it and grants
it specific repos, revocable anytime — exactly the "select which repositories
to share" flow. But a GitHub App authenticates by signing a JWT with its
**private key** to mint short-lived (1-hour) installation access tokens, and
GitHub's token endpoints send no CORS headers. So the App cannot run purely
client-side; it needs a **small backend** that holds the private key.

Net: the backend is unavoidable for private access, but it is tiny — hold the
key, mint a token, serve repo files to the browser.

## The GitHub App: "Video Examiner"

Owned by the `jasper-tms` account. Public page:
https://github.com/apps/video-examiner. Settings:
https://github.com/settings/apps/video-examiner.

- **App ID:** 4923976 (not secret; the backend signs the app JWT with it).
- **Client ID:** `Iv23liF1OCpXVkMmbKTj` (public; used by the OAuth flow that
  discovers a user's installations).

Configuration (github.com/settings/apps/video-examiner):

- **Homepage URL:** https://examine.video
- **Identifying and authorizing users → Callback (Redirect) URI:**
  `https://plugins.examine.video/oauth/callback`, and **"Request user
  authorization (OAuth) during installation" is checked** (so installing also
  authorizes, in one step). The OAuth flow is how the app discovers which
  installations/repos a user may access; setting a callback makes the "Setup
  URL" field greyed out, which is expected.
- **Webhook → Active: unchecked.** Nothing reacts to events, and leaving it on
  makes a Webhook URL mandatory.
- **Permissions → Repository → Contents: Read-only** (the only granted
  permission; reads file contents). GitHub also force-adds **Metadata:
  Read-only**. Everything else: No access.
- **Where can this GitHub App be installed? → Any account.** Lets the owner
  install it on `jasper-tms` for company plugins AND lets other users install
  it on their own accounts for their own private plugin repos.

Two secrets the backend needs, generated on the app's General page and never
committed: the **client secret** (*Client secrets → Generate a new client
secret*) and the **private key** `.pem` (*Private keys → Generate a private
key*). The private key is issued as PKCS#1 and must be converted to PKCS#8 for
WebCrypto (see the worker README).

## Two consumption models (the same App serves both)

- **Model B — company proprietary (primary):** the owner installs the App once
  on `jasper-tms`, granting it the plugins repo. The backend serves those
  plugins to Video Examiner users who pass the app's own authorization.
- **Model A — bring-your-own-repo:** any user installs the App on their own
  account and picks their private plugin repos (the literal "select repos"
  screen); the backend mints per-installation tokens.

## The backend: a Cloudflare Worker at `plugins.examine.video`

Chosen over a Raspberry Pi because the OAuth callback + proxy need a stable
public HTTPS origin, which a Worker gives for free on the same Cloudflare
account as examine.video. It is deployed BY HAND through the Cloudflare
dashboard (no `wrangler`); `plugin-loader-worker/worker.js` is the whole
backend and `plugin-loader-worker/README.md` is the click-through setup +
required variables/secrets. Two routes:

1. **`GET /oauth/callback`** — finishes GitHub OAuth: exchanges the code (with
   the client secret) for a user token, calls `/user/installations` +
   `/user/installations/{id}/repositories` to learn what the user may access,
   mints a short-lived **session token**, and `postMessage`s it back to the app
   popup.
2. **`GET /s/<sessionToken>/gh/<installationId>/<owner>/<repo>/<path...>`** — the
   file proxy: verifies the session token, checks the installation is granted,
   mints a GitHub installation token (app JWT → `POST /app/installations/{id}/
   access_tokens`, cached ~1h), and returns the file's raw bytes (Contents API
   with `Accept: application/vnd.github.raw`) with the right `Content-Type` +
   CORS. The token sits in the PATH (not a query) so a plugin's relative imports
   keep the `/s/<token>/` prefix and multi-file plugins resolve their siblings.

**Isolation (the core guarantee):** the session token is a Worker-signed
(HMAC) capability naming exactly the installation ids GitHub confirmed the
OAuth'd user can access; the proxy serves only installations named in the
presented token. So one user's token can never read another user's repos —
isolation is structural, not dependent on any database lookup.

**Firebase's role:** users are already signed in with Google (Firebase Auth),
and the app already syncs a per-user "installed plugins" URL list in Firestore
(`users/{uid}`). A chosen private plugin becomes a canonical (tokenless) URL
`https://plugins.examine.video/gh/<installationId>/<owner>/<repo>/<folder>/`
stored in that existing list; at load time the client swaps in a fresh
`/s/<token>/` prefix. Firestore records connection info (installations/repos
for the picker) but is NOT the security boundary, so no new Firestore rules or
service account are needed for v1.

**Known v1 limitation:** the session token expires (8h); getting a fresh one
re-runs the OAuth popup (fast, since GitHub auto-approves an already-authorized
app). Making it silent — the plugins list loading already-authorized on every
visit — is the planned v2 (see "Future: permanent authorization"), not built.

## Where the code lives

- `plugin-loader-worker/worker.js` — the Worker (OAuth callback + proxy).
- `plugin-loader-worker/README.md` — dashboard setup, variables/secrets, the
  one-time PKCS#1→PKCS#8 key conversion.
- `js/plugins/private-github-loader.js` — the client helper
  (`connectPrivateGitHub()`, `authorizedPluginBaseUrl()`, `canonicalPluginUrl()`).
- `js/ui/settings-modal.js` — the Settings modal's Plugins section, where the
  "Add from private GitHub repository…" button drives the helper: connect →
  list the shared repos → store each chosen repo's canonical tokenless URL in
  the installed-plugins list. (Fetching/running a plugin from a stored URL is
  still unwired for every plugin, private or public.)

## Related

- The plugin repo for these sport plugins:
  github.com/jasper-tms/exact-video-annotator-sport-plugins (private).
- The plugin contract the loaded folder must satisfy (manifest, host-API
  injection, URL persistence) is specified in the movim repo's
  `plan_court-keypoint-correspondence-annotator.md`, Part 1.

## Future: permanent authorization (v2)

Goal: once a user has installed the app on their GitHub account, their private
plugins load already-authorized on every signed-in visit to examine.video — no
8-hour re-popup.

The popup today is only for *discovery* — confirming which installations a user
may see. File serving already uses the app private key + installation id
(server-to-server), not the user's GitHub token. So permanence needs only a
durable, trustworthy record of `firebaseUid → [installation ids]`:

- At connect time the app passes the user's **Firebase ID token** (a JWT) in the
  OAuth `state`; the Worker verifies it against Google's public keys (RS256 —
  the same primitive it already uses to sign the app JWT) and persists the
  verified `uid → [installation ids]`. **Cloudflare KV** is the light store (a
  Worker binding, no new secret; Firestore-from-Worker would need a
  service-account key).
- On later visits the app hands the Worker the Firebase ID token; the Worker
  verifies it, looks up the installations, and mints a fresh session token
  silently. The localStorage token becomes a cache, re-fetched on expiry rather
  than re-popping GitHub.
- Revocation is automatic: uninstalling the app on GitHub makes the
  installation-token mint fail, so access dies. An uninstall webhook could prune
  the store but is not required for safety.

Consequences:

- The stored `uid → installations` map becomes the load-bearing isolation
  boundary (v1 isolation is purely token-structural) — the original "one user's
  integration never exposes their repos to another" requirement coming into
  play.
- The private-GitHub path becomes **login-gated**: no `uid` to key on until the
  user is signed in, so gating falls out of the design rather than being a
  separate decision. Public URL plugins can stay offline-first and ungated.

Additive: no rework of the v1 Worker, proxy, or client helper.

## Status

- [x] GitHub App "Video Examiner" created (App ID 4923976), OAuth callback +
      user-authorization-during-installation configured.
- [x] Worker code + client helper written (see "Where the code lives").
- [x] Client secret generated, private key converted to PKCS#8, and both stored
      (with `SESSION_HMAC_SECRET`) as Worker secrets.
- [x] Worker `video-examiner-plugin-loader` created in the dashboard,
      variables/secrets set, `plugins.examine.video` custom domain connected.
      `https://plugins.examine.video/health` returns
      `video-examiner plugin loader: ok`. (Setup steps: the worker README.)
- [x] Wire the helper into the Settings modal's Plugins section ("Add from
      private GitHub repository…": connect → pick repos → store canonical URL).
- [ ] Install the App (done interactively per user, or self-serve via the app),
      which also first exercises the OAuth + proxy path end to end.
- [ ] Wire actual fetching/running of a plugin from its stored URL (unbuilt for
      every plugin, private or public), and confirm `.pem`/client-secret never
      enter any repo or bundle.
- [ ] v2: permanent authorization (see the section above) — silent re-mint via a
      verified Firebase ID token + a `uid → installations` store.
