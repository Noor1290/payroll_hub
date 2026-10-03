import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeHub, type HubApp } from "./hub";
import type { SendDataPayload } from "./protocol";

const ORIGIN = "https://noor1290.github.io";
const DATA: SendDataPayload = { dataType: "payroll-result", rows: [{ Surname: "DOE" }] };

const APPS: HubApp[] = [
  {
    id: "payroll",
    origin: ORIGIN,
    protocolVersion: 1,
    accepts: [],
    produces: ["payroll-result"],
    active: true,
  },
  {
    id: "pdf-editor",
    origin: ORIGIN,
    protocolVersion: 1,
    accepts: ["payroll-result"],
    produces: [],
    active: true,
  },
  {
    id: "payslip",
    origin: null,
    protocolVersion: 1,
    accepts: ["payroll-result"],
    produces: [],
    active: false,
  },
];

interface Sent {
  type: string;
  from: string;
  to: string;
  version: number;
  id: string;
  payload: unknown;
}

/** A real iframe window (so event.source checks are genuine) with postMessage recorded. */
function makeFrame() {
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  const win = iframe.contentWindow!;
  const post = vi.fn();
  win.postMessage = post as unknown as Window["postMessage"];
  const sent = (type?: string) =>
    (post.mock.calls as [Sent, string][])
      .map(([message]) => message)
      .filter((message) => !type || message.type === type);
  return { win, post, sent };
}

function deliver(source: Window | null, data: unknown, origin = ORIGIN) {
  window.dispatchEvent(new MessageEvent("message", { data, origin, source }));
}

const from = (appId: string, type: string, id: string, payload: unknown = {}, version = 1) => ({
  type,
  from: appId,
  to: "dashboard",
  version,
  id,
  payload,
});

let hub: BridgeHub;
let nextId: number;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  nextId = 0;
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  hub = new BridgeHub({
    apps: APPS,
    selfId: "dashboard",
    newId: () => `generated-id-${++nextId}`,
  });
  hub.start();
});

