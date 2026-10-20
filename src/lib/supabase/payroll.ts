import { z } from "zod";
import {
  isEmploymentDate,
  NUMERIC_COLUMNS,
  type NumericColumn,
  type PayrollRow,
} from "@/config/payrollFields";
import { decideEmploymentDate } from "@/features/import/employmentDateRule";
import { toRpcRow, type ExistingEmployee, type ExistingRun } from "@/features/import/importPlan";
import {
  demoFetchImportContext,
  demoFetchRunEntries,
  demoFetchRuns,
  demoImportRun,
  demoSetEmployeeDate,
  demoSetRunStatus,
  demoNewestRunMonth,
  demoStoreEmploymentDates,
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
/** Set once a read shows the database has no employees.date_of_employment_month (migration 0017). */
let sourceColumnsMissing = false;
const DATE_COLUMNS = "id, national_id, date_of_employment";
const SOURCE_COLUMNS = "date_of_employment_month, date_of_employment_typed";

/** For tests: forget what was learnt about the database. */
export function resetSchemaKnowledge(): void {
  dateColumnMissing = false;
  sourceColumnsMissing = false;
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
 * Sets or clears an employee's date of employment, typed in the Data explorer. Admins only: the
 * database refuses anyone else by changing no row, which is reported as "not allowed".
 *
 * A typed date is recorded as typed, against the company's newest saved month now (migration
 * 0017): the payroll app replaces it only with a date sent for a newer month. Against a database
 * without migration 0017 only the date is saved, as before.
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

  const save = async (change: Record<string, unknown>) => {
    const { data, error } = await client()
      .from("employees")
      .update(change)
      .eq("id", employeeId)
      .select("id");
    if (error) throw error;
    if (!data || data.length === 0) {
      throw Object.assign(new Error("No employee was updated."), { code: "42501" });
    }
  };
  if (sourceColumnsMissing) return save({ date_of_employment: value });

  // Cleared: nothing is recorded about where it came from either.
  let source: Record<string, unknown> = {
    date_of_employment_month: null,
    date_of_employment_typed: null,
  };
  if (value !== null) {
    const { data, error } = await client()
      .from("employees")
      .select("company_id")
      .eq("id", employeeId);
    if (error) throw error;
    const companyId = (data as { company_id: string }[] | null)?.[0]?.company_id;
    if (!companyId) throw Object.assign(new Error("No employee was updated."), { code: "42501" });
    source = {
      date_of_employment_month: await newestRunMonth(viewer, companyId),
      date_of_employment_typed: true,
    };
  }
  try {
    await save({ date_of_employment: value, ...source });
  } catch (error) {
    if (!isMissingColumn(error)) throw error;
    sourceColumnsMissing = true;
    await save({ date_of_employment: value });
  }
}

