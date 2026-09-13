// Private-GitHub plugin loading (client side)
// ===========================================
//
// Talks to the plugin-loader Worker (see plugin-loader-worker/) so the app can
// load plugins from a user's PRIVATE GitHub repositories via the "Video
// Examiner" GitHub App.
//
// This module is deliberately self-contained: it does NOT import the plugin
// registry or any in-flux plugin-add UI. It provides the pieces the button
// wiring will call once that UI settles:
//
//   connectPrivateGitHub()        -> opens the OAuth popup, returns the user's
//                                    installations+repos, stores a session token
//   hasSession() / clearSession() -> session-token state
//   authorizedPluginBaseUrl(...)  -> a /s/<token>/gh/... URL to import from
//   installUrl                    -> where to send a user who hasn't installed
//
// The session token is a short-lived, Worker-signed capability naming exactly
// the installation ids GitHub confirmed this user can access. It is stored in
// localStorage so a page reload can keep loading already-added private plugins
// until it expires; when it does, call connectPrivateGitHub() again (GitHub
// auto-approves an already-authorized app, so the popup returns quickly).

const WORKER_BASE = 'https://plugins.examine.video';
const CLIENT_ID = 'Iv23liF1OCpXVkMmbKTj';
const APP_SLUG = 'video-examiner';
const SESSION_STORAGE_KEY = 'videoExaminer.githubSessionToken';

export const installUrl = `https://github.com/apps/${APP_SLUG}/installations/new`;

/** The current session token, or null. */
export function getSessionToken() {
  try { return localStorage.getItem(SESSION_STORAGE_KEY); } catch { return null; }
}

export function hasSession() { return Boolean(getSessionToken()); }

export function clearSession() {
  try { localStorage.removeItem(SESSION_STORAGE_KEY); } catch { /* ignore */ }
}

function setSessionToken(token) {
  try { localStorage.setItem(SESSION_STORAGE_KEY, token); } catch { /* ignore */ }
}

/**
 * Open the GitHub OAuth popup and resolve once the Worker reports back.
 *
 * Resolves to { installations } where each installation is
 * { id, account, repositories: [{ full_name, owner, name, private, default_branch }] }.
 * An empty installations array means the user authorized but hasn't installed
 * the app on any repos yet — send them to `installUrl`.
 *
 * Rejects if the popup is blocked, the user closes it, or the Worker errors.
 */
export function connectPrivateGitHub() {
  return new Promise((resolve, reject) => {
    const nonce = crypto.randomUUID();
    const state = base64urlJson({ origin: window.location.origin, nonce });
    const authorizeUrl = 'https://github.com/login/oauth/authorize'
      + `?client_id=${encodeURIComponent(CLIENT_ID)}`
      + `&redirect_uri=${encodeURIComponent(WORKER_BASE + '/oauth/callback')}`
      + `&state=${encodeURIComponent(state)}`;

    const popup = window.open(authorizeUrl, 'video-examiner-github', 'width=720,height=800');
    if (!popup) { reject(new Error('Popup blocked. Allow popups for examine.video and retry.')); return; }

    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      clearInterval(closedPoll);
      fn(arg);
    };

    function onMessage(event) {
      if (event.origin !== WORKER_BASE) return;
      const data = event.data;
      if (!data || data.type !== 'video-examiner-github') return;
      if (data.nonce !== nonce) return; // CSRF: must match the state we sent
      try { popup.close(); } catch { /* ignore */ }
      if (!data.ok) { finish(reject, new Error(`GitHub connection failed: ${data.error || 'unknown'}`)); return; }
      setSessionToken(data.sessionToken);
      finish(resolve, { installations: data.installations || [] });
    }

    window.addEventListener('message', onMessage);
    // Detect the user closing the popup without finishing.
    const closedPoll = setInterval(() => {
      if (popup.closed) finish(reject, new Error('GitHub connection cancelled.'));
    }, 500);
  });
}

/**
 * Build the base URL to import a private plugin from, given the canonical
 * (tokenless) coordinates. Requires a live session (call connectPrivateGitHub
 * first). Returns e.g.
 *   https://plugins.examine.video/s/<token>/gh/<installationId>/<owner>/<repo>/<folder>/
 * Relative imports inside the plugin keep the /s/<token>/ prefix, so multi-file
 * plugins resolve their siblings.
 */
export function authorizedPluginBaseUrl({ installationId, owner, repo, folder = '' }) {
  const token = getSessionToken();
  if (!token) throw new Error('Not connected to GitHub. Call connectPrivateGitHub() first.');
  return `${WORKER_BASE}/s/${encodeURIComponent(token)}/${pluginPath({ installationId, owner, repo, folder })}`;
}

/**
 * The canonical, tokenless URL stored in the user's installed-plugins list for a
 * private-repo plugin, e.g.
 *   https://plugins.examine.video/gh/<installationId>/<owner>/<repo>/<folder>/
 * At load time the app swaps in a fresh `/s/<token>/` prefix (see
 * authorizedPluginBaseUrl) so the stored list never holds a short-lived token.
 */
export function canonicalPluginUrl({ installationId, owner, repo, folder = '' }) {
  return `${WORKER_BASE}/${pluginPath({ installationId, owner, repo, folder })}`;
}

function pluginPath({ installationId, owner, repo, folder = '' }) {
  const clean = folder.replace(/^\/+|\/+$/g, '');
  const tail = clean ? `${clean}/` : '';
  return `gh/${installationId}/${owner}/${repo}/${tail}`;
}

function base64urlJson(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
