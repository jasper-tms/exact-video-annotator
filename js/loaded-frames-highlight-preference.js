// Whether to shade the transport scrubber where frames are currently held
// decoded in the engine's cache — the loaded (instantly seekable) range, drawn
// the way a video player shows its buffered range (see js/ui/transport.js).
// Off by default: it is a diagnostic overlay most viewers do not need, and it
// only means anything on the WebCodecs tier, which has an addressable frame
// cache. The preference is global (not per-document), so it is persisted
// through the shared preference store (localStorage, and the Firebase backend
// when signed in) alongside the other cross-application settings.

import { definePreference } from './sync/preference-store.js';
import { coerceBoolean } from './sync/coerce-boolean.js';

// Persisted (and synced when signed in) through the shared timestamped
// preference store; the storage key is unchanged so earlier values migrate.
// Off by default. The coerce accepts both a real boolean (the new format and
// synced values) and the "true"/"false" string an earlier version wrote.
const preference = definePreference({
  key: 'exact-video-annotator.loadedFramesHighlightEnabled',
  defaultValue: false,
  coerce: (value) => coerceBoolean(value, false),
});

export function isLoadedFramesHighlightEnabled() {
  return preference.get();
}

export function setLoadedFramesHighlightEnabled(enabled) {
  preference.set(Boolean(enabled));
}
