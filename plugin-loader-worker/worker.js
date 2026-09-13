// Video Examiner — private-plugin loader Worker
// =============================================
//
// A small Cloudflare Worker that lets the public examine.video app load plugins
// from a user's PRIVATE GitHub repositories, using the "Video Examiner" GitHub
// App (App ID 4923976). See plugin-loader-worker/README.md for the dashboard
// setup and the security model; the short version:
//
//   1. /oauth/callback  — finishes the GitHub OAuth user-authorization flow.
//      It exchanges the code (server-side, with the client secret) for a user
//      token, asks GitHub which installations + repositories THIS user may
//      access, mints a short-lived Worker-signed "session token" naming exactly
//      those installation ids, and postMessages it back to the app popup.
//
//   2. /s/<sessionToken>/gh/<installationId>/<owner>/<repo>/<path...>
//      — the file proxy. It verifies the session token, checks the requested
//      installation id is one the token grants, mints a GitHub installation
//      access token (JWT signed with the app private key -> installation token),
//      fetches the file, and returns its raw bytes with a correct Content-Type
//      and CORS so the browser can import() it.
//
// The isolation guarantee: a session token is minted ONLY from installations
// GitHub confirmed the OAuth'd user can access, and the proxy serves ONLY
// installations named in the presented token. So user A's token can never read
// user B's repositories.
//
// Env (Worker settings -> Variables and Secrets):
//   GITHUB_APP_ID            var    e.g. "4923976"
//   GITHUB_APP_CLIENT_ID     var    e.g. "Iv23liF1OCpXVkMmbKTj"
//   GITHUB_APP_CLIENT_SECRET secret (from the app's "Client secrets")
//   GITHUB_APP_PRIVATE_KEY   secret (the .pem contents, PKCS#8 — see README)
//   SESSION_HMAC_SECRET      secret (any long random string; signs session tokens)
//   ALLOWED_ORIGINS          var    comma-separated, e.g.
//                                   "https://examine.video,https://exact-video-annotator.pages.dev,http://localhost:8000"

const GITHUB_API = 'https://api.github.com';
const OAUTH_REDIRECT_PATH = '/oauth/callback';
const SESSION_TTL_SECONDS = 8 * 60 * 60; // 8 hours
const USER_AGENT = 'video-examiner-plugin-loader';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/' || url.pathname === '/health') {
        return new Response('video-examiner plugin loader: ok', { status: 200 });
      }
      if (url.pathname === OAUTH_REDIRECT_PATH) {
        return handleOAuthCallback(request, url, env);
      }
      if (url.pathname.startsWith('/s/')) {
        return handleProxy(request, url, env);
      }
      return new Response('Not found', { status: 404 });
    } catch (error) {
      // Never leak internals; log to the Worker tail for debugging.
      console.error(error && error.stack ? error.stack : String(error));
      return new Response('Internal error', { status: 500 });
    }
  },
};

/* ------------------------------------------------------------------ *
 * OAuth: discover the user's installations and mint a session token.  *
 * ------------------------------------------------------------------ */

