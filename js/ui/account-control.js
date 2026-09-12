// The account control in the top bar's right group. Signed out it reads
// "Log in" and starts a Google sign-in popup; signed in it shows the account
// email and, on hover, opens a small menu whose only entry is "Log out". On a
// build with no Firebase config it is disabled with an explanatory tooltip, so
// the bar looks the same everywhere but the feature is inert where it cannot work.

import { isFirebaseConfigured } from '../firebase-config.js';
import { onUserChanged, signInWithGoogle, signOut, currentUser } from '../sync/firebase.js';

export function initializeAccountControl(app, buttonElement) {
  if (!isFirebaseConfigured()) {
    buttonElement.disabled = true;
    buttonElement.title = 'Sign-in is not configured for this build.';
    return;
  }

  let menuElement = null;
  // Hovering off the button and onto the menu (or vice versa) briefly leaves
  // both, so a close is scheduled and cancelled if the pointer lands on either.
  let closeTimer = null;

  function cancelScheduledClose() {
    if (closeTimer === null) return;
    clearTimeout(closeTimer);
    closeTimer = null;
  }

  function scheduleClose() {
    cancelScheduledClose();
    closeTimer = window.setTimeout(closeMenu, 160);
  }

  function closeMenu() {
    cancelScheduledClose();
    if (!menuElement) return;
    menuElement.remove();
    menuElement = null;
    window.removeEventListener('pointerdown', dismissMenu, true);
  }

  function dismissMenu(event) {
    if (menuElement && !menuElement.contains(event.target) && event.target !== buttonElement) {
      closeMenu();
    }
  }

  function openMenu() {
    closeMenu();
    menuElement = document.createElement('div');
    menuElement.className = 'account-menu';
    menuElement.addEventListener('mouseenter', cancelScheduledClose);
    menuElement.addEventListener('mouseleave', scheduleClose);

    const logOutButton = document.createElement('button');
    logOutButton.type = 'button';
    logOutButton.textContent = 'Log out';
    logOutButton.addEventListener('click', async () => {
      closeMenu();
      try {
        await signOut();
      } catch (error) {
        app.showToast(`Could not log out: ${error?.message ?? error}`, { kind: 'error' });
      }
    });
    menuElement.appendChild(logOutButton);

    // Anchored to the button with fixed viewport coordinates, opening downward
    // from just below the top bar and aligned to the button's right edge.
    document.body.appendChild(menuElement);
    const buttonRect = buttonElement.getBoundingClientRect();
    menuElement.style.top = `${buttonRect.bottom + 4}px`;
    menuElement.style.right = `${window.innerWidth - buttonRect.right}px`;

    window.addEventListener('pointerdown', dismissMenu, true);
  }

  function reflectUser(user) {
    closeMenu();
    if (user) {
      buttonElement.textContent = user.email || user.displayName || 'Account';
      buttonElement.title = 'Account — hover to log out';
    } else {
      buttonElement.textContent = 'Log in';
      buttonElement.title = 'Sign in to sync settings across devices';
    }
  }

  onUserChanged(reflectUser);

  // Signed in, the menu tracks hover over the button (and stays open while the
  // pointer is over the menu itself, handled in openMenu).
  buttonElement.addEventListener('mouseenter', () => {
    if (!currentUser()) return;
    cancelScheduledClose();
    if (!menuElement) openMenu();
  });
  buttonElement.addEventListener('mouseleave', () => {
    if (menuElement) scheduleClose();
  });

  buttonElement.addEventListener('click', async () => {
    const user = currentUser();
    if (user) {
      // Hover drives the menu; a click still opens it for pointers without hover
      // (touch), and taps elsewhere dismiss it.
      if (!menuElement) openMenu();
      return;
    }
    try {
      await signInWithGoogle();
    } catch (error) {
      // A user dismissing the popup is not an error worth shouting about.
      const code = error?.code ?? '';
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return;
      app.showToast(`Could not sign in: ${error?.message ?? error}`, { kind: 'error' });
    }
  });
}
