import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APPS } from "@/config/apps.config";
import { AuthContext, type AuthContextValue } from "@/features/auth/auth-context";
import { CompanyContext, type CompanyContextValue } from "@/features/company/company-context";
import { clearTransferLog } from "@/features/transfer/transferLog";
import { dataRequests } from "@/lib/bridge/bridge";
import { runSessionCleanup } from "@/lib/sessionCleanup";
import type { Membership } from "@/lib/supabase/schemas";
import { grantUnlock, lock } from "@/lib/unlock";
import { fake, type Answer, type Call } from "@/test/fakeClient";
import { exchangeContext } from "./appData";
import { BATCH_ALLOWED_MS } from "./batchAccess";
import { BridgeDialogs } from "./BridgeDialogs";
import { answerPayrollBatchRequest, forgetPayrollBatchAllowed } from "./payrollBatchData";

/**
 * The payroll app's months of several companies at once, for one Excel file (payroll-batch):
 * only the user's admin companies, one question in the dashboard naming the month and every
 * company, then one company per load, with its month and its column setup. The database is the
 * fake client. FAKE values only.
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
const SHARED = "60000000-0000-4000-8000-000000000001";
const abc = { id: ABC, name: "ABC Co Ltd", address: "1 Fake Street", brn: "C1234567", vat: null };
const def = { id: DEF, name: "DEF Ltd", address: null, brn: "C3333333", vat: null };
const xyz = { id: XYZ, name: "XYZ Trading Ltd", address: null, brn: "C2222222", vat: null };

let members = [
  { role: "admin", companies: abc },
  { role: "admin", companies: def },
  { role: "viewer", companies: xyz },
];
const signIn = () =>
  exchangeContext.set({
    viewer: { id: ME, isDemo: false },
    membership: { role: "admin", company: abc },
  });

const SHARED_BODY = { identityFields: [{ key: "employeeId", name: "ID" }], globalColumns: [] };
const ABC_BODY = { columns: [{ key: "basicSalary", name: "Basic Salary", type: "input" }] };
const EMPLOYEES = [{ id: "e1", values: { employeeId: "X0000000000001", basicSalary: 25000 } }];

const table = (calls: Call[]) => fake.arg(calls, "from") as string | undefined;
const eqValue = (calls: Call[], column: string) =>
  calls.find(([method, name]) => method === "eq" && name === column)?.[2];

/** ABC: a setup and a month of September 2026. DEF: a setup, no month. XYZ: viewer only. */
function database(more: (calls: Call[]) => Answer | undefined = () => undefined): void {
  fake.reset((calls) => {
    const found = more(calls);
    if (found) return found;
    const company = eqValue(calls, "company_id");
    switch (table(calls)) {
      case "company_members":
        return { data: members };
      case "payroll_company_setups": {
        const own = (id: string, body: unknown) => ({
          company_id: id,
          shared_setup_id: SHARED,
          body,
          revision: id === ABC ? 4 : 1,
          updated_by: ME,
          updated_at: "t",
        });
        if (company === undefined) {
          return {
            data: [ABC, DEF].map((id) => ({ company_id: id, shared_setup_id: SHARED })),
          };
        }
        return { data: company === ABC ? own(ABC, ABC_BODY) : own(DEF, { columns: [] }) };
      }
      case "payroll_shared_setups":
        return {
          data: {
            id: SHARED,
            name: "Shared column setup",
            body: SHARED_BODY,
            revision: 7,
            updated_by: ME,
            updated_at: "t",
          },
        };
      case "payroll_months":
        return company === ABC
          ? {
              data: [
                {
                  period: "2026-09-01",
                  revision: 3,
                  shared_revision: 7,
                  company_revision: 4,
                  employee_count: 1,
                  employees: EMPLOYEES,
                  updated_by: ME,
                  updated_at: "2026-10-02T09:00:00+04:00",
                },
              ],
            }
          : { data: [] };
      default:
        return { data: [] };
    }
  });
}

const request = (params: Record<string, unknown>, appId = "payroll") =>
  answerPayrollBatchRequest(appId, { dataType: "payroll-batch", params });

/** Asks, then answers the dashboard's question as the user would: unlocked, then "Send". */
async function askAndAllow(companies: string[]) {
  const pending = request({ action: "ask", brn: "C1234567", period: "2026-09", companies });
  await vi.waitFor(() => expect(dataRequests.get()).toHaveLength(1));
  const asked = dataRequests.get()[0]!;
  grantUnlock(10);
  asked.respond(await asked.question!.answer());
  return { answer: await pending, asked };
}
const LOAD = { action: "load", brn: "C1234567", period: "2026-09", company_brn: "C1234567" };

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
  forgetPayrollBatchAllowed();
  lock();
  vi.useRealTimers();
});

