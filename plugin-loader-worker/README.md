# Video Examiner — private-plugin loader Worker

A Cloudflare Worker that lets the public examine.video app load plugins from a
user's **private** GitHub repositories, using the "Video Examiner" GitHub App.
`worker.js` is the whole backend; this file is the click-through setup for the
Cloudflare dashboard (no `wrangler`). The architecture and security model live
in the `github-app-integration-for-private-plugin-access` agent skill.

## What it does

- `GET /oauth/callback` — finishes GitHub OAuth: exchanges the code (with the
  client secret) for a user token, asks GitHub which installations +
  repositories the user may access, mints a short-lived Worker-signed **session
  token** naming exactly those installation ids, and `postMessage`s it to the
  app popup.
- `GET /s/<sessionToken>/gh/<installationId>/<owner>/<repo>/<path...>` — the
  file proxy: verifies the session token, checks the installation is granted,
  mints a GitHub installation token from the app private key, and returns the
  file's raw bytes with the right `Content-Type` + CORS so the browser can
  `import()` it. Relative imports keep the `/s/<token>/` prefix, so multi-file
  plugins resolve their siblings.

**Isolation:** a session token is minted only from installations GitHub
confirmed the OAuth'd user can access, and the proxy serves only installations
named in the presented token — so one user's token can never read another
user's repos.

## One-time key conversion (do this first)

WebCrypto needs a **PKCS#8** private key; GitHub issues **PKCS#1**. Convert the
`.pem` you downloaded once (on the Pi, or wherever it lives):

```
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
  -in video-examiner.2026-09-13.private-key.pem \
  -out video-examiner.pkcs8.pem
```

The converted file starts with `-----BEGIN PRIVATE KEY-----` (not `BEGIN RSA
PRIVATE KEY`). You'll paste its full contents into the `GITHUB_APP_PRIVATE_KEY`
secret. Keep both files out of any git repo.

## Create the Worker in the dashboard

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Create Worker**.
   Name it e.g. `video-examiner-plugin-loader`. Deploy the placeholder.
2. **Edit code** → replace the sample with the contents of `worker.js` → **Deploy**.

## Set variables and secrets

Worker → **Settings** tab → **Runtime variables and secrets** section →
**Add variable**. The dialog gives Key/Value rows each with a **Secret** toggle
on the right; **+ Add** stacks another row; **Add N variables and deploy** saves
them all and redeploys. Leave the Secret toggle **off** for the plain variables
and **on** for the secrets. All six can go in one dialog.

Plain variables (Secret toggle off):
- `GITHUB_APP_ID` = `4923976`
- `GITHUB_APP_CLIENT_ID` = `Iv23liF1OCpXVkMmbKTj`
- `ALLOWED_ORIGINS` = `https://examine.video,https://www.examine.video,https://exact-video-annotator.pages.dev,http://localhost:8000,http://127.0.0.1:8000`
  (comma-separated, no trailing slashes: an entry is an `Origin` header value,
  scheme + host + port only.)

Secrets (Secret toggle on — hidden after saving):
- `GITHUB_APP_CLIENT_SECRET` = generate on the app's **General** page
  (https://github.com/settings/apps/video-examiner) → *Client secrets* →
  **Generate a new client secret**, then paste it here immediately (shown once).
- `GITHUB_APP_PRIVATE_KEY` = the full contents of `video-examiner.pkcs8.pem`,
  including the BEGIN/END lines. A multi-line paste is fine — the Worker strips
  whitespace and the BEGIN/END markers when it parses the key.
- `SESSION_HMAC_SECRET` = any long random string (e.g. `openssl rand -hex 32`).

## Which secrets to keep afterward

Cloudflare hides secret values after saving, so a retained copy is only for
re-provisioning. Keep only the GitHub-issued `.pem` (on the Pi):

- `SESSION_HMAC_SECRET` — the Worker both signs and verifies session tokens with
  it, so nothing outside the Worker needs it. If lost, generate a new one;
  outstanding session tokens stop verifying and users re-run the OAuth popup
  once (same effect as the 8-hour expiry). Nothing to keep.
- `GITHUB_APP_CLIENT_SECRET` — regenerate on the app's General page if needed
  (GitHub allows multiple, revoke the old). No copy required.
- `GITHUB_APP_PRIVATE_KEY` — re-derive by re-running the `openssl pkcs8` command
  against the Pi's `.pem`; delete the intermediate `video-examiner.pkcs8.pem`.

## Custom domain

Worker → **Domains** tab → **Custom Domains and Routes** → **Add Domain** (not
Add Route). In the "Connect domain" dialog, click **examine.video** in the zone
list (don't type the full hostname into the search box). On the "Connect to
examine.video" screen, type `plugins` in the **Subdomain** field → **Add
domain**. The row then reads `plugins.examine.video`, Type Production, Zone
examine.video. The GitHub App's OAuth callback points at
`https://plugins.examine.video/oauth/callback`, so the subdomain must be
`plugins`.

The Domains tab also shows the Worker's own `*.workers.dev` URL (e.g.
`video-examiner-plugin-loader.jasper-s-phelps.workers.dev`). To exercise the
flow against that before the custom domain resolves, add it as a second
**Redirect URI** on the GitHub App and a second `ALLOWED_ORIGINS` entry.

## Test

- `https://plugins.examine.video/health` → `video-examiner plugin loader: ok`.
- Full flow is exercised from the app (the "Add plugin from private GitHub
  repository" button). To watch server logs while testing, open the Worker →
  **Logs** (real-time) — the Worker `console.error`s failures there.

## Redeploying after an edit

Edit `worker.js` here, then paste it into the dashboard editor and **Deploy**
again. (There is intentionally no `wrangler` deploy in this setup.)
