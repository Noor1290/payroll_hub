import { fetchApprovedPeriods } from "@/lib/supabase/payroll";
import { fetchMonths, fetchNewestMonths } from "@/lib/supabase/payrollMonths";
import {
  fetchCompanySetups,
  fetchSharedSetup,
  type SharedSetup,
} from "@/lib/supabase/payrollSetups";
import type { Viewer } from "@/lib/supabase/queries";
import type { Membership } from "@/lib/supabase/schemas";
import { isUnlocked } from "@/lib/unlock";
import type { PreviewRow } from "./companyImport";
import type { CurrentCompany } from "./companyUpdate";
import type { EmployeeFileRow, ExistingCompany, NewCompany } from "./employeeImport";
import { setupFields } from "./employeeSheet";
import { TemplateLocked } from "./employeeTemplateData";

// What the preview of the Employees sheet compares the file with (employeeImport.ts). Reads only,
// and only for the user's admin companies the file names. Their saved months hold national IDs
// and salaries, so they are read only while the password gate is open; if it locks while
// reading, nothing is returned (TemplateLocked).

const normaliseBrn = (brn: string) => brn.replace(/\s/g, "").toUpperCase();

/** The admin companies the file's employee rows name, by BRN. */
export function namedAdminCompanies(
  rows: readonly EmployeeFileRow[],
  admin: readonly CurrentCompany[],
): CurrentCompany[] {
  const wanted = new Set(rows.map((row) => row.brn).filter(Boolean));
  return admin.filter((company) => company.brn && wanted.has(normaliseBrn(company.brn)));
}

/** Whether reading the file's employees needs the password gate open: it names a company of yours. */
export const needsUnlock = (rows: readonly EmployeeFileRow[], admin: readonly CurrentCompany[]) =>
  namedAdminCompanies(rows, admin).length > 0;

/**
 * For each of the user's admin companies the file names: its setup, its newest saved month,
 * whether that month is approved, and the older months its References point to.
 */
export async function loadExistingCompanies(
  viewer: Viewer,
  rows: readonly EmployeeFileRow[],
  admin: readonly CurrentCompany[],
): Promise<Map<string, ExistingCompany>> {
  const named = namedAdminCompanies(rows, admin);
  const out = new Map<string, ExistingCompany>();
  if (named.length === 0) return out;
  if (!isUnlocked()) throw new TemplateLocked();

  const ids = named.map((company) => company.id);
  const [setups, months, approved] = await Promise.all([
    fetchCompanySetups(viewer, ids),
    fetchNewestMonths(viewer, ids),
    fetchApprovedPeriods(viewer, ids),
  ]);
  const shared = new Map<string, SharedSetup | null>(
    await Promise.all(
      [...new Set(setups.map((setup) => setup.shared_setup_id))].map(
        async (id) => [id, await fetchSharedSetup(viewer, id)] as const,
      ),
    ),
  );

  // Older months a Reference points to (a file downloaded before a newer month was saved).
  const referenced = new Map<string, Map<string, readonly Record<string, unknown>[]>>();
  await Promise.all(
    named.map(async (company) => {
      const brn = normaliseBrn(company.brn!);
      const newest = months.get(company.id)?.period;
      const periods = [
        ...new Set(
          rows
            .filter((row) => row.brn === brn)
            .map((row) => /^(\d{4}-(0[1-9]|1[0-2]))\//.exec(row.reference)?.[1])
            .filter((month): month is string => !!month)
            .map((month) => `${month}-01`)
            .filter((period) => period !== newest),
        ),
      ].slice(0, 24);
      const found = await fetchMonths(viewer, company.id, periods);
      referenced.set(company.id, new Map(found.map((month) => [month.period, month.employees])));
    }),
  );
  // The gate may have locked while the database was answering: then nothing leaves.
  if (!isUnlocked()) throw new TemplateLocked();

  for (const company of named) {
    const setup = setups.find((s) => s.company_id === company.id);
    const body = setup ? shared.get(setup.shared_setup_id)?.body : undefined;
    const month = months.get(company.id);
    out.set(normaliseBrn(company.brn!), {
      id: company.id,
      name: company.name,
      brn: normaliseBrn(company.brn!),
      fields: setup && body ? setupFields(body, setup.body) : null,
      setupRevisions:
        setup && body
          ? { shared: shared.get(setup.shared_setup_id)!.revision, company: setup.revision }
          : null,
      newest: month
        ? {
            period: month.period,
            revision: month.revision,
            sharedRevision: month.shared_revision,
            companyRevision: month.company_revision,
            employees: month.employees,
          }
        : null,
      approved: month ? approved.has(`${company.id}|${month.period}`) : false,
      referenced: referenced.get(company.id) ?? new Map(),
    });
  }
  return out;
}

/** The companies of the dashboard the user is only a member of, by BRN: their names. */
export function notAdminCompanies(memberships: readonly Membership[]): Map<string, string> {
  const admin = new Set(
    memberships
      .filter((m) => m.role === "admin" && m.company.brn)
      .map((m) => normaliseBrn(m.company.brn!)),
  );
  const out = new Map<string, string>();
  for (const { company } of memberships) {
    if (!company.brn) continue;
    const brn = normaliseBrn(company.brn);
    if (!admin.has(brn)) out.set(brn, company.name);
  }
  return out;
}

/**
 * The Companies sheet's companies that are not in the dashboard, by BRN, and whether each is being
 * created: a new row, ticked. One with a problem, unticked, or used twice is not.
 */
export function newCompaniesOf(rows: readonly PreviewRow[]): Map<string, NewCompany> {
  const out = new Map<string, NewCompany>();
  for (const item of rows) {
    if (item.status === "update" || item.status === "same" || item.status === "existing") continue;
    if (!item.row.brn || out.get(item.row.brn)?.created) continue;
    out.set(item.row.brn, {
      name: item.row.name,
      created: item.status === "new" && item.ticked,
    });
  }
  return out;
}

/** "YYYY-MM-01" of this month. */
export function thisMonth(at: Date = new Date()): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-01`;
}

/** The months a company with no saved month can start in: a year back to a year ahead. */
export function startMonths(at: Date = new Date()): string[] {
  const out: string[] = [];
  for (let offset = -12; offset <= 12; offset++) {
    const d = new Date(at.getFullYear(), at.getMonth() + offset, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`);
  }
  return out;
}
