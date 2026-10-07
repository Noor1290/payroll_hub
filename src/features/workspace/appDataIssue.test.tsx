import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext, type AuthContextValue } from "@/features/auth/auth-context";
import { CompanyContext, type CompanyContextValue } from "@/features/company/company-context";
import { clearTransferLog, transferLog } from "@/features/transfer/transferLog";
import { bridge, dataRequests } from "@/lib/bridge/bridge";
import { GATED_QUERY_KEYS, queryClient } from "@/lib/queryClient";
import { runSessionCleanup } from "@/lib/sessionCleanup";
import type { Membership } from "@/lib/supabase/schemas";
import { grantUnlock, lock } from "@/lib/unlock";
import { fake } from "@/test/fakeClient";
import { answerIssuedRequest, describeIssue, exchangeContext, issueFromApp } from "./appData";
import { BridgeDialogs } from "./BridgeDialogs";

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
const XYZ = "10000000-0000-4000-8000-000000000002";
const T1 = "20000000-0000-4000-8000-000000000001";
const NIC_1 = "X0000000000001";
const NIC_2 = "X0000000000002";
const NIC_3 = "X0000000000003";
type Company = Membership["company"];
const company: Company = {
  id: ABC,
  name: "ABC Co Ltd",
  address: "Mauritius",
  brn: "C1234567",
  vat: "12%",
};
const other: Company = {
  id: XYZ,
  name: "XYZ Trading Ltd",
  address: null,
  brn: "C7654321",
  vat: null,
};
const signIn = (role: Membership["role"] = "admin", of = company) =>
  exchangeContext.set({ viewer: { id: ME, isDemo: false }, membership: { role, company: of } });

const LINES = [
  { section: "earnings", label: "Basic salary", amount: 25000 },
  { section: "totals", label: "Net pay", amount: 18169.12 },
];
const RATES = {
  effective_from: "2026-07",
  revision: 2,
  nsf_employee_rate: 1,
  nsf_ceiling: 29710,
  nsf_exempt_at_60: true,
  csg_employee_rate_low: 1.5,
  csg_employee_rate_high: 3,
  csg_threshold: 50000,
};
const DIFFERENCE = {
  what: "Total Deductions",
  payroll: 502.87,
  payslip: 502.88,
  reason: "rounding",
};
const payslip = (more: Record<string, unknown> = {}) => ({
  national_id: NIC_1,
  expected_revision: 0,
  template_id: T1,
  template_version: 3,
  rates: null,
  lines: LINES,
  accepted_differences: [],
  ...more,
});
const MONTH = [
  payslip({ rates: RATES, accepted_differences: [DIFFERENCE] }),
  payslip({ national_id: NIC_2, expected_revision: 1 }),
  payslip({ national_id: NIC_3 }),
];
const ISSUE = { action: "issue", brn: "C1234567", period: "2026-09", payslips: MONTH };
const ISSUED = {
  period: "2026-09-01",
  issued: 3,
  issued_at: "2026-10-02T09:00:00+04:00",
  payslips: [
    { national_id: NIC_1, revision: 1 },
    { national_id: NIC_2, revision: 2 },
    { national_id: NIC_3, revision: 1 },
  ],
};
/** A row as issued_payslips_for_month returns it: with the issuer's user id. */
const stored = (more: Record<string, unknown> = {}) => ({
  national_id: NIC_1,
  revision: 2,
  template_id: T1,
  template_version: 3,
  rates: RATES,
  lines: LINES,
  accepted_differences: [DIFFERENCE],
  issued_by: ME,
  issued_at: "2026-10-02T09:00:00+04:00",
  ...more,
});

const issue = (row: Record<string, unknown> = ISSUE) =>
  issueFromApp({ dataType: "payslip-issue", rows: [row] });
const LOAD = { action: "load", brn: "C1234567", period: "2026-09" };
const ask = (params: Record<string, unknown> | undefined = LOAD) =>
  answerIssuedRequest("payslip", { dataType: "payslip-issue", ...(params ? { params } : {}) });
/** Asks, and agrees in the dialog's place: what "Send" does once the gate is open. */
async function askAndAgree(params: Record<string, unknown> = LOAD) {
  const answer = ask(params);
  const waiting = dataRequests.get()[0]!;
  waiting.respond(await waiting.question!.answer());
  return answer;
}
const cached = () => queryClient.getQueryCache().findAll({ queryKey: ["issued-payslips"] });

