import { z } from "zod";
import { demoDeleteCompany, demoFetchDeletePreview } from "@/lib/demo/demoData";
import { queryClient } from "@/lib/queryClient";
import { preferenceStorage } from "@/lib/storage";
import { supabase } from "@/lib/supabase/client";
import {
  classifyDataError,
  isMissingTable,
  NotConfiguredError,
  type DataFailure,
} from "@/lib/supabase/errors";
import type { Viewer } from "@/lib/supabase/queries";
import type { Membership } from "@/lib/supabase/schemas";
import { isUnlocked, lock } from "@/lib/unlock";
import { COMPANY_STORAGE_KEY } from "./company-context";

/** What deleting a company would remove, shown before the user confirms. Counts and periods only. */
export interface DeletePreview {
  /** Including soft-deleted ones: they are deleted too. */
  employees: number;
  runs: number;
  entries: number;
  /** Members other than the person deleting, who lose access. */
  otherMembers: number;
  /** Custom company details and links, removed with the company. Zero if those tables don't exist yet. */
  details: number;
  links: number;
  /**
   * Statutory rates versions, payslip templates and their published versions (migrations 0009
   * and 0010), removed with the company. Zero if those tables don't exist yet.
   */
  rates: number;
  templates: number;
  templateVersions: number;
  /** How many of the runs are approved, soft-deleted ones included. They are deleted like the rest. */
  approvedRuns: number;
}

const count = z.number().int().nonnegative();

/** What delete_company (migration 0007) returns: how much was removed. No company data. */
const deleteResultSchema = z.object({
  company_id: z.uuid(),
  entries: count,
  runs: count,
  employees: count,
  members: count,
});
export type DeleteResult = z.infer<typeof deleteResultSchema>;

/** The typed confirmation must be the company's name exactly (case included); only outer spaces are ignored. */
export function nameMatches(typed: string, name: string): boolean {
  return typed.trim() !== "" && typed.trim() === name.trim();
}

/** Thrown when a delete is attempted while the password gate is locked. */
export class LockedError extends Error {
  constructor() {
    super("The password gate is locked.");
    this.name = "LockedError";
  }
}

/** Thrown when the typed name is not the company's name. */
export class NameMismatchError extends Error {
  constructor() {
    super("The typed name does not match.");
    this.name = "NameMismatchError";
  }
}

/** Counts what a deletion would remove, soft-deleted rows included, and how many runs are approved. */
export async function fetchDeletePreview(
  viewer: Viewer,
  companyId: string,
): Promise<DeletePreview> {
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchDeletePreview(companyId);
  if (!supabase) throw new NotConfiguredError();
  const db = supabase;
  const head = { count: "exact", head: true } as const;

  const [
    employees,
    runs,
    entries,
    members,
    approved,
    details,
    links,
    rates,
    templates,
    templateVersions,
  ] = await Promise.all([
    db.from("employees").select("id", head).eq("company_id", companyId),
    db.from("payroll_runs").select("id", head).eq("company_id", companyId),
    db
      .from("payroll_entries")
      .select("id, payroll_runs!inner(company_id)", head)
      .eq("payroll_runs.company_id", companyId),
    db.from("company_members").select("user_id", head).eq("company_id", companyId),
    db.from("payroll_runs").select("id", head).eq("company_id", companyId).eq("status", "approved"),
    db.from("company_details").select("id", head).eq("company_id", companyId),
    db.from("company_links").select("id", head).eq("company_id", companyId),
    db.from("statutory_rates").select("id", head).eq("company_id", companyId),
    db.from("payslip_templates").select("id", head).eq("company_id", companyId),
    db.from("payslip_template_versions").select("id", head).eq("company_id", companyId),
  ]);
  for (const result of [employees, runs, entries, members, approved]) {
    if (result.error) throw result.error;
  }
  // These tables come from later migrations (0005, 0006, 0009, 0010). Until they are run
  // there is nothing in them to delete, and deleting a company must keep working.
  const optional = (result: typeof details) => {
    if (result.error) {
      if (isMissingTable(result.error)) return 0;
      throw result.error;
    }
    return count.parse(result.count);
  };

  return {
    employees: count.parse(employees.count),
    runs: count.parse(runs.count),
    entries: count.parse(entries.count),
    otherMembers: Math.max(0, count.parse(members.count) - 1),
    details: optional(details),
    links: optional(links),
    rates: optional(rates),
    templates: optional(templates),
    templateVersions: optional(templateVersions),
    approvedRuns: count.parse(approved.count),
  };
}

