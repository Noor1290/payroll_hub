import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeXlsx } from "@/lib/xlsx/writeXlsx";

vi.mock("@/lib/supabase/client", async () => ({
  supabase: (await import("@/test/fakeClient")).fake.client,
}));
const { fake } = await import("@/test/fakeClient");
const { loadExistingCompanies } = await import("./employeeImportData");
const { readCompaniesFile } = await import("./companyImport");
const { grantUnlock, lock } = await import("@/lib/unlock");
type CurrentCompany = import("./companyUpdate").CurrentCompany;
type EmployeeFileRow = import("./employeeImport").EmployeeFileRow;
type Call = import("@/test/fakeClient").Call;

// What the Employees preview reads from the dashboard: only the user's admin companies the file
// names (no password since hotfix 2). TEST companies and fake employees only.

const VIEWER = { id: "00000000-0000-4000-8000-0000000000a1", isDemo: false };
const SHARED = "20000000-0000-4000-8000-000000000001";
const company = (n: number, brn: string): CurrentCompany => ({
  id: `10000000-0000-4000-8000-00000000000${n}`,
  name: `TEST ${n} Ltd`,
  brn,
  address: null,
  vat: null,
  details: [],
  mra: null,
});
const ALPHA = company(1, "C0000101");
const BETA = company(2, "C0000102");
const row = (brn: string, reference = ""): EmployeeFileRow => ({
  line: 2,
  brnTyped: brn,
  brn,
  reference,
  cells: [],
});

const answer = (calls: Call[]) => {
  const from = fake.arg(calls, "from");
  const select = String(fake.arg(calls, "select"));
  if (from === "payroll_company_setups") {
    return {
      data: [
        {
          company_id: ALPHA.id,
          shared_setup_id: SHARED,
          body: {},
          revision: 2,
          updated_by: null,
          updated_at: "2026-11-01T00:00:00Z",
        },
      ],
    };
  }
  if (from === "payroll_shared_setups") {
    return {
      data: {
        id: SHARED,
        name: "TEST setup",
        body: { identityFields: [{ name: "ID", key: "id" }], idFieldKey: "id", globalColumns: [] },
        revision: 5,
        updated_by: null,
        updated_at: "2026-11-01T00:00:00Z",
      },
    };
  }
  if (from === "payroll_runs") return { data: [{ company_id: ALPHA.id, period: "2026-10-01" }] };
  if (from === "payroll_months" && select === "company_id, period") {
    return { data: [{ company_id: ALPHA.id, period: "2026-10-01" }] };
  }
  if (from === "payroll_months") {
    const month = (period: string, id: string) => ({
      company_id: ALPHA.id,
      period,
      revision: 3,
      shared_revision: 5,
      company_revision: 2,
      employee_count: 1,
      employees: [{ id, values: { id: "T1" } }],
      updated_by: null,
      updated_at: "2026-11-01T00:00:00Z",
    });
    return fake.arg(calls, "eq", 1) === "2026-10-01"
      ? { data: [month("2026-10-01", "oct-1")] }
      : { data: [month("2026-09-01", "sep-1")] };
  }
  return { data: [] };
};

beforeEach(() => fake.reset(answer));
afterEach(() => lock());

describe("what the Employees preview reads", () => {
  it("reads with the password gate locked: no password for this any more (hotfix 2)", async () => {
    lock();
    const found = await loadExistingCompanies(VIEWER, [row("C0000101")], [ALPHA]);
    expect(found.size).toBe(1);
    expect(fake.state.queries.length).toBeGreaterThan(0);
  });

  it("reads only the companies the file names: setup, newest month, approval, and the older months its References point to", async () => {
    grantUnlock(5);
    const found = await loadExistingCompanies(
      VIEWER,
      [row("C0000101", "2026-09/sep-1"), row("C0000101", "2026-10/oct-1")],
      [ALPHA, BETA],
    );
    const alpha = found.get("C0000101")!;
    expect(alpha.newest).toMatchObject({ period: "2026-10-01", revision: 3, sharedRevision: 5 });
    expect(alpha.approved).toBe(true);
    expect(alpha.fields?.idKey).toBe("id");
    expect([...alpha.referenced.keys()]).toEqual(["2026-09-01"]);
    expect(found.has("C0000102")).toBe(false);
    // Every company asked for, in any read, is TEST 1 only.
    for (const query of fake.state.queries) {
      for (const [method, column, value] of query) {
        if (method === "in" && column === "company_id") expect(value).toEqual([ALPHA.id]);
        if (method === "eq" && column === "company_id") expect(value).toBe(ALPHA.id);
      }
    }
    const runs = fake.state.queries.find((q) => fake.arg(q, "from") === "payroll_runs")!;
    expect(runs).toContainEqual(["eq", "status", "approved"]);
    expect(runs).toContainEqual(["is", "deleted_at", null]);
  });

  it("reads nothing for a file whose employees are all of new companies", async () => {
    expect((await loadExistingCompanies(VIEWER, [row("C0000999")], [ALPHA])).size).toBe(0);
    expect(fake.state.queries).toEqual([]);
  });
});

describe("a file with employees only", () => {
  const asFile = (bytes: Uint8Array) => ({
    size: bytes.length,
    arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
  });
  const file = (employees: string[][]) =>
    asFile(
      writeXlsx([
        { name: "Companies", columns: [], rows: [["Company name *", "BRN *"]] },
        { name: "Employees", columns: [], rows: [["Company BRN *", "ID"], ...employees] },
      ]),
    );

  it("is read when its Companies sheet is empty: employees for companies already there", async () => {
    const result = await readCompaniesFile(file([["C0000101", "T1"]]));
    expect(result.ok && result.rows).toEqual([]);
    expect(result.ok && result.employees?.rows.map((r) => r.brn)).toEqual(["C0000101"]);
  });

  it("is still refused when both sheets are empty", async () => {
    expect(await readCompaniesFile(file([]))).toEqual({
      ok: false,
      why: "The Companies sheet has no companies in it.",
    });
  });
});
