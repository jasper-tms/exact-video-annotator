// Transient notifications. Installs app.showToast; each toast fades in, dismisses
// itself after a timeout (longer for errors), can be dismissed early by clicking
// it, and is dropped oldest-first once more than a few are on screen. The toast
// container is pointer-events: none (see style.css) so it never blocks the
// canvas; each toast opts back into pointer events so its click still works.

const MAXIMUM_VISIBLE_TOASTS = 4;
const DEFAULT_DURATION_MILLISECONDS = 4000;
const ERROR_DURATION_MILLISECONDS = 8000;
// Long fallback so a toast is still removed if its fade-out never fires a
// transitionend (for example, when the tab is backgrounded).
const FADE_OUT_FALLBACK_MILLISECONDS = 600;

export function initializeToasts(app, containerElement) {
  // Toasts currently counted as "on screen" (front is oldest). A toast leaves
  // this list the moment it starts dismissing, even though its element lingers
  // briefly while it fades out.
  const liveToasts = [];

  function dismiss(toast) {
    const index = liveToasts.indexOf(toast);
    if (index === -1) return;   // already dismissing
    liveToasts.splice(index, 1);
    if (toast.dismissTimerId !== undefined) clearTimeout(toast.dismissTimerId);

    toast.classList.remove('toast-visible');
    toast.classList.add('toast-leaving');

    let removed = false;
    const removeFromDocument = () => {
      if (removed) return;
      removed = true;
      toast.remove();
    };
    toast.addEventListener('transitionend', removeFromDocument, { once: true });
    setTimeout(removeFromDocument, FADE_OUT_FALLBACK_MILLISECONDS);
  }

  app.showToast = (message, { kind = 'info' } = {}) => {
    const toast = document.createElement('div');
    toast.className = `toast toast-${kind}`;
    toast.textContent = message;
    toast.addEventListener('click', () => dismiss(toast));

    containerElement.appendChild(toast);
    liveToasts.push(toast);

    // Keep at most a few on screen, dropping the oldest first.
    while (liveToasts.length > MAXIMUM_VISIBLE_TOASTS) dismiss(liveToasts[0]);

    // Fade in on the next frame so the initial (hidden) state is painted first.
    requestAnimationFrame(() => toast.classList.add('toast-visible'));

    const duration = kind === 'error' ? ERROR_DURATION_MILLISECONDS : DEFAULT_DURATION_MILLISECONDS;
    toast.dismissTimerId = setTimeout(() => dismiss(toast), duration);

    return toast;
  };
}
