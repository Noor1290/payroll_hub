import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APPS } from "@/config/apps.config";
import { clearTransferLog } from "@/features/transfer/transferLog";
import { runSessionCleanup } from "@/lib/sessionCleanup";
import { grantUnlock, lock } from "@/lib/unlock";
import { fake, type Answer, type Call } from "@/test/fakeClient";
import { exchangeContext } from "./appData";
import {
  answerPayrollImportRequest,
  describeImport,
  savePayrollImportFromApp,
} from "./payrollImportData";

/**
 * Importing a "Several companies" Excel file (payroll-import): what the dashboard has for each
 * BRN of the file, then one company at a time through import_payroll_company (migration 0019).
 * Admins only, with the gate open. The database is the fake client. FAKE values only.
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
const members = [
  { role: "admin", companies: abc },
  { role: "admin", companies: def },
  { role: "viewer", companies: xyz },
];

const table = (calls: Call[]) => fake.arg(calls, "from") as string | undefined;
const eqValue = (calls: Call[], column: string) =>
  calls.find(([method, name]) => method === "eq" && name === column)?.[2];
const rpcs = () =>
  fake.state.queries.filter((calls) => fake.arg(calls, "rpc") === "import_payroll_company");

const IMPORTED = {
  company_id: ABC,
  brn: "C1234567",
  name: "ABC Co Ltd",
  created: false,
  shared_setup_id: SHARED,
  shared_created: false,
  attached: false,
  shared_revision: 7,
  company_revision: 4,
  months: [{ period: "2026-10-01", revision: 2, employee_count: 1, replaced: true }],
};

function database(more: (calls: Call[]) => Answer | undefined = () => undefined): void {
  fake.reset((calls) => {
    const found = more(calls);
    if (found) return found;
    const company = eqValue(calls, "company_id");
    if (fake.arg(calls, "rpc") === "import_payroll_company") return { data: IMPORTED };
    switch (table(calls)) {
      case "company_members":
        return { data: members };
      case "payroll_company_setups":
        return company === ABC
          ? {
              data: {
                company_id: ABC,
                shared_setup_id: SHARED,
                body: { columns: [] },
                revision: 4,
                updated_by: ME,
                updated_at: "t",
              },
            }
          : { data: null };
      case "payroll_shared_setups":
        return {
          data: {
            id: SHARED,
            name: "Shared column setup",
            body: { globalColumns: [] },
            revision: 7,
            updated_by: ME,
            updated_at: "t",
          },
        };
      case "payroll_months":
        return company === ABC
          ? {
              data: ["2026-06-01", "2026-09-01", "2026-10-01"].map((period, i) => ({
                period,
                revision: i + 1,
                shared_revision: 7,
                company_revision: 4,
                employee_count: 2,
                value_keys: ["basicSalary"],
                updated_by: ME,
                updated_at: "t",
              })),
            }
          : { data: [] };
      case "payroll_runs":
        return company === ABC
          ? {
              data: [
                {
                  id: "40000000-0000-4000-8000-000000000001",
                  period: "2026-10-01",
                  status: "approved",
                  created_by: null,
                  created_at: "t",
                  payroll_entries: [{ count: 1 }],
                },
                {
                  id: "40000000-0000-4000-8000-000000000002",
                  period: "2026-09-01",
                  status: "draft",
                  created_by: null,
                  created_at: "t",
                  payroll_entries: [{ count: 1 }],
                },
              ],
            }
          : { data: [] };
      default:
        return { data: [] };
    }
  });
}

const check = (params: Record<string, unknown>) =>
  answerPayrollImportRequest({ dataType: "payroll-import", params });
const CHECK = { action: "check", brn: "C1234567", from: "2026-07", to: "2027-06" };
const save = (row: Record<string, unknown>) =>
  savePayrollImportFromApp({ dataType: "payroll-import", rows: [row] });
const EMPLOYEES = [{ id: "e1", values: { employeeId: "TST001", basicSalary: 25000 } }];
const COMPANY = {
  action: "company",
  brn: "C1234567",
  company_brn: "C1234567",
  expected: { shared_revision: 7, company_revision: 4 },
  months: [{ period: "2026-10", employees: EMPLOYEES, expected_revision: 3, replace: true }],
};

beforeEach(() => {
  exchangeContext.set({
    viewer: { id: ME, isDemo: false },
    membership: { role: "admin", company: abc },
  });
  database();
  grantUnlock(10);
});
afterEach(() => {
  runSessionCleanup();
  clearTransferLog();
  lock();
});

describe("the data type", () => {
  it("is the payroll app's, to ask for and to send", () => {
    expect(
      APPS.filter((app) => app.accepts.includes("payroll-import")).map((app) => app.id),
    ).toEqual(["payroll"]);
    expect(
      APPS.filter((app) => app.produces.includes("payroll-import")).map((app) => app.id),
    ).toEqual(["payroll"]);
  });
});

describe("check: what the dashboard has for each BRN of the file", () => {
  it("says, per BRN, admin (with its setup, the saved months of the range and the approved ones), member, or not in the dashboard", async () => {
    const answer = await check({ ...CHECK, companies: ["C1234567", " c2222222 ", "C9999999"] });
    expect(answer).toEqual({
      ok: true,
      dataType: "payroll-import",
      meta: { label: "ABC Co Ltd", brn: "C1234567", role: "admin" },
      rows: [
        {
          brn: "C1234567",
          status: "admin",
          name: "ABC Co Ltd",
          address: "1 Fake Street",
          setup: {
            shared_setup_id: SHARED,
            shared_name: "Shared column setup",
            shared_body: { globalColumns: [] },
            shared_revision: 7,
            company_body: { columns: [] },
            company_revision: 4,
          },
          // June 2026 is before the range.
          months: [
            { period: "2026-09", revision: 2, employee_count: 2 },
            { period: "2026-10", revision: 3, employee_count: 2 },
          ],
          approved: ["2026-10"],
        },
        { brn: "C2222222", status: "member", name: "XYZ Trading Ltd" },
        { brn: "C9999999", status: "absent" },
      ],
    });
    expect(JSON.stringify(answer)).not.toContain(ME);
  });

  it("is refused while the gate is locked, for another selected company, and for a bad range", async () => {
    lock();
    expect(await check({ ...CHECK, companies: ["C1234567"] })).toMatchObject({
      ok: false,
      code: "locked",
    });
    expect(fake.state.queries).toHaveLength(0);
    grantUnlock(10);
    expect(await check({ ...CHECK, brn: "C3333333", companies: ["C1234567"] })).toMatchObject({
      ok: false,
      code: "wrong-company",
    });
    expect(await check({ ...CHECK, to: "2026-06", companies: ["C1234567"] })).toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(
      await check({ ...CHECK, from: "2024-01", to: "2026-01", companies: ["C1234567"] }),
    ).toMatchObject({ ok: false, code: "invalid" });
    expect(await check({ ...CHECK, companies: [] })).toMatchObject({ ok: false, code: "invalid" });
  });
});

describe("company: one company of the file, all or nothing", () => {
  it("saves a company the user is an admin of through import_payroll_company, the months as the database's dates", async () => {
    expect(await save(COMPANY)).toEqual({
      ok: true,
      result: {
        action: "company",
        brn: "C1234567",
        company: "ABC Co Ltd",
        created: false,
        attached: false,
        shared_created: false,
        shared_setup_id: SHARED,
        months: [{ period: "2026-10", revision: 2, employee_count: 1, replaced: true }],
      },
    });
    expect(rpcs()).toHaveLength(1);
    expect(fake.arg(rpcs()[0]!, "rpc", 1)).toEqual({
      p_company_id: ABC,
      p_new_company: null,
      p_setup: null,
      p_expected: { shared_revision: 7, company_revision: 4 },
      p_months: [
        { period: "2026-10-01", employees: EMPLOYEES, expected_revision: 3, replace: true },
      ],
    });
  });

  it("makes a new company only for a BRN the user has no company with, and only when asked to", async () => {
    const setup = { shared_setup_id: SHARED, create: false, company_body: { columns: [] } };
    expect(await save({ ...COMPANY, company_brn: "C9999999", expected: undefined })).toMatchObject({
      ok: false,
      code: "not-found",
    });
    expect(rpcs()).toHaveLength(0);
    database((calls) =>
      fake.arg(calls, "rpc") === "import_payroll_company"
        ? { data: { ...IMPORTED, created: true, attached: true } }
        : undefined,
    );
    const { expected: _expected, ...rest } = COMPANY;
    void _expected;
    expect(
      await save({
        ...rest,
        company_brn: " C9999999 ",
        new_company: { name: "Fake New Ltd", address: null },
        setup,
      }),
    ).toMatchObject({ ok: true, result: { created: true } });
    expect(fake.arg(rpcs()[0]!, "rpc", 1)).toMatchObject({
      p_company_id: null,
      p_new_company: { name: "Fake New Ltd", brn: "C9999999", address: null },
      p_setup: setup,
      p_expected: null,
    });
    // A company the user already has is never made again.
    expect(
      await save({ ...rest, new_company: { name: "ABC Co Ltd", address: null }, setup }),
    ).toMatchObject({
      ok: false,
      code: "stale",
    });
  });

  it("refuses at once, storing nothing: a company the user only views, the gate locked", async () => {
    expect(await save({ ...COMPANY, company_brn: "C2222222" })).toEqual({
      ok: false,
      code: "forbidden",
      error: "Only an admin of that company can import its months.",
    });
    lock();
    expect(await save(COMPANY)).toMatchObject({ ok: false, code: "locked" });
    expect(rpcs()).toHaveLength(0);
  });

  it("says plainly when the database refuses an approved month or a BRN in use", async () => {
    database((calls) =>
      fake.arg(calls, "rpc") === "import_payroll_company"
        ? { error: { message: "PH_MONTH_APPROVED: 2026-10" } }
        : undefined,
    );
    expect(await save(COMPANY)).toEqual({
      ok: false,
      code: "forbidden",
      error:
        "The month 2026-10 has an approved run in the dashboard, so it is never replaced. Nothing of this company was saved.",
    });
    database((calls) =>
      fake.arg(calls, "rpc") === "import_payroll_company"
        ? { error: { message: "PH_DUPLICATE_BRN" } }
        : undefined,
    );
    const { expected: _expected, ...rest } = COMPANY;
    void _expected;
    expect(
      await save({
        ...rest,
        company_brn: "C9999999",
        new_company: { name: "Fake New Ltd", address: null },
        setup: { shared_setup_id: SHARED, create: false, company_body: {} },
      }),
    ).toMatchObject({
      ok: false,
      code: "invalid",
      error: expect.stringContaining("you are not a member of it"),
    });
  });

  it("checks what it is sent: 1 to 24 months named once, each 1 MB at most", async () => {
    expect(await save({ ...COMPANY, months: [] })).toMatchObject({ ok: false, code: "invalid" });
    expect(
      await save({ ...COMPANY, months: [COMPANY.months[0], COMPANY.months[0]] }),
    ).toMatchObject({ ok: false, code: "invalid" });
    const big = Array.from({ length: 5000 }, (_, i) => ({
      id: `e${i}`,
      values: { note: "x".repeat(250) },
    }));
    expect(
      await save({ ...COMPANY, months: [{ ...COMPANY.months[0], employees: big }] }),
    ).toMatchObject({ ok: false, code: "too-large" });
    expect(rpcs()).toHaveLength(0);
  });
});

describe("summary: the one toast at the end", () => {
  it("counts what was done, and what was not", () => {
    expect(describeImport({ created: 2, added: 14, replaced: 3, skipped: 4, failed: 1 })).toBe(
      "Payroll imported from Excel: 2 companies added to the dashboard, 14 months added, 3 months replaced; 4 months skipped, 1 company not imported.",
    );
    expect(describeImport({ created: 0, added: 1, replaced: 0, skipped: 0, failed: 0 })).toBe(
      "Payroll imported from Excel: 1 month added.",
    );
    expect(describeImport({ created: 0, added: 0, replaced: 0, skipped: 2, failed: 0 })).toBe(
      "Nothing was imported from Excel; 2 months skipped.",
    );
  });
});
