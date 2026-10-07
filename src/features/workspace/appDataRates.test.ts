import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearTransferLog, transferLog } from "@/features/transfer/transferLog";
import { bridge, dataRequests } from "@/lib/bridge/bridge";
import { runSessionCleanup } from "@/lib/sessionCleanup";
import type { Membership } from "@/lib/supabase/schemas";
import { isUnlocked, lock } from "@/lib/unlock";
import { fake } from "@/test/fakeClient";
import { answerRatesRequest, exchangeContext, refusalFor, saveRates } from "./appData";

vi.mock("@/lib/supabase/client", async () => ({
  supabase: (await import("@/test/fakeClient")).fake.client,
}));
const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  loading: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));

// FAKE values only.
const ME = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";
const ABC = "10000000-0000-4000-8000-000000000001";
const company = { id: ABC, name: "ABC Co Ltd", address: "Mauritius", brn: "C1234567", vat: "12%" };
const signIn = (role: Membership["role"] = "admin", more: Partial<typeof company> = {}) =>
  exchangeContext.set({
    viewer: { id: ME, isDemo: false },
    membership: { role, company: { ...company, ...more } },
  });

const stored = (more: Record<string, unknown> = {}) => ({
  effective_from: "2026-07-01",
  revision: 1,
  nsf_employee_rate: 1,
  nsf_ceiling: 29710,
  nsf_exempt_at_60: true,
  csg_employee_rate_low: 1.5,
  csg_employee_rate_high: 3,
  csg_threshold: 50000,
  source_note: "Finance Act 2026",
  created_by: ME,
  created_at: "2026-07-02T09:00:00+04:00",
  ...more,
});
const SAVE = {
  brn: "C1234567",
  effective_from: "2026-07",
  expected_revision: 1,
  nsf_employee_rate: 1,
  nsf_ceiling: 29710,
  nsf_exempt_at_60: true,
  csg_employee_rate_low: 1.5,
  csg_employee_rate_high: 3,
  csg_threshold: 50000.5,
  source_note: "Finance Act 2026",
};
const request = (params?: Record<string, unknown>) =>
  answerRatesRequest({ dataType: "statutory-rates", ...(params ? { params } : {}) });
const save = (row: Record<string, unknown> = SAVE) =>
  saveRates({ dataType: "statutory-rates", rows: [row] });

beforeEach(() => {
  fake.reset();
  signIn();
  toast.success.mockClear();
  toast.error.mockClear();
});
afterEach(() => {
  runSessionCleanup();
  clearTransferLog();
  lock();
});