beforeEach(() => {
  fake.reset();
  signIn();
  toast.success.mockClear();
  toast.error.mockClear();
});
afterEach(() => {
  cleanup();
  runSessionCleanup();
  clearTransferLog();
  lock();
  queryClient.clear();
});

describe("payslip-issue: issuing a month", () => {
  it("refuses at once while the password gate is locked: nothing reaches the database", async () => {
    expect(await issue()).toEqual({
      ok: false,
      code: "locked",
      error: expect.stringMatching(/locked, so nothing was issued/),
    });
    expect(fake.state.queries).toHaveLength(0);
  });

  it("issues the whole month in one call, exactly as sent, and answers with each revision", async () => {
    grantUnlock(10);
    fake.reset(() => ({ data: ISSUED }));
    expect(await issue()).toEqual({
      ok: true,
      result: {
        period: "2026-09",
        issued: 3,
        issued_at: "2026-10-02T09:00:00+04:00",
        payslips: ISSUED.payslips,
      },
    });
    // One call, for the selected company and that month. Nothing is added, rounded or reordered.
    expect(fake.state.queries).toEqual([
      [["rpc", "issue_payslips", { p_company_id: ABC, p_period: "2026-09-01", p_payslips: MONTH }]],
    ]);
  });

  it("refuses a viewer, another company and a missing BRN before reaching the database", async () => {
    grantUnlock(10);
    signIn("viewer");
    expect(await issue()).toMatchObject({ ok: false, code: "forbidden" });
    signIn("admin", other);
    expect(await issue()).toMatchObject({ ok: false, code: "wrong-company" });
    signIn("admin", { ...company, brn: null });
    expect(await issue()).toMatchObject({ ok: false, code: "wrong-company" });
    signIn();
    const { brn: _brn, ...without } = ISSUE;
    void _brn;
    expect(await issue(without)).toMatchObject({ ok: false, code: "invalid" });
    exchangeContext.set(null);
    expect(await issue()).toMatchObject({ ok: false, code: "unavailable" });
    expect(fake.state.queries).toHaveLength(0);
  });

  it.each([
    ["no action", { ...ISSUE, action: undefined }],
    ["an action it does not know", { ...ISSUE, action: "delete" }],
    ["no month", { ...ISSUE, period: undefined }],
    ["a month that is not one", { ...ISSUE, period: "2026-13" }],
    ["no payslips", { ...ISSUE, payslips: [] }],
    ["a field it does not know", { ...ISSUE, issued_by: OTHER }],
  ])("refuses %s as invalid, with no position", async (_what, row) => {
    grantUnlock(10);
    const refusal = await issue(row);
    expect(refusal).toMatchObject({ ok: false, code: "invalid" });
    expect(refusal).not.toHaveProperty("index");
    expect(fake.state.queries).toHaveLength(0);
  });

  // The payslip at fault is the THIRD each time: the app is told position 2, counted from 0.
  it.each([
    ["no national ID", payslip({ national_id: "  " })],
    ["a last-seen revision of 1.5", payslip({ national_id: NIC_3, expected_revision: 1.5 })],
    ["a template id that is not one", payslip({ national_id: NIC_3, template_id: "abc" })],
    ["no template version", payslip({ national_id: NIC_3, template_version: undefined })],
    [
      "no word on the rates (the key is missing)",
      payslip({ national_id: NIC_3, rates: undefined }),
    ],
    [
      "rates with a field it does not know",
      payslip({ national_id: NIC_3, rates: { ...RATES, x: 1 } }),
    ],
    ["no lines", payslip({ national_id: NIC_3, lines: [] })],
    ["201 lines", payslip({ national_id: NIC_3, lines: Array(201).fill({ label: "x" }) })],
    ["a line that is not an object", payslip({ national_id: NIC_3, lines: ["Net pay"] })],
    [
      "an accepted difference with no reason",
      payslip({ national_id: NIC_3, accepted_differences: [{ ...DIFFERENCE, reason: " " }] }),
    ],
    [
      "an accepted difference that says who accepted it",
      payslip({
        national_id: NIC_3,
        accepted_differences: [{ ...DIFFERENCE, accepted_by: OTHER }],
      }),
    ],
    ["a field it does not know", payslip({ national_id: NIC_3, revision: 7 })],
    ["a revision chosen by the app", payslip({ national_id: NIC_3, issued_at: "2001-01-01" })],
  ])(
    "refuses a month because of %s in one payslip, and says which by its position",
    async (_what, third) => {
      grantUnlock(10);
      const refusal = await issue({ ...ISSUE, payslips: [MONTH[0], MONTH[1], third] });
      expect(refusal).toMatchObject({ ok: false, code: "invalid", index: 2 });
      expect(JSON.stringify(refusal)).not.toMatch(/X00000/);
      expect(fake.state.queries).toHaveLength(0);
    },
  );

  it("refuses more than 1,000 payslips as too large, without looking further", async () => {
    grantUnlock(10);
    const refusal = await issue({ ...ISSUE, payslips: Array(1001).fill({ any: "thing" }) });
    expect(refusal).toMatchObject({ ok: false, code: "too-large" });
    expect(refusal).not.toHaveProperty("index");
    expect(fake.state.queries).toHaveLength(0);
  });

  it("refuses a payslip over 16 KB as too large, and says which", async () => {
    grantUnlock(10);
    const big = payslip({ national_id: NIC_2, lines: [{ label: "x".repeat(16_000) }] });
    expect(await issue({ ...ISSUE, payslips: [MONTH[0], big] })).toMatchObject({
      ok: false,
      code: "too-large",
      index: 1,
    });
    expect(fake.state.queries).toHaveLength(0);
  });

  it("refuses a payslip with an image in a line, and says which", async () => {
    grantUnlock(10);
    const logo = payslip({
      national_id: NIC_2,
      lines: [{ label: "Logo", cells: [{ src: "data:image/png;base64,AAAA" }] }],
    });
    expect(await issue({ ...ISSUE, payslips: [MONTH[0], logo] })).toMatchObject({
      ok: false,
      code: "invalid",
      index: 1,
    });
    expect(fake.state.queries).toHaveLength(0);
  });

  it("refuses the same employee twice, whatever the spaces, and says which", async () => {
    grantUnlock(10);
    const again = payslip({ national_id: ` ${NIC_1} ` });
    expect(await issue({ ...ISSUE, payslips: [MONTH[0], MONTH[1], again] })).toMatchObject({
      ok: false,
      code: "invalid",
      index: 2,
    });
    expect(fake.state.queries).toHaveLength(0);
  });

  it.each([
    ["P0001", "PH_STALE: payslip 3", "stale", 2, /issued by someone else.*Nothing was issued/],
    ["P0002", "PH_UNKNOWN_EMPLOYEE: payslip 1", "not-found", 0, /not a current employee/],
    ["P0002", "PH_UNKNOWN_TEMPLATE: payslip 2", "not-found", 1, /template version/],
    ["54000", "PH_LIMIT: payslip 2", "too-large", 1, /limit/],
    ["54000", "PH_TOO_LARGE: payslip 4", "too-large", 3, /too large/],
    ["22023", "PH_INVALID_INPUT: payslip 2: it has no lines", "invalid", 1, /it has no lines/],
  ])(
    "tells the app which payslip the database refused (%s %s), by its position from 0",
    async (code, message, expected, index, text) => {
      grantUnlock(10);
      fake.reset(() => ({ error: { code, message } }));
      const refusal = await issue();
      expect(refusal).toEqual({ ok: false, code: expected, index, error: expect.any(String) });
      expect((refusal as { error: string }).error).toMatch(text);
      // The position is all the app is told: never a national ID.
      expect(JSON.stringify(refusal)).not.toMatch(/X00000/);
    },
  );

  it.each([
    ["42501", "PH_NOT_ADMIN", "forbidden"],
    ["54000", "PH_TOO_LARGE", "too-large"],
    ["22023", "PH_INVALID_INPUT: the month is missing", "invalid"],
  ])(
    "gives no position when the database names no payslip (%s %s)",
    async (code, message, expected) => {
      grantUnlock(10);
      fake.reset(() => ({ error: { code, message } }));
      const refusal = await issue();
      expect(refusal).toMatchObject({ ok: false, code: expected });
      expect(refusal).not.toHaveProperty("index");
    },
  );

  it("names migration 0011 when the database is not set up for it", async () => {
    grantUnlock(10);
    fake.reset(() => ({ error: { code: "PGRST202", message: "Could not find the function" } }));
    const refusal = await issue();
    expect(refusal).toMatchObject({ ok: false, code: "unavailable" });
    expect((refusal as { error: string }).error).toContain("0011_issued_payslips.sql");
  });

  it("describes an issued month by a count and the month, never by who", () => {
    expect(describeIssue({ period: "2026-09", issued: 3, payslips: ISSUED.payslips })).toBe(
      "3 payslips issued for September 2026",
    );
    expect(describeIssue({ period: "2026-09", issued: 1 })).toBe(
      "1 payslip issued for September 2026",
    );
  });
});

