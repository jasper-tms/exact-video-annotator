// What to do when a second video is loaded while exactly one video is already
// open — 'prompt' (ask each time), 'replace' (swap out the current video), or
// 'new-layer' (stack it as another layer). With no video open, the first video
// simply loads; with two or more already open, every further video always
// makes a new layer regardless of this setting (there is no single video to
// "replace"), so this preference only governs the one-video case. It is a
// global preference, not per-document, so it lives in localStorage — the same
// place as the pixel-grid preference.

const STORAGE_KEY = 'exact-video-annotator.secondVideoBehavior';

export const SECOND_VIDEO_BEHAVIORS = ['prompt', 'replace', 'new-layer'];
const DEFAULT_BEHAVIOR = 'prompt';

export function getSecondVideoBehavior() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return SECOND_VIDEO_BEHAVIORS.includes(raw) ? raw : DEFAULT_BEHAVIOR;
  } catch {
    return DEFAULT_BEHAVIOR;
  }
}

export function setSecondVideoBehavior(behavior) {
  if (!SECOND_VIDEO_BEHAVIORS.includes(behavior)) return;
  try { localStorage.setItem(STORAGE_KEY, behavior); } catch { /* ignore */ }
}