describe("statutory-rates: a request", () => {
  it("answers with every version of the selected company, months as YYYY-MM, and no user id", async () => {
    fake.reset(() => ({
      data: [stored({ revision: 2, created_by: OTHER }), stored(), stored({ created_by: null })],
    }));
    const answer = await request();
    expect(answer).toEqual({
      ok: true,
      dataType: "statutory-rates",
      meta: { label: "ABC Co Ltd", brn: "C1234567" },
      rows: [
        expect.objectContaining({ effective_from: "2026-07", revision: 2, created_by_you: false }),
        {
          effective_from: "2026-07",
          revision: 1,
          nsf_employee_rate: 1,
          nsf_ceiling: 29710,
          nsf_exempt_at_60: true,
          csg_employee_rate_low: 1.5,
          csg_employee_rate_high: 3,
          csg_threshold: 50000,
          source_note: "Finance Act 2026",
          created_at: "2026-07-02T09:00:00+04:00",
          created_by_you: true,
        },
        expect.objectContaining({ created_by_you: false }),
      ],
    });
    expect(JSON.stringify(answer)).not.toContain(OTHER);
    expect(JSON.stringify(answer)).not.toContain('created_by"');
    // Read only, and only this company's rows.
    expect(fake.state.queries).toHaveLength(1);
    expect(fake.state.queries[0]).toEqual(
      expect.arrayContaining([
        ["from", "statutory_rates"],
        ["eq", "company_id", ABC],
      ]),
    );
  });

  it("answers with no rows when the company has none yet", async () => {
    expect(await request()).toMatchObject({ ok: true, rows: [] });
  });

  it("accepts the selected company's BRN, whatever the capitals and spaces", async () => {
    expect(await request({ brn: " c1234567 " })).toMatchObject({ ok: true });
  });

  it.each([{ brn: "C7654321" }, { brn: "C123456" }])(
    "refuses %j as the wrong company, without reading anything",
    async (params) => {
      expect(await request(params)).toMatchObject({ ok: false, code: "wrong-company" });
      expect(fake.state.queries).toHaveLength(0);
    },
  );

  it("refuses a BRN when the selected company has none", async () => {
    signIn("admin", { brn: null as unknown as string });
    expect(await request({ brn: "C1234567" })).toMatchObject({ ok: false, code: "wrong-company" });
    expect(await request()).toMatchObject({ ok: true, meta: { label: "ABC Co Ltd" } });
  });

  it.each([{ company: ABC }, { brn: 12 }, { brn: "" }])(
    "refuses params %j as invalid",
    async (params) => {
      expect(await request(params)).toMatchObject({ ok: false, code: "invalid" });
      expect(fake.state.queries).toHaveLength(0);
    },
  );

  it("is unavailable when nobody is signed in or no company is selected", async () => {
    exchangeContext.set(null);
    expect(await request()).toMatchObject({ ok: false, code: "unavailable" });
    expect(fake.state.queries).toHaveLength(0);
  });

  it("names the migration to run when the table is not there", async () => {
    fake.reset(() => ({ error: { code: "PGRST205", message: "not in the schema cache" } }));
    const answer = await request();
    expect(answer).toMatchObject({ ok: false, code: "unavailable" });
    expect((answer as { error: string }).error).toContain("0009_statutory_rates.sql");
  });

  it("refuses rather than pass on rows that are not what it expects", async () => {
    fake.reset(() => ({ data: [stored({ revision: "two" })] }));
    expect(await request()).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("is answered for a viewer too: members may read", async () => {
    signIn("viewer");
    expect(await request()).toMatchObject({ ok: true });
  });
});

describe("statutory-rates: a save", () => {
  const saved = () => ({
    data: { id: "x", effective_from: "2026-07-01", revision: 2, created_at: "t" },
  });

  it("calls the database function with the values exactly as sent, and returns the new revision", async () => {
    fake.reset(saved);
    expect(await save()).toEqual({ ok: true, result: { effective_from: "2026-07", revision: 2 } });
    expect(fake.state.queries).toEqual([
      [
        [
          "rpc",
          "save_statutory_rates",
          {
            p_company_id: ABC,
            p_effective_from: "2026-07-01",
            p_expected_revision: 1,
            p_nsf_employee_rate: 1,
            p_nsf_ceiling: 29710,
            p_nsf_exempt_at_60: true,
            p_csg_employee_rate_low: 1.5,
            p_csg_employee_rate_high: 3,
            p_csg_threshold: 50000.5,
            p_source_note: "Finance Act 2026",
          },
        ],
      ],
    ]);
  });

  it("sends no note as null, with or without the key", async () => {
    fake.reset(saved);
    const { source_note: _note, ...withoutNote } = SAVE;
    void _note;
    for (const row of [
      withoutNote,
      { ...SAVE, source_note: null },
      { ...SAVE, source_note: "  " },
    ]) {
      fake.reset(saved);
      await save(row);
      expect(fake.arg(fake.state.queries[0]!, "rpc", 1)).toMatchObject({ p_source_note: null });
    }
  });

  it("refuses a viewer before reaching the database", async () => {
    signIn("viewer");
    expect(await save()).toMatchObject({ ok: false, code: "forbidden" });
    expect(fake.state.queries).toHaveLength(0);
  });

  it("refuses a save for another company, or with no BRN, before reaching the database", async () => {
    expect(await save({ ...SAVE, brn: "C7654321" })).toMatchObject({
      ok: false,
      code: "wrong-company",
    });
    const { brn: _brn, ...noBrn } = SAVE;
    void _brn;
    expect(await save(noBrn)).toMatchObject({ ok: false, code: "invalid" });
    expect(fake.state.queries).toHaveLength(0);
  });

  it.each([
    ["a rate as text", { nsf_employee_rate: "1" }],
    ["a rate above 100", { csg_employee_rate_high: 100.5 }],
    ["a rate with 5 decimals", { csg_employee_rate_low: 1.50001 }],
    ["an amount with 3 decimals", { nsf_ceiling: 29710.005 }],
    ["a negative amount", { csg_threshold: -1 }],
    ["a month with a day", { effective_from: "2026-07-01" }],
    ["month 13", { effective_from: "2026-13" }],
    ["no last-seen revision", { expected_revision: undefined }],
    ["a fractional revision", { expected_revision: 1.5 }],
    ["a missing setting", { nsf_exempt_at_60: undefined }],
    ["a field it does not know", { nsf_employer_rate: 2.5 }],
    ["a note of 301 characters", { source_note: "x".repeat(301) }],
  ])(
    "refuses %s as invalid, without rounding it and without reaching the database",
    async (_what, change) => {
      const answer = await save({ ...SAVE, ...change });
      expect(answer).toMatchObject({ ok: false, code: "invalid" });
      expect(fake.state.queries).toHaveLength(0);
      // The refusal names the field, never the value.
      expect((answer as { error: string }).error).not.toMatch(/29710|1\.50001|100\.5/);
    },
  );

  it.each([
    ["P0001", "PH_STALE", "stale"],
    ["P0001", "PH_NO_CHANGE", "no-change"],
    ["42501", "PH_NOT_ADMIN", "forbidden"],
    ["42501", "PH_NOT_SIGNED_IN", "forbidden"],
    [
      "22023",
      "PH_INVALID_INPUT: a rate must be between 0 and 100 with at most 4 decimals",
      "invalid",
    ],
    ["54000", "PH_LIMIT", "too-large"],
    ["54000", "PH_TOO_LARGE", "too-large"],
    ["P0002", "PH_NOT_FOUND", "not-found"],
    ["23505", "PH_DUPLICATE_NAME", "invalid"],
    ["PGRST202", "Could not find the function", "unavailable"],
    ["XX000", "something else", "unavailable"],
  ])("tells the app %s %s as code %s", async (code, message, expected) => {
    fake.reset(() => ({ error: { code, message } }));
    expect(await save()).toMatchObject({ ok: false, code: expected });
  });

  it("names the migration to run when the function is not there", () => {
    expect(
      refusalFor({ code: "PGRST202", message: "x" }, "0009_statutory_rates.sql").error,
    ).toContain("supabase/migrations/0009_statutory_rates.sql");
  });
});

describe("statutory-rates over the bridge: no dialog, no password gate", () => {
  const ORIGIN = "https://noor1290.github.io";
  interface Sent {
    type: string;
    id: string;
    payload: Record<string, unknown>;
  }

  function connect() {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const win = iframe.contentWindow!;
    const post = vi.fn();
    win.postMessage = post as unknown as Window["postMessage"];
    const say = (type: string, id: string, payload: unknown = {}) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type, from: "payslip", to: "dashboard", version: 1, id, payload },
          origin: ORIGIN,
          source: win,
        }),
      );
    bridge.start();
    bridge.attachFrame("payslip", () => win);
    bridge.frameLoaded("payslip");
    say("ready", "ready-0000001");
    const sent = (type: string) =>
      (post.mock.calls as [Sent, string][]).filter(([m]) => m.type === type).map(([m]) => m);
    return { say, sent };
  }
  afterEach(() => {
    bridge.stop();
    document.body.innerHTML = "";
  });

  it("answers a request straight away while the gate is locked, and logs it", async () => {
    fake.reset(() => ({ data: [stored()] }));
    const app = connect();
    expect(isUnlocked()).toBe(false);
    app.say("request-data", "request-000001", {
      dataType: "statutory-rates",
      params: { brn: "C1234567" },
    });
    await vi.waitFor(() => expect(app.sent("response-data")).toHaveLength(1));

    expect(app.sent("response-data")[0]).toMatchObject({
      id: "request-000001",
      payload: { ok: true, dataType: "statutory-rates", meta: { brn: "C1234567" } },
    });
    expect(dataRequests.get()).toHaveLength(0); // nothing waiting on the user
    expect(transferLog.get()).toEqual([
      expect.objectContaining({
        kind: "request",
        from: "Database",
        toName: "Payslip Automation",
        dataType: "statutory-rates",
        status: "delivered",
        rowCount: 1,
      }),
    ]);
  });

  it("saves, answers with the result, logs it and shows a toast", async () => {
    fake.reset(() => ({ data: { effective_from: "2026-07-01", revision: 2 } }));
    const app = connect();
    app.say("send-data", "save-00000001", { dataType: "statutory-rates", rows: [SAVE] });
    await vi.waitFor(() => expect(app.sent("received")).toHaveLength(1));

    expect(app.sent("received")[0]).toMatchObject({
      id: "save-00000001",
      payload: { ok: true, result: { effective_from: "2026-07", revision: 2 } },
    });
    expect(transferLog.get()).toEqual([
      expect.objectContaining({
        kind: "save",
        from: "Payslip Automation",
        toName: "Database",
        dataType: "statutory-rates",
        status: "delivered",
      }),
    ]);
    expect(toast.success).toHaveBeenCalledWith("Statutory rates saved for July 2026 (revision 2)", {
      description: "Saved from Payslip Automation.",
    });
    // No rate or amount in the log.
    expect(JSON.stringify(transferLog.get())).not.toMatch(/29710|50000/);
  });

  it("tells the app, the log and the user when a save is refused as stale", async () => {
    fake.reset(() => ({ error: { code: "P0001", message: "PH_STALE" } }));
    const app = connect();
    app.say("send-data", "save-00000002", { dataType: "statutory-rates", rows: [SAVE] });
    await vi.waitFor(() => expect(app.sent("received")).toHaveLength(1));
    expect(app.sent("received")[0]!.payload).toMatchObject({ ok: false, code: "stale" });
    expect(transferLog.get()[0]).toMatchObject({
      status: "failed",
      reason: "someone else saved first",
    });
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it("still refuses a data type the app is not registered for", async () => {
    const app = connect();
    app.say("request-data", "request-000002", { dataType: "payslip-archive" });
    app.say("send-data", "save-00000003", { dataType: "payslip-archive", rows: [{ a: 1 }] });
    await vi.waitFor(() => expect(app.sent("received")).toHaveLength(1));
    expect(app.sent("response-data")[0]!.payload.error).toMatch(/not registered/);
    expect(app.sent("received")[0]!.payload.error).toMatch(/not registered/);
    expect(fake.state.queries).toHaveLength(0);
  });
});
