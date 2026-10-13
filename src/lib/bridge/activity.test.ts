import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import source from "../../../docs/bridge.js?raw";
import { HOSTING } from "@/config/origins";
import { startIdleWatcher } from "@/lib/idle";
import { grantUnlock, isUnlocked, lock, unlockState } from "@/lib/unlock";
import { bridge } from "./bridge";

/**
 * Working inside an app's frame, end to end: the real docs/bridge.js (the file the apps
 * carry) posts to the dashboard's real hub, which feeds the one activity signal that the
 * idle sign-out and the password gate listen to.
 *
 * The first three tests are the measurement of 12 October 2026 (docs/MIGRATION_PLAN.md,
 * section 5.8): idle time 1 minute, watched for 100 seconds. Before the `activity` message,
 * the third one ended "signed out".
 */

const MINUTE = 60_000;
const APP = "payroll";

/** An app in the dashboard's workspace, running the real bridge.js. */
function openApp(appId: string, { showing }: { showing: boolean }) {
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  const frame = iframe.contentWindow!;
  bridge.attachFrame(appId, () => frame);
  bridge.setShown(appId, showing);

  const listeners = new Map<string, (event: unknown) => void>();
  const targets: string[] = [];
  const fake: Record<string, unknown> = {
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    crypto: { randomUUID: () => crypto.randomUUID() },
    parent: {
      // What the browser does with the app's postMessage: deliver it to the dashboard's
      // window, naming the frame it came from.
      postMessage: (data: unknown, targetOrigin: string) => {
        targets.push(targetOrigin);
        window.dispatchEvent(
          new MessageEvent("message", { data, origin: HOSTING.apps, source: frame }),
        );
      },
    },
  };
  new Function("window", source as string)(fake);
  (fake.PayrollHubBridge as { init(options: { appId: string }): boolean }).init({ appId });

  return {
    /** The user clicks and presses a key inside the app. The dashboard's window sees neither. */
    work: () => {
      listeners.get("pointerdown")?.({ type: "pointerdown" });
      listeners.get("keydown")?.({ type: "keydown" });
    },
    targets,
  };
}

/** Does `step` every 3 seconds for `ms`. */
function every3Seconds(ms: number, step: () => void) {
  for (let elapsed = 0; elapsed < ms; elapsed += 3_000) {
    step();
    vi.advanceTimersByTime(3_000);
  }
}

function setVisibility(state: "visible" | "hidden") {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
  document.dispatchEvent(new Event("visibilitychange"));
}

let stopIdle: () => void = () => {};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-13T09:00:00Z"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  bridge.start();
});

afterEach(() => {
  stopIdle();
  lock();
  bridge.stop();
  bridge.detachFrame(APP);
  bridge.detachFrame("pdf-editor");
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("the sign-out for inactivity, idle time 1 minute, watched for 100 seconds", () => {
  function watchForSignOut() {
    const signedOut = vi.fn();
    const start = Date.now();
    let after: number | null = null;
    stopIdle = startIdleWatcher({
      timeoutMs: MINUTE,
      onIdle: () => {
        after = Date.now() - start;
        signedOut();
      },
    });
    return { signedOut, afterSeconds: () => (after === null ? null : after / 1_000) };
  }

  it("nothing at all: signed out after about 60 seconds", () => {
    const { signedOut, afterSeconds } = watchForSignOut();
    openApp(APP, { showing: true });

    vi.advanceTimersByTime(100_000);

    expect(signedOut).toHaveBeenCalledTimes(1);
    expect(afterSeconds()).toBeGreaterThanOrEqual(60);
    expect(afterSeconds()).toBeLessThanOrEqual(75);
  });

  it("a key pressed in the dashboard itself every 3 seconds: still signed in", () => {
    const { signedOut } = watchForSignOut();

    every3Seconds(100_000, () => window.dispatchEvent(new Event("keydown")));

    expect(signedOut).not.toHaveBeenCalled();
  });

  it("a click and a key every 3 seconds inside an app's frame: still signed in", () => {
    const { signedOut } = watchForSignOut();
    const app = openApp(APP, { showing: true });

    every3Seconds(100_000, app.work);

    expect(signedOut).not.toHaveBeenCalled();
    // And it only ever spoke to the dashboard's exact origin.
    expect(new Set(app.targets)).toEqual(new Set([HOSTING.dashboard]));
  });

  it("an hour of work inside an app, then nothing: signed out about a minute after the last key", () => {
    const { signedOut, afterSeconds } = watchForSignOut();
    const app = openApp(APP, { showing: true });

    every3Seconds(60 * MINUTE, app.work);
    expect(signedOut).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2 * MINUTE);
    expect(signedOut).toHaveBeenCalledTimes(1);
    // The last key was at 59:57. The app may report it up to 30 seconds late, never early.
    expect(afterSeconds()).toBeGreaterThanOrEqual(60 * 60 + 57);
    expect(afterSeconds()).toBeLessThanOrEqual(60 * 60 + 105);
  });

  it("work in an app that is not the one showing does not count", () => {
    const { signedOut } = watchForSignOut();
    const hiddenApp = openApp(APP, { showing: false });

    every3Seconds(100_000, hiddenApp.work);

    expect(signedOut).toHaveBeenCalledTimes(1);
  });
});

describe("the password gate, 10 minutes", () => {
  it("stays open while someone types in an app, far past 10 minutes after unlocking", () => {
    const app = openApp("pdf-editor", { showing: true });
    grantUnlock(10);

    every3Seconds(45 * MINUTE, app.work);

    expect(isUnlocked()).toBe(true);
    expect(unlockState.get().lockedBy).toBeNull();
  });

  it("locks 10 minutes after the last key in the app", () => {
    const app = openApp(APP, { showing: true });
    grantUnlock(10);
    every3Seconds(45 * MINUTE, app.work);

    // The last key was 3 seconds ago.
    vi.advanceTimersByTime(9 * MINUTE + 50_000);
    expect(isUnlocked()).toBe(true);

    // 10 minutes after it, give or take the 30 seconds an app may take to report.
    vi.advanceTimersByTime(45_000);
    expect(isUnlocked()).toBe(false);
    expect(unlockState.get().lockedBy).toBe("timeout");
  });

  it("is not kept open by an app that is not the one showing", () => {
    const hiddenApp = openApp(APP, { showing: false });
    grantUnlock(10);

    every3Seconds(10 * MINUTE, hiddenApp.work);

    expect(isUnlocked()).toBe(false);
    expect(unlockState.get().lockedBy).toBe("timeout");
  });

  it("still locks when the tab has been hidden for two minutes, whatever an app reports", () => {
    const app = openApp(APP, { showing: true });
    grantUnlock(10);
    setVisibility("hidden");

    every3Seconds(2 * MINUTE + 3_000, app.work);

    expect(isUnlocked()).toBe(false);
    expect(unlockState.get().lockedBy).toBe("hidden");
  });
});
