// How synchronized multi-video playback should behave when the decoders cannot
// quite keep up with real time. Both pacings track the same real-time clock, so
// neither ever runs faster than real time, and every painted composite is
// frame-exact either way — this only decides what gives under load:
//   'realtime'    — keep the wall clock; if an engine is briefly behind, hold
//                   the last exact composite and let the clock move on, so some
//                   frames are skipped from view to stay at real-time speed.
//   'every-frame' — never skip a frame; advance at most one frame past the last
//                   painted, so playback slows below real time when it must and
//                   catches every frame, but never gets ahead of real time.
// A global preference, not per-document, so it is persisted through the shared
// preference store (localStorage, and the Firebase backend when signed in)
// alongside the other cross-application settings (see second-media-preference.js).

import { definePreference } from './sync/preference-store.js';

export const SYNCED_PLAYBACK_PACINGS = ['realtime', 'every-frame'];
const DEFAULT_PACING = 'realtime';

// Persisted (and synced when signed in) through the shared timestamped
// preference store; the storage key is unchanged so earlier values migrate.
const preference = definePreference({
  key: 'exact-video-annotator.syncedPlaybackPacing',
  defaultValue: DEFAULT_PACING,
  coerce: (value) => (SYNCED_PLAYBACK_PACINGS.includes(value) ? value : DEFAULT_PACING),
});

export function getSyncedPlaybackPacing() {
  return preference.get();
}

export function setSyncedPlaybackPacing(pacing) {
  if (!SYNCED_PLAYBACK_PACINGS.includes(pacing)) return;
  preference.set(pacing);
}
