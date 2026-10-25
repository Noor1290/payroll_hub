import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext, type AuthContextValue } from "@/features/auth/auth-context";
import { CompanyContext, type CompanyContextValue } from "@/features/company/company-context";
import { clearTransferLog } from "@/features/transfer/transferLog";
import { dataRequests } from "@/lib/bridge/bridge";
import { runSessionCleanup } from "@/lib/sessionCleanup";
import type { Membership } from "@/lib/supabase/schemas";
import { grantUnlock, lock } from "@/lib/unlock";
import { fake, type Answer, type Call } from "@/test/fakeClient";
import { exchangeContext } from "./appData";
import { BridgeDialogs } from "./BridgeDialogs";
import { answerBatchRequest, BATCH_ALLOWED_MS, forgetBatchAllowed } from "./payslipBatchData";

/**
 * Payslips for several companies (payslip-batch): only the user's admin companies, one question
 * in the dashboard for the month and the companies, then one company per load. The database is
 * the fake client. FAKE values only.
 */

vi.mock("@/lib/supabase/client", async () => ({
  supabase: (await import("@/test/fakeClient")).fake.client,
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

const ME = "00000000-0000-4000-8000-0000000000a1";
const ABC = "10000000-0000-4000-8000-000000000001";
const XYZ = "10000000-0000-4000-8000-000000000002";
const DEF = "10000000-0000-4000-8000-000000000003";
const T1 = "20000000-0000-4000-8000-000000000001";
const T2 = "20000000-0000-4000-8000-000000000002";
const T3 = "20000000-0000-4000-8000-000000000003";
const RUN = "40000000-0000-4000-8000-000000000001";
const abc = {
  id: ABC,
  name: "ABC Co Ltd",
  address: "1 Fake Street, Port Louis",
  brn: "C1234567",
  vat: "12%",
};
const def = { id: DEF, name: "DEF Ltd", address: null, brn: "C3333333", vat: null };
const xyz = { id: XYZ, name: "XYZ Trading Ltd", address: null, brn: "C2222222", vat: null };

let members = [
  { role: "admin", companies: abc },
  { role: "admin", companies: def },
  { role: "viewer", companies: xyz },
];
const signIn = (role: Membership["role"] = "admin") =>
  exchangeContext.set({ viewer: { id: ME, isDemo: false }, membership: { role, company: abc } });

const BODY = { schema: 1, kind: "table", labels: { title: "Payslip" } };
const money = Object.fromEntries(
  [
    "basic_salary",
    "govt_increment",
    "new_basic_salary",
    "allowances",
    "emoluments",
    "travelling",
    "gross_pay",
    "csg",
    "nsf",
    "paye",
    "total_deductions",
    "net_pay",
    "levy",
    "prgf",
    "total_mra_contributions",
    "edf",
    "edf_monthly",
    "total",
  ].map((column) => [column, 0]),
);
const ENTRY = {
  id: "50000000-0000-4000-8000-000000000001",
  age_60_plus: false,
  extra: { employee_csg: 375, "Presence Bonus": 500 },
  ...money,
  basic_salary: 25000,
  net_pay: 24625,
  employees: {
    id: "30000000-0000-4000-8000-000000000001",
    national_id: "X0000000000001",
    surname: "DOE",
    other_names: "Jane",
    employment_type: "Full Time",
    date_of_employment: null,
  },
};
const RATES = {
  effective_from: "2026-07-01",
  revision: 1,
  nsf_employee_rate: 1,
  nsf_ceiling: 29710,
  nsf_exempt_at_60: true,
  csg_employee_rate_low: 1.5,
  csg_employee_rate_high: 3,
  csg_threshold: 50000,
  source_note: null,
  created_by: ME,
  created_at: "t",
};

const table = (calls: Call[]) => fake.arg(calls, "from") as string | undefined;
const eqValue = (calls: Call[], column: string) =>
  calls.find(([method, name]) => method === "eq" && name === column)?.[2];
const single = (calls: Call[]) => calls.some(([method]) => method === "maybeSingle");
const summary = (id: string, name: string) => ({
  id,
  name,
  draft_revision: 1,
  updated_by: ME,
  updated_at: "t",
});
const version = (templateId: string, number: number, name: string) => ({
  template_id: templateId,
  version: number,
  name,
  body: { ...BODY, labels: { title: `${name} v${number}` } },
  published_by: ME,
  published_at: "t",
});

/**
 * ABC: a run of September 2026 with one employee; "Monthly payslip" chosen at version 2 for the
 * payslips; one rates version. DEF: no run, one published template ("Only one", version 3).
 */
function database(more: (calls: Call[]) => Answer | undefined = () => undefined): void {
  fake.reset((calls) => {
    const found = more(calls);
    if (found) return found;
    const company = eqValue(calls, "company_id");
    switch (table(calls)) {
      case "company_members":
        return { data: members };
      case "payroll_runs":
        return company === ABC
          ? {
              data: [
                {
                  id: RUN,
                  period: "2026-09-01",
                  status: "draft",
                  created_by: null,
                  created_at: "t",
                  payroll_entries: [{ count: 1 }],
                },
              ],
            }
          : { data: [] };
      case "payroll_entries":
        return eqValue(calls, "run_id") === RUN ? { data: [ENTRY] } : { data: [] };
      case "payslip_template_in_use":
        return company === ABC ? { data: [{ template_id: T1, version: 2 }] } : { data: [] };
      case "payslip_templates":
        return company === ABC
          ? { data: [summary(T1, "Monthly payslip"), summary(T2, "Weekly")] }
          : { data: [summary(T3, "Only one")] };
      case "payslip_template_versions": {
        if (single(calls)) {
          const id = eqValue(calls, "template_id") as string;
          const number = eqValue(calls, "version") as number;
          return { data: version(id, number, id === T3 ? "Only one" : "Monthly payslip") };
        }
        return eqValue(calls, "template_id") === T3
          ? { data: [{ version: 3, published_at: "t" }] }
          : { data: [{ version: 2, published_at: "t" }] };
      }
      case "statutory_rates":
        return company === ABC ? { data: [RATES] } : { data: [] };
      default:
        return { data: [] };
    }
  });
}

const request = (params: Record<string, unknown>, appId = "payslip") =>
  answerBatchRequest(appId, { dataType: "payslip-batch", params });

/** Asks, then answers the dashboard's question as the user would: unlocked, then "Send". */
async function askAndAllow(params: Record<string, unknown>) {
  const pending = request({ action: "ask", brn: "C1234567", period: "2026-09", ...params });
  await vi.waitFor(() => expect(dataRequests.get()).toHaveLength(1));
  const asked = dataRequests.get()[0]!;
  grantUnlock(10);
  asked.respond(await asked.question!.answer());
  return { answer: await pending, asked };
}
const LOAD = { action: "load", brn: "C1234567", period: "2026-09", company_brn: "C3333333" };

beforeEach(() => {
  members = [
    { role: "admin", companies: abc },
    { role: "admin", companies: def },
    { role: "viewer", companies: xyz },
  ];
  signIn();
  database();
});
afterEach(() => {
  for (const asked of dataRequests.get()) asked.respond({ ok: false, code: "denied", error: "x" });
  runSessionCleanup();
  clearTransferLog();
  forgetBatchAllowed();
  lock();
  vi.useRealTimers();
});

describe("companies: the user's admin companies, read from the database", () => {
  it("lists only companies where the user is an admin, this company first, with no question asked", async () => {
    const answer = await request({ action: "companies", brn: "C1234567" });
    expect(answer).toEqual({
      ok: true,
      dataType: "payslip-batch",
      rows: [
        { brn: "C1234567", name: "ABC Co Ltd", selected: true },
        { brn: "C3333333", name: "DEF Ltd", selected: false },
      ],
      meta: { label: "ABC Co Ltd", brn: "C1234567", role: "admin" },
    });
    expect(dataRequests.get()).toHaveLength(0);
    expect(fake.state.queries.some((calls) => table(calls) === "company_members")).toBe(true);
  });

  it("refuses another company's BRN, and answers without one, naming the selected company", async () => {
    expect(await request({ action: "companies", brn: "C2222222" })).toMatchObject({
      ok: false,
      code: "wrong-company",
    });
    expect(await request({ action: "companies" })).toMatchObject({
      ok: true,
      meta: { brn: "C1234567" },
      rows: [{ brn: "C1234567", selected: true }, { brn: "C3333333" }],
    });
  });
});

describe("ask: one question for the month and the companies", () => {
  it("asks the user once, naming the month and the companies, and allows only those", async () => {
    const pending = request({
      action: "ask",
      brn: "C1234567",
      period: "2026-09",
      companies: ["C1234567", " c3333333 "],
    });
    await vi.waitFor(() => expect(dataRequests.get()).toHaveLength(1));
    const asked = dataRequests.get()[0]!;
    expect(asked.question).toMatchObject({
      what: "the September 2026 payroll of 2 companies",
      of: "ABC Co Ltd and DEF Ltd",
    });
    expect(asked.question!.warning).toContain("national IDs and pay");
    grantUnlock(10);
    asked.respond(await asked.question!.answer());
    expect(await pending).toEqual({
      ok: true,
      dataType: "payslip-batch",
      rows: [
        { brn: "C1234567", name: "ABC Co Ltd" },
        { brn: "C3333333", name: "DEF Ltd" },
      ],
      meta: { label: "ABC Co Ltd", brn: "C1234567", role: "admin", period: "2026-09" },
    });
  });

  it("asks for all of the user's admin companies, and says how many", async () => {
    const pending = request({ action: "ask", brn: "C1234567", period: "2026-09", all: true });
    await vi.waitFor(() => expect(dataRequests.get()).toHaveLength(1));
    expect(dataRequests.get()[0]!.question).toMatchObject({
      what: "the September 2026 payroll of all your 2 companies",
      of: undefined,
    });
    dataRequests.get()[0]!.respond({ ok: false, code: "denied", error: "No." });
    expect(await pending).toMatchObject({ ok: false, code: "denied" });
  });

  it("refuses at once, without asking, a company where the user is only a member or not a member", async () => {
    for (const brn of ["C2222222", "C9999999"]) {
      const answer = await request({
        action: "ask",
        brn: "C1234567",
        period: "2026-09",
        companies: ["C1234567", brn],
      });
      expect(answer).toEqual({
        ok: false,
        code: "forbidden",
        error: "Only companies where you are an admin can be chosen.",
      });
    }
    expect(dataRequests.get()).toHaveLength(0);
  });

  it("needs exactly one of a list or all, a month, and at most 100 companies", async () => {
    const ask = (more: Record<string, unknown>) =>
      request({ action: "ask", brn: "C1234567", period: "2026-09", ...more });
    expect(await ask({})).toMatchObject({ ok: false, code: "invalid" });
    expect(await ask({ companies: ["C1234567"], all: true })).toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(await ask({ companies: ["C1234567"], period: "2026-13" })).toMatchObject({
      ok: false,
      code: "invalid",
    });
    const many = Array.from({ length: 101 }, (_, n) => `B${n}`);
    expect(await ask({ companies: many })).toMatchObject({ ok: false, code: "invalid" });
    expect(dataRequests.get()).toHaveLength(0);
  });

  it("allows nothing for a company the user stopped being an admin of while the question was open", async () => {
    const pending = request({
      action: "ask",
      brn: "C1234567",
      period: "2026-09",
      companies: ["C3333333"],
    });
    await vi.waitFor(() => expect(dataRequests.get()).toHaveLength(1));
    members = [{ role: "admin", companies: abc }];
    grantUnlock(10);
    const asked = dataRequests.get()[0]!;
    asked.respond(await asked.question!.answer());
    expect(await pending).toMatchObject({ ok: true, rows: [] });
    expect(await request(LOAD)).toMatchObject({ ok: false, code: "denied" });
  });
});

describe("load: one company at a time, only as allowed", () => {
  it("is refused when nothing was allowed", async () => {
    grantUnlock(10);
    expect(await request(LOAD)).toEqual({
      ok: false,
      code: "denied",
      error: "That company and month were not allowed in the dashboard for this app. Ask again.",
    });
    expect(fake.state.queries).toHaveLength(0);
  });

  it("adds the payslips already issued for that month, never with a user id", async () => {
    await askAndAllow({ companies: ["C1234567"] });
    const ISSUED = {
      national_id: "X0000000000001",
      revision: 2,
      template_id: T1,
      template_version: 2,
      rates: null,
      lines: [{ format: 1 }],
      accepted_differences: [],
      issued_by: ME,
      issued_at: "2026-10-02T09:00:00+04:00",
    };
    database((calls) =>
      fake.arg(calls, "rpc") === "issued_payslips_for_month" ? { data: [ISSUED] } : undefined,
    );
    const answer = await request({ ...LOAD, company_brn: "C1234567" });
    const { issued_by: _who, ...rest } = ISSUED;
    void _who;
    expect(answer).toMatchObject({
      ok: true,
      rows: [{ issued: [{ ...rest, issued_by_you: true }] }],
    });
    expect(JSON.stringify(answer)).not.toContain(ME);
    const call = fake.state.queries.find(
      (calls) => fake.arg(calls, "rpc") === "issued_payslips_for_month",
    )!;
    expect(fake.arg(call, "rpc", 1)).toEqual({ p_company_id: ABC, p_period: "2026-09-01" });
  });

  it("gives one company's run of the month, the template its payslips use and its rates", async () => {
    await askAndAllow({ companies: ["C1234567", "C3333333"] });
    const answer = await request({ ...LOAD, company_brn: "C1234567" });
    expect(answer).toMatchObject({
      ok: true,
      dataType: "payslip-batch",
      meta: { brn: "C1234567", period: "2026-09" },
      rows: [
        {
          brn: "C1234567",
          company: "ABC Co Ltd",
          period: "2026-09",
          run: true,
          template: { template_id: T1, name: "Monthly payslip", version: 2 },
          template_reason: null,
          rates: [{ effective_from: "2026-07", revision: 1, created_by_you: true }],
        },
      ],
    });
    const [row] = (answer as { rows: Record<string, unknown>[] }).rows;
    // The rows "Get from dashboard" gives, with the company's own details on each.
    expect(row!.employees).toEqual([
      expect.objectContaining({
        ID: "X0000000000001",
        Surname: "DOE",
        "Basic Salary": 25000,
        "Net Pay": 24625,
        "Employee CSG": 375,
        "Presence Bonus": 500,
        "Company Name": "ABC Co Ltd",
        BRN: "C1234567",
      }),
    ]);
    expect(JSON.stringify(row)).not.toContain(ME);
  });

  it("uses a company's one published template when none was chosen, and says when there is none or several", async () => {
    await askAndAllow({ companies: ["C3333333"] });
    expect(await request(LOAD)).toMatchObject({
      ok: true,
      rows: [
        { brn: "C3333333", run: false, employees: [], template: { template_id: T3, version: 3 } },
      ],
    });
    database((calls) =>
      table(calls) === "payslip_templates" && eqValue(calls, "company_id") === DEF
        ? { data: [summary(T3, "Only one"), summary(T2, "Second")] }
        : undefined,
    );
    expect(await request(LOAD)).toMatchObject({
      ok: true,
      rows: [{ template: null, template_reason: "several" }],
    });
    database((calls) =>
      table(calls) === "payslip_templates" && eqValue(calls, "company_id") === DEF
        ? { data: [] }
        : undefined,
    );
    expect(await request(LOAD)).toMatchObject({
      ok: true,
      rows: [{ template: null, template_reason: "none" }],
    });
  });

  it("is refused for a company or a month that was not allowed, or for another app", async () => {
    await askAndAllow({ companies: ["C1234567"] });
    expect(await request(LOAD)).toMatchObject({ ok: false, code: "denied" });
    expect(await request({ ...LOAD, company_brn: "C1234567", period: "2026-08" })).toMatchObject({
      ok: false,
      code: "denied",
    });
    expect(await request({ ...LOAD, company_brn: "C1234567" }, "pdf-editor")).toMatchObject({
      ok: false,
      code: "denied",
    });
  });

  it("is refused while the gate is locked, and locking forgets what was allowed", async () => {
    await askAndAllow({ companies: ["C3333333"] });
    lock();
    fake.state.queries.length = 0;
    expect(await request(LOAD)).toMatchObject({ ok: false, code: "denied" });
    grantUnlock(10);
    expect(await request(LOAD)).toMatchObject({ ok: false, code: "denied" });
    expect(fake.state.queries).toHaveLength(0);
  });

  it("stops being allowed after 15 minutes", async () => {
    await askAndAllow({ companies: ["C3333333"] });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + BATCH_ALLOWED_MS + 1_000);
    grantUnlock(10);
    expect(await request(LOAD)).toMatchObject({ ok: false, code: "denied" });
  });

  it("is refused when the user is no longer an admin of that company, even when it was allowed", async () => {
    await askAndAllow({ companies: ["C3333333"] });
    members = [
      { role: "admin", companies: abc },
      { role: "viewer", companies: def },
    ];
    expect(await request(LOAD)).toEqual({
      ok: false,
      code: "forbidden",
      error: "Only an admin of that company can make its payslips.",
    });
  });

  it("is refused after another company is selected in the dashboard", async () => {
    await askAndAllow({ companies: ["C3333333"] });
    exchangeContext.set({
      viewer: { id: ME, isDemo: false },
      membership: { role: "admin", company: def },
    });
    expect(await request({ ...LOAD, brn: "C3333333" })).toMatchObject({
      ok: false,
      code: "denied",
    });
  });
});

describe("the question in the dashboard", () => {
  const membership: Membership = { role: "admin", company: abc };
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
  afterEach(() => cleanup());

  it("names the month and the companies instead of the selected company, and what it sends", async () => {
    grantUnlock(10);
    void request({
      action: "ask",
      brn: "C1234567",
      period: "2026-09",
      companies: ["C1234567", "C3333333"],
    });
    await vi.waitFor(() => expect(dataRequests.get()).toHaveLength(1));
    render(
      <AuthContext.Provider value={auth}>
        <CompanyContext.Provider value={companies}>
          <BridgeDialogs />
        </CompanyContext.Provider>
      </AuthContext.Provider>,
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain(
      "It wants the September 2026 payroll of 2 companies: ABC Co Ltd and DEF Ltd.",
    );
    expect(dialog.textContent).not.toContain("of ABC Co Ltd.");
    expect(dialog.textContent).toContain(
      "This sends each company's saved run for that month, with national IDs and pay, with its payslip template, its rates and the payslips already issued for that month, to the app, one company at a time, for the next 15 minutes.",
    );
    expect(
      screen.getByRole("button", { name: "Send the September 2026 payroll of 2 companies" }),
    ).toBeTruthy();
  });
});
