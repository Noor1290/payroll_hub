import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import source from "../../../docs/bridge.js?raw";
import { HOSTING } from "@/config/origins";

/**
 * Tests for docs/bridge.js, the file copied into each app. It is run here against a fake
 * `window` so its behaviour inside an iframe can be checked without a browser.
 */

const HUB = HOSTING.dashboard;

interface Posted {
  type: string;
  from: string;
  to: string;
  version: number;
  id: string;
  payload: Record<string, unknown>;
}

interface Bridge {
  isEmbedded(): boolean;
  isConnected(): boolean;
  init(options: { appId: string; onData?: (payload: unknown) => unknown }): boolean;
  sendToDashboard(type: string, payload: unknown): Promise<{ ok: boolean; error?: string }>;
  requestData(dataType: string, period?: string): Promise<{ ok: boolean; error?: string }>;
  onStatus(listener: (connected: boolean) => void): () => void;
}

function load({ embedded }: { embedded: boolean }) {
  const parent = { postMessage: vi.fn() };
  let listener: ((event: unknown) => void) | undefined;
  const fake: Record<string, unknown> = {
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      if (type === "message") listener = fn;
    },
    crypto: { randomUUID: () => crypto.randomUUID() },
  };
  fake.parent = embedded ? parent : fake;

  // The file reads `window` (falling back to `this`); give it the fake one.
  new Function("window", source as string)(fake);

  const posted = (type?: string) =>
    (parent.postMessage.mock.calls as [Posted, string][])
      .map(([message]) => message)
      .filter((message) => !type || message.type === type);
  const receive = (data: unknown, overrides: { origin?: string; source?: unknown } = {}) =>
    listener?.({ data, origin: HUB, source: parent, ...overrides });
  const fromHub = (type: string, id: string, payload: unknown = {}, to = "pdf-editor") => ({
    type,
    from: "dashboard",
    to,
    version: 1,
    id,
    payload,
  });

  return {
    bridge: fake.PayrollHubBridge as Bridge,
    parent,
    posted,
    receive,
    fromHub,
    hasListener: () => listener !== undefined,
  };
}

