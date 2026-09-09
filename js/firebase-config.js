// Firebase web configuration for the optional user-account backend.
//
// These values are NOT secret. The Firebase web config (apiKey included) is a
// public client-side identifier that ships in every visitor's browser by
// design — it only names which project the SDK should talk to. What actually
// protects data is the Firestore security rules (see firestore.rules) and the
// Auth authorized-domains list, neither of which this config can bypass.
//
// Analytics is deliberately omitted: the app needs only Authentication and
// Firestore, and leaving Analytics out avoids pulling in an extra dependency
// and privacy surface. `measurementId` is Analytics-only, so it is not here.

export const firebaseConfig = {
  apiKey: 'AIzaSyDGSNdLTbQ8f3UbMK7wilHnIe8iqWR93Zk',
  authDomain: 'exact-video-annotator.firebaseapp.com',
  projectId: 'exact-video-annotator',
  storageBucket: 'exact-video-annotator.firebasestorage.app',
  messagingSenderId: '163100434452',
  appId: '1:163100434452:web:74e396c818082909ecc701',
};

// The pinned Firebase JS SDK version, loaded as ES modules straight from
// gstatic (the same CDN-module pattern the app uses for mp4box and the video
// engine — no bundler). Bump deliberately, like the engine pin in index.html.
export const FIREBASE_SDK_VERSION = '12.6.0';

/** True when a real project config is present (not a blank placeholder), so the
    UI can degrade gracefully — showing a disabled Log in — on a build that has
    not been given one. */
export function isFirebaseConfigured() {
  return Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);
}
