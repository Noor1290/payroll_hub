import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clampUnlockMinutes, setUnlockMinutes, UNLOCK_MINUTES, unlockMinutes } from "./preferences";
import { queryClient } from "./queryClient";
import { runSessionCleanup } from "./sessionCleanup";
import {
  grantUnlock,
  HIDDEN_LOCK_MS,
  isUnlocked,
  lock,
  registerLockCleanup,
  unlockState,
} from "./unlock";

const MINUTE = 60_000;

function setVisibility(state: "visible" | "hidden") {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-03T10:00:00Z"));
});

afterEach(() => {
  lock();
  queryClient.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
  sessionStorage.clear();
});

describe("defaults", () => {
  it("starts locked", () => {
    expect(isUnlocked()).toBe(false);
    expect(unlockState.get()).toMatchObject({ unlocked: false, expiresAt: null });
  });

  it("unlocks for 10 minutes by default, adjustable from 1 to 30", () => {
    expect(UNLOCK_MINUTES).toEqual({ min: 1, max: 30, default: 10 });
    expect(unlockMinutes.get()).toBe(10);
    expect(clampUnlockMinutes(undefined)).toBe(10);
    expect(clampUnlockMinutes("abc")).toBe(10);
    expect(clampUnlockMinutes(0)).toBe(1);
    expect(clampUnlockMinutes(45)).toBe(30);
    expect(clampUnlockMinutes("7")).toBe(7);
    expect(clampUnlockMinutes(2.6)).toBe(3);
  });

  it("remembers the chosen duration as a preference", () => {
    expect(setUnlockMinutes(20)).toBe(20);
    expect(unlockMinutes.get()).toBe(20);
    expect(localStorage.getItem("payroll-hub:unlock-minutes")).toBe("20");
    setUnlockMinutes(UNLOCK_MINUTES.default);
  });
});

describe("locking after the timeout", () => {
  it("stays open until the deadline, then locks", () => {
    grantUnlock(10);
    expect(unlockState.get().expiresAt).toBe(Date.now() + 10 * MINUTE);

    vi.advanceTimersByTime(10 * MINUTE - 1_000);
    expect(isUnlocked()).toBe(true);

    vi.advanceTimersByTime(1_000);
    expect(isUnlocked()).toBe(false);
    expect(unlockState.get()).toEqual({ unlocked: false, expiresAt: null, lockedBy: "timeout" });
  });

  it("is a fixed window: activity does not extend it", () => {
    grantUnlock(10);
    for (let minute = 0; minute < 9; minute++) {
      vi.advanceTimersByTime(MINUTE);
      window.dispatchEvent(new Event("pointerdown"));
      window.dispatchEvent(new Event("keydown"));
    }
    expect(isUnlocked()).toBe(true);
    vi.advanceTimersByTime(MINUTE);
    expect(isUnlocked()).toBe(false);
  });

  it("locks by the clock even if the timer itself never fired (sleeping laptop)", () => {
    grantUnlock(10);
    vi.setSystemTime(Date.now() + 11 * MINUTE); // time passes, no timers run
    expect(isUnlocked()).toBe(false);
    expect(unlockState.get().lockedBy).toBe("timeout");
  });

  it("uses the configured duration", () => {
    grantUnlock(1);
    vi.advanceTimersByTime(MINUTE);
    expect(isUnlocked()).toBe(false);
  });
});

describe("locking when the tab is hidden", () => {
  it("locks after more than two minutes in the background", () => {
    grantUnlock(10);
    setVisibility("hidden");
    vi.advanceTimersByTime(HIDDEN_LOCK_MS);
    expect(isUnlocked()).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(isUnlocked()).toBe(false);
    expect(unlockState.get().lockedBy).toBe("hidden");
  });

  it("locks on return if background timers were frozen the whole time", () => {
    grantUnlock(10);
    setVisibility("hidden");
    vi.setSystemTime(Date.now() + 3 * MINUTE);
    setVisibility("visible");
    expect(unlockState.get()).toMatchObject({ unlocked: false, lockedBy: "hidden" });
  });

  it("stays open after a short trip to another tab", () => {
    grantUnlock(10);
    setVisibility("hidden");
    vi.advanceTimersByTime(90_000);
    setVisibility("visible");
    vi.advanceTimersByTime(3 * MINUTE);
    expect(isUnlocked()).toBe(true);
  });
});

describe("locking with the session", () => {
  it("locks on sign-out, idle sign-out and session expiry (all run the session cleanup)", () => {
    grantUnlock(10);
    runSessionCleanup();
    expect(unlockState.get()).toEqual({ unlocked: false, expiresAt: null, lockedBy: "session" });

    // And it does not quietly reopen later.
    vi.advanceTimersByTime(30 * MINUTE);
    expect(isUnlocked()).toBe(false);
  });

  it("can be locked by hand", () => {
    grantUnlock(10);
    lock("manual");
    expect(unlockState.get()).toMatchObject({ unlocked: false, lockedBy: "manual" });
  });
});

describe("what locking wipes", () => {
  it("runs the registered cleanups once per lock, and not when already locked", () => {
    const cleanup = vi.fn();
    const unregister = registerLockCleanup(cleanup);

    lock();
    expect(cleanup).not.toHaveBeenCalled();

    grantUnlock(10);
    vi.advanceTimersByTime(10 * MINUTE);
    expect(cleanup).toHaveBeenCalledTimes(1);

    lock();
    expect(cleanup).toHaveBeenCalledTimes(1);
    unregister();
  });

  it("removes the employee rows from memory, but leaves the rest of the session alone", () => {
    queryClient.setQueryData(["run-entries", "run-1", "user-1"], [{ national_id: "X1" }]);
    queryClient.setQueryData(["runs", "company-1", "user-1"], [{ id: "run-1" }]);
    // One minute, so the query cache's own 5-minute tidy-up of unused data stays out of the picture.
    grantUnlock(1);

    vi.advanceTimersByTime(MINUTE);
    expect(isUnlocked()).toBe(false);

    expect(queryClient.getQueryData(["run-entries", "run-1", "user-1"])).toBeUndefined();
    expect(queryClient.getQueryCache().findAll({ queryKey: ["run-entries"] })).toHaveLength(0);
    // Only the gated data goes: the user is still signed in and other screens keep working.
    expect(queryClient.getQueryData(["runs", "company-1", "user-1"])).toEqual([{ id: "run-1" }]);
  });

  it("removes them on sign-out too", () => {
    queryClient.setQueryData(["run-entries", "run-1", "user-1"], [{ national_id: "X1" }]);
    grantUnlock(10);
    runSessionCleanup();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });
});

describe("where the unlocked state lives", () => {
  it("is in memory only: nothing about it is written to browser storage", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    grantUnlock(10);
    vi.advanceTimersByTime(MINUTE);
    lock();
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });
});
