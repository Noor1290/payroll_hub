import type {
  KeptMonthRevision,
  KeyChangeInput,
  MonthInfo,
  MonthInput,
  MonthRevision,
  SavedKeyChange,
  SavedMonth,
  StoredMonth,
} from "@/lib/supabase/payrollMonths";
import { demoMemberships } from "./demoData";
import {
  demoAttachedCompanyIds,
  demoHasSetupRevision,
  demoSaveCompanySetup,
  demoSaveSharedSetup,
  demoSetupRevisions,
} from "./demoPayrollSetups";

/**
 * FAKE payroll months for dev-only demo mode and the dashboard's own tests. They follow the
 * rules of migration 0014_payroll_months.sql: admins only; a month needs its company to have
 * a column setup, and records setup revisions that exist; every save names the revision last
 * seen; every save is recorded, and the content is kept with a record when someone else saves
 * over it or the save asks for it; a change of key saves the setup and moves the values in
 * every month it reaches, or does nothing. Everything here is invented and lives in memory.
 * Only reachable behind `import.meta.env.DEV`.
 */

const DEMO_USER_ID = "00000000-0000-4000-8000-000000000001";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message: string, code: string) => Object.assign(new Error(message), { code });
const copy = <T>(value: T): T => structuredClone(value);

type Employees = Record<string, unknown>[];
interface Stored extends Omit<MonthInfo, "value_keys"> {
  company_id: string;
  shared_setup_id: string;
  employees: Employees;
}
interface Record_ extends Omit<MonthRevision, "kept"> {
  company_id: string;
  period: string;
  employees: Employees | null;
}

const months: Stored[] = [];
const history: Record_[] = [];

const isAdmin = (companyId: string) =>
  demoMemberships.find((m) => m.company.id === companyId)?.role === "admin";
const KEY = /^[A-Za-z_$][A-Za-z0-9_$]{0,99}$/;

const valuesOf = (employee: Record<string, unknown>) =>
  (employee.values ?? {}) as Record<string, unknown>;

function valueKeys(employees: Employees): string[] {
  return [...new Set(employees.flatMap((e) => Object.keys(valuesOf(e))))].sort();
}

function check(employees: unknown): number {
  if (!Array.isArray(employees))
    throw fail("PH_INVALID_INPUT: the employees must be a list", "22023");
  if (
    new TextEncoder().encode(JSON.stringify(employees)).length > 1_048_576 ||
    employees.length > 5000
  ) {
    throw fail("PH_TOO_LARGE", "54000");
  }
  const ids = new Set<string>();
  for (const e of employees as Record<string, unknown>[]) {
    const ok =
      e !== null &&
      typeof e === "object" &&
      typeof e.id === "string" &&
      e.id.length >= 1 &&
      e.id.length <= 100 &&
      e.values !== null &&
      typeof e.values === "object" &&
      !Array.isArray(e.values);
    if (!ok) throw fail("PH_INVALID_INPUT: an employee is missing its id or its values", "22023");
    ids.add(e.id as string);
  }
  if (ids.size !== employees.length)
    throw fail("PH_INVALID_INPUT: an employee id appears twice", "22023");
  return employees.length;
}

const sameDay = (a: string, b: string) => a.slice(0, 10) === b.slice(0, 10);

/** Keeps the content of the revision about to be replaced, when it would otherwise be lost. */
function keepPrevious(month: Stored, now: string, asked: boolean) {
  const record = history.find(
    (h) =>
      h.company_id === month.company_id &&
      h.period === month.period &&
      h.revision === month.revision,
  );
  if (!record || record.employees !== null) return;
  if (asked || month.updated_by !== DEMO_USER_ID || !sameDay(month.updated_at, now)) {
    record.employees = copy(month.employees);
  }
}

function recordSave(month: Stored) {
  history.push({
    company_id: month.company_id,
    period: month.period,
    revision: month.revision,
    shared_revision: month.shared_revision,
    company_revision: month.company_revision,
    employee_count: month.employee_count,
    employees: null,
    saved_by: DEMO_USER_ID,
    saved_at: month.updated_at,
  });
}

const info = (month: Stored): MonthInfo => ({
  period: month.period,
  revision: month.revision,
  shared_revision: month.shared_revision,
  company_revision: month.company_revision,
  employee_count: month.employee_count,
  value_keys: valueKeys(month.employees),
  updated_by: month.updated_by,
  updated_at: month.updated_at,
});

// ---------- reading ----------

export async function demoFetchMonthList(companyId: string): Promise<MonthInfo[]> {
  await pause(30);
  if (!isAdmin(companyId)) return [];
  return months
    .filter((m) => m.company_id === companyId)
    .sort((a, b) => a.period.localeCompare(b.period))
    .map(info);
}

