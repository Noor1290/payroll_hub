import type { ImportedCompany, ImportInput } from "@/lib/supabase/payrollImport";
import { NotConfiguredError } from "@/lib/supabase/errors";
import { demoFetchApprovedPeriods, demoMemberships } from "./demoData";
import { demoFetchMonths, demoSaveMonth } from "./demoPayrollMonths";
import { demoSetupRevisions } from "./demoPayrollSetups";

/**
 * FAKE `import_payroll_company` (migration 0019) for dev-only demo mode and the dashboard's own
 * tests, for a company that exists and has a column setup (what the companies import saves its
 * employees with). Its rules: an admin of the company; the setup revisions the caller checked
 * are the current ones (PH_STALE); a saved month is replaced only when asked (PH_STALE) and
 * never when its run is approved (PH_MONTH_APPROVED). Months are checked before any is saved,
 * so a refusal stores nothing. A new company or a setup is not made here. Everything is invented
 * and lives in memory; only reachable behind `import.meta.env.DEV`.
 */
export async function demoImportPayrollCompany(input: ImportInput): Promise<ImportedCompany> {
  const fail = (message: string, code: string) => Object.assign(new Error(message), { code });
  if (input.companyId === null || input.setup !== null) throw new NotConfiguredError();
  const member = demoMemberships.find((m) => m.company.id === input.companyId);
  if (member?.role !== "admin") throw fail("PH_NOT_ADMIN", "42501");
  const setup = demoSetupRevisions(input.companyId);
  if (!setup) throw fail("PH_NOT_FOUND: the company has no payroll column setup", "P0002");
  if (
    !input.expected ||
    input.expected.shared_revision !== setup.sharedRevision ||
    input.expected.company_revision !== setup.companyRevision
  ) {
    throw fail("PH_STALE", "P0001");
  }
  const approved = new Set(
    (await demoFetchApprovedPeriods([input.companyId])).map((run) => run.period),
  );
  const saved = await demoFetchMonths(
    input.companyId,
    input.months.map((m) => m.period),
  );
  for (const month of input.months) {
    const exists = saved.find((s) => s.period === month.period);
    if (!exists) continue;
    if (!month.replace || exists.revision !== month.expected_revision) {
      throw fail("PH_STALE", "P0001");
    }
    if (approved.has(month.period)) {
      throw fail(`PH_MONTH_APPROVED: ${month.period.slice(0, 7)}`, "P0001");
    }
  }
  const months: ImportedCompany["months"] = [];
  for (const month of input.months) {
    const result = await demoSaveMonth(input.companyId, {
      period: month.period,
      employees: month.employees,
      expectedRevision: month.expected_revision,
      sharedRevision: setup.sharedRevision,
      companyRevision: setup.companyRevision,
      keepPrevious: true,
    });
    months.push({
      period: result.period,
      revision: result.revision,
      employee_count: result.employee_count,
      replaced: saved.some((s) => s.period === month.period),
    });
  }
  return {
    company_id: input.companyId,
    brn: member.company.brn,
    name: member.company.name,
    created: false,
    shared_setup_id: setup.sharedSetupId,
    shared_created: false,
    attached: false,
    shared_revision: setup.sharedRevision,
    company_revision: setup.companyRevision,
    months,
  };
}
