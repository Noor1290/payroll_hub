import { z } from "zod";
import {
  demoFetchMonthHistory,
  demoFetchMonthList,
  demoFetchMonthRevision,
  demoFetchMonths,
  demoSaveKeyChange,
  demoSaveMonth,
} from "@/lib/demo/demoPayrollMonths";
import { supabase } from "./client";
import { NotConfiguredError } from "./errors";
import type { Viewer } from "./queries";

/**
 * The payroll app's months (migration 0014_payroll_months.sql): one row per company per month
 * in payroll_months, holding every employee and the values typed for them, and a record of
 * every save in payroll_month_history. National IDs and salaries: ADMIN-ONLY in the database,
 * and read by the dashboard only while the password gate is open (payrollMonthData.ts).
 *
 * The employees are the payroll app's own JSON, stored and returned exactly as sent. Nothing
 * here looks inside them. Writes go only through the database functions.
 */

/** The file the owner runs to set this up; named in messages when it has not been run. */
export const PAYROLL_MONTHS_MIGRATION = "0014_payroll_months.sql";

/** How many revisions one history answer lists, newest first. All are recorded. */
const HISTORY_PAGE = 200;

const periodSchema = z.string().regex(/^\d{4}-\d{2}-01$/);
const employeesSchema = z.array(z.record(z.string(), z.unknown()));

const monthInfoSchema = z.object({
  period: periodSchema,
  revision: z.number().int().min(1),
  shared_revision: z.number().int().min(1),
  company_revision: z.number().int().min(1),
  employee_count: z.number().int().min(0),
  value_keys: z.array(z.string()),
  updated_by: z.uuid().nullable(),
  updated_at: z.string(),
});
/** What is known about a month without its employees: enough to list it, and its column keys. */
export type MonthInfo = z.infer<typeof monthInfoSchema>;

const monthSchema = monthInfoSchema.omit({ value_keys: true }).extend({
  employees: employeesSchema,
});
export type StoredMonth = z.infer<typeof monthSchema>;

const monthRevisionSchema = z.object({
  revision: z.number().int().min(1),
  shared_revision: z.number().int().min(1),
  company_revision: z.number().int().min(1),
  employee_count: z.number().int().min(0),
  kept: z.boolean(),
  saved_by: z.uuid().nullable(),
  saved_at: z.string(),
});
export type MonthRevision = z.infer<typeof monthRevisionSchema>;

const savedMonthSchema = z.object({
  company_id: z.uuid(),
  period: periodSchema,
  revision: z.number().int().min(1),
  shared_revision: z.number().int().min(1),
  company_revision: z.number().int().min(1),
  employee_count: z.number().int().min(0),
  updated_at: z.string(),
});
export type SavedMonth = z.infer<typeof savedMonthSchema>;

const savedKeyChangeSchema = z.object({
  /** The setup function's own answer: save_payroll_shared_setup's or save_payroll_company_setup's. */
  setup: z.object({
    revision: z.number().int().min(1),
    shared_setup_id: z.uuid(),
    company_id: z.uuid().optional(),
    companies: z
      .array(z.object({ company_id: z.uuid(), revision: z.number().int().min(1) }))
      .optional(),
  }),
  months: z.array(
    z.object({ company_id: z.uuid(), period: periodSchema, revision: z.number().int().min(1) }),
  ),
});
export type SavedKeyChange = z.infer<typeof savedKeyChangeSchema>;

export interface MonthInput {
  /** The first day of the month, "YYYY-MM-01". */
  period: string;
  employees: Record<string, unknown>[];
  /** The revision the caller last saw; 0 for a month that does not exist yet. */
  expectedRevision: number;
  /** The column setup revisions the month is saved with. */
  sharedRevision: number;
  companyRevision: number;
  /** Keep what is there now in the month's history before replacing it. */
  keepPrevious: boolean;
}

export interface KeyMove {
  oldKey: string;
  newKey: string;
  /** null = every company attached to the shared setup; otherwise that company. */
  companyId: string | null;
}

export interface KeyChangeInput {
  moves: KeyMove[];
  shared: {
    setupId: string;
    name: string;
    body: Record<string, unknown>;
    expectedRevision: number;
    companies: { companyId: string; body: Record<string, unknown>; expectedRevision: number }[];
  } | null;
  company: { companyId: string; body: Record<string, unknown>; expectedRevision: number } | null;
}

const INFO_COLUMNS =
  "period, revision, shared_revision, company_revision, employee_count, value_keys, updated_by, updated_at";
const MONTH_COLUMNS =
  "period, revision, shared_revision, company_revision, employee_count, employees, updated_by, updated_at";

function client() {
  if (!supabase) throw new NotConfiguredError();
  return supabase;
}

// ---------- reading ----------

/** Every saved month of a company, oldest first, without the employees. Admins only (RLS). */
export async function fetchMonthList(viewer: Viewer, companyId: string): Promise<MonthInfo[]> {
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchMonthList(companyId);
  const { data, error } = await client()
    .from("payroll_months")
    .select(INFO_COLUMNS)
    .eq("company_id", companyId)
    .order("period", { ascending: true })
    .range(0, 1199);
  if (error) throw error;
  return z.array(monthInfoSchema).parse(data);
}

