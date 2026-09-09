---
name: exact-video-annotator-firebase
description: Non-obvious console/setup facts for exact-video-annotator (Video Examiner)'s Firebase backend. Load when working on its Google login, settings sync, or Firestore — e.g. deploying its security rules, or sign-in failing on a new domain.
---

# exact-video-annotator Firebase backend: the out-of-code facts

The app has an optional account backend: Google sign-in, plus per-user
settings and an "installed plugins" URL list synced through Firestore. The
code and its comments explain the sync design well (see "Where things live"
below). This skill records only what you CANNOT learn from the code — the
Firebase console / Google Cloud configuration and the deploy workflow.

## The project

- Firebase project id: `exact-video-annotator`.
- Console: https://console.firebase.google.com/project/exact-video-annotator
- The web app config in `js/firebase-config.js` is committed on purpose: a
  Firebase web config (apiKey included) is a public client identifier, not a
  secret. What protects data is the Firestore rules and authorized domains,
  neither of which that config can bypass.

## Firestore database region: eur3 (PERMANENT)

The Firestore database lives in the **`eur3`** multi-region — Europe, made up
of `europe-west1` (Belgium) and `europe-west4` (Netherlands). Chosen to match
the movim-ai project.

A Firestore database's location is fixed at creation and **cannot be changed**
without deleting and recreating the database. If a future feature adds Cloud
Functions with Firestore triggers, they must be deployed to a region inside
eur3 (e.g. `europe-west4`) or they will not be "next to" the database.

## Authentication

- **Only the Google provider is enabled.** Sign-in is a Google popup; there is
  no email/password or other provider.
- **Authorized domains gotcha:** Google sign-in only completes on a domain
  listed under Authentication › Settings › Authorized domains. `localhost` is
  there by default (so test at `http://localhost:...`, NOT `127.0.0.1`, which
  is not authorized). The production/staging domains that must stay listed:
  `examine.video`, `www.examine.video`, `exact-video-annotator.pages.dev`.
  **Any new deploy domain must be added there** or sign-in fails on it with no
  obvious error.

## What is stored (and what is deliberately NOT)

- One document per user at `users/{uid}`, holding a `preferences` map of
  `{ value, updatedAt }` envelopes. That's it.
- **Only preferences and the plugin-URL list are ever stored — never video or
  annotation data.** This is a hard product constraint: the app's promise is
  "no server, no upload." Keep any future backend feature on the right side of
  that line.
- Analytics is intentionally omitted. The raw config Firebase generated
  included a `measurementId` for Google Analytics; it is left out of
  `js/firebase-config.js` on purpose (extra dependency + privacy surface for no
  benefit).

## Deploying the security rules

- `firebase/firestore.rules` is the **source of truth**, not the console. A
  console edit is overwritten by the next deploy — that is intended.
- Deploy from the repo root:
  - `./deploy-firebase-rules.sh --dry-run` — compile-check only, touches
    nothing.
  - `./deploy-firebase-rules.sh` — validate, confirm, deploy. (`--yes` skips
    the prompt.)
- `firebase-tools` is pinned in `firebase/package.json`; run
  `(cd firebase && npm install)` once. `firebase/node_modules` is gitignored,
  so the script falls back to `npx firebase-tools` if it's absent.
- Deploying rules requires the Firestore database to already exist.
- On Node 25 the CLI prints a harmless `EBADENGINE` warning (a dependency wants
  Node 20/22/24). Rules deploy works anyway; suspect the Node version only if
  the CLI misbehaves in other ways.
- This mirrors the deploy setup in `scoreTec/reaction-test` and
  `movim/movim-website` (same `firebase/_deploy_common.sh` lineage).

## Where things live (code — read these rather than re-deriving)

- `js/firebase-config.js` — public config + pinned `FIREBASE_SDK_VERSION`. The
  Firebase SDK is loaded as ES modules from gstatic via lazy dynamic import, so
  the app stays fully functional offline or if the CDN is blocked.
- `js/sync/preference-store.js` — the timestamped `{value, updatedAt}` store;
  the migration path for pre-timestamp localStorage values.
- `js/sync/sync-engine.js` — last-write-wins-per-key reconcile on sign-in and
  the live cross-device listener. Merge is by client `Date.now()`, so severe
  clock skew between devices can pick the "wrong" winner (accepted trade-off).
- `js/sync/firebase.js` — auth + the `users/{uid}` Firestore reads/writes.
- `js/ui/account-control.js` — the top-bar Log in / account menu.
