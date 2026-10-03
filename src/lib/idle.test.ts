import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startIdleWatcher } from "./idle";

const MINUTE = 60_000;

describe("startIdleWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires once after the timeout with no activity", () => {
    const onIdle = vi.fn();
    startIdleWatcher({ timeoutMs: 15 * MINUTE, onIdle });

    vi.advanceTimersByTime(14 * MINUTE);
    expect(onIdle).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2 * MINUTE);
    expect(onIdle).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60 * MINUTE);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("restarts the countdown on user activity", () => {
    const onIdle = vi.fn();
    startIdleWatcher({ timeoutMs: 15 * MINUTE, onIdle });

    vi.advanceTimersByTime(14 * MINUTE);
    window.dispatchEvent(new Event("keydown"));
    vi.advanceTimersByTime(14 * MINUTE);
    expect(onIdle).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2 * MINUTE);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("does nothing after being stopped", () => {
    const onIdle = vi.fn();
    const stop = startIdleWatcher({ timeoutMs: MINUTE, onIdle });
    stop();
    vi.advanceTimersByTime(10 * MINUTE);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("is disabled when the timeout is 0", () => {
    const onIdle = vi.fn();
    startIdleWatcher({ timeoutMs: 0, onIdle });
    vi.advanceTimersByTime(60 * MINUTE);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("checks as soon as a throttled background tab becomes visible again", () => {
    let clock = 0;
    const onIdle = vi.fn();
    startIdleWatcher({ timeoutMs: 15 * MINUTE, onIdle, now: () => clock });

    // Timers did not run while hidden, but the wall clock moved on.
    clock = 20 * MINUTE;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(onIdle).toHaveBeenCalledTimes(1);
  });
});
