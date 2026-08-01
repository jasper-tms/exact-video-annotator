// How synchronized multi-video playback should behave when the decoders cannot
// quite keep up with real time. Every painted composite is frame-exact either
// way — this only decides what gives under load:
//   'realtime'    — keep the wall clock; if an engine is briefly behind, hold
//                   the last exact composite and let the clock move on, so some
//                   frames are skipped from view to stay at real-time speed.
//   'every-frame' — never skip a frame; advance only once every engine has the
//                   next frame, so playback slows below real time when it must.
// A global preference, not per-document, so it lives in localStorage alongside
// the other cross-application settings (see second-video-preference.js).

const STORAGE_KEY = 'exact-video-annotator.syncedPlaybackPacing';

export const SYNCED_PLAYBACK_PACINGS = ['realtime', 'every-frame'];
const DEFAULT_PACING = 'realtime';

export function getSyncedPlaybackPacing() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return SYNCED_PLAYBACK_PACINGS.includes(raw) ? raw : DEFAULT_PACING;
  } catch {
    return DEFAULT_PACING;
  }
}

export function setSyncedPlaybackPacing(pacing) {
  if (!SYNCED_PLAYBACK_PACINGS.includes(pacing)) return;
  try { localStorage.setItem(STORAGE_KEY, pacing); } catch { /* ignore */ }
}