afterEach(() => {
  hub.stop();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

/** Mounts an app's frame and brings it to "ready" the way a real page would. */
function connect(appId: string) {
  const frame = makeFrame();
  hub.attachFrame(appId, () => frame.win);
  hub.frameLoaded(appId);
  deliver(frame.win, from(appId, "ready", "ready-00001"));
  // The hub answers ready with a ping; a real bridge answers that straight away.
  deliver(frame.win, from(appId, "pong", frame.sent("ping").at(-1)!.id));
  return frame;
}

describe("health", () => {
  it("starts idle for active apps and coming-soon for the rest", () => {
    expect(hub.getSnapshot()).toEqual({
      payroll: "idle",
      "pdf-editor": "idle",
      payslip: "coming-soon",
    });
  });

  it("answers ready with a ping, so the app learns it is connected", () => {
    const frame = makeFrame();
    hub.attachFrame("pdf-editor", () => frame.win);
    expect(frame.sent("ping")).toHaveLength(0);
    deliver(frame.win, from("pdf-editor", "ready", "ready-00001"));
    expect(frame.sent("ping")).toHaveLength(1);
  });

  it("goes loading -> ready when the app says ready", () => {
    const frame = makeFrame();
    hub.attachFrame("pdf-editor", () => frame.win);
    expect(hub.getSnapshot()["pdf-editor"]).toBe("loading");
    deliver(frame.win, from("pdf-editor", "ready", "ready-00001"));
    expect(hub.getSnapshot()["pdf-editor"]).toBe("ready");
  });

  it("reports a page that loads but never answers as having no bridge, not as an error", () => {
    const frame = makeFrame();
    hub.attachFrame("pdf-editor", () => frame.win);
    hub.frameLoaded("pdf-editor");
    vi.advanceTimersByTime(6_000);
    expect(hub.getSnapshot()["pdf-editor"]).toBe("no-bridge");
  });

  it("reports a frame that never loads as failed", () => {
    const frame = makeFrame();
    hub.attachFrame("pdf-editor", () => frame.win);
    vi.advanceTimersByTime(20_000);
    expect(hub.getSnapshot()["pdf-editor"]).toBe("failed");
  });

  it("withdraws readiness on every load and asks the new page to prove itself", () => {
    const frame = connect("pdf-editor");
    expect(hub.getSnapshot()["pdf-editor"]).toBe("ready");

    hub.frameLoaded("pdf-editor"); // reload or in-frame navigation
    expect(hub.getSnapshot()["pdf-editor"]).toBe("loading");

    const ping = frame.sent("ping").at(-1)!;
    deliver(frame.win, from("pdf-editor", "pong", ping.id));
    expect(hub.getSnapshot()["pdf-editor"]).toBe("ready");
  });

  it("turns unresponsive after two unanswered pings and recovers on a pong", () => {
    const frame = connect("pdf-editor");
    vi.advanceTimersByTime(15_000); // ping 1 sent
    vi.advanceTimersByTime(15_000); // ping 1 missed, ping 2 sent
    expect(hub.getSnapshot()["pdf-editor"]).toBe("ready");
    vi.advanceTimersByTime(15_000); // ping 2 missed
    expect(hub.getSnapshot()["pdf-editor"]).toBe("unresponsive");

    const ping = frame.sent("ping").at(-1)!;
    deliver(frame.win, from("pdf-editor", "pong", ping.id));
    expect(hub.getSnapshot()["pdf-editor"]).toBe("ready");
  });

  it("does not ping, or count misses, while the tab is hidden", () => {
    const frame = connect("pdf-editor");
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    const before = frame.sent("ping").length;

    vi.advanceTimersByTime(120_000);
    expect(frame.sent("ping")).toHaveLength(before);
    expect(hub.getSnapshot()["pdf-editor"]).toBe("ready");

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(frame.sent("ping")).toHaveLength(before + 1);
    visibility.mockRestore();
  });
});

describe("incoming message checks", () => {
  it("ignores a valid-looking message from a window that is not a registered iframe", () => {
    connect("pdf-editor");
    const stranger = makeFrame();
    const onData = vi.fn(() => ({ ok: true }) as const);
    hub.setHandlers({ onData });

    // Right origin, right shape, claims to be the payroll app: but the source is not its frame.
    deliver(stranger.win, from("payroll", "send-data", "msg-000001", DATA));
    deliver(null, from("payroll", "send-data", "msg-000002", DATA));

    expect(onData).not.toHaveBeenCalled();
    expect(stranger.post).not.toHaveBeenCalled();
  });

  it("does not let one app speak as another", () => {
    const pdf = connect("pdf-editor");
    connect("payroll");
    const onData = vi.fn(() => ({ ok: true }) as const);
    hub.setHandlers({ onData });

    deliver(pdf.win, from("payroll", "send-data", "msg-000001", DATA));

    expect(onData).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.any(String), {
      app: "pdf-editor",
      reason: "wrong-addressing",
    });
  });

  it("rejects the wrong origin", () => {
    const frame = makeFrame();
    hub.attachFrame("pdf-editor", () => frame.win);
    deliver(frame.win, from("pdf-editor", "ready", "ready-00001"), "https://evil.example");
    expect(hub.getSnapshot()["pdf-editor"]).toBe("loading");
    expect(warn).toHaveBeenCalledWith(expect.any(String), {
      app: "pdf-editor",
      reason: "wrong-origin",
    });
  });

  it("rejects the wrong protocol version", () => {
    const frame = makeFrame();
    hub.attachFrame("pdf-editor", () => frame.win);
    deliver(frame.win, from("pdf-editor", "ready", "ready-00001", {}, 2));
    expect(hub.getSnapshot()["pdf-editor"]).toBe("loading");
    expect(warn).toHaveBeenCalledWith(expect.any(String), {
      app: "pdf-editor",
      reason: "wrong-version",
    });
  });

  it("rejects malformed messages and unknown types", () => {
    const frame = connect("payroll");
    const onData = vi.fn(() => ({ ok: true }) as const);
    hub.setHandlers({ onData });

    deliver(frame.win, "hello");
    deliver(frame.win, { type: "send-data" });
    deliver(frame.win, from("payroll", "send-data", "msg-000001", { dataType: "payroll-result" }));
    deliver(frame.win, from("payroll", "send-data", "msg-000002", { ...DATA, rows: [] }));
    deliver(frame.win, from("payroll", "delete-everything", "msg-000003"));
    deliver(frame.win, from("payroll", "send-data", "x", DATA)); // id too short

    expect(onData).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(6);
  });

  it("never logs message contents when rejecting", () => {
    const frame = connect("payroll");
    deliver(frame.win, { type: "send-data", secret: "Rs 99,999 for X0000000000001" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("99,999");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("X0000000000001");
  });
});

describe("sending", () => {
  it("posts with the app's exact origin, never a wildcard", async () => {
    const frame = connect("pdf-editor");
    void hub.send("pdf-editor", DATA);
    vi.advanceTimersByTime(15_000);

    expect(frame.post.mock.calls.length).toBeGreaterThan(0);
    for (const [, targetOrigin] of frame.post.mock.calls) {
      expect(targetOrigin).toBe(ORIGIN);
    }
  });

  it("resolves when the app acknowledges", async () => {
    const frame = connect("pdf-editor");
    const result = hub.send("pdf-editor", DATA);
    const message = frame.sent("send-data")[0]!;
    expect(message).toMatchObject({
      from: "dashboard",
      to: "pdf-editor",
      version: 1,
      payload: DATA,
    });

    deliver(frame.win, from("pdf-editor", "received", message.id, { ok: true }));
    await expect(result).resolves.toEqual({ ok: true, id: message.id });
  });

  it("reports the app's own error when it refuses the data", async () => {
    const frame = connect("pdf-editor");
    const result = hub.send("pdf-editor", DATA);
    const { id } = frame.sent("send-data")[0]!;
    deliver(frame.win, from("pdf-editor", "received", id, { ok: false, error: "No template" }));
    await expect(result).resolves.toEqual({
      ok: false,
      id,
      reason: "rejected",
      error: "No template",
    });
  });

  it("queues until the app is ready, then delivers", async () => {
    const frame = makeFrame();
    hub.attachFrame("pdf-editor", () => frame.win);
    const result = hub.send("pdf-editor", DATA);
    expect(frame.sent("send-data")).toHaveLength(0);

    vi.advanceTimersByTime(3_000);
    deliver(frame.win, from("pdf-editor", "ready", "ready-00001"));
    const message = frame.sent("send-data")[0]!;
    expect(message.payload).toEqual(DATA);

    deliver(frame.win, from("pdf-editor", "received", message.id, { ok: true }));
    await expect(result).resolves.toMatchObject({ ok: true });
  });

  it("does not release queued data to a page that has not proven itself after a reload", async () => {
    const frame = connect("pdf-editor");
    hub.frameLoaded("pdf-editor"); // a different page may now be in the frame
    void hub.send("pdf-editor", DATA);
    expect(frame.sent("send-data")).toHaveLength(0);

    const ping = frame.sent("ping").at(-1)!;
    deliver(frame.win, from("pdf-editor", "pong", ping.id));
    expect(frame.sent("send-data")).toHaveLength(1);
  });

  it("gives up with not-ready if the app never becomes ready", async () => {
    const frame = makeFrame();
    hub.attachFrame("pdf-editor", () => frame.win);
    const result = hub.send("pdf-editor", DATA);
    vi.advanceTimersByTime(10_000);
    await expect(result).resolves.toMatchObject({ ok: false, reason: "not-ready" });

    // Becoming ready later must not deliver data the user was told had failed.
    deliver(frame.win, from("pdf-editor", "ready", "ready-00001"));
    expect(frame.sent("send-data")).toHaveLength(0);
  });

  it("times out when no acknowledgement arrives", async () => {
    const frame = connect("pdf-editor");
    const result = hub.send("pdf-editor", DATA);
    vi.advanceTimersByTime(9_999);
    expect(frame.sent("send-data")).toHaveLength(1);
    vi.advanceTimersByTime(1);
    await expect(result).resolves.toMatchObject({ ok: false, reason: "timeout" });
  });

  it("ignores an acknowledgement that arrives after the timeout", async () => {
    const frame = connect("pdf-editor");
    const result = hub.send("pdf-editor", DATA);
    const { id } = frame.sent("send-data")[0]!;
    vi.advanceTimersByTime(10_000);
    await expect(result).resolves.toMatchObject({ ok: false, reason: "timeout" });

    expect(() =>
      deliver(frame.win, from("pdf-editor", "received", id, { ok: true })),
    ).not.toThrow();
  });

  it("retries with the same id, so the app can recognise the duplicate", async () => {
    const frame = connect("pdf-editor");
    const first = await (async () => {
      const result = hub.send("pdf-editor", DATA);
      vi.advanceTimersByTime(10_000);
      return result;
    })();
    expect(first.ok).toBe(false);

    const retry = hub.send("pdf-editor", DATA, { id: first.id });
    const sent = frame.sent("send-data");
    expect(sent).toHaveLength(2);
    expect(sent[1]!.id).toBe(sent[0]!.id);

    deliver(frame.win, from("pdf-editor", "received", first.id, { ok: true }));
    await expect(retry).resolves.toEqual({ ok: true, id: first.id });
  });

  it("only accepts an acknowledgement from the app the data was sent to", async () => {
    const pdf = connect("pdf-editor");
    const payroll = connect("payroll");
    const result = hub.send("pdf-editor", DATA);
    const { id } = pdf.sent("send-data")[0]!;

    deliver(payroll.win, from("payroll", "received", id, { ok: true }));
    vi.advanceTimersByTime(10_000);
    await expect(result).resolves.toMatchObject({ ok: false, reason: "timeout" });
  });

  it("is unavailable for coming-soon apps and unmounted frames", async () => {
    await expect(hub.send("payslip", DATA)).resolves.toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    await expect(hub.send("pdf-editor", DATA)).resolves.toMatchObject({
      ok: false,
      reason: "unavailable",
    });
  });

  it("drops queued and in-flight payloads on clear (sign-out)", async () => {
    const frame = makeFrame();
    hub.attachFrame("pdf-editor", () => frame.win);
    const result = hub.send("pdf-editor", DATA);
    hub.clear();
    await expect(result).resolves.toMatchObject({ ok: false, reason: "unavailable" });

    deliver(frame.win, from("pdf-editor", "ready", "ready-00001"));
    expect(frame.sent("send-data")).toHaveLength(0);
  });
});

describe("data from apps", () => {
  it("hands payroll results to the handler and acknowledges with the same id", () => {
    const frame = connect("payroll");
    const onData = vi.fn(() => ({ ok: true }) as const);
    hub.setHandlers({ onData });

    deliver(frame.win, from("payroll", "send-data", "msg-000001", DATA));

    expect(onData).toHaveBeenCalledWith("payroll", DATA);
    expect(frame.sent("received")).toEqual([
      {
        type: "received",
        from: "dashboard",
        to: "payroll",
        version: 1,
        id: "msg-000001",
        payload: { ok: true },
      },
    ]);
  });

  it("refuses data from an app that is not registered to produce it", () => {
    const frame = connect("pdf-editor");
    const onData = vi.fn(() => ({ ok: true }) as const);
    hub.setHandlers({ onData });

    deliver(frame.win, from("pdf-editor", "send-data", "msg-000001", DATA));

    expect(onData).not.toHaveBeenCalled();
    expect(frame.sent("received")[0]!.payload).toMatchObject({ ok: false });
  });

  it("answers a data request through the handler, with the request's id", async () => {
    const frame = connect("pdf-editor");
    const onRequest = vi.fn(async () => ({ ok: true, ...DATA }) as const);
    hub.setHandlers({ onRequest });

    deliver(
      frame.win,
      from("pdf-editor", "request-data", "req-000001", { dataType: "payroll-result" }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(onRequest).toHaveBeenCalledWith("pdf-editor", { dataType: "payroll-result" });
    expect(frame.sent("response-data")[0]).toMatchObject({
      id: "req-000001",
      to: "pdf-editor",
      payload: { ok: true, rows: DATA.rows },
    });
  });

  it("refuses a data request from an app that does not accept that data", async () => {
    const frame = connect("payroll");
    const onRequest = vi.fn(async () => ({ ok: true, ...DATA }) as const);
    hub.setHandlers({ onRequest });

    deliver(
      frame.win,
      from("payroll", "request-data", "req-000001", { dataType: "payroll-result" }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(onRequest).not.toHaveBeenCalled();
    expect(frame.sent("response-data")[0]!.payload).toMatchObject({ ok: false });
  });
});
