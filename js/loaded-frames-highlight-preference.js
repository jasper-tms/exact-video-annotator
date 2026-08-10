// Whether to shade the transport scrubber where frames are currently held
// decoded in the engine's cache — the loaded (instantly seekable) range, drawn
// the way a video player shows its buffered range (see js/ui/transport.js).
// Off by default: it is a diagnostic overlay most viewers do not need, and it
// only means anything on the WebCodecs tier, which has an addressable frame
// cache. The preference is global (not per-document), so it lives in
// localStorage alongside the other cross-application settings.

const STORAGE_KEY = 'exact-video-annotator.loadedFramesHighlightEnabled';

function loadEnabled() {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

let loadedFramesHighlightEnabled = loadEnabled();

export function isLoadedFramesHighlightEnabled() {
  return loadedFramesHighlightEnabled;
}

export function setLoadedFramesHighlightEnabled(enabled) {
  loadedFramesHighlightEnabled = enabled;
  try { localStorage.setItem(STORAGE_KEY, String(enabled)); } catch { /* ignore */ }
}
