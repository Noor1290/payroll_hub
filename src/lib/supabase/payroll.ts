import { z } from "zod";
import {
  isEmploymentDate,
  NUMERIC_COLUMNS,
  type NumericColumn,
  type PayrollRow,
} from "@/config/payrollFields";
import { toRpcRow, type ExistingEmployee, type ExistingRun } from "@/features/import/importPlan";
import {
  demoFetchImportContext,
  demoFetchRunEntries,
  demoFetchRuns,
  demoImportRun,
  demoSetEmployeeDate,
  demoSetRunStatus,
  demoSoftDeleteRun,
} from "@/lib/demo/demoData";
import { supabase } from "./client";
import { classifyDataError, isMissingColumn, NotConfiguredError, type DataFailure } from "./errors";
import { fetchAllRows } from "./paginate";
import type { Viewer } from "./queries";
import {
  existingEmployeeSchema,
  existingRunSchema,
  importResultSchema,
  moneySchema,
  runSummaryRowSchema,
  toRunSummary,
  type ImportResult,
  type RunStatus,
  type RunSummary,
} from "./schemas";

function client() {
  if (!supabase) throw new NotConfiguredError();
  return supabase;
}

/** Every live run of a company, newest period first. */
export async function fetchRuns(viewer: Viewer, companyId: string): Promise<RunSummary[]> {
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchRuns(companyId);

  const rows = await fetchAllRows(async (from, to) => {
    const { data, error } = await client()
      .from("payroll_runs")
      .select("id, period, status, created_by, created_at, payroll_entries(count)")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .order("period", { ascending: false })
      .range(from, to);
    if (error) throw error;
    return z.array(runSummaryRowSchema).parse(data);
  });
  return rows.map(toRunSummary);
}

const entryRowSchema = z.object({
  id: z.uuid(),
  age_60_plus: z.boolean(),
  extra: z.record(z.string(), z.unknown()),
  employees: z.object({
    id: z.uuid(),
    national_id: z.string(),
    surname: z.string(),
    other_names: z.string().nullable(),
    employment_type: z.string().nullable(),
    // Absent when the database has not had migration 0008.
    date_of_employment: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
  }),
  ...(Object.fromEntries(NUMERIC_COLUMNS.map((column) => [column, moneySchema])) as Record<
    NumericColumn,
    typeof moneySchema
  >),
});

const entrySelect = (withDate: boolean) =>
  `id, age_60_plus, extra, ${NUMERIC_COLUMNS.join(", ")}, employees(id, national_id, surname, other_names, employment_type${withDate ? ", date_of_employment" : ""})`;

/** Set once a read shows the database has no employees.date_of_employment (migration 0008). */
let dateColumnMissing = false;

/** For tests: forget what was learnt about the database. */
export function resetSchemaKnowledge(): void {
  dateColumnMissing = false;
}

/**
 * Every entry of a run with its employee, flattened into grid rows.
 * Works against a database without migration 0008: the rows then carry no date of employment
 * (`date_of_employment` is undefined, not null), and everything else is unchanged.
 */
export async function fetchRunEntries(viewer: Viewer, runId: string): Promise<PayrollRow[]> {
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchRunEntries(runId);

  const read = (withDate: boolean) =>
    fetchAllRows(async (from, to) => {
      const { data, error } = await client()
        .from("payroll_entries")
        .select(entrySelect(withDate))
        .eq("run_id", runId)
        .order("id")
        .range(from, to);
      if (error) throw error;
      return z.array(entryRowSchema).parse(data);
    });

  let rows: Awaited<ReturnType<typeof read>>;
  if (dateColumnMissing) {
    rows = await read(false);
  } else {
    try {
      rows = await read(true);
    } catch (error) {
      if (!isMissingColumn(error)) throw error;
      dateColumnMissing = true;
      rows = await read(false);
    }
  }
  return rows.map(({ employees, ...entry }) => {
    const { id: employee_id, date_of_employment, ...employee } = employees;
    return {
      ...entry,
      ...employee,
      employee_id,
      ...(date_of_employment === undefined ? {} : { date_of_employment }),
    };
  });
}

/**
 * Sets or clears an employee's date of employment. Admins only: the database refuses anyone
 * else by changing no row, which is reported as "not allowed".
 */
export async function setEmployeeDate(
  viewer: Viewer,
  employeeId: string,
  value: string | null,
): Promise<void> {
  if (value !== null && !isEmploymentDate(value)) {
    throw Object.assign(new Error("PH_INVALID_INPUT: not a date"), { code: "22023" });
  }
  if (import.meta.env.DEV && viewer.isDemo) return demoSetEmployeeDate(employeeId, value);

  const { data, error } = await client()
    .from("employees")
    .update({ date_of_employment: value })
    .eq("id", employeeId)
    .select("id");
  if (error) throw error;
  if (!data || data.length === 0) {
    throw Object.assign(new Error("No employee was updated."), { code: "42501" });
  }
}

/** Explains a failed change to a date of employment. In every case nothing was changed. */
export function classifyEmployeeDateError(error: unknown): DataFailure {
  const { code } = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown };
  if (isMissingColumn(error)) {
    return failure(
      "Dates of employment aren't set up in the database yet",
      "The owner needs to run supabase/migrations/0008_employee_date_of_employment.sql once in the Supabase SQL editor. Nothing was changed.",
    );
  }
  if (code === "22023" || code === "23514" || code === "22008" || code === "22007") {
    return failure(
      "That isn't a date the database accepts",
      "Use a real date between 1900 and 2100. Nothing was changed.",
    );
  }
  if (code === "42501") {
    return failure(
      "Only admins can change this",
      "Your account isn't an admin of this company, or the employee no longer exists. Nothing was changed.",
    );
  }
  const general = classifyDataError(error);
  return { ...general, message: `${general.message} Nothing was changed.` };
}