/**
 * Permanently deletes a company through the database function `delete_company`
 * (migration 0007). Refuses, without contacting the database, unless the password gate is
 * open and the typed name is the company's name. The database checks the name and the
 * caller's role again. Approved runs do not protect a company: they are deleted with it.
 */
export async function deleteCompany(
  viewer: Viewer,
  company: Pick<Membership["company"], "id" | "name">,
  typedName: string,
): Promise<DeleteResult> {
  if (!nameMatches(typedName, company.name)) throw new NameMismatchError();
  if (!isUnlocked()) throw new LockedError();

  if (import.meta.env.DEV && viewer.isDemo) return demoDeleteCompany(company.id, typedName);
  if (!supabase) throw new NotConfiguredError();

  const { data, error } = await supabase.rpc("delete_company", {
    p_company_id: company.id,
    p_confirm_name: typedName.trim(),
  });
  if (error) throw error;
  return deleteResultSchema.parse(data);
}

/**
 * Drops everything the dashboard still holds about a company that no longer exists: its
 * cached rows and counts, anything behind the password gate (which is locked again), the
 * remembered selection, and its place in the company list.
 */
export function forgetCompany(companyId: string): void {
  // Locking wipes the gated rows and any failed transfer that came from a saved run.
  lock("cleared");
  queryClient.removeQueries({ predicate: (query) => query.queryKey.includes(companyId) });
  queryClient.setQueriesData<Membership[]>({ queryKey: ["memberships"] }, (list) =>
    list?.filter((membership) => membership.company.id !== companyId),
  );
  if (preferenceStorage.getItem(COMPANY_STORAGE_KEY) === companyId) {
    preferenceStorage.removeItem(COMPANY_STORAGE_KEY);
  }
}

export interface DeleteCompanyFailure extends DataFailure {
  /** True when the typed name is what needs correcting. */
  nameField?: boolean;
}

/** The file that holds the current delete_company. Run on its own, it also installs the function. */
const MIGRATION = "0007_delete_company_any_runs.sql";

const failure = (
  title: string,
  message: string,
  more: Partial<DeleteCompanyFailure> = {},
): DeleteCompanyFailure => ({ kind: "unknown", title, message, retryable: false, ...more });

/** Explains why a company could not be deleted. In every case nothing was deleted. */
export function classifyDeleteCompanyError(error: unknown): DeleteCompanyFailure {
  if (error instanceof LockedError) {
    return failure(
      "Confirm your password first",
      "Deleting a company needs the password gate to be open, and it has locked again. Nothing was deleted.",
    );
  }
  if (error instanceof NameMismatchError) {
    return failure(
      "That isn't the company's name",
      "Type the name exactly as shown, including capitals. Nothing was deleted.",
      { nameField: true },
    );
  }

  const { code, message } = (typeof error === "object" && error !== null ? error : {}) as {
    code?: unknown;
    message?: unknown;
  };
  const text = typeof message === "string" ? message : "";

  // PGRST202: the Data API cannot find the function (42883 is Postgres's own "no such function").
  if (code === "PGRST202" || code === "42883") {
    return failure(
      "Deleting companies isn't set up in the database yet",
      `The owner needs to run supabase/migrations/${MIGRATION} once in the Supabase SQL editor. Nothing was deleted.`,
    );
  }
  // Only the function from migration 0004 says this: the database has not had 0007 yet.
  if (text.includes("PH_HAS_APPROVED_RUNS")) {
    return failure(
      "The database needs an update",
      `It still refuses companies with approved runs. The owner needs to run supabase/migrations/${MIGRATION} once in the Supabase SQL editor. Nothing was deleted.`,
    );
  }
  if (text.includes("PH_NAME_MISMATCH")) {
    return failure(
      "That isn't the company's name",
      "The database compared the name you typed with the company's and they differ. Reload the page in case it was renamed. Nothing was deleted.",
      { nameField: true },
    );
  }
  if (text.includes("PH_NOT_ADMIN") || text.includes("PH_NOT_SIGNED_IN")) {
    return failure(
      "You're not allowed to delete this company",
      "Only an admin of this company can delete it, and it may already have been deleted by someone else. Nothing was deleted.",
    );
  }

  const general = classifyDataError(error);
  return { ...general, message: `${general.message} Nothing was deleted.` };
}
