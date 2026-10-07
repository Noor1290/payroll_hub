import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeHub, SAVE_UNCONFIRMED, type HubApp } from "./hub";
import {
  checkAnswer,
  checkRequest,
  checkSentData,
  incomingMessageSchema,
  jsonBytes,
  receivedPayloadSchema,
  REFUSAL_CODES,
  responseDataPayloadSchema,
  rulesFor,
  type ReceivedPayload,
  type ResponseDataPayload,
} from "./protocol";

const ORIGIN = "https://noor1290.github.io";
const TYPES = ["payroll-result", "statutory-rates", "payslip-template", "payslip-issue"];
const APPS: HubApp[] = [
  {
    id: "payslip",
    origin: ORIGIN,
    protocolVersion: 1,
    accepts: TYPES,
    produces: TYPES,
    active: true,
  },
];

interface Sent {
  type: string;
  id: string;
  payload: Record<string, unknown>;
}

let hub: BridgeHub;
let win: Window;
let post: ReturnType<typeof vi.fn>;

const sent = (type: string) =>
  (post.mock.calls as [Sent, string][]).map(([m]) => m).filter((m) => m.type === type);
const say = (type: string, id: string, payload: unknown) =>
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { type, from: "payslip", to: "dashboard", version: 1, id, payload },
      origin: ORIGIN,
      source: win,
    }),
  );