describe("the payroll app may ask for several companies", () => {
  it("is registered for the payroll app only", () => {
    expect(
      APPS.filter((app) => app.accepts.includes("payroll-batch")).map((app) => app.id),
    ).toEqual(["payroll"]);
  });
});

describe("companies: the user's admin companies, read from the database", () => {
  it("lists only companies where the user is an admin, this company first, with no question asked", async () => {
    expect(await request({ action: "companies", brn: "C1234567" })).toEqual({
      ok: true,
      dataType: "payroll-batch",
      rows: [
        { brn: "C1234567", name: "ABC Co Ltd", selected: true, has_setup: true },
        { brn: "C3333333", name: "DEF Ltd", selected: false, has_setup: true },
      ],
      meta: { label: "ABC Co Ltd", brn: "C1234567", role: "admin" },
    });
    expect(dataRequests.get()).toHaveLength(0);
  });

  it("says which have no column setup in the dashboard", async () => {
    database((calls) =>
      table(calls) === "payroll_company_setups" && eqValue(calls, "company_id") === undefined
        ? { data: [{ company_id: ABC, shared_setup_id: SHARED }] }
        : undefined,
    );
    expect(await request({ action: "companies" })).toMatchObject({
      ok: true,
      rows: [
        { brn: "C1234567", has_setup: true },
        { brn: "C3333333", has_setup: false },
      ],
    });
  });

  it("refuses another company's BRN", async () => {
    expect(await request({ action: "companies", brn: "C2222222" })).toMatchObject({
      ok: false,
      code: "wrong-company",
    });
  });
});

describe("ask: one question naming the month and every company", () => {
  it("asks once, naming the month and every company chosen, and allows only those", async () => {
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
    expect(asked.question!.warning).toContain("national IDs and salaries");
    grantUnlock(10);
    asked.respond(await asked.question!.answer());
    expect(await pending).toEqual({
      ok: true,
      dataType: "payroll-batch",
      rows: [
        { brn: "C1234567", name: "ABC Co Ltd" },
        { brn: "C3333333", name: "DEF Ltd" },
      ],
      meta: { label: "ABC Co Ltd", brn: "C1234567", role: "admin", period: "2026-09" },
    });
  });

  it("names every company, however many, never 'and N more'", async () => {
    const many = Array.from({ length: 6 }, (_, n) => ({
      role: "admin",
      companies: {
        id: `10000000-0000-4000-8000-00000000010${n}`,
        name: `Fake Co ${n + 1} Ltd`,
        address: null,
        brn: `C900000${n}`,
        vat: null,
      },
    }));
    members = [{ role: "admin", companies: abc }, ...many];
    void request({
      action: "ask",
      brn: "C1234567",
      period: "2026-09",
      companies: many.map((one) => one.companies.brn),
    });
    await vi.waitFor(() => expect(dataRequests.get()).toHaveLength(1));
    expect(dataRequests.get()[0]!.question!.of).toBe(
      "Fake Co 1 Ltd, Fake Co 2 Ltd, Fake Co 3 Ltd, Fake Co 4 Ltd, Fake Co 5 Ltd and Fake Co 6 Ltd",
    );
  });

  it("refuses at once, without asking, a company where the user is only a member or not a member", async () => {
    for (const brn of ["C2222222", "C9999999"]) {
      expect(
        await request({
          action: "ask",
          brn: "C1234567",
          period: "2026-09",
          companies: ["C1234567", brn],
        }),
      ).toEqual({
        ok: false,
        code: "forbidden",
        error: "Only companies where you are an admin can be chosen.",
      });
    }
    expect(dataRequests.get()).toHaveLength(0);
  });

  it("needs a month and 1 to 200 companies, always named", async () => {
    const ask = (more: Record<string, unknown>) =>
      request({ action: "ask", brn: "C1234567", period: "2026-09", ...more });
    expect(await ask({})).toMatchObject({ ok: false, code: "invalid" });
    expect(await ask({ companies: [] })).toMatchObject({ ok: false, code: "invalid" });
    expect(await ask({ all: true })).toMatchObject({ ok: false, code: "invalid" });
    expect(await ask({ companies: ["C1234567"], period: "2026-13" })).toMatchObject({
      ok: false,
      code: "invalid",
    });
    const many = Array.from({ length: 201 }, (_, n) => `B${n}`);
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
    expect(await request({ ...LOAD, company_brn: "C3333333" })).toMatchObject({
      ok: false,
      code: "denied",
    });
  });
});