/** These months of a company, with their employees; months that do not exist are left out. */
export async function fetchMonths(
  viewer: Viewer,
  companyId: string,
  periods: string[],
): Promise<StoredMonth[]> {
  if (periods.length === 0) return [];
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchMonths(companyId, periods);
  const { data, error } = await client()
    .from("payroll_months")
    .select(MONTH_COLUMNS)
    .eq("company_id", companyId)
    .in("period", periods)
    .order("period", { ascending: true });
  if (error) throw error;
  return z.array(monthSchema).parse(data);
}

/** The record of a month's saves, newest first, and whether each one's content was kept. */
export async function fetchMonthHistory(
  viewer: Viewer,
  companyId: string,
  period: string,
): Promise<MonthRevision[]> {
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchMonthHistory(companyId, period);
  const { data, error } = await client()
    .from("payroll_month_history")
    .select(
      "revision, shared_revision, company_revision, employee_count, saved_by, saved_at, kept:content_kept",
    )
    .eq("company_id", companyId)
    .eq("period", period)
    .order("revision", { ascending: false })
    .range(0, HISTORY_PAGE - 1);
  if (error) throw error;
  return z.array(monthRevisionSchema).parse(data);
}

const keptRevisionSchema = monthRevisionSchema.omit({ kept: true }).extend({
  employees: employeesSchema.nullable(),
});
const currentContentSchema = z.object({
  revision: z.number().int().min(1),
  employees: employeesSchema,
});

/** One revision of a month as it was saved, with its employees. */
export type KeptMonthRevision = Omit<MonthRevision, "kept"> & {
  employees: Record<string, unknown>[];
};

/**
 * One revision of a month with its employees, for the payroll app's history preview and
 * restore. The content comes from its history record when it was kept there, or from the month
 * itself when it is the revision in use now. Null when the revision does not exist or only its
 * record was kept (see migration 0014). Reads only.
 */
export async function fetchMonthRevision(
  viewer: Viewer,
  companyId: string,
  period: string,
  revision: number,
): Promise<KeptMonthRevision | null> {
  if (import.meta.env.DEV && viewer.isDemo) {
    return demoFetchMonthRevision(companyId, period, revision);
  }
  const { data, error } = await client()
    .from("payroll_month_history")
    .select(
      "revision, shared_revision, company_revision, employee_count, employees, saved_by, saved_at",
    )
    .eq("company_id", companyId)
    .eq("period", period)
    .eq("revision", revision)
    .maybeSingle();
  if (error) throw error;
  if (data === null) return null;
  const record = keptRevisionSchema.parse(data);
  if (record.employees !== null) return { ...record, employees: record.employees };

  const now = await client()
    .from("payroll_months")
    .select("revision, employees")
    .eq("company_id", companyId)
    .eq("period", period)
    .maybeSingle();
  if (now.error) throw now.error;
  if (now.data === null) return null;
  const month = currentContentSchema.parse(now.data);
  return month.revision === revision ? { ...record, employees: month.employees } : null;
}

// ---------- saving ----------

/**
 * Saves one month through `save_payroll_month`. The database decides who may (an admin of
 * the company) and refuses an old revision (PH_STALE), never overwriting.
 */
export async function saveMonth(
  viewer: Viewer,
  companyId: string,
  input: MonthInput,
): Promise<SavedMonth> {
  if (import.meta.env.DEV && viewer.isDemo) return demoSaveMonth(companyId, input);
  const { data, error } = await client().rpc("save_payroll_month", {
    p_company_id: companyId,
    p_period: input.period,
    p_employees: input.employees,
    p_expected_revision: input.expectedRevision,
    p_shared_revision: input.sharedRevision,
    p_company_revision: input.companyRevision,
    p_keep_previous: input.keepPrevious,
  });
  if (error) throw error;
  return savedMonthSchema.parse(data);
}

/**
 * A change of key through `save_payroll_key_change`: the setup that carries the new key and
 * every month the key reaches, in one transaction.
 */
export async function saveKeyChange(
  viewer: Viewer,
  input: KeyChangeInput,
): Promise<SavedKeyChange> {
  if (import.meta.env.DEV && viewer.isDemo) return demoSaveKeyChange(input);
  const { data, error } = await client().rpc("save_payroll_key_change", {
    p_moves: input.moves.map((move) => ({
      old_key: move.oldKey,
      new_key: move.newKey,
      company_id: move.companyId,
    })),
    p_shared: input.shared && {
      setup_id: input.shared.setupId,
      name: input.shared.name,
      body: input.shared.body,
      expected_revision: input.shared.expectedRevision,
      companies: input.shared.companies.map((company) => ({
        company_id: company.companyId,
        body: company.body,
        expected_revision: company.expectedRevision,
      })),
    },
    p_company: input.company && {
      company_id: input.company.companyId,
      body: input.company.body,
      expected_revision: input.company.expectedRevision,
    },
  });
  if (error) throw error;
  return savedKeyChangeSchema.parse(data);
}
