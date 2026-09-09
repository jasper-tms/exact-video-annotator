// What to do when a second piece of media — a video OR an image — is loaded
// while exactly one is already open: 'prompt' (ask each time), 'replace' (swap
// out the current one, of either kind), or 'new-layer' (stack it as another
// layer). With nothing open, the first media simply loads; with two or more
// already open, every further one always makes a new layer regardless of this
// setting (there is no single one to "replace"), so this preference only
// governs the one-open case.
//
// A global preference, not per-document, so it is persisted through the shared
// preference store (localStorage, and the Firebase backend when signed in),
// alongside the other cross-application settings.

import { definePreference } from './sync/preference-store.js';

export const SECOND_MEDIA_BEHAVIORS = ['prompt', 'replace', 'new-layer'];
const DEFAULT_BEHAVIOR = 'prompt';

const STORAGE_KEY = 'exact-video-annotator.secondMediaBehavior';
// The pre-rename key, back when this governed a second VIDEO only. The
// preference store keys off the exact string, so carry a value saved under the
// old key over to the new one once (as a legacy bare value the store re-stamps
// on the next write). Signed-in cloud values under the old key are not migrated
// here — the default is the safe 'prompt', so an unmigrated account just falls
// back to being asked. Local-only, best-effort.
const LEGACY_STORAGE_KEY = 'exact-video-annotator.secondVideoBehavior';
try {
  if (localStorage.getItem(STORAGE_KEY) === null) {
    const legacyValue = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacyValue !== null) localStorage.setItem(STORAGE_KEY, legacyValue);
  }
} catch { /* ignore */ }

const preference = definePreference({
  key: STORAGE_KEY,
  defaultValue: DEFAULT_BEHAVIOR,
  coerce: (value) => (SECOND_MEDIA_BEHAVIORS.includes(value) ? value : DEFAULT_BEHAVIOR),
});

export function getSecondMediaBehavior() {
  return preference.get();
}

export function setSecondMediaBehavior(behavior) {
  if (!SECOND_MEDIA_BEHAVIORS.includes(behavior)) return;
  preference.set(behavior);
}
