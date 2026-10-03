import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSessionCleanup } from "@/lib/sessionCleanup";
import { grantUnlock, lock } from "@/lib/unlock";
import { dataRequests, handleDataRequest, REQUEST_DEADLINE_MS } from "./bridge";

const REQUEST = { dataType: "payroll-result" };

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  runSessionCleanup();
  lock();
  vi.useRealTimers();
});

describe("an app asking the dashboard for a saved run", () => {
  it("waits for the user, showing up as an open request", () => {
    void handleDataRequest("pdf-editor", REQUEST);
    expect(dataRequests.get()).toHaveLength(1);
    expect(dataRequests.get()[0]).toMatchObject({ appId: "pdf-editor", payload: REQUEST });
  });

  it('answers "locked" if the dashboard is still locked at the deadline, instead of hanging', async () => {
    const reply = handleDataRequest("pdf-editor", REQUEST);

    vi.advanceTimersByTime(REQUEST_DEADLINE_MS - 1);
    expect(dataRequests.get()).toHaveLength(1);

    vi.advanceTimersByTime(1);
    await expect(reply).resolves.toMatchObject({
      ok: false,
      code: "locked",
      error: expect.stringMatching(/locked/i),
    });
    expect(dataRequests.get()).toHaveLength(0);
  });

  it("answers before the app's own 120-second wait runs out", () => {
    expect(REQUEST_DEADLINE_MS).toBeLessThan(120_000);
  });

  it('answers "timeout", not "locked", when it was unlocked but nobody decided', async () => {
    grantUnlock(10);
    const reply = handleDataRequest("pdf-editor", REQUEST);
    vi.advanceTimersByTime(REQUEST_DEADLINE_MS);
    await expect(reply).resolves.toMatchObject({ ok: false, code: "timeout" });
  });

  it('answers "locked" when the gate locked again while the request was waiting', async () => {
    grantUnlock(1);
    const reply = handleDataRequest("pdf-editor", REQUEST);
    vi.advanceTimersByTime(REQUEST_DEADLINE_MS);
    await expect(reply).resolves.toMatchObject({ ok: false, code: "locked" });
  });

  it("uses the user's answer when they give one, and cancels the deadline", async () => {
    const reply = handleDataRequest("pdf-editor", REQUEST);
    dataRequests.get()[0]!.respond({ ok: false, code: "denied", error: "Declined." });
    await expect(reply).resolves.toEqual({ ok: false, code: "denied", error: "Declined." });

    expect(dataRequests.get()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("answers every open request when the user signs out", async () => {
    const first = handleDataRequest("pdf-editor", REQUEST);
    const second = handleDataRequest("pdf-editor", { ...REQUEST, period: "2026-09" });
    runSessionCleanup();
    await expect(first).resolves.toMatchObject({ ok: false, code: "unavailable" });
    await expect(second).resolves.toMatchObject({ ok: false, code: "unavailable" });
    expect(dataRequests.get()).toHaveLength(0);
  });
});
