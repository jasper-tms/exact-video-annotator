// The Firebase adapter: the only module that talks to the Firebase SDK. It
// loads the SDK lazily (a dynamic import of the pinned gstatic ES modules) so
// the core app never depends on Firebase at startup — if the CDN is blocked or
// the user is offline, everything here degrades to no-ops and the app keeps
// working signed-out. Auth state is exposed through a tiny observer that both
// the account button (account-control.js) and the sync engine (sync-engine.js)
// subscribe to.

import { firebaseConfig, FIREBASE_SDK_VERSION, isFirebaseConfigured } from '../firebase-config.js';

const CDN_BASE = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}`;

/** Memoized SDK load + app init. Resolves to the handles the rest of the module
    needs, or rejects if the SDK cannot be loaded. */
let servicesPromise = null;

function loadServices() {
  if (servicesPromise) return servicesPromise;
  servicesPromise = (async () => {
    const [appModule, authModule, firestoreModule] = await Promise.all([
      import(`${CDN_BASE}/firebase-app.js`),
      import(`${CDN_BASE}/firebase-auth.js`),
      import(`${CDN_BASE}/firebase-firestore.js`),
    ]);
    const app = appModule.initializeApp(firebaseConfig);
    const auth = authModule.getAuth(app);
    const db = firestoreModule.getFirestore(app);
    return { app, auth, db, authModule, firestoreModule };
  })();
  // If loading fails, don't cache the rejection forever — a later retry (e.g.
  // the user clicks Log in after their connection returns) should try again.
  servicesPromise.catch(() => { servicesPromise = null; });
  return servicesPromise;
}

/* ---------- Auth observer ---------- */

// The current signed-in user, or null. Undefined until the first auth state is
// known (SDK still resolving); observers are only ever called with user|null.
let currentUserValue = null;
let authStarted = false;
const userListeners = new Set();

function setCurrentUser(user) {
  currentUserValue = user;
  for (const listener of userListeners) {
    try { listener(user); } catch { /* one listener must not break the others */ }
  }
}

/** Begin observing auth once (restores a persisted session on reload). Safe to
    call when unconfigured or offline — it simply never reports a user. */
async function startAuthObserver() {
  if (authStarted || !isFirebaseConfigured()) return;
  authStarted = true;
  try {
    const { auth, authModule } = await loadServices();
    authModule.onAuthStateChanged(auth, (user) => setCurrentUser(user ?? null));
  } catch {
    authStarted = false; // allow a later retry
  }
}

/** The current user, or null. */
export function currentUser() {
  return currentUserValue;
}

/** Subscribe to sign-in/out. Fires immediately with the current value, then on
    every change. Returns an unsubscribe fn. Kicks off the auth observer. */
export function onUserChanged(listener) {
  userListeners.add(listener);
  listener(currentUserValue);
  startAuthObserver();
  return () => userListeners.delete(listener);
}

/* ---------- Sign in / out ---------- */

export async function signInWithGoogle() {
  const { auth, authModule } = await loadServices();
  const provider = new authModule.GoogleAuthProvider();
  await authModule.signInWithPopup(auth, provider);
}

export async function signOut() {
  const { auth, authModule } = await loadServices();
  await authModule.signOut(auth);
}

/* ---------- Firestore: the per-user preferences document ---------- */

// One document per user holds every synced preference as a map of envelopes:
//   users/{uid} = { preferences: { <key>: { value, updatedAt }, ... } }
// A single doc means one read on sign-in and one live listener — cheap for the
// handful of small preferences this app has.

function userDocRef(firestoreModule, db, uid) {
  return firestoreModule.doc(db, 'users', uid);
}

/** Fetch the stored preferences map for a user (empty object if none yet). */
export async function fetchUserPreferences(uid) {
  const { db, firestoreModule } = await loadServices();
  const snapshot = await firestoreModule.getDoc(userDocRef(firestoreModule, db, uid));
  const data = snapshot.exists() ? snapshot.data() : null;
  return (data && data.preferences) || {};
}

/** Write one preference envelope, merging so sibling keys are untouched and the
    document is created if it does not exist yet. */
export async function writeUserPreference(uid, key, envelope) {
  const { db, firestoreModule } = await loadServices();
  await firestoreModule.setDoc(
    userDocRef(firestoreModule, db, uid),
    { preferences: { [key]: envelope } },
    { merge: true },
  );
}

/** Listen for live changes to a user's preferences map (other devices). Calls
    back with the map on every change. Returns an unsubscribe fn (a no-op if the
    SDK never loads). */
export function subscribeUserPreferences(uid, callback) {
  let unsubscribe = () => {};
  let cancelled = false;
  loadServices().then(({ db, firestoreModule }) => {
    if (cancelled) return;
    unsubscribe = firestoreModule.onSnapshot(userDocRef(firestoreModule, db, uid), (snapshot) => {
      const data = snapshot.exists() ? snapshot.data() : null;
      callback((data && data.preferences) || {});
    }, () => { /* permission or network error: ignore, local still works */ });
  }).catch(() => { /* SDK unavailable: no live updates, local still works */ });
  return () => { cancelled = true; unsubscribe(); };
}