const DATA = { dataType: "payroll-result", rows: [{ Surname: "DOE" }] };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("bridge.js configuration", () => {
  it("trusts exactly the dashboard origin in src/config/origins.ts", () => {
    expect(source).toContain(`var HUB_ORIGIN = "${HUB}";`);
  });

  it("never posts with a wildcard origin and has no localhost exception", () => {
    expect(source).not.toMatch(/postMessage\([^)]*["']\*["']/);
    expect(source).not.toMatch(/localhost|127\.0\.0\.1/);
  });
});

describe("bridge.js standalone", () => {
  it("does nothing when the app is not embedded", async () => {
    const { bridge, parent, hasListener } = load({ embedded: false });
    expect(bridge.isEmbedded()).toBe(false);
    expect(bridge.init({ appId: "pdf-editor", onData: vi.fn() })).toBe(false);
    expect(hasListener()).toBe(false);
    expect(parent.postMessage).not.toHaveBeenCalled();
    await expect(bridge.sendToDashboard("send-data", DATA)).resolves.toMatchObject({ ok: false });
  });
});

describe("bridge.js embedded", () => {
  it("announces itself with ready, to the exact dashboard origin", () => {
    const { bridge, parent, posted } = load({ embedded: true });
    expect(bridge.init({ appId: "pdf-editor" })).toBe(true);
    expect(posted("ready")[0]).toMatchObject({ from: "pdf-editor", to: "dashboard", version: 1 });
    expect(parent.postMessage.mock.calls[0]![1]).toBe(HUB);
  });

  it("answers ping with a pong carrying the same id", () => {
    const { bridge, posted, receive, fromHub } = load({ embedded: true });
    bridge.init({ appId: "pdf-editor" });
    receive(fromHub("ping", "ping-0000001"));
    expect(posted("pong")[0]).toMatchObject({ id: "ping-0000001" });
    expect(bridge.isConnected()).toBe(true);
  });

  it("passes data to the app's handler and acknowledges", () => {
    const { bridge, posted, receive, fromHub } = load({ embedded: true });
    const onData = vi.fn();
    bridge.init({ appId: "pdf-editor", onData });

    receive(fromHub("send-data", "send-000001", DATA));

    expect(onData).toHaveBeenCalledWith(DATA);
    expect(posted("received")[0]).toMatchObject({ id: "send-000001", payload: { ok: true } });
  });

  it("ignores a repeated id, so a retry after a late acknowledgement never imports twice", () => {
    const { bridge, posted, receive, fromHub } = load({ embedded: true });
    const onData = vi.fn();
    bridge.init({ appId: "pdf-editor", onData });

    receive(fromHub("send-data", "send-000001", DATA));
    receive(fromHub("send-data", "send-000001", DATA));
    receive(fromHub("send-data", "send-000001", DATA));

    expect(onData).toHaveBeenCalledTimes(1);
    // The earlier answer is repeated so the dashboard's retry still gets its confirmation.
    expect(posted("received")).toHaveLength(3);
    expect(posted("received").every((m) => m.payload.ok === true)).toBe(true);
  });

  it("does not answer a duplicate while the first import is still running", async () => {
    const { bridge, posted, receive, fromHub } = load({ embedded: true });
    let finish!: () => void;
    const onData = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    bridge.init({ appId: "pdf-editor", onData });

    receive(fromHub("send-data", "send-000001", DATA));
    receive(fromHub("send-data", "send-000001", DATA));
    expect(onData).toHaveBeenCalledTimes(1);
    expect(posted("received")).toHaveLength(0);

    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(posted("received")).toHaveLength(1);
  });

  it("reports a failed import instead of claiming success", () => {
    const { bridge, posted, receive, fromHub } = load({ embedded: true });
    bridge.init({
      appId: "pdf-editor",
      onData: () => {
        throw new Error("No PDF template loaded");
      },
    });
    receive(fromHub("send-data", "send-000001", DATA));
    expect(posted("received")[0]!.payload).toEqual({ ok: false, error: "No PDF template loaded" });
  });

  it("ignores messages from the wrong window, origin or addressee", () => {
    const { bridge, posted, receive, fromHub } = load({ embedded: true });
    const onData = vi.fn();
    bridge.init({ appId: "pdf-editor", onData });
    const before = posted().length;

    receive(fromHub("send-data", "send-000001", DATA), { source: {} });
    receive(fromHub("send-data", "send-000002", DATA), { origin: "https://evil.example" });
    receive(fromHub("send-data", "send-000003", DATA, "payslip"));
    receive({ ...fromHub("send-data", "send-000004", DATA), from: "payroll" });
    receive("not an object");

    expect(onData).not.toHaveBeenCalled();
    expect(posted()).toHaveLength(before);
    expect(bridge.isConnected()).toBe(false);
  });

  it("refuses data sent with a different protocol version", () => {
    const { bridge, posted, receive, fromHub } = load({ embedded: true });
    const onData = vi.fn();
    bridge.init({ appId: "pdf-editor", onData });
    receive({ ...fromHub("send-data", "send-000001", DATA), version: 2 });
    expect(onData).not.toHaveBeenCalled();
    expect(posted("received")[0]!.payload.ok).toBe(false);
  });

  it("sendToDashboard resolves with the dashboard's reply", async () => {
    const { bridge, posted, receive, fromHub } = load({ embedded: true });
    bridge.init({ appId: "payroll" });
    const reply = bridge.sendToDashboard("send-data", DATA);
    const message = posted("send-data")[0]!;
    expect(message).toMatchObject({ from: "payroll", to: "dashboard", payload: DATA });

    receive(fromHub("received", message.id, { ok: true }, "payroll"));
    await expect(reply).resolves.toEqual({ ok: true });
  });

  it("sendToDashboard gives up after 10 seconds without rejecting", async () => {
    const { bridge } = load({ embedded: true });
    bridge.init({ appId: "payroll" });
    const reply = bridge.sendToDashboard("send-data", DATA);
    vi.advanceTimersByTime(10_000);
    await expect(reply).resolves.toMatchObject({ ok: false });
  });

  it("requestData asks for a period and waits longer, for the user's approval", async () => {
    const { bridge, posted, receive, fromHub } = load({ embedded: true });
    bridge.init({ appId: "pdf-editor" });
    const reply = bridge.requestData("payroll-result", "2026-09");
    const message = posted("request-data")[0]!;
    expect(message.payload).toEqual({ dataType: "payroll-result", period: "2026-09" });

    vi.advanceTimersByTime(60_000);
    receive(fromHub("response-data", message.id, { ok: true, ...DATA }));
    await expect(reply).resolves.toMatchObject({ ok: true, rows: DATA.rows });
  });
});