export async function demoFetchMonths(
  companyId: string,
  periods: string[],
): Promise<StoredMonth[]> {
  await pause(30);
  if (!isAdmin(companyId)) return [];
  return months
    .filter((m) => m.company_id === companyId && periods.includes(m.period))
    .sort((a, b) => a.period.localeCompare(b.period))
    .map((m) => {
      const {
        period,
        revision,
        shared_revision,
        company_revision,
        employee_count,
        updated_by,
        updated_at,
      } = info(m);
      return {
        period,
        revision,
        shared_revision,
        company_revision,
        employee_count,
        updated_by,
        updated_at,
        employees: copy(m.employees),
      };
    });
}

export async function demoFetchMonthHistory(
  companyId: string,
  period: string,
): Promise<MonthRevision[]> {
  await pause(30);
  if (!isAdmin(companyId)) return [];
  return history
    .filter((h) => h.company_id === companyId && h.period === period)
    .sort((a, b) => b.revision - a.revision)
    .slice(0, 200)
    .map((h) => ({
      revision: h.revision,
      shared_revision: h.shared_revision,
      company_revision: h.company_revision,
      employee_count: h.employee_count,
      kept: h.employees !== null,
      saved_by: h.saved_by,
      saved_at: h.saved_at,
    }));
}

/** One revision with its employees: kept with its record, or the month's own when current. */
export async function demoFetchMonthRevision(
  companyId: string,
  period: string,
  revision: number,
): Promise<KeptMonthRevision | null> {
  await pause(30);
  if (!isAdmin(companyId)) return null;
  const record = history.find(
    (h) => h.company_id === companyId && h.period === period && h.revision === revision,
  );
  if (!record) return null;
  const month = months.find((m) => m.company_id === companyId && m.period === period);
  const employees =
    record.employees ?? (month && month.revision === revision ? month.employees : null);
  if (employees === null) return null;
  return {
    revision: record.revision,
    shared_revision: record.shared_revision,
    company_revision: record.company_revision,
    employee_count: record.employee_count,
    saved_by: record.saved_by,
    saved_at: record.saved_at,
    employees: copy(employees),
  };
}

/** The raw rows the Database page reads for a company, shaped as the API returns them. */
export function demoPayrollMonthRows(
  table: "payroll_months" | "payroll_month_history",
  companyId: string,
): Record<string, unknown>[] {
  if (!isAdmin(companyId)) return [];
  if (table === "payroll_months") {
    return months
      .filter((m) => m.company_id === companyId)
      .map((m) => ({
        ...copy(m),
        value_keys: valueKeys(m.employees),
        created_by: m.updated_by,
        created_at: m.updated_at,
      }));
  }
  return history
    .filter((h) => h.company_id === companyId)
    .map((h) => ({
      ...copy(h),
      shared_setup_id: months.find((m) => m.company_id === companyId && m.period === h.period)!
        .shared_setup_id,
      content_kept: h.employees !== null,
    }));
}

// ---------- saving ----------

export async function demoSaveMonth(companyId: string, input: MonthInput): Promise<SavedMonth> {
  await pause(80);
  if (!isAdmin(companyId)) throw fail("PH_NOT_ADMIN", "42501");
  if (
    !/^\d{4}-(0[1-9]|1[0-2])-01$/.test(input.period) ||
    input.period < "2000-01-01" ||
    input.period > "2100-12-01"
  ) {
    throw fail("PH_INVALID_INPUT: the month", "22023");
  }
  const count = check(input.employees);
  if (input.expectedRevision < 0) throw fail("PH_INVALID_INPUT: the last revision seen", "22023");
  const setup = demoSetupRevisions(companyId);
  if (!setup) throw fail("PH_NOT_FOUND: the company has no payroll column setup", "P0002");
  if (
    !demoHasSetupRevision({ kind: "shared", id: setup.sharedSetupId }, input.sharedRevision) ||
    !demoHasSetupRevision({ kind: "company", id: companyId }, input.companyRevision)
  ) {
    throw fail("PH_INVALID_INPUT: those column setup revisions are not this company's", "22023");
  }

  const now = new Date().toISOString();
  let month = months.find((m) => m.company_id === companyId && m.period === input.period);
  if (!month) {
    if (input.expectedRevision !== 0) throw fail("PH_NOT_FOUND", "P0002");
    month = {
      company_id: companyId,
      period: input.period,
      revision: 1,
      shared_setup_id: setup.sharedSetupId,
      shared_revision: input.sharedRevision,
      company_revision: input.companyRevision,
      employee_count: count,
      employees: copy(input.employees),
      updated_by: DEMO_USER_ID,
      updated_at: now,
    };
    months.push(month);
  } else {
    if (month.revision !== input.expectedRevision) throw fail("PH_STALE", "P0001");
    keepPrevious(month, now, input.keepPrevious);
    Object.assign(month, {
      revision: month.revision + 1,
      shared_setup_id: setup.sharedSetupId,
      shared_revision: input.sharedRevision,
      company_revision: input.companyRevision,
      employee_count: count,
      employees: copy(input.employees),
      updated_by: DEMO_USER_ID,
      updated_at: now,
    });
  }
  recordSave(month);
  return {
    company_id: companyId,
    period: month.period,
    revision: month.revision,
    shared_revision: month.shared_revision,
    company_revision: month.company_revision,
    employee_count: month.employee_count,
    updated_at: now,
  };
}

