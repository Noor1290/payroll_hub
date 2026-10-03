import { NUMERIC_COLUMNS, type PayrollRow } from "@/config/payrollFields";
import type { Membership, RunStatus } from "@/lib/supabase/schemas";
import type { FileCompany } from "./parsePayroll";

/** BRNs are compared ignoring case and surrounding whitespace. */
const normaliseBrn = (brn: string) => brn.trim().toUpperCase();

export type CompanyMatch =
  | { kind: "matched"; membership: Membership }
  | { kind: "no-brn" }
  | { kind: "unknown"; brn: string };

/**
 * Finds the company a file belongs to by BRN, among the companies the user can see.
 * The dashboard never creates companies: no match is an error for the user to resolve.
 */
export function matchCompanyByBrn(
  memberships: readonly Membership[],
  brn: string | null | undefined,
): CompanyMatch {
  if (!brn?.trim()) return { kind: "no-brn" };
  const wanted = normaliseBrn(brn);
  const membership = memberships.find(
    (m) => m.company.brn && normaliseBrn(m.company.brn) === wanted,
  );
  return membership ? { kind: "matched", membership } : { kind: "unknown", brn: brn.trim() };
}

/** Company details that differ between the file and the database. Shown as warnings; never written. */
export function companyDifferences(file: FileCompany, stored: Membership["company"]): string[] {
  const differences: string[] = [];
  const check = (label: string, inFile: string | null, inDb: string | null) => {
    if (inFile !== null && inFile !== (inDb ?? "").trim()) {
      differences.push(`${label}: the file says "${inFile}", the database has "${inDb ?? ""}".`);
    }
  };
  check("Name", file.name, stored.name);
  check("Address", file.address, stored.address);
  check("VAT", file.vat, stored.vat);
  return differences;
}

/** What the database already knows about an employee. */
export interface ExistingEmployee {
  national_id: string;
  surname: string;
  other_names: string | null;
  employment_type: string | null;
  deleted_at: string | null;
}

export interface EmployeeDiff {
  new: number;
  changed: number;
  unchanged: number;
  /** Soft-deleted employees this import will bring back (whether or not their details changed). */
  restored: number;
}

/** How this file's employees compare with the ones already stored for the company. */
export function diffEmployees(
  rows: readonly PayrollRow[],
  existing: readonly ExistingEmployee[],
): EmployeeDiff {
  const byId = new Map(existing.map((employee) => [employee.national_id, employee]));
  const diff: EmployeeDiff = { new: 0, changed: 0, unchanged: 0, restored: 0 };

  for (const row of rows) {
    const stored = byId.get(row.national_id);
    if (!stored) diff.new += 1;
    else if (stored.deleted_at !== null) diff.restored += 1;
    else if (
      stored.surname !== row.surname ||
      (stored.other_names ?? null) !== row.other_names ||
      (stored.employment_type ?? null) !== row.employment_type
    ) {
      diff.changed += 1;
    } else diff.unchanged += 1;
  }
  return diff;
}

/** The run already stored for this company and period, if any (including soft-deleted ones). */
export interface ExistingRun {
  id: string;
  status: RunStatus;
  deleted_at: string | null;
}

export type RunConflict =
  | { kind: "none" }
  /** A live draft: can be replaced after confirmation. */
  | { kind: "replace-draft" }
  /** A live approved run: must be set back to draft first. */
  | { kind: "blocked-approved" }
  /** A soft-deleted run: will be revived and overwritten after confirmation. */
  | { kind: "revive-deleted" };

export function runConflict(existing: ExistingRun | null): RunConflict {
  if (!existing) return { kind: "none" };
  if (existing.deleted_at !== null) return { kind: "revive-deleted" };
  return existing.status === "approved" ? { kind: "blocked-approved" } : { kind: "replace-draft" };
}

/** A row as the import function expects it: snake_case columns, exactly the file's values. */
export function toRpcRow(row: PayrollRow): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    national_id: row.national_id,
    surname: row.surname,
    other_names: row.other_names,
    employment_type: row.employment_type,
    age_60_plus: row.age_60_plus,
    extra: row.extra,
  };
  for (const column of NUMERIC_COLUMNS) payload[column] = row[column];
  return payload;
}