/** The company's newest saved month ("YYYY-MM-01"), or null when it has no run. */
export async function newestRunMonth(viewer: Viewer, companyId: string): Promise<string | null> {
  if (import.meta.env.DEV && viewer.isDemo) return demoNewestRunMonth(companyId);
  const { data, error } = await client()
    .from("payroll_runs")
    .select("period")
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .order("period", { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data as { period: string }[] | null)?.[0]?.period ?? null;
}

/** What storeEmploymentDates did. */
export interface EmploymentDatesStored {
  /** Dates stored, for employees who had none. */
  stored: number;
  /** Dates replaced: a different date from the same or an older month. */
  changed: number;
  /** Employees whose date was already the one sent, or was changed by someone else meanwhile. */
  kept: number;
  /** Dates kept because they came from a newer month (or were typed in the Data explorer since). */
  keptNewer: number;
}

/** Where the dates come from: the month sent, and the company's newest saved month before it. */
export interface EmploymentDatesSource {
  /** "YYYY-MM-01". */
  period: string;
  /** "YYYY-MM-01", or null when the company had no run before this import. */
  newestBefore: string | null;
}

/** National IDs per query, so the request stays short. */
const DATE_LOOKUP_CHUNK = 200;

type EmployeeDateRow = {
  id: string;
  national_id: string;
  date_of_employment: string | null;
  date_of_employment_month?: string | null;
  date_of_employment_typed?: boolean | null;
};

/**
 * After an import is saved: stores the file's dates of employment (`national ID -> "YYYY-MM-DD"`)
 * for this company's current employees (rehearsal fix F6), by the rule in employmentDateRule.ts:
 * an empty date is filled; a different one is replaced only when it came from the same or an
 * older month (a typed one, or one stored before migration 0017: only by a newer month). Every
 * update carries "only where the date, and where it came from, are still the ones just read", so
 * a change made in the meantime is kept, never overwritten unseen. Against a database without
 * migration 0017 an empty date is filled and a date already set is kept. Admins only, like
 * setEmployeeDate.
 */
export async function storeEmploymentDates(
  viewer: Viewer,
  companyId: string,
  dates: Readonly<Record<string, string>>,
  source: EmploymentDatesSource,
): Promise<EmploymentDatesStored> {
  const counts = { stored: 0, changed: 0, kept: 0, keptNewer: 0 };
  const ids = Object.keys(dates).filter((id) => isEmploymentDate(dates[id]));
  if (ids.length === 0) return counts;
  if (import.meta.env.DEV && viewer.isDemo)
    return demoStoreEmploymentDates(companyId, dates, source);

  const lookup = async (withSource: boolean) => {
    const found: EmployeeDateRow[] = [];
    for (let i = 0; i < ids.length; i += DATE_LOOKUP_CHUNK) {
      const { data, error } = await client()
        .from("employees")
        .select(withSource ? `${DATE_COLUMNS}, ${SOURCE_COLUMNS}` : DATE_COLUMNS)
        .eq("company_id", companyId)
        .is("deleted_at", null)
        .in("national_id", ids.slice(i, i + DATE_LOOKUP_CHUNK));
      if (error) throw error;
      found.push(...((data ?? []) as unknown as EmployeeDateRow[]));
    }
    return found;
  };
  let found: EmployeeDateRow[];
  if (sourceColumnsMissing) {
    found = await lookup(false);
  } else {
    try {
      found = await lookup(true);
    } catch (error) {
      if (!isMissingColumn(error)) throw error;
      sourceColumnsMissing = true;
      found = await lookup(false);
    }
  }
  const withSource = !sourceColumnsMissing;

  for (const employee of found) {
    // Only national IDs taken from `dates` were looked up.
    const date = dates[employee.national_id]!;
    const month = employee.date_of_employment_month ?? null;
    const typed = employee.date_of_employment_typed ?? null;
    // Without migration 0017 nothing says which month a date came from: one already set is kept.
    const decision = withSource
      ? decideEmploymentDate(
          { date: employee.date_of_employment, month, typed },
          date,
          source.period,
          source.newestBefore,
        )
      : employee.date_of_employment === null
        ? "store"
        : "same";
    if (decision === "same") {
      counts.kept++;
      continue;
    }
    if (decision === "keep-newer") {
      counts.keptNewer++;
      continue;
    }

    let update = client()
      .from("employees")
      .update(
        withSource
          ? {
              date_of_employment: date,
              date_of_employment_month: source.period,
              date_of_employment_typed: false,
            }
          : { date_of_employment: date },
      )
      .eq("id", employee.id);
    // Only where nothing changed since it was read.
    update =
      employee.date_of_employment === null
        ? update.is("date_of_employment", null)
        : update.eq("date_of_employment", employee.date_of_employment);
    if (withSource) {
      update =
        month === null
          ? update.is("date_of_employment_month", null)
          : update.eq("date_of_employment_month", month);
      update =
        typed === null
          ? update.is("date_of_employment_typed", null)
          : update.eq("date_of_employment_typed", typed);
    }
    const { data, error } = await update.select("id");
    if (error) throw error;
    if (!data || data.length === 0) counts.kept++;
    else if (decision === "store") counts.stored++;
    else if (decision === "replace") counts.changed++;
    // "same-newer": the same date, now known to come from a newer month.
    else counts.kept++;
  }
  return counts;
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