async function handleOAuthCallback(request, url, env) {
  const code = url.searchParams.get('code');
  const rawState = url.searchParams.get('state') || '';
  if (!code) return htmlMessage(env, null, { ok: false, error: 'missing_code' }, rawState);

  // state carries the app's origin (so we know where to postMessage) plus a
  // client nonce the app re-checks. Format: base64url(JSON{origin, nonce}).
  let origin = null;
  let nonce = null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64urlDecode(rawState)));
    origin = parsed.origin;
    nonce = parsed.nonce;
  } catch { /* fall through to origin check below */ }

  const allowed = allowedOrigins(env);
  if (!origin || !allowed.includes(origin)) {
    // Can't safely postMessage to an unknown origin; show a plain error page.
    return new Response('Unrecognized or missing origin in OAuth state.', { status: 400 });
  }

  // Exchange the code for a user-to-server access token (needs the client
  // secret, which is why this happens here and never in the browser).
  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({
      client_id: env.GITHUB_APP_CLIENT_ID,
      client_secret: env.GITHUB_APP_CLIENT_SECRET,
      code,
      redirect_uri: url.origin + OAUTH_REDIRECT_PATH,
    }),
  });
  const tokenData = await tokenResponse.json();
  const userToken = tokenData.access_token;
  if (!userToken) {
    return htmlMessage(env, origin, { ok: false, error: 'token_exchange_failed', nonce }, rawState);
  }

  // Ask GitHub which installations of THIS app the user can access, and the
  // repositories inside each. This is the authoritative access check.
  const installationsData = await githubGet('/user/installations', userToken);
  const installations = [];
  for (const installation of installationsData.installations || []) {
    const reposData = await githubGet(`/user/installations/${installation.id}/repositories`, userToken);
    installations.push({
      id: installation.id,
      account: installation.account ? installation.account.login : null,
      repositories: (reposData.repositories || []).map((repo) => ({
        full_name: repo.full_name,
        owner: repo.owner ? repo.owner.login : null,
        name: repo.name,
        private: repo.private,
        default_branch: repo.default_branch,
      })),
    });
  }

  const sessionToken = await mintSessionToken(installations.map((i) => i.id), env);
  return htmlMessage(env, origin, { ok: true, nonce, sessionToken, installations }, rawState);
}

/** Returns a tiny HTML page that hands the result back to the opener window and
    closes the popup. The message is posted only to the validated app origin. */
function htmlMessage(env, origin, payload, rawState) {
  const target = origin || '*';
  const body = JSON.stringify({ type: 'video-examiner-github', ...payload });
  const html = `<!doctype html><meta charset="utf-8"><title>Video Examiner</title>
<body><p>Finishing GitHub connection… you can close this window.</p>
<script>
  try { window.opener && window.opener.postMessage(${body}, ${JSON.stringify(target)}); } catch (e) {}
  window.close();
</script></body>`;
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

/* ------------------------------------------------------------------ *
 * Proxy: serve one file from a private repo, gated by a session token.*
 * ------------------------------------------------------------------ */

async function handleProxy(request, url, env) {
  if (request.method === 'OPTIONS') return corsPreflight(request, env);

  // /s/<sessionToken>/gh/<installationId>/<owner>/<repo>/<path...>
  const parts = url.pathname.split('/').filter(Boolean); // drops empty segments
  if (parts.length < 6 || parts[0] !== 's' || parts[2] !== 'gh') {
    return new Response('Bad plugin path', { status: 400 });
  }
  const sessionToken = decodeURIComponent(parts[1]);
  const installationId = parts[3];
  const owner = parts[4];
  const repo = parts[5];
  const filePath = parts.slice(6).map(decodeURIComponent).join('/');
  if (!filePath) return new Response('Missing file path', { status: 400 });

  const grantedInstallations = await verifySessionToken(sessionToken, env);
  if (!grantedInstallations) return withCors(request, env, new Response('Session expired', { status: 401 }));
  if (!grantedInstallations.includes(Number(installationId))) {
    return withCors(request, env, new Response('Installation not authorized', { status: 403 }));
  }

  const installationToken = await getInstallationToken(installationId, env);
  const ref = url.searchParams.get('ref'); // optional branch/tag/sha
  const contentsUrl = `${GITHUB_API}/repos/${owner}/${repo}/contents/${filePath}`
    + (ref ? `?ref=${encodeURIComponent(ref)}` : '');
  const fileResponse = await fetch(contentsUrl, {
    headers: {
      'Authorization': `Bearer ${installationToken}`,
      'Accept': 'application/vnd.github.raw', // raw bytes, not base64 JSON
      'User-Agent': USER_AGENT,
    },
  });
  if (!fileResponse.ok) {
    return withCors(request, env, new Response(`GitHub ${fileResponse.status}`, { status: fileResponse.status }));
  }

  const bytes = await fileResponse.arrayBuffer();
  const headers = new Headers();
  headers.set('Content-Type', contentTypeFor(filePath));
  headers.set('Cache-Control', 'no-store');
  return withCors(request, env, new Response(bytes, { status: 200, headers }));
}

/* ------------------------------------------------------------------ *
 * GitHub App auth: app JWT -> installation access token (cached).     *
 * ------------------------------------------------------------------ */

const installationTokenCache = new Map(); // installationId -> { token, expiresAt(ms) }

async function getInstallationToken(installationId, env) {
  const cached = installationTokenCache.get(installationId);
  if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token;

  const appJwt = await makeAppJwt(env);
  const response = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${appJwt}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
    },
  });
  if (!response.ok) throw new Error(`installation token: GitHub ${response.status}`);
  const data = await response.json();
  installationTokenCache.set(installationId, {
    token: data.token,
    expiresAt: new Date(data.expires_at).getTime(),
  });
  return data.token;
}

