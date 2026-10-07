import type { RatesInput, RatesVersion, SavedRates } from "@/lib/supabase/statutoryRates";
import { demoMemberships } from "./demoData";

/**
 * FAKE statutory rates for dev-only demo mode, so the mock payslip app has something to talk
 * to. It follows the same rules as the database functions (admin only, the revision the caller
 * last saw must still be the latest, an identical correction is refused). Everything here is
 * invented and lives in memory. Only reachable behind `import.meta.env.DEV`.
 */

const ABC = "10000000-0000-4000-8000-000000000001";
const DEMO_USER_ID = "00000000-0000-4000-8000-000000000001";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message: string, code: string) => Object.assign(new Error(message), { code });

function requireAdmin(companyId: string) {
  const role = demoMemberships.find((m) => m.company.id === companyId)?.role;
  if (role !== "admin") throw fail("PH_NOT_ADMIN", "42501");
}

type StoredRates = RatesVersion & { company_id: string };

const rates: StoredRates[] = [
  {
    company_id: ABC,
    effective_from: "2025-07-01",
    revision: 1,
    nsf_employee_rate: 1,
    nsf_ceiling: 28570,
    nsf_exempt_at_60: true,
    csg_employee_rate_low: 1.5,
    csg_employee_rate_high: 3,
    csg_threshold: 50000,
    source_note: "Sample figures, not the real ones",
    created_by: DEMO_USER_ID,
    created_at: "2025-07-02T09:00:00+04:00",
  },
];

export async function demoFetchStatutoryRates(companyId: string): Promise<RatesVersion[]> {
  await pause(250);
  return rates
    .filter((row) => row.company_id === companyId)
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from) || b.revision - a.revision)
    .map((row) => {
      const copy: Partial<StoredRates> = { ...row };
      delete copy.company_id;
      return copy as RatesVersion;
    });
}

export async function demoSaveStatutoryRates(
  companyId: string,
  input: RatesInput,
): Promise<SavedRates> {
  await pause(400);
  requireAdmin(companyId);
  const sameMonth = rates.filter(
    (row) => row.company_id === companyId && row.effective_from === input.effectiveFrom,
  );
  const latest = sameMonth.reduce<StoredRates | null>(
    (best, row) => (best === null || row.revision > best.revision ? row : best),
    null,
  );
  if ((latest?.revision ?? 0) !== input.expectedRevision) throw fail("PH_STALE", "P0001");
  if (
    latest &&
    latest.nsf_employee_rate === input.nsfEmployeeRate &&
    latest.nsf_ceiling === input.nsfCeiling &&
    latest.nsf_exempt_at_60 === input.nsfExemptAt60 &&
    latest.csg_employee_rate_low === input.csgEmployeeRateLow &&
    latest.csg_employee_rate_high === input.csgEmployeeRateHigh &&
    latest.csg_threshold === input.csgThreshold &&
    latest.source_note === input.sourceNote
  ) {
    throw fail("PH_NO_CHANGE", "P0001");
  }
  const revision = (latest?.revision ?? 0) + 1;
  rates.push({
    company_id: companyId,
    effective_from: input.effectiveFrom,
    revision,
    nsf_employee_rate: input.nsfEmployeeRate,
    nsf_ceiling: input.nsfCeiling,
    nsf_exempt_at_60: input.nsfExemptAt60,
    csg_employee_rate_low: input.csgEmployeeRateLow,
    csg_employee_rate_high: input.csgEmployeeRateHigh,
    csg_threshold: input.csgThreshold,
    source_note: input.sourceNote,
    created_by: DEMO_USER_ID,
    created_at: new Date().toISOString(),
  });
  return { effective_from: input.effectiveFrom, revision };
}

/** Rows the demo company has here, for the delete-company preview. */
export function demoAppDataCounts(companyId: string) {
  return { rates: rates.filter((row) => row.company_id === companyId).length };
}

/** Removes everything a deleted demo company had here. */
export function demoForgetAppData(companyId: string): void {
  for (let i = rates.length - 1; i >= 0; i--) {
    if (rates[i]!.company_id === companyId) rates.splice(i, 1);
  }
}
