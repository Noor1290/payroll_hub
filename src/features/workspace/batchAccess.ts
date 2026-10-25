import { formatCount } from "@/lib/format";
import { fetchMemberships, type Viewer } from "@/lib/supabase/queries";
import type { Membership } from "@/lib/supabase/schemas";
import { normaliseBrn } from "./appData";

/**
 * What the data types for several companies at once share (payslip-batch, payroll-batch):
 *
 *  - only companies the user is an ADMIN of, read from the database each time;
 *  - ONE question in the dashboard for a month and the companies; agreeing allows a load of
 *    those companies and that month only, for this app, user and selected company, for 15
 *    minutes. The permission is kept in memory only; each data type forgets its own when the
 *    gate locks or on sign-out (registerLockCleanup, registerSessionCleanup).
 */

/** How long agreeing in the dialog allows the loads. */
export const BATCH_ALLOWED_MS = 15 * 60_000;

/** The companies the user is an admin of and that have a BRN, read from the database now. */
export async function adminCompanies(viewer: Viewer, selectedId: string): Promise<Membership[]> {
  return (await fetchMemberships(viewer))
    .filter((membership) => membership.role === "admin" && membership.company.brn)
    .sort(
      (a, b) =>
        Number(b.company.id === selectedId) - Number(a.company.id === selectedId) ||
        a.company.name.localeCompare(b.company.name) ||
        a.company.id.localeCompare(b.company.id),
    );
}

/** "1 company", "12 companies". */
export const countCompanies = (count: number) =>
  `${formatCount(count)} ${count === 1 ? "company" : "companies"}`;

/** "ABC Co Ltd, DEF Ltd and GHI Ltd" or, with `upTo`, "ABC Co Ltd, DEF Ltd, GHI Ltd and 7 more". */
export function listNames(names: readonly string[], upTo = Infinity): string {
  const shown = names.slice(0, upTo);
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${formatCount(rest)} more`;
  return shown.length > 1
    ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)!}`
    : shown.join("");
}

/** What the user allowed in the dialog. */
export interface BatchPermit {
  appId: string;
  userId: string;
  selectedCompanyId: string;
  period: string;
  brns: ReadonlySet<string>;
  until: number;
}

/** One permission at a time per data type: a new ask replaces it. */
export function batchPermits() {
  let allowed: BatchPermit | null = null;
  return {
    allow(permit: BatchPermit): void {
      allowed = permit;
    },
    forget(): void {
      allowed = null;
    },
    /** Whether a load of this company and month was allowed, by this app, user and selection. */
    allows(load: Omit<BatchPermit, "brns" | "until"> & { brn: string }): boolean {
      const permit = allowed;
      return (
        permit !== null &&
        permit.until >= Date.now() &&
        permit.appId === load.appId &&
        permit.userId === load.userId &&
        permit.selectedCompanyId === load.selectedCompanyId &&
        permit.period === load.period &&
        permit.brns.has(normaliseBrn(load.brn))
      );
    },
  };
}
