// The user's list of "installed" plugins: the URLs (typically GitHub raw URLs)
// they have added so the app can fetch and load those plugins. This is the
// first thing built for the plugin ecosystem — actually fetching and running a
// plugin from its URL comes later; for now the list is simply persisted (and,
// once signed in, synced across devices) via the timestamped preference store.
//
// The whole list is one preference value, so it reconciles by last-write-wins
// on the list as a whole (see preference-store.js). That means two devices each
// adding a different URL while both offline could keep only the later save's
// list; acceptable for now and consistent with every other preference. Order is
// preserved and duplicates are dropped.

import { definePreference } from './preference-store.js';

const preference = definePreference({
  key: 'exact-video-annotator.installedPlugins',
  defaultValue: [],
  coerce(candidate) {
    if (!Array.isArray(candidate)) return [];
    const seen = new Set();
    const urls = [];
    for (const entry of candidate) {
      if (typeof entry !== 'string') continue;
      const url = entry.trim();
      if (url && !seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    }
    return urls;
  },
});

/** The installed plugin URLs, in order. */
export function getInstalledPlugins() {
  return preference.get();
}

/** Replace the whole list (coerced: trimmed, de-duplicated, strings only). */
export function setInstalledPlugins(urls) {
  preference.set(urls);
}

/** Add one URL to the end if not already present. Returns true if it was added,
    false if it was blank or already installed. */
export function addInstalledPlugin(url) {
  const trimmed = typeof url === 'string' ? url.trim() : '';
  if (!trimmed) return false;
  const current = preference.get();
  if (current.includes(trimmed)) return false;
  preference.set([...current, trimmed]);
  return true;
}

/** Remove one URL. Returns true if it was present and removed. */
export function removeInstalledPlugin(url) {
  const current = preference.get();
  if (!current.includes(url)) return false;
  preference.set(current.filter((entry) => entry !== url));
  return true;
}

/** Subscribe to changes (local edits or synced updates from another device).
    Returns an unsubscribe fn. */
export function subscribeInstalledPlugins(listener) {
  return preference.subscribe(listener);
}