export interface ImportContext {
  /** All of the company's employees, including soft-deleted ones (an import restores those). */
  employees: ExistingEmployee[];
  /** The run already stored for the period, including a soft-deleted one. */
  run: ExistingRun | null;
}

/** What the database already holds, so the preview can say what an import would change. */
export async function fetchImportContext(
  viewer: Viewer,
  companyId: string,
  period: string,
): Promise<ImportContext> {
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchImportContext(companyId, period);

  const db = client();
  const [employees, run] = await Promise.all([
    fetchAllRows(async (from, to) => {
      const { data, error } = await db
        .from("employees")
        .select("national_id, surname, other_names, employment_type, deleted_at")
        .eq("company_id", companyId)
        .order("id")
        .range(from, to);
      if (error) throw error;
      return z.array(existingEmployeeSchema).parse(data);
    }),
    db
      .from("payroll_runs")
      .select("id, status, deleted_at")
      .eq("company_id", companyId)
      .eq("period", period)
      .maybeSingle(),
  ]);
  if (run.error) throw run.error;

  return { employees, run: existingRunSchema.nullable().parse(run.data) };
}

export interface ImportRequest {
  companyId: string;
  period: string;
  rows: readonly PayrollRow[];
  /** Must be true to overwrite an existing (or revive a soft-deleted) run. */
  replace: boolean;
}

/**
 * Saves an import through the atomic database function (migration 0002).
 * It either fully succeeds or changes nothing, so there is never anything to clean up.
 */
export async function importPayrollRun(
  viewer: Viewer,
  { companyId, period, rows, replace }: ImportRequest,
): Promise<ImportResult> {
  if (import.meta.env.DEV && viewer.isDemo) return demoImportRun(companyId, period, rows, replace);

  const { data, error } = await client().rpc("import_payroll_run", {
    p_company_id: companyId,
    p_period: period,
    p_rows: rows.map(toRpcRow),
    p_replace: replace,
  });
  if (error) throw error;
  return importResultSchema.parse(data);
}

/**
 * RLS filters rows a user may not change instead of raising an error, so an update that
 * touches nothing means "not allowed" (or the run is gone).
 */
async function updateRun(runId: string, patch: Record<string, unknown>): Promise<void> {
  const { data, error } = await client()
    .from("payroll_runs")
    .update(patch)
    .eq("id", runId)
    .select("id");
  if (error) throw error;
  if (!data || data.length === 0) {
    throw Object.assign(new Error("No run was updated."), { code: "42501" });
  }
}

export async function setRunStatus(
  viewer: Viewer,
  runId: string,
  status: RunStatus,
): Promise<void> {
  if (import.meta.env.DEV && viewer.isDemo) return demoSetRunStatus(runId, status);
  await updateRun(runId, { status });
}

/** Soft delete: the run disappears from the dashboard but stays in the database. */
export async function softDeleteRun(viewer: Viewer, runId: string): Promise<void> {
  if (import.meta.env.DEV && viewer.isDemo) return demoSoftDeleteRun(runId);
  await updateRun(runId, { deleted_at: new Date().toISOString() });
}

const failure = (title: string, message: string, retryable = false): DataFailure => ({
  kind: "unknown",
  title,
  message,
  retryable,
});

/**
 * Explains a failed import. Because the save is atomic, every one of these means
 * "nothing was saved": the database is exactly as it was before.
 */
export function classifyImportError(error: unknown): DataFailure {
  const { code, message } = (typeof error === "object" && error !== null ? error : {}) as {
    code?: unknown;
    message?: unknown;
  };
  const text = typeof message === "string" ? message : "";

  // PGRST202: the Data API cannot find the function (42883 is Postgres's own "no such function").
  if (code === "PGRST202" || code === "42883") {
    return failure(
      "The import function isn't installed in the database",
      "The owner needs to run supabase/migrations/0002_import_payroll_run.sql once in the Supabase SQL editor. Nothing was saved.",
    );
  }
  if (text.includes("PH_NOT_ADMIN")) {
    return failure(
      "Only admins can import",
      "Your account isn't an admin of this company, so the database refused the import. Nothing was saved.",
    );
  }
  if (text.includes("PH_RUN_APPROVED")) {
    return failure(
      "This period's run is approved",
      "An approved run can't be replaced. Set it back to draft in the Data explorer first. Nothing was saved.",
    );
  }
  if (text.includes("PH_RUN_EXISTS") || code === "23505") {
    return failure(
      "A run for this period already exists",
      "Someone may have created it while you were previewing. Check again to see it, then choose Replace if that is what you want. Nothing was saved.",
    );
  }
  if (text.includes("PH_INVALID_INPUT")) {
    return failure(
      "The database rejected the data",
      `${text.replace(/^.*PH_INVALID_INPUT:\s*/, "").replace(/^\w/, (c) => c.toUpperCase())}. Nothing was saved.`,
    );
  }

  const general = classifyDataError(error);
  return { ...general, message: `${general.message} Nothing was saved.` };
}