describe("payslip-issue: loading a month", () => {
  it.each([
    ["no params", undefined],
    ["no action", { brn: "C1234567", period: "2026-09" }],
    ["no BRN (required here)", { action: "load", period: "2026-09" }],
    ["no month", { action: "load", brn: "C1234567" }],
    ["a month that is not one", { ...LOAD, period: "2026-9" }],
    ["a field it does not know", { ...LOAD, revisions: "all" }],
  ])("refuses %s as invalid without asking the user", async (_what, params) => {
    grantUnlock(10);
    const answer = await answerIssuedRequest("payslip", {
      dataType: "payslip-issue",
      ...(params ? { params } : {}),
    });
    expect(answer).toMatchObject({ ok: false, code: "invalid" });
    expect(dataRequests.get()).toHaveLength(0);
    expect(fake.state.queries).toHaveLength(0);
  });

  it("refuses a viewer, another company and a signed-out dashboard without asking the user", async () => {
    grantUnlock(10);
    signIn("viewer");
    expect(await ask()).toMatchObject({ ok: false, code: "forbidden" });
    signIn("admin", other);
    expect(await ask()).toMatchObject({ ok: false, code: "wrong-company" });
    exchangeContext.set(null);
    expect(await ask()).toMatchObject({ ok: false, code: "unavailable" });
    expect(dataRequests.get()).toHaveLength(0);
    expect(fake.state.queries).toHaveLength(0);
  });

  it("waits for the user, reading nothing until they agree", async () => {
    grantUnlock(10);
    void ask();
    expect(dataRequests.get()).toHaveLength(1);
    expect(dataRequests.get()[0]!.question).toMatchObject({
      what: "the payslips issued for September 2026",
      warning: expect.stringMatching(/national IDs and pay/),
    });
    expect(fake.state.queries).toHaveLength(0);
  });

  it("answers with the latest revision of each employee, and never sends a user id with issued payslips", async () => {
    grantUnlock(10);
    fake.reset(() => ({
      data: [stored(), stored({ national_id: NIC_2, revision: 1, rates: null, issued_by: OTHER })],
    }));
    const answer = await askAndAgree({ ...LOAD, brn: " c1234567 " });
    expect(answer).toEqual({
      ok: true,
      dataType: "payslip-issue",
      meta: { label: "ABC Co Ltd", brn: "C1234567", period: "2026-09", role: "admin" },
      rows: [
        {
          national_id: NIC_1,
          revision: 2,
          template_id: T1,
          template_version: 3,
          rates: RATES,
          lines: LINES,
          accepted_differences: [DIFFERENCE],
          issued_at: "2026-10-02T09:00:00+04:00",
          issued_by_you: true,
        },
        {
          national_id: NIC_2,
          revision: 1,
          template_id: T1,
          template_version: 3,
          rates: null,
          lines: LINES,
          accepted_differences: [DIFFERENCE],
          issued_at: "2026-10-02T09:00:00+04:00",
          issued_by_you: false,
        },
      ],
    });
    // issued_by is a user id: it stays in the dashboard, whoever's it is.
    expect(JSON.stringify(answer)).not.toContain(ME);
    expect(JSON.stringify(answer)).not.toContain(OTHER);
    expect(JSON.stringify(answer)).not.toContain('issued_by"');
    // One read, with the user's own permissions, for the selected company and that month.
    expect(fake.state.queries).toEqual([
      [["rpc", "issued_payslips_for_month", { p_company_id: ABC, p_period: "2026-09-01" }]],
    ]);
  });

  it("answers with no rows for a month nothing was issued for", async () => {
    grantUnlock(10);
    expect(await askAndAgree()).toMatchObject({ ok: true, rows: [], meta: { period: "2026-09" } });
  });

  it("keeps nothing in memory once the app has its answer, under a key that locking wipes", async () => {
    expect(GATED_QUERY_KEYS).toContainEqual(["issued-payslips"]);
    grantUnlock(10);
    fake.reset(() => ({ data: [stored()] }));
    await askAndAgree();
    expect(cached()).toHaveLength(0);
  });

  it("sends nothing when the gate is locked at the moment the user's answer is acted on", async () => {
    const answer = ask();
    const waiting = dataRequests.get()[0]!;
    waiting.respond(await waiting.question!.answer());
    expect(await answer).toMatchObject({ ok: false, code: "locked" });
    expect(fake.state.queries).toHaveLength(0);
  });

  it("sends nothing when the gate locks while the database is answering", async () => {
    grantUnlock(10);
    fake.reset(() => {
      lock();
      return { data: [stored()] };
    });
    const answer = await askAndAgree();
    expect(answer).toMatchObject({ ok: false, code: "locked" });
    expect(JSON.stringify(answer)).not.toMatch(/X00000/);
    expect(cached()).toHaveLength(0);
  });

  it("checks the company and the role again when the user agrees: they may have changed meanwhile", async () => {
    grantUnlock(10);
    fake.reset(() => ({ data: [stored()] }));
    const answer = ask();
    signIn("admin", other);
    const waiting = dataRequests.get()[0]!;
    waiting.respond(await waiting.question!.answer());
    expect(await answer).toMatchObject({ ok: false, code: "wrong-company" });

    const second = ask({ ...LOAD, brn: "C7654321" });
    signIn("viewer", other);
    const next = dataRequests.get()[0]!;
    next.respond(await next.question!.answer());
    expect(await second).toMatchObject({ ok: false, code: "forbidden" });
    expect(fake.state.queries).toHaveLength(0);
  });

  it("names migration 0011 when the database is not set up for it", async () => {
    grantUnlock(10);
    fake.reset(() => ({ error: { code: "PGRST202", message: "Could not find the function" } }));
    const answer = await askAndAgree();
    expect(answer).toMatchObject({ ok: false, code: "unavailable" });
    expect((answer as { error: string }).error).toContain("0011_issued_payslips.sql");
  });
});

