// The sync engine ties the timestamped preference store (preference-store.js)
// to the Firebase backend (firebase.js). It is the only thing that decides,
// when the local and cloud copies of a preference disagree, which one wins:
// the newer one, per key (last-write-wins by updatedAt).
//
// Lifecycle, driven entirely by auth state:
//   sign in  → reconcile every preference against the cloud, then route local
//              writes to the cloud and subscribe to live updates from other
//              devices.
//   sign out → stop routing writes and drop the live listener; localStorage
//              keeps everything so the app carries on unchanged.

import { allPreferences, registerCloudWriter } from './preference-store.js';
import {
  onUserChanged, fetchUserPreferences, writeUserPreference, subscribeUserPreferences,
} from './firebase.js';

let unsubscribeLiveUpdates = null;

/** Reconcile one signed-in user's cloud preferences with the local ones,
    keeping the newer of each pair and copying it to whichever side is behind. */
async function reconcile(uid) {
  let cloudPreferences;
  try {
    cloudPreferences = await fetchUserPreferences(uid);
  } catch {
    return; // offline or blocked: keep using local values, try again next time
  }

  for (const preference of allPreferences()) {
    const localEnvelope = preference.getEnvelope();
    const cloudEnvelope = cloudPreferences[preference.key];
    const localTime = localEnvelope ? localEnvelope.updatedAt : -1;
    const cloudTime = cloudEnvelope ? cloudEnvelope.updatedAt : -1;

    if (cloudTime > localTime) {
      // The cloud is ahead: adopt it locally without echoing it back.
      preference.applyEnvelope(cloudEnvelope, { fromCloud: true });
    } else if (localTime > cloudTime && localEnvelope) {
      // We are ahead (or the cloud has never seen this key): push local up.
      writeUserPreference(uid, preference.key, localEnvelope).catch(() => {});
    }
    // Equal timestamps: already in agreement, nothing to do.
  }
}

/** Apply a live snapshot of the cloud preferences, adopting only keys whose
    cloud copy is strictly newer than what we hold — so our own just-written
    values (echoed back by the listener) and stale keys are left alone. */
function applyLiveSnapshot(cloudPreferences) {
  for (const preference of allPreferences()) {
    const cloudEnvelope = cloudPreferences[preference.key];
    if (!cloudEnvelope) continue;
    const localEnvelope = preference.getEnvelope();
    const localTime = localEnvelope ? localEnvelope.updatedAt : -1;
    if (cloudEnvelope.updatedAt > localTime) {
      preference.applyEnvelope(cloudEnvelope, { fromCloud: true });
    }
  }
}

/** Start syncing. Call once at startup; it wires itself to auth changes. */
export function initializeSync() {
  onUserChanged((user) => {
    // Tear down any previous session's routing and listener first.
    registerCloudWriter(null);
    if (unsubscribeLiveUpdates) {
      unsubscribeLiveUpdates();
      unsubscribeLiveUpdates = null;
    }

    if (!user) return;

    const { uid } = user;
    // Route every local write to this user's document from now on.
    registerCloudWriter((key, envelope) => {
      writeUserPreference(uid, key, envelope).catch(() => {});
    });
    // Merge in whatever the cloud already has, then watch for other devices.
    reconcile(uid).finally(() => {
      unsubscribeLiveUpdates = subscribeUserPreferences(uid, applyLiveSnapshot);
    });
  });
}
