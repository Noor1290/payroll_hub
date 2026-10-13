import { onActivity } from "@/lib/activity";

export interface IdleWatcherOptions {
  timeoutMs: number;
  onIdle: () => void;
  /** Injectable for tests. */
  now?: () => number;
}

/**
 * Calls `onIdle` once after `timeoutMs` without user activity. Returns a stop function.
 * What counts as activity is decided in src/lib/activity.ts: the dashboard's own window, and
 * the app that is showing.
 *
 * Compares timestamps instead of trusting one long timer, because browsers throttle timers
 * in background tabs; the check also runs the moment the tab becomes visible again.
 */
export function startIdleWatcher({
  timeoutMs,
  onIdle,
  now = Date.now,
}: IdleWatcherOptions): () => void {
  if (timeoutMs <= 0) return () => {};

  let lastActivity = now();
  let stopped = false;

  const markActive = () => {
    lastActivity = now();
  };

  const check = () => {
    if (stopped || now() - lastActivity < timeoutMs) return;
    stop();
    onIdle();
  };

  const onVisibility = () => {
    if (document.visibilityState === "visible") check();
  };

  const interval = setInterval(check, Math.min(15_000, Math.max(1_000, timeoutMs / 4)));
  const stopListening = onActivity(markActive);
  document.addEventListener("visibilitychange", onVisibility);

  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    stopListening();
    document.removeEventListener("visibilitychange", onVisibility);
  }

  return stop;
}
