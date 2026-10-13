/**
 * The one signal for "someone is using the dashboard right now". The idle sign-out
 * (src/lib/idle.ts) and the password gate (src/lib/unlock.ts) both listen to it, so they
 * always agree on what counts as activity.
 *
 * Two things feed it:
 *  - a click, a key, the wheel or a touch in the dashboard's own window;
 *  - an "activity" message from the app that is showing (src/lib/bridge/bridge.ts calls
 *    `reportActivity`). A browser does not pass events from inside a frame to the page
 *    around it, so without that message, working in an app looks like doing nothing.
 *
 * It carries no information about what was done, and nothing is stored.
 */
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

const listeners = new Set<() => void>();

/** Say that the user just did something. */
export function reportActivity(): void {
  for (const listener of [...listeners]) listener();
}

/** Calls `listener` every time the user does something. Returns a stop function. */
export function onActivity(listener: () => void): () => void {
  if (listeners.size === 0) {
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, reportActivity, { passive: true, capture: true });
    }
  }
  listeners.add(listener);

  return () => {
    if (!listeners.delete(listener) || listeners.size > 0) return;
    for (const event of ACTIVITY_EVENTS) {
      window.removeEventListener(event, reportActivity, { capture: true });
    }
  };
}