describe("load: one company at a time, only as allowed", () => {
  it("is refused when nothing was allowed, and reads nothing", async () => {
    grantUnlock(10);
    expect(await request(LOAD)).toEqual({
      ok: false,
      code: "denied",
      error: "That company and month were not allowed in the dashboard for this app. Ask again.",
    });
    expect(fake.state.queries).toHaveLength(0);
  });

  it("gives one company's month exactly as saved, with its column setup, and never a user id", async () => {
    await askAndAllow(["C1234567", "C3333333"]);
    const answer = await request(LOAD);
    expect(answer).toEqual({
      ok: true,
      dataType: "payroll-batch",
      meta: { label: "ABC Co Ltd", brn: "C1234567", role: "admin", period: "2026-09" },
      rows: [
        {
          brn: "C1234567",
          name: "ABC Co Ltd",
          address: "1 Fake Street",
          period: "2026-09",
          setup: {
            shared_setup_id: SHARED,
            shared_name: "Shared column setup",
            shared_body: SHARED_BODY,
            shared_revision: 7,
            company_body: ABC_BODY,
            company_revision: 4,
          },
          month: {
            revision: 3,
            shared_revision: 7,
            company_revision: 4,
            employee_count: 1,
            employees: EMPLOYEES,
            updated_at: "2026-10-02T09:00:00+04:00",
          },
        },
      ],
    });
    expect(JSON.stringify(answer)).not.toContain(ME);
    const month = fake.state.queries.find((calls) => table(calls) === "payroll_months")!;
    expect(month).toContainEqual(["in", "period", ["2026-09-01"]]);
  });

  it("says when a company has no month, or no column setup", async () => {
    await askAndAllow(["C3333333"]);
    expect(await request({ ...LOAD, company_brn: "C3333333" })).toMatchObject({
      ok: true,
      rows: [{ brn: "C3333333", setup: { company_body: { columns: [] } }, month: null }],
    });
    database((calls) => (table(calls) === "payroll_company_setups" ? { data: null } : undefined));
    expect(await request({ ...LOAD, company_brn: "C3333333" })).toMatchObject({
      ok: true,
      rows: [{ brn: "C3333333", setup: null, month: null }],
    });
  });

  it("is refused for a company or a month that was not allowed, or for another app", async () => {
    await askAndAllow(["C1234567"]);
    expect(await request({ ...LOAD, company_brn: "C3333333" })).toMatchObject({
      ok: false,
      code: "denied",
    });
    expect(await request({ ...LOAD, period: "2026-08" })).toMatchObject({
      ok: false,
      code: "denied",
    });
    expect(await request(LOAD, "payslip")).toMatchObject({ ok: false, code: "denied" });
  });

  it("is refused while the gate is locked, and locking forgets what was allowed", async () => {
    await askAndAllow(["C1234567"]);
    lock();
    fake.state.queries.length = 0;
    expect(await request(LOAD)).toMatchObject({ ok: false, code: "denied" });
    grantUnlock(10);
    expect(await request(LOAD)).toMatchObject({ ok: false, code: "denied" });
    expect(fake.state.queries).toHaveLength(0);
  });

  it("stops being allowed after 15 minutes", async () => {
    await askAndAllow(["C1234567"]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + BATCH_ALLOWED_MS + 1_000);
    grantUnlock(10);
    expect(await request(LOAD)).toMatchObject({ ok: false, code: "denied" });
  });

  it("is refused when the user is no longer an admin of that company, even when it was allowed", async () => {
    await askAndAllow(["C3333333"]);
    members = [
      { role: "admin", companies: abc },
      { role: "viewer", companies: def },
    ];
    expect(await request({ ...LOAD, company_brn: "C3333333" })).toEqual({
      ok: false,
      code: "forbidden",
      error: "Only an admin of that company can export its employees' figures.",
    });
  });

  it("does not keep what payslip-batch allowed, nor the other way round", async () => {
    await askAndAllow(["C1234567"]);
    expect(
      await answerPayrollBatchRequest("payroll", {
        dataType: "payroll-batch",
        params: { ...LOAD },
      }),
    ).toMatchObject({ ok: true });
    const { answerBatchRequest } = await import("./payslipBatchData");
    expect(
      await answerBatchRequest("payroll", {
        dataType: "payslip-batch",
        params: { ...LOAD },
      }),
    ).toMatchObject({ ok: false, code: "denied" });
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

  it("names the month and every company, and what it sends", async () => {
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
    expect(dialog.textContent).toContain("Payroll System is asking for payroll data");
    expect(dialog.textContent).toContain(
      "It wants the September 2026 payroll of 2 companies: ABC Co Ltd and DEF Ltd.",
    );
    expect(dialog.textContent).toContain(
      "This sends each company's saved month, with national IDs and salaries, and its column setup, to the app, one company at a time, for the next 15 minutes, to make one Excel file.",
    );
    expect(
      screen.getByRole("button", { name: "Send the September 2026 payroll of 2 companies" }),
    ).toBeTruthy();
  });
});