describe("payslip-issue over the bridge: a prompt for a read, the gate for both", () => {
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
  const membership: Membership = { role: "admin", company };
  const auth: AuthContextValue = {
    status: "signed-in",
    user: { id: ME, email: "admin@example.com", isDemo: false },
    notice: null,
    signIn: async () => null,
    signInDemo: null,
    signOut: async () => {},
    clearNotice: () => {},
  };
  const companies: CompanyContextValue = {
    status: "ready",
    failure: null,
    retry: () => {},
    memberships: [membership],
    current: membership,
    isAdmin: true,
    canAddCompany: true,
    select: () => {},
  };
  const showDialogs = () =>
    render(
      <AuthContext.Provider value={auth}>
        <CompanyContext.Provider value={companies}>
          <BridgeDialogs />
        </CompanyContext.Provider>
      </AuthContext.Provider>,
    );
  /** Everything the dashboard wrote down or showed about the exchange. */
  const seen = () =>
    JSON.stringify([transferLog.get(), toast.success.mock.calls, toast.error.mock.calls]);

  afterEach(() => {
    bridge.stop();
    document.body.innerHTML = "";
  });

  it("is registered for the payslip app only, to ask for and to send", async () => {
    const { APPS } = await import("@/config/apps.config");
    const using = APPS.filter((app) =>
      [...app.accepts, ...app.produces].includes("payslip-issue"),
    ).map((app) => app.id);
    expect(using).toEqual(["payslip"]);
  });

  it("issues a month sent by the app, answers with the result, and logs a count without values", async () => {
    grantUnlock(10);
    fake.reset(() => ({ data: ISSUED }));
    const app = connect();
    app.say("send-data", "save-00000001", { dataType: "payslip-issue", rows: [ISSUE] });
    await vi.waitFor(() => expect(app.sent("received")).toHaveLength(1));

    expect(app.sent("received")[0]).toMatchObject({
      id: "save-00000001",
      payload: { ok: true, result: { period: "2026-09", issued: 3 } },
    });
    expect(transferLog.get()).toEqual([
      expect.objectContaining({
        kind: "save",
        from: "Payslip Automation",
        toName: "Database",
        dataType: "payslip-issue",
        status: "delivered",
        rowCount: 3,
      }),
    ]);
    expect(toast.success).toHaveBeenCalledWith("3 payslips issued for September 2026", {
      description: "Saved from Payslip Automation.",
    });
    // No national ID, no figure, no label of a line: in the log or in a toast.
    expect(seen()).not.toMatch(/X00000|18169|25000|502\.8|Net pay|rounding/);
  });

  it("refuses a save while locked over the bridge too, says so in the dashboard, and stores nothing", async () => {
    const app = connect();
    app.say("send-data", "save-00000002", { dataType: "payslip-issue", rows: [ISSUE] });
    await vi.waitFor(() => expect(app.sent("received")).toHaveLength(1));

    expect(app.sent("received")[0]!.payload).toMatchObject({ ok: false, code: "locked" });
    expect(dataRequests.get()).toHaveLength(0); // no dialog for a save
    expect(fake.state.queries).toHaveLength(0);
    expect(transferLog.get()[0]).toMatchObject({ status: "failed", reason: "dashboard locked" });
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it("passes the position of the refused payslip on to the app, and keeps it out of the log", async () => {
    grantUnlock(10);
    fake.reset(() => ({ error: { code: "P0001", message: "PH_STALE: payslip 2" } }));
    const app = connect();
    app.say("send-data", "save-00000003", { dataType: "payslip-issue", rows: [ISSUE] });
    await vi.waitFor(() => expect(app.sent("received")).toHaveLength(1));

    expect(app.sent("received")[0]!.payload).toMatchObject({ ok: false, code: "stale", index: 1 });
    expect(transferLog.get()[0]).toMatchObject({
      status: "failed",
      reason: "someone else saved first",
      rowCount: 0,
    });
    expect(seen()).not.toMatch(/X00000/);
  });

  it("asks the user for a read, shows the unlock form while locked, and sends only on their say-so", async () => {
    fake.reset(() => ({ data: [stored(), stored({ national_id: NIC_2 })] }));
    const app = connect();
    showDialogs();
    app.say("request-data", "request-000001", { dataType: "payslip-issue", params: LOAD });

    // Locked: the dialog explains and offers the password form, and there is nothing to send yet.
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("the payslips issued for September 2026");
    expect(dialog.textContent).toContain("ABC Co Ltd");
    expect(dialog.textContent).toMatch(/locked/i);
    expect(screen.queryByRole("button", { name: /^Send / })).toBeNull();
    expect(app.sent("response-data")).toHaveLength(0);
    expect(fake.state.queries).toHaveLength(0);

    grantUnlock(10);
    const send = await screen.findByRole("button", { name: /Send the payslips issued for/ });
    expect(dialog.textContent).toMatch(/national IDs and pay/);
    expect(fake.state.queries).toHaveLength(0);
    fireEvent.click(send);
    await vi.waitFor(() => expect(app.sent("response-data")).toHaveLength(1));

    expect(app.sent("response-data")[0]).toMatchObject({
      id: "request-000001",
      payload: {
        ok: true,
        dataType: "payslip-issue",
        meta: { brn: "C1234567", period: "2026-09", role: "admin" },
      },
    });
    expect((app.sent("response-data")[0]!.payload.rows as unknown[]).length).toBe(2);
    expect(transferLog.get()).toEqual([
      expect.objectContaining({
        kind: "request",
        from: "Database, September 2026",
        toName: "Payslip Automation",
        dataType: "payslip-issue",
        status: "delivered",
        rowCount: 2,
      }),
    ]);
    expect(seen()).not.toMatch(/X00000|18169|25000/);
  });

  it("tells the app the user said no, and reads nothing", async () => {
    grantUnlock(10);
    const app = connect();
    showDialogs();
    app.say("request-data", "request-000002", { dataType: "payslip-issue", params: LOAD });
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
    await vi.waitFor(() => expect(app.sent("response-data")).toHaveLength(1));

    expect(app.sent("response-data")[0]!.payload).toMatchObject({ ok: false, code: "denied" });
    expect(fake.state.queries).toHaveLength(0);
    expect(transferLog.get()[0]).toMatchObject({
      status: "failed",
      reason: "declined in the dashboard",
    });
  });

  it("does not ask a viewer at all: the app is told read-only straight away", async () => {
    signIn("viewer");
    const app = connect();
    app.say("request-data", "request-000003", { dataType: "payslip-issue", params: LOAD });
    await vi.waitFor(() => expect(app.sent("response-data")).toHaveLength(1));
    expect(app.sent("response-data")[0]!.payload).toMatchObject({ ok: false, code: "forbidden" });
    expect(dataRequests.get()).toHaveLength(0);
  });
});
