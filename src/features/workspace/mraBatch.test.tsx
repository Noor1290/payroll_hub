import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getApp } from "@/config/apps.config";
import { AuthContext, type AuthContextValue } from "@/features/auth/auth-context";
import { CompanyContext, type CompanyContextValue } from "@/features/company/company-context";
import { clearTransferLog, transferLog } from "@/features/transfer/transferLog";
import { dataRequests } from "@/lib/bridge/bridge";
import { DATA_RULES } from "@/lib/bridge/protocol";
import { runSessionCleanup } from "@/lib/sessionCleanup";
import type { Membership } from "@/lib/supabase/schemas";
import { grantUnlock, lock } from "@/lib/unlock";
import { fake, type Answer, type Call } from "@/test/fakeClient";
import { exchangeContext } from "./appData";
import { BridgeDialogs } from "./BridgeDialogs";
import { BATCH_ALLOWED_MS } from "./batchAccess";
import { answerRequest } from "./deliver";
import { answerMraBatchRequest, forgetMraBatchAllowed } from "./mraBatchData";
import { setProfileOpener } from "./openProfile";

/**
 * The MRA return files (mra-batch): only the user's admin companies, one question in the
 * dashboard for the month and every company, then one company's saved run per load. The
 * database is the fake client. FAKE values only.
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
  extra: { employee_csg: 281.25, "Employer NSF": 468.75 },
  ...money,
  basic_salary: 18115,
  new_basic_salary: 18750,
  gross_pay: 18750,
  employees: {
    id: "30000000-0000-4000-8000-000000000001",
    national_id: "X0000000000001",
    surname: "DOE",
    other_names: "Jane",
    employment_type: "Full Time",
    date_of_employment: "2020-02-01",
  },
};

const table = (calls: Call[]) => fake.arg(calls, "from") as string | undefined;
const eqValue = (calls: Call[], column: string) =>
  calls.find(([method, name]) => method === "eq" && name === column)?.[2];

/** ABC: a run of August 2026 with one employee. DEF: no run. */
function database(more: (calls: Call[]) => Answer | undefined = () => undefined): void {
  fake.reset((calls) => {
    const found = more(calls);
    if (found) return found;
    switch (table(calls)) {
      case "company_members":
        return { data: members };
      case "payroll_runs":
        return eqValue(calls, "company_id") === ABC
          ? {
              data: [
                {
                  id: RUN,
                  period: "2026-08-01",
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
      // Nothing saved yet for the MRA (migration 0020): one row at most, so null.
      case "mra_company_details":
      case "mra_settings":
        return { data: null };
      default:
        return { data: [] };
    }
  });
}

const request = (params: Record<string, unknown>, appId = "mra-returns") =>
  answerMraBatchRequest(appId, { dataType: "mra-batch", params });

/** Asks, then answers the dashboard's question as the user would: unlocked, then "Send". */
async function askAndAllow(companies: string[]) {
  const pending = request({ action: "ask", brn: "C1234567", period: "2026-08", companies });
  await vi.waitFor(() => expect(dataRequests.get()).toHaveLength(1));
  const asked = dataRequests.get()[0]!;
  grantUnlock(10);
  asked.respond(await asked.question!.answer());
  return { answer: await pending, asked };
}
const LOAD = { action: "load", brn: "C1234567", period: "2026-08", company_brn: "C1234567" };

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
  forgetMraBatchAllowed();
  lock();
  vi.useRealTimers();
});

describe("the MRA Returns app in the registry", () => {
  it("may ask for mra-batch and its templates, and send only templates", () => {
    expect(getApp("mra-returns")).toMatchObject({
      name: "MRA Returns",
      url: "https://noor1290.github.io/mra_returns/",
      status: "active",
      accepts: ["mra-batch", "mra-template"],
      produces: ["mra-template"],
    });
    expect(DATA_RULES["mra-batch"]).toMatchObject({ sendRows: 0, sendBytes: 0 });
  });
});

describe("companies: the user's admin companies, read from the database", () => {
  it("lists only companies where the user is an admin, this company first, with no question asked", async () => {
    const answer = await request({ action: "companies", brn: "C1234567" });
    expect(answer).toEqual({
      ok: true,
      dataType: "mra-batch",
      rows: [
        { brn: "C1234567", name: "ABC Co Ltd", selected: true },
        { brn: "C3333333", name: "DEF Ltd", selected: false },
      ],
      meta: { label: "ABC Co Ltd", brn: "C1234567", role: "admin" },
    });
    expect(dataRequests.get()).toHaveLength(0);
  });

  it("refuses another company's BRN", async () => {
    expect(await request({ action: "companies", brn: "C2222222" })).toMatchObject({
      ok: false,
      code: "wrong-company",
    });
  });
});

describe("ask: one question naming the month and every company", () => {
  it("asks once, naming every company, never 'and N more', and allows only those", async () => {
    const pending = request({
      action: "ask",
      brn: "C1234567",
      period: "2026-08",
      companies: ["C1234567", " c3333333 "],
    });
    await vi.waitFor(() => expect(dataRequests.get()).toHaveLength(1));
    const asked = dataRequests.get()[0]!;
    expect(asked.question).toMatchObject({
      what: "the August 2026 payroll of 2 companies",
      of: "ABC Co Ltd and DEF Ltd",
    });
    expect(asked.question!.warning).toContain("national IDs and pay");
    grantUnlock(10);
    asked.respond(await asked.question!.answer());
    expect(await pending).toEqual({
      ok: true,
      dataType: "mra-batch",
      rows: [
        { brn: "C1234567", name: "ABC Co Ltd" },
        { brn: "C3333333", name: "DEF Ltd" },
      ],
      meta: { label: "ABC Co Ltd", brn: "C1234567", role: "admin", period: "2026-08" },
    });
  });

  it("asks for one company the same way", async () => {
    const pending = request({
      action: "ask",
      brn: "C1234567",
      period: "2026-08",
      companies: ["C1234567"],
    });
    await vi.waitFor(() => expect(dataRequests.get()).toHaveLength(1));
    expect(dataRequests.get()[0]!.question).toMatchObject({
      what: "the August 2026 payroll of 1 company",
      of: "ABC Co Ltd",
    });
    dataRequests.get()[0]!.respond({ ok: false, code: "denied", error: "No." });
    expect(await pending).toMatchObject({ ok: false, code: "denied" });
  });

  it("refuses at once, without asking, a company where the user is only a member or not a member", async () => {
    for (const brn of ["C2222222", "C9999999"]) {
      expect(
        await request({
          action: "ask",
          brn: "C1234567",
          period: "2026-08",
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

  it("refuses a selected company where the user is only a member, without asking", async () => {
    members = [{ role: "viewer", companies: abc }];
    signIn("viewer");
    expect(
      await request({ action: "ask", brn: "C1234567", period: "2026-08", companies: ["C1234567"] }),
    ).toMatchObject({ ok: false, code: "forbidden" });
    expect(await request({ action: "companies" })).toMatchObject({ ok: true, rows: [] });
    expect(dataRequests.get()).toHaveLength(0);
  });

  it("needs a month, named companies (no 'all') and at most 200 of them", async () => {
    const ask = (more: Record<string, unknown>) =>
      request({ action: "ask", brn: "C1234567", period: "2026-08", ...more });
    expect(await ask({})).toMatchObject({ ok: false, code: "invalid" });
    expect(await ask({ all: true })).toMatchObject({ ok: false, code: "invalid" });
    expect(await ask({ companies: ["C1234567"], period: "2026-13" })).toMatchObject({
      ok: false,
      code: "invalid",
    });
    const many = Array.from({ length: 201 }, (_, n) => `B${n}`);
    expect(await ask({ companies: many })).toMatchObject({ ok: false, code: "invalid" });
    expect(dataRequests.get()).toHaveLength(0);
  });
});

describe("load: one company's saved run, only as allowed", () => {
  it("is refused when nothing was allowed, with nothing read", async () => {
    grantUnlock(10);
    expect(await request(LOAD)).toEqual({
      ok: false,
      code: "denied",
      error: "That company and month were not allowed in the dashboard for this app. Ask again.",
    });
    expect(fake.state.queries).toHaveLength(0);
  });

  it("gives the company's saved run of the month: the rows 'Get from dashboard' gives", async () => {
    await askAndAllow(["C1234567", "C3333333"]);
    const answer = await request(LOAD);
    expect(answer).toMatchObject({
      ok: true,
      dataType: "mra-batch",
      meta: { brn: "C1234567", period: "2026-08" },
      rows: [
        {
          brn: "C1234567",
          name: "ABC Co Ltd",
          address: "1 Fake Street, Port Louis",
          period: "2026-08",
          run: true,
        },
      ],
    });
    const [row] = (answer as { rows: Record<string, unknown>[] }).rows;
    expect(row!.employees).toEqual([
      expect.objectContaining({
        ID: "X0000000000001",
        Surname: "DOE",
        "Other names": "Jane",
        "New Basic Salary": 18750,
        "Gross Pay": 18750,
        "Employee CSG": 281.25,
        "Employer NSF": 468.75,
        "Date of Employment": "2020-02-01",
        "Company Name": "ABC Co Ltd",
        BRN: "C1234567",
      }),
    ]);
    expect(JSON.stringify(row)).not.toContain(ME);
  });

  it("adds the company's MRA details, the user's email and its own template values (0020)", async () => {
    const TEMPLATE = "60000000-0000-4000-8000-000000000001";
    database((calls) => {
      if (table(calls) === "mra_company_details" && eqValue(calls, "company_id") === ABC) {
        return {
          data: {
            company_id: ABC,
            ern: "001234",
            telephone: "",
            mobile: "5000 0000",
            declarant: "A. SAMPLE",
            revision: 2,
            updated_at: "t",
          },
        };
      }
      if (table(calls) === "mra_settings" && eqValue(calls, "user_id") === ME) {
        return { data: { email: "returns@example.org", revision: 1, updated_at: "t" } };
      }
      if (table(calls) === "mra_template_companies") {
        return {
          data: [
            {
              template_id: TEMPLATE,
              company_id: ABC,
              own_values: { values: { c7: "abc@example.org" } },
              revision: 3,
              updated_by: null,
              updated_at: "t",
            },
          ],
        };
      }
      return undefined;
    });
    await askAndAllow(["C1234567"]);
    const answer = await request(LOAD);
    const [row] = (answer as { rows: Record<string, unknown>[] }).rows;
    expect(row).toMatchObject({
      // Text, so the leading zeros stay.
      mra: { ern: "001234", telephone: "", mobile: "5000 0000", declarant: "A. SAMPLE" },
      email: "returns@example.org",
      templates: [
        {
          template_id: TEMPLATE,
          own_values: { values: { c7: "abc@example.org" } },
          values_revision: 3,
        },
      ],
    });
    expect(JSON.stringify(row)).not.toContain(ME);
  });

  it("gives empty MRA details and email until they are saved", async () => {
    await askAndAllow(["C1234567"]);
    const [row] = ((await request(LOAD)) as { rows: Record<string, unknown>[] }).rows;
    expect(row).toMatchObject({
      mra: { ern: "", telephone: "", mobile: "", declarant: "" },
      email: "",
      templates: [],
    });
  });

  it("names migration 0020 when its tables are not there yet", async () => {
    database((calls) =>
      table(calls) === "mra_company_details"
        ? { data: null, error: { code: "PGRST205", message: "Could not find the table" } }
        : undefined,
    );
    await askAndAllow(["C1234567"]);
    expect(await request(LOAD)).toMatchObject({
      ok: false,
      code: "unavailable",
      error: expect.stringContaining("0020_mra_returns.sql"),
    });
  });

  it("says when the month was never sent to the dashboard", async () => {
    await askAndAllow(["C3333333"]);
    expect(await request({ ...LOAD, company_brn: "C3333333" })).toMatchObject({
      ok: true,
      rows: [{ brn: "C3333333", name: "DEF Ltd", period: "2026-08", run: false, employees: [] }],
    });
    // ABC has a run, but of August only: July was never sent.
    const pending = request({
      action: "ask",
      brn: "C1234567",
      period: "2026-07",
      companies: ["C1234567"],
    });
    await vi.waitFor(() => expect(dataRequests.get()).toHaveLength(1));
    const asked = dataRequests.get()[0]!;
    asked.respond(await asked.question!.answer());
    await pending;
    expect(await request({ ...LOAD, period: "2026-07" })).toMatchObject({
      ok: true,
      rows: [{ brn: "C1234567", period: "2026-07", run: false, employees: [] }],
    });
  });

  it("is refused for a company or a month that was not allowed, or for another app", async () => {
    await askAndAllow(["C1234567"]);
    expect(await request({ ...LOAD, company_brn: "C3333333" })).toMatchObject({
      ok: false,
      code: "denied",
    });
    expect(await request({ ...LOAD, period: "2026-07" })).toMatchObject({
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
      error: "Only an admin of that company can make its MRA returns.",
    });
  });

  it("is refused after another company is selected in the dashboard", async () => {
    await askAndAllow(["C3333333"]);
    exchangeContext.set({
      viewer: { id: ME, isDemo: false },
      membership: { role: "admin", company: def },
    });
    expect(await request({ ...LOAD, brn: "C3333333", company_brn: "C3333333" })).toMatchObject({
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

  it("names the month and every company, and what it sends", async () => {
    grantUnlock(10);
    void request({
      action: "ask",
      brn: "C1234567",
      period: "2026-08",
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
    expect(dialog.textContent).toContain("MRA Returns is asking for payroll data");
    expect(dialog.textContent).toContain(
      "It wants the August 2026 payroll of 2 companies: ABC Co Ltd and DEF Ltd.",
    );
    expect(dialog.textContent).toContain(
      "This sends each company's saved run for that month, with national IDs and pay, to the app, one company at a time, for the next 15 minutes, to make its MRA return files.",
    );
    expect(
      screen.getByRole("button", { name: "Send the August 2026 payroll of 2 companies" }),
    ).toBeTruthy();
  });

  it("writes a row in the Transfer log for each request, never with a value", async () => {
    await askAndAllow(["C1234567"]);
    await answerRequest("mra-returns", "mra-batch", () => request(LOAD));
    const log = JSON.stringify(transferLog.get());
    expect(log).toContain("mra-batch");
    expect(log).not.toContain("X0000000000001");
    expect(log).not.toContain("18750");
  });
});

describe("open-profile: the Company profile of a company whose MRA details are missing (Stage 2)", () => {
  const OPEN = { action: "open-profile", brn: "C1234567" };
  let opened: string[];
  let removeOpener: () => void;
  beforeEach(() => {
    opened = [];
    removeOpener = setProfileOpener((companyId) => opened.push(companyId));
  });
  afterEach(() => removeOpener());

  /** The dashboard moves only after the answer has left. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

  it("shows the selected company's profile, asks nothing, needs no gate and sends nothing", async () => {
    lock();
    const answer = await request({ ...OPEN, company_brn: "C1234567" });
    expect(answer).toEqual({
      ok: true,
      dataType: "mra-batch",
      rows: [],
      meta: expect.objectContaining({ brn: "C1234567" }),
    });
    expect(dataRequests.get()).toHaveLength(0);
    expect(opened).toEqual([]);
    await settle();
    expect(opened).toEqual([ABC]);
  });

  it("shows another company's profile when the user is its admin", async () => {
    expect(await request({ ...OPEN, company_brn: " c3333333 " })).toMatchObject({ ok: true });
    await settle();
    expect(opened).toEqual([DEF]);
  });

  it("refuses a company where the user is only a member, or not a member, even when the app is bypassed", async () => {
    for (const brn of ["C2222222", "C9999999"]) {
      expect(await request({ ...OPEN, company_brn: brn })).toEqual({
        ok: false,
        code: "forbidden",
        error: "Only an admin of that company can open its MRA details.",
      });
    }
    await settle();
    expect(opened).toEqual([]);
  });

  it("refuses another company's BRN as the selected one, and a request with no company", async () => {
    expect(await request({ ...OPEN, brn: "C3333333", company_brn: "C3333333" })).toMatchObject({
      ok: false,
      code: "wrong-company",
    });
    expect(await request({ action: "open-profile", brn: "C1234567" })).toMatchObject({
      ok: false,
      code: "invalid",
    });
    await settle();
    expect(opened).toEqual([]);
  });

  it("says when the dashboard cannot show the profile", async () => {
    removeOpener();
    expect(await request({ ...OPEN, company_brn: "C1234567" })).toEqual({
      ok: false,
      code: "unavailable",
      error: "The dashboard cannot show the Company profile right now.",
    });
  });

  it("writes a row in the Transfer log", async () => {
    await answerRequest("mra-returns", "mra-batch", () =>
      request({ ...OPEN, company_brn: "C1234567" }),
    );
    expect(JSON.stringify(transferLog.get())).toContain("mra-batch");
  });
});
