// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { NotConfiguredError } from "@/lib/supabase/errors";
import type { ImportInput } from "@/lib/supabase/payrollImport";
import { demoMemberships } from "./demoData";
import { demoImportPayrollCompany } from "./demoPayrollImport";
import { demoFetchMonths, demoForgetPayrollMonths, demoSeedMonth } from "./demoPayrollMonths";
import {
  demoAttachPayrollCompany,
  demoForgetPayrollSetups,
  demoSaveSharedSetup,
} from "./demoPayrollSetups";

// The demo workspace's stand-in for import_payroll_company (0019), as the companies import saves
// its employees with it: the same refusals as the database. Fake data only.

const ABC = demoMemberships.find((m) => m.company.name === "ABC Co Ltd")!.company.id;
const XYZ = demoMemberships.find((m) => m.role === "viewer")!.company.id;
const SETUP = "30000000-0000-4000-8000-0000000000f1";
const people = [{ id: "e1", values: { id: "T0101" } }];

async function attach() {
  await demoSaveSharedSetup({
    setupId: SETUP,
    name: "TEST setup",
    body: { identityFields: [{ id: "f1", name: "ID", key: "id" }], idFieldKey: "id" },
    expectedRevision: 0,
    companies: [],
  });
  await demoAttachPayrollCompany(ABC, SETUP, { columns: [] });
}
const input = (over: Partial<ImportInput> = {}): ImportInput => ({
  companyId: ABC,
  newCompany: null,
  setup: null,
  expected: { shared_revision: 1, company_revision: 1 },
  months: [{ period: "2026-11-01", employees: people, expected_revision: 0, replace: false }],
  ...over,
});

afterEach(() => {
  demoForgetPayrollMonths(ABC);
  demoForgetPayrollSetups(ABC);
  demoForgetPayrollSetups();
});

describe("demo import_payroll_company", () => {
  it("saves a new month, then replaces it only when asked and at the revision seen", async () => {
    await attach();
    expect((await demoImportPayrollCompany(input())).months[0]!.revision).toBe(1);
    await expect(demoImportPayrollCompany(input())).rejects.toThrow("PH_STALE");
    const again = input({
      months: [{ period: "2026-11-01", employees: [], expected_revision: 1, replace: true }],
    });
    expect((await demoImportPayrollCompany(again)).months[0]).toMatchObject({
      revision: 2,
      employee_count: 0,
      replaced: true,
    });
  });

  it("refuses a setup saved since, an approved month, a viewer, and anything but an existing company", async () => {
    await attach();
    await expect(
      demoImportPayrollCompany(input({ expected: { shared_revision: 2, company_revision: 1 } })),
    ).rejects.toThrow("PH_STALE");
    demoSeedMonth(ABC, "2026-08-01", people);
    await expect(
      demoImportPayrollCompany(
        input({
          months: [{ period: "2026-08-01", employees: [], expected_revision: 1, replace: true }],
        }),
      ),
    ).rejects.toThrow("PH_MONTH_APPROVED: 2026-08");
    expect((await demoFetchMonths(ABC, ["2026-08-01"]))[0]!.employees).toEqual(people);
    await expect(demoImportPayrollCompany(input({ companyId: XYZ }))).rejects.toThrow(
      "PH_NOT_ADMIN",
    );
    await expect(
      demoImportPayrollCompany(
        input({ companyId: null, newCompany: { name: "X", brn: "C9", address: null } }),
      ),
    ).rejects.toBeInstanceOf(NotConfiguredError);
  });
});

describe("the production build", () => {
  it("can drop this stand-in: its one use is behind `import.meta.env.DEV`, written out in place", async () => {
    const source = (await import("@/lib/supabase/payrollImport.ts?raw")).default as string;
    const guarded =
      source.split("import.meta.env.DEV && viewer.isDemo) return demoImportPayrollCompany(")
        .length - 1;
    const demoCalls = [...source.matchAll(/\bdemo[A-Z]\w+\(/g)].length;
    expect(demoCalls).toBe(1);
    expect(guarded).toBe(1);
    expect(source).not.toMatch(/=>\s*import\.meta\.env\.DEV/);
  });
});
