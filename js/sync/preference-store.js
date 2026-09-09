// The timestamped preference store: the one place a global (cross-application,
// not per-document) preference is read and written, so that every such
// preference can persist two ways at once — the browser's localStorage for the
// signed-out, offline-first case, and the Firebase backend for true
// cross-device persistence when signed in.
//
// The trick that lets the two reconcile is that every value is stored wrapped
// in an envelope carrying WHEN it was last changed:
//
//   { value: <the actual preference value>, updatedAt: <epoch milliseconds> }
//
// On sign-in the sync engine (sync-engine.js) compares the local and cloud
// envelopes for each key and keeps the newer one — last-write-wins, per key.
// While signed in, every local change is stamped and pushed to the cloud, and
// a live listener applies newer changes arriving from other devices.
//
// A preference module (e.g. pixel-grid.js) defines its preference here once and
// then only ever calls get/set/subscribe; it never touches localStorage or
// Firestore itself. Nothing in this file imports Firebase — the cloud side is
// injected by sync-engine.js via registerCloudWriter(), so the store works
// perfectly on its own when signed out or when the backend is unreachable.

/** Every defined preference, keyed by its localStorage key, in definition
    order. The sync engine iterates this to reconcile. */
const preferencesByKey = new Map();

/** Set by the sync engine while signed in: called with (key, envelope) after
    every local write so the change can be mirrored to the cloud. Null when
    signed out, so writes stay purely local. */
let cloudWriter = null;

/** Read and parse the stored envelope for a key, or null when nothing is
    stored. Tolerates the pre-timestamp storage format that earlier versions
    wrote (a bare value, e.g. the string "true" or "prompt"): such a value is
    surfaced with updatedAt 0 so any real cloud timestamp beats it on first
    sign-in, and the next local change re-stamps it into the new format. */
function readEnvelope(key) {
  let raw;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON at all (a legacy bare string like "prompt").
    return { value: raw, updatedAt: 0 };
  }
  // A real envelope is an object carrying a numeric updatedAt. Anything else
  // that happened to parse as JSON (a legacy bare `true`/`false`, or a number)
  // is a legacy value.
  if (parsed && typeof parsed === 'object' && typeof parsed.updatedAt === 'number') {
    return { value: parsed.value, updatedAt: parsed.updatedAt };
  }
  return { value: parsed, updatedAt: 0 };
}

function writeEnvelope(key, envelope) {
  try {
    localStorage.setItem(key, JSON.stringify(envelope));
  } catch {
    /* Storage full or unavailable (private mode): the in-memory cache below
       still keeps the value for this session. */
  }
}

/**
 * Define a global preference. Returns a small handle the owning module exposes
 * through its own named getters/setters.
 *
 * @param {object} options
 * @param {string} options.key           localStorage key; also the Firestore
 *                                        field name. Namespaced, e.g.
 *                                        'exact-video-annotator.pixelGridEnabled'.
 * @param {*}      options.defaultValue   value when nothing valid is stored.
 * @param {(candidate: *) => *} options.coerce
 *        Turn any candidate (a fresh set, a legacy stored value, or a value
 *        arriving from the cloud) into a valid value, falling back to the
 *        default. Must never throw.
 */
export function definePreference({ key, defaultValue, coerce }) {
  if (preferencesByKey.has(key)) {
    throw new Error(`Preference already defined: ${key}`);
  }

  const listeners = new Set();
  // Cached envelope so get() stays synchronous and cheap. Seeded from storage.
  let envelope = readEnvelope(key);

  function currentValue() {
    return coerce(envelope ? envelope.value : defaultValue);
  }

  function notify() {
    const value = currentValue();
    for (const listener of listeners) {
      try { listener(value); } catch { /* a listener must not break others */ }
    }
  }

  const preference = {
    key,
    defaultValue,

    /** The current value, always valid (coerced). Synchronous. */
    get() {
      return currentValue();
    },

    /** The stored envelope, or null when nothing has ever been stored. Used by
        the sync engine to compare timestamps; app code uses get() instead. */
    getEnvelope() {
      return envelope;
    },

    /** Set from local user action: coerce, stamp with now, persist locally,
        mirror to the cloud if signed in, and notify subscribers. */
    set(value) {
      const coerced = coerce(value);
      envelope = { value: coerced, updatedAt: Date.now() };
      writeEnvelope(key, envelope);
      notify();
      if (cloudWriter) cloudWriter(key, envelope);
    },

    /** Apply an envelope decided elsewhere (a reconcile winner, or a live
        update from another device). Persists locally and notifies. When it came
        from the cloud we do NOT write it back — that would just echo. */
    applyEnvelope(incoming, { fromCloud } = {}) {
      envelope = { value: coerce(incoming.value), updatedAt: incoming.updatedAt };
      writeEnvelope(key, envelope);
      notify();
      if (!fromCloud && cloudWriter) cloudWriter(key, envelope);
    },

    /** Subscribe to changes (local or synced). Returns an unsubscribe fn. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  preferencesByKey.set(key, preference);
  return preference;
}

/** All defined preferences, for the sync engine to reconcile. */
export function allPreferences() {
  return [...preferencesByKey.values()];
}

/** The sync engine calls this to route local writes to the cloud (or passes
    null on sign-out to stop). */
export function registerCloudWriter(writer) {
  cloudWriter = writer;
}
