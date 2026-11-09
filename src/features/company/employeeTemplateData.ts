import { fetchNewestMonths } from "@/lib/supabase/payrollMonths";
import {
  fetchCompanySetups,
  fetchSharedSetup,
  type SharedSetup,
} from "@/lib/supabase/payrollSetups";
import type { Viewer } from "@/lib/supabase/queries";
import type { Membership } from "@/lib/supabase/schemas";
import { isUnlocked } from "@/lib/unlock";
import { loadSetupChoices, type CompanyEmployees } from "./companyImport";
import type { CurrentCompany } from "./companyUpdate";
import { setupFields, type SetupFields } from "./employeeSheet";

// What the two templates' Employees sheets are made from. Reads only.
//
//  - The blank template: the identity fields and Input columns of the user's most-used column
//    setup (names only, no employee).
//  - The template with my companies: each company's setup and the employees of its newest saved
//    month. Months hold national IDs and salaries, so they are read only while the password gate
//    is open, as every other read of them (payrollMonthData.ts); if it locks while reading,
//    nothing is returned. The file is then made from the identity fields other than the ID, and
//    nothing read is kept.

/** The password gate is locked: the template with my companies needs it open. */
export class TemplateLocked extends Error {
  constructor() {
    super("The dashboard is locked.");
    this.name = "TemplateLocked";
  }
}

/** The blank template's columns: the default setup for new companies; null when there is none. */
export async function fetchBlankTemplateSetup(
  viewer: Viewer,
  memberships: readonly Membership[],
): Promise<{ name: string; fields: SetupFields } | null> {
  const adminIds = memberships.filter((m) => m.role === "admin").map((m) => m.company.id);
  if (adminIds.length === 0) return null;
  const { defaultSetup } = await loadSetupChoices(viewer, adminIds);
  return defaultSetup
    ? { name: defaultSetup.name, fields: setupFields(defaultSetup.body, null) }
    : null;
}

/** For each of these companies, by id: its setup and the employees of its newest saved month. */
export async function fetchTemplateEmployees(
  viewer: Viewer,
  companies: readonly CurrentCompany[],
): Promise<Map<string, CompanyEmployees>> {
  if (!isUnlocked()) throw new TemplateLocked();
  const ids = companies.map((company) => company.id);
  const setups = await fetchCompanySetups(viewer, ids);
  const sharedIds = [...new Set(setups.map((setup) => setup.shared_setup_id))];
  const shared = new Map<string, SharedSetup | null>(
    await Promise.all(
      sharedIds.map(async (id) => [id, await fetchSharedSetup(viewer, id)] as const),
    ),
  );
  const months = await fetchNewestMonths(
    viewer,
    setups.map((setup) => setup.company_id),
  );
  // The gate may have locked while the database was answering: then nothing leaves.
  if (!isUnlocked()) throw new TemplateLocked();

  const out = new Map<string, CompanyEmployees>();
  for (const setup of setups) {
    const body = shared.get(setup.shared_setup_id)?.body;
    if (!body) continue;
    const month = months.get(setup.company_id);
    out.set(setup.company_id, {
      fields: setupFields(body, setup.body),
      period: month?.period ?? null,
      employees: month?.employees ?? [],
    });
  }
  return out;
}