/** A ~9-minute app JWT (RS256) identifying the GitHub App by its App ID. */
async function makeAppJwt(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat: now - 30, exp: now + 9 * 60, iss: env.GITHUB_APP_ID };
  const signingInput = `${base64urlJson(header)}.${base64urlJson(payload)}`;
  const key = await importPrivateKey(env.GITHUB_APP_PRIVATE_KEY);
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' }, key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64urlBytes(new Uint8Array(signature))}`;
}

let cachedPrivateKey = null;
async function importPrivateKey(pem) {
  if (cachedPrivateKey) return cachedPrivateKey;
  // Expects a PKCS#8 key ("BEGIN PRIVATE KEY"). GitHub issues PKCS#1
  // ("BEGIN RSA PRIVATE KEY"); convert it once with openssl — see README.
  const der = pemToDer(pem);
  cachedPrivateKey = await crypto.subtle.importKey(
    'pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  return cachedPrivateKey;
}

/* ------------------------------------------------------------------ *
 * Session tokens: Worker-signed capability naming installation ids.  *
 * ------------------------------------------------------------------ */

async function mintSessionToken(installationIds, env) {
  const payload = { inst: installationIds, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS };
  const encoded = base64urlJson(payload);
  const signature = await hmac(encoded, env.SESSION_HMAC_SECRET);
  return `${encoded}.${signature}`;
}

/** Returns the granted installation ids (numbers) if valid and unexpired, else null. */
async function verifySessionToken(token, env) {
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = await hmac(encoded, env.SESSION_HMAC_SECRET);
  if (!timingSafeEqual(signature, expected)) return null;
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(base64urlDecode(encoded))); } catch { return null; }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return Array.isArray(payload.inst) ? payload.inst.map(Number) : null;
}

async function hmac(message, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return base64urlBytes(new Uint8Array(sig));
}

/* ------------------------------------------------------------------ *
 * Small helpers.                                                      *
 * ------------------------------------------------------------------ */

async function githubGet(path, userToken) {
  const response = await fetch(`${GITHUB_API}${path}?per_page=100`, {
    headers: {
      'Authorization': `Bearer ${userToken}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
    },
  });
  if (!response.ok) throw new Error(`GitHub GET ${path}: ${response.status}`);
  return response.json();
}

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function withCors(request, env, response) {
  const origin = request.headers.get('Origin');
  if (origin && allowedOrigins(env).includes(origin)) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Vary', 'Origin');
  }
  return response;
}

function corsPreflight(request, env) {
  const response = new Response(null, { status: 204 });
  return withCors(request, env, response);
}

function contentTypeFor(path) {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const map = {
    js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8', css: 'text/css; charset=utf-8',
    html: 'text/html; charset=utf-8', svg: 'image/svg+xml', png: 'image/png',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    wasm: 'application/wasm', txt: 'text/plain; charset=utf-8', map: 'application/json',
  };
  return map[ext] || 'application/octet-stream';
}

/* --- base64url + PEM --- */

function base64urlJson(obj) { return base64urlBytes(new TextEncoder().encode(JSON.stringify(obj))); }

function base64urlBytes(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function pemToDer(pem) {
  const base64 = pem.replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '').replace(/\s+/g, '');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
