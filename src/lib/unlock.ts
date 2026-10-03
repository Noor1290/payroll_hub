import { logger } from "@/lib/logger";
import { registerSessionCleanup } from "@/lib/sessionCleanup";
import { createStore } from "@/lib/store";

/**
 * The password gate's state: whether the sensitive areas are currently open.
 *
 * This is a convenience layer for a shared or unattended screen. It is NOT what protects the
 * data: the database's row-level security does that, whether this gate is open or not.
 *
 * Rules:
 *  - The state lives in this module's memory only. Never in localStorage, sessionStorage or a URL.
 *  - It is independent of the login session: when it locks, the user stays signed in.
 *  - It locks a fixed time after unlocking (not extended by activity), when the tab has been
 *    hidden for more than two minutes, on demand, and whenever the session ends.
 *  - Locking also drops the data the gate was protecting from memory.
 */

/** Why the gate last closed, so the prompt can say so. */
export type LockReason = "timeout" | "hidden" | "manual" | "session";

export interface UnlockState {
  unlocked: boolean;
  /** Epoch milliseconds at which it locks again; null while locked. */
  expiresAt: number | null;
  /** Why it locked last time; null if it has not been unlocked in this session. */
  lockedBy: LockReason | null;
}

/** A hidden tab locks after this long. */
export const HIDDEN_LOCK_MS = 2 * 60_000;
/** How often the deadline is checked. Timestamps are compared, so a throttled timer only delays, never skips. */
const CHECK_EVERY_MS = 1_000;

export const unlockState = createStore<UnlockState>({
  unlocked: false,
  expiresAt: null,
  lockedBy: null,
});

const cleanups = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | null = null;
let hiddenSince: number | null = null;

/**
 * Registers something to wipe when the gate locks (for example cached employee rows).
 * Returns an unregister function.
 */
export function registerLockCleanup(cleanup: () => void): () => void {
  cleanups.add(cleanup);
  return () => {
    cleanups.delete(cleanup);
  };
}

export function isUnlocked(): boolean {
  // Check the clock here too, so a late timer can never leave the gate open past its deadline.
  enforce();
  return unlockState.get().unlocked;
}

/** Opens the gate for `minutes`, counted from now. Only call after the password was verified. */
export function grantUnlock(minutes: number): void {
  const expiresAt = Date.now() + minutes * 60_000;
  hiddenSince = document.visibilityState === "hidden" ? Date.now() : null;
  unlockState.set({ unlocked: true, expiresAt, lockedBy: null });
  if (ticker === null) ticker = setInterval(enforce, CHECK_EVERY_MS);
}

export function lock(reason: LockReason = "manual"): void {
  if (ticker !== null) clearInterval(ticker);
  ticker = null;
  hiddenSince = null;
  if (!unlockState.get().unlocked) return;

  // Close the gate first (gated screens unmount), then wipe what they were showing.
  unlockState.set({ unlocked: false, expiresAt: null, lockedBy: reason });
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch {
      logger.error("A lock cleanup step failed.");
    }
  }
}

function enforce(): void {
  const { unlocked, expiresAt } = unlockState.get();
  if (!unlocked) return;
  const now = Date.now();
  if (expiresAt !== null && now >= expiresAt) lock("timeout");
  else if (hiddenSince !== null && now - hiddenSince > HIDDEN_LOCK_MS) lock("hidden");
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (!unlockState.get().unlocked) return;
    if (document.visibilityState === "hidden") {
      hiddenSince = Date.now();
    } else {
      // Background timers are throttled, so decide by the clock the moment the tab is back.
      enforce();
      hiddenSince = null;
    }
  });
}

// Manual sign-out, idle sign-out and session expiry all end the session: lock with them.
registerSessionCleanup(() => lock("session"));