function renameKey(employees: Employees, oldKey: string, newKey: string): Employees {
  return employees.map((e) => {
    const values = valuesOf(e);
    if (!(oldKey in values)) return e;
    const { [oldKey]: value, ...rest } = values;
    return { ...e, values: { ...rest, [newKey]: value } };
  });
}

export async function demoSaveKeyChange(input: KeyChangeInput): Promise<SavedKeyChange> {
  await pause(80);
  if ((input.shared === null) === (input.company === null)) {
    throw fail("PH_INVALID_INPUT: give either the shared setup or the company setup", "22023");
  }
  if (input.moves.length < 1 || input.moves.length > 20)
    throw fail("PH_INVALID_INPUT: the keys to move", "22023");
  for (const move of input.moves) {
    if (!KEY.test(move.oldKey) || !KEY.test(move.newKey) || move.oldKey === move.newKey) {
      throw fail("PH_INVALID_INPUT: a key to move is missing or malformed", "22023");
    }
  }

  // Everything that can be refused is checked before anything changes: all or nothing.
  const setupId = input.shared
    ? input.shared.setupId
    : demoSetupRevisions(input.company!.companyId)?.sharedSetupId;
  if (!setupId) throw fail("PH_NOT_FOUND", "P0002");
  if (input.company && input.moves.some((m) => m.companyId !== input.company!.companyId)) {
    throw fail("PH_INVALID_INPUT: a company setup can only move keys in its own months", "22023");
  }
  const attached = demoAttachedCompanyIds(setupId);
  const plan = input.moves.map((move) => {
    const targets = move.companyId === null ? attached : [move.companyId];
    if (move.companyId !== null && !attached.includes(move.companyId))
      throw fail("PH_NOT_FOUND", "P0002");
    if (targets.some((id) => !isAdmin(id))) throw fail("PH_NOT_ADMIN", "42501");
    return { move, targets };
  });

  const saved = input.shared
    ? await demoSaveSharedSetup(input.shared)
    : await demoSaveCompanySetup(
        input.company!.companyId,
        input.company!.body,
        input.company!.expectedRevision,
      );

  const now = new Date().toISOString();
  const moved: SavedKeyChange["months"] = [];
  for (const { move, targets } of plan) {
    for (const companyId of targets) {
      const revisions = demoSetupRevisions(companyId)!;
      for (const month of months.filter(
        (m) => m.company_id === companyId && valueKeys(m.employees).includes(move.oldKey),
      )) {
        keepPrevious(month, now, false);
        const employees = renameKey(month.employees, move.oldKey, move.newKey);
        Object.assign(month, {
          revision: month.revision + 1,
          shared_setup_id: setupId,
          shared_revision: revisions.sharedRevision,
          company_revision: revisions.companyRevision,
          employees,
          employee_count: employees.length,
          updated_by: DEMO_USER_ID,
          updated_at: now,
        });
        recordSave(month);
        moved.push({ company_id: companyId, period: month.period, revision: month.revision });
      }
    }
  }
  return {
    setup: { ...saved, shared_setup_id: setupId } as SavedKeyChange["setup"],
    months: moved,
  };
}

// ---------- for tests and delete_company ----------

/** A month saved by another admin, whatever the demo user's role: for tests only. */
export function demoSeedMonth(
  companyId: string,
  period: string,
  employees: Employees,
  revision = 1,
) {
  const setup = demoSetupRevisions(companyId);
  const month: Stored = {
    company_id: companyId,
    period,
    revision,
    shared_setup_id: setup?.sharedSetupId ?? "30000000-0000-4000-8000-000000000000",
    shared_revision: setup?.sharedRevision || 1,
    company_revision: setup?.companyRevision || 1,
    employee_count: employees.length,
    employees: copy(employees),
    updated_by: "00000000-0000-4000-8000-0000000000ff",
    updated_at: new Date().toISOString(),
  };
  const index = months.findIndex((m) => m.company_id === companyId && m.period === period);
  if (index >= 0) months.splice(index, 1, month);
  else months.push(month);
  recordSave(month);
  history.at(-1)!.saved_by = month.updated_by;
}

/** What deleting a company would remove: for the delete preview. */
export function demoPayrollMonthCounts(companyId: string) {
  return {
    payrollMonths: months.filter((m) => m.company_id === companyId).length,
    payrollMonthRevisions: history.filter((h) => h.company_id === companyId).length,
  };
}

/** As delete_company (migration 0014): the company's months and their history go. */
export function demoForgetPayrollMonths(companyId?: string): void {
  for (const list of [months, history] as { company_id: string }[][]) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (companyId === undefined || list[i]!.company_id === companyId) list.splice(i, 1);
    }
  }
}