const save = (dataType: string, rows: unknown[], id = "save-0000001") =>
  say("send-data", id, { dataType, rows });

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  hub = new BridgeHub({ apps: APPS, selfId: "dashboard" });
  hub.start();
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  win = iframe.contentWindow!;
  post = vi.fn();
  win.postMessage = post as unknown as Window["postMessage"];
  hub.attachFrame("payslip", () => win);
  hub.frameLoaded("payslip");
  say("ready", "ready-0000001", {});
});
afterEach(() => {
  hub.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("a save that takes time (asynchronous onData)", () => {
  it("is acknowledged with the handler's answer, including its result, once it settles", async () => {
    hub.setHandlers({
      onData: async () => ({ ok: true, result: { effective_from: "2026-07", revision: 2 } }),
    });
    save("statutory-rates", [{ any: 1 }]);
    expect(sent("received")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent("received")).toEqual([
      expect.objectContaining({
        id: "save-0000001",
        payload: { ok: true, result: { effective_from: "2026-07", revision: 2 } },
      }),
    ]);
  });

  it("passes a refusal through with its code", async () => {
    hub.setHandlers({ onData: async () => ({ ok: false, code: "stale", error: "Reload first." }) });
    save("statutory-rates", [{ any: 1 }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent("received")[0]!.payload).toEqual({
      ok: false,
      code: "stale",
      error: "Reload first.",
    });
  });

  it("answers by itself at 8 seconds, before the app's own 10-second wait runs out", async () => {
    let finish!: (ack: ReceivedPayload) => void;
    hub.setHandlers({
      onData: () => new Promise<ReceivedPayload>((resolve) => (finish = resolve)),
    });
    save("statutory-rates", [{ any: 1 }]);

    await vi.advanceTimersByTimeAsync(7_999);
    expect(sent("received")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent("received")).toHaveLength(1);
    expect(sent("received")[0]!.payload).toEqual(SAVE_UNCONFIRMED);
    expect(SAVE_UNCONFIRMED).toMatchObject({ ok: false, code: "unavailable" });
    expect((SAVE_UNCONFIRMED as { error: string }).error).toMatch(/reload/i);

    // The handler finishing later sends nothing more: one message, one answer.
    finish({ ok: true, result: { revision: 3 } });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent("received")).toHaveLength(1);
  });

  it("does not answer a second time at 8 seconds when the handler was quick", async () => {
    hub.setHandlers({ onData: async () => ({ ok: true }) });
    save("statutory-rates", [{ any: 1 }]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sent("received")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1); // only the hub's ping interval is left
  });

  it.each([
    ["rejects", () => Promise.reject(new Error("boom"))],
    [
      "throws",
      () => {
        throw new Error("boom");
      },
    ],
  ])('answers "unavailable", never silence, when the handler %s', async (_how, onData) => {
    hub.setHandlers({ onData });
    save("statutory-rates", [{ any: 1 }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent("received")[0]!.payload).toEqual(SAVE_UNCONFIRMED);
  });

  it("still acknowledges a synchronous handler in the same turn (payroll results)", () => {
    hub.setHandlers({ onData: () => ({ ok: true }) });
    save("payroll-result", [{ Surname: "DOE" }]);
    expect(sent("received")[0]!.payload).toEqual({ ok: true });
  });
});

describe("limits per data type", () => {
  const onData = vi.fn(async () => ({ ok: true }) as const);
  beforeEach(() => {
    onData.mockClear();
    hub.setHandlers({ onData });
  });

  it("refuses more than one row for a save, without calling the handler", () => {
    save("statutory-rates", [{ a: 1 }, { a: 2 }]);
    expect(onData).not.toHaveBeenCalled();
    expect(sent("received")[0]!.payload).toMatchObject({ ok: false, code: "invalid" });
  });

  it("refuses a template message that is too large, without calling the handler", () => {
    save("payslip-template", [{ body: { pad: "x".repeat(170_000) } }]);
    expect(onData).not.toHaveBeenCalled();
    expect(sent("received")[0]!.payload).toMatchObject({ ok: false, code: "too-large" });
  });

  it("lets a template of 150 KB through to its handler", async () => {
    const body = { pad: "x".repeat(149_000) };
    expect(jsonBytes(body)).toBeLessThan(150_000);
    save("payslip-template", [{ action: "save-draft", name: "Monthly", body }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(onData).toHaveBeenCalledTimes(1);
  });

  it("takes a month of payslips as ONE row of at most 4 MB", async () => {
    save("payslip-issue", [{ action: "issue" }, { action: "issue" }]);
    expect(onData).not.toHaveBeenCalled();
    expect(sent("received")[0]!.payload).toMatchObject({ ok: false, code: "invalid" });

    post.mockClear();
    const payslip = { lines: [{ pad: "x".repeat(15_000) }] };
    save("payslip-issue", [{ action: "issue", payslips: Array(270).fill(payslip) }]);
    expect(onData).not.toHaveBeenCalled();
    expect(sent("received")[0]!.payload).toMatchObject({ ok: false, code: "too-large" });

    post.mockClear();
    save("payslip-issue", [{ action: "issue", payslips: Array(250).fill(payslip) }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(onData).toHaveBeenCalledTimes(1);
    expect(rulesFor("payslip-issue").answerRows).toEqual([0, 5_000]);
  });

  it("keeps payroll results at one row or more, up to 10,000", () => {
    expect(rulesFor("payroll-result")).toEqual(rulesFor("something-new"));
    expect(checkSentData({ dataType: "payroll-result", rows: Array(10_000).fill({}) })).toBeNull();
    const none = incomingMessageSchema.safeParse({
      type: "send-data",
      from: "payslip",
      to: "dashboard",
      version: 1,
      id: "save-0000001",
      payload: { dataType: "statutory-rates", rows: [] },
    });
    expect(none.success).toBe(false);
  });

  it("refuses request params that are too large", async () => {
    const onRequest = vi.fn(async (): Promise<ResponseDataPayload> => ({ ok: false, error: "x" }));
    hub.setHandlers({ onRequest });
    say("request-data", "request-000001", {
      dataType: "statutory-rates",
      params: { brn: "x".repeat(3_000) },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(onRequest).not.toHaveBeenCalled();
    expect(sent("response-data")[0]!.payload).toMatchObject({ ok: false, code: "too-large" });
    expect(checkRequest({ dataType: "statutory-rates", params: { brn: "C1" } })).toBeNull();
  });
});

describe("answers to requests", () => {
  const answerWith = async (payload: ResponseDataPayload, request: Record<string, unknown>) => {
    const onRequest = vi.fn(async () => payload);
    hub.setHandlers({ onRequest });
    say("request-data", "request-000001", request);
    await vi.advanceTimersByTimeAsync(0);
    return { onRequest, answer: sent("response-data")[0]!.payload };
  };

  it("hands the request's params to the handler", async () => {
    const request = { dataType: "payslip-template", params: { action: "list", brn: "C1" } };
    const { onRequest } = await answerWith({ ok: false, error: "x" }, request);
    expect(onRequest).toHaveBeenCalledWith("payslip", request);
  });

  it("may have no rows for statutory rates and templates", async () => {
    for (const dataType of ["statutory-rates", "payslip-template"]) {
      post.mockClear();
      const payload: ResponseDataPayload = {
        ok: true,
        dataType,
        rows: [],
        meta: { label: "ABC Co Ltd", brn: "C1" },
      };
      const { answer } = await answerWith(payload, { dataType });
      expect(answer).toEqual(payload);
    }
  });

  it("never sends payroll results with no rows", async () => {
    const empty: ResponseDataPayload = { ok: true, dataType: "payroll-result", rows: [] };
    const { answer } = await answerWith(empty, { dataType: "payroll-result" });
    expect(answer).toMatchObject({ ok: false, code: "not-found" });
    expect(checkAnswer(empty)).not.toBeNull();
  });
});

describe("the payload schemas", () => {
  it("accept an optional result on an ok acknowledgement, and a code on a refusal", () => {
    expect(receivedPayloadSchema.safeParse({ ok: true }).success).toBe(true);
    expect(receivedPayloadSchema.safeParse({ ok: true, result: { revision: 1 } }).success).toBe(
      true,
    );
    for (const code of REFUSAL_CODES) {
      expect(receivedPayloadSchema.safeParse({ ok: false, error: "x", code }).success).toBe(true);
      expect(responseDataPayloadSchema.safeParse({ ok: false, error: "x", code }).success).toBe(
        true,
      );
    }
    expect(receivedPayloadSchema.safeParse({ ok: false, error: "x", code: "nope" }).success).toBe(
      false,
    );
  });

  it("carry the position of the payslip at fault on a refused save, as a whole number from 0", () => {
    const refusal = { ok: false, error: "x", code: "stale" };
    expect(receivedPayloadSchema.parse({ ...refusal, index: 2 })).toEqual({ ...refusal, index: 2 });
    expect(receivedPayloadSchema.parse({ ...refusal, index: 0 })).toEqual({ ...refusal, index: 0 });
    for (const index of [-1, 1.5, "2"]) {
      expect(receivedPayloadSchema.safeParse({ ...refusal, index }).success).toBe(false);
    }
  });

  it("carry the user's role in an answer's meta: admin or member, nothing else", () => {
    const answer = (role: unknown) =>
      responseDataPayloadSchema.safeParse({
        ok: true,
        dataType: "statutory-rates",
        rows: [],
        meta: { label: "ABC Co Ltd", brn: "C1", role },
      });
    for (const role of ["admin", "member"]) {
      const parsed = answer(role);
      expect(parsed.success && parsed.data.ok && parsed.data.meta?.role).toBe(role);
    }
    expect(answer(undefined).success).toBe(true);
    for (const role of ["viewer", "owner", "", 1]) expect(answer(role).success).toBe(false);
  });

  it("list exactly the agreed refusal codes", () => {
    expect([...REFUSAL_CODES].sort()).toEqual(
      [
        "denied",
        "forbidden",
        "invalid",
        "locked",
        "no-change",
        "not-found",
        "stale",
        "timeout",
        "too-large",
        "unavailable",
        "wrong-company",
      ].sort(),
    );
  });
});
