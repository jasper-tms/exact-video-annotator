// What to do when a second video is loaded while exactly one video is already
// open — 'prompt' (ask each time), 'replace' (swap out the current video), or
// 'new-layer' (stack it as another layer). With no video open, the first video
// simply loads; with two or more already open, every further video always
// makes a new layer regardless of this setting (there is no single video to
// "replace"), so this preference only governs the one-video case. It is a
// global preference, not per-document, so it is persisted through the shared
// preference store (localStorage, and the Firebase backend when signed in) —
// the same place as the pixel-grid preference.

import { definePreference } from './sync/preference-store.js';

export const SECOND_VIDEO_BEHAVIORS = ['prompt', 'replace', 'new-layer'];
const DEFAULT_BEHAVIOR = 'prompt';

// Persisted (and, when signed in, synced across devices) through the shared
// timestamped preference store rather than localStorage directly. The storage
// key is unchanged, so a value written by an earlier version is picked up and
// migrated into the new timestamped format on first read.
const preference = definePreference({
  key: 'exact-video-annotator.secondVideoBehavior',
  defaultValue: DEFAULT_BEHAVIOR,
  coerce: (value) => (SECOND_VIDEO_BEHAVIORS.includes(value) ? value : DEFAULT_BEHAVIOR),
});

export function getSecondVideoBehavior() {
  return preference.get();
}

export function setSecondVideoBehavior(behavior) {
  if (!SECOND_VIDEO_BEHAVIORS.includes(behavior)) return;
  preference.set(behavior);
}
