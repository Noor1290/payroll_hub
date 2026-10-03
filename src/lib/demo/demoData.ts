import { NUMERIC_COLUMNS, type NumericColumn, type PayrollRow } from "@/config/payrollFields";
import type { ExistingEmployee, ExistingRun } from "@/features/import/importPlan";
import { sumMoney } from "@/lib/format";
import type {
  DbRow,
  DbTable,
  DbTableName,
  TableCounts,
  TablePage,
  TableQuery,
} from "@/lib/supabase/database";
import type { ImportResult, Membership, RunStatus, RunSummary } from "@/lib/supabase/schemas";

/**
 * FAKE in-memory database for dev-only demo mode. Every name, number and id here is invented.
 * It mimics the real rules closely enough to explore the UI (admin checks, replace, revive),
 * and resets on reload. Only reachable behind `import.meta.env.DEV`, so production builds drop it.
 */

const ABC = "10000000-0000-4000-8000-000000000001";
const XYZ = "10000000-0000-4000-8000-000000000002";
const EMPTY = "10000000-0000-4000-8000-000000000003";
const BIG = "10000000-0000-4000-8000-000000000004";
const DEMO_USER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "0b0b0b0b-0000-4000-8000-000000000002";

export const demoMemberships: Membership[] = [
  {
    role: "admin",
    company: { id: ABC, name: "ABC Co Ltd", address: "Mauritius", brn: "C1234567", vat: "12%" },
  },
  {
    role: "viewer",
    company: { id: XYZ, name: "XYZ Trading Ltd", address: "Mauritius", brn: "C7654321", vat: null },
  },
  {
    role: "admin",
    company: { id: EMPTY, name: "New Venture Ltd", address: null, brn: "C0000001", vat: null },
  },
  {
    // Big enough to need more than one 1,000-row page.
    role: "admin",
    company: { id: BIG, name: "Big Sample Ltd", address: "Mauritius", brn: "C0000002", vat: "15%" },
  },
];

interface DemoEmployee extends ExistingEmployee {
  id: string;
  companyId: string;
}
interface DemoRun {
  id: string;
  companyId: string;
  period: string;
  status: RunStatus;
  createdBy: string;
  createdAt: string;
  deletedAt: string | null;
}
interface DemoEntry {
  id: string;
  runId: string;
  employeeId: string;
  age_60_plus: boolean;
  extra: Record<string, unknown>;
  values: Record<NumericColumn, number>;
}

const employees: DemoEmployee[] = [];
const runs: DemoRun[] = [];
const entries: DemoEntry[] = [];

let nextId = 1;
const newId = (kind: number) =>
  `${kind}0000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;
const round2 = (value: number) => Math.round(value * 100) / 100;

function fakeValues(basic: number, increment: number): Record<NumericColumn, number> {
  const newBasic = basic + increment;
  const csg = round2(newBasic * 0.03);
  const deductions = round2(csg * 0.5 + 186.36);
  return {
    basic_salary: basic,
    govt_increment: increment,
    new_basic_salary: newBasic,
    allowances: 0,
    emoluments: newBasic,
    travelling: 0,
    gross_pay: newBasic,
    csg,
    nsf: 449.5,
    paye: 0,
    total_deductions: deductions,
    net_pay: round2(newBasic - deductions),
    levy: 270,
    prgf: round2(newBasic * 0.045),
    total_mra_contributions: round2(csg + 449.5 + 270 + newBasic * 0.07),
    edf: 390000,
    edf_monthly: 30000,
    total: 0,
  };
}

const SURNAMES = [
  "DOE",
  "SAMPLE",
  "EXAMPLE",
  "TESTER",
  "FICTIF",
  "NOUVEAU",
  "PLACEHOLDER",
  "MOCK",
  "DUMMY",
  "FAUX",
  "INVENTE",
  "SPECIMEN",
];
const FIRST_NAMES = ["JANE", "ALEX", "PRIYA", "SAM", "MARIE", "LEA", "RAVI", "NOAH"];

function seed(
  companyId: string,
  prefix: string,
  headcount: number,
  periods: [string, RunStatus, number, boolean][],
) {
  const staff: DemoEmployee[] = Array.from({ length: headcount }, (_, i) => ({
    id: newId(3),
    companyId,
    national_id: `${prefix}${String(i + 1).padStart(13, "0")}`,
    surname: SURNAMES[i % SURNAMES.length]!,
    other_names: FIRST_NAMES[i % FIRST_NAMES.length]!,
    employment_type: i % 5 === 3 ? "Part Time" : "Full Time",
    deleted_at: null,
  }));
  employees.push(...staff);

  for (const [period, status, count, mine] of periods) {
    const run: DemoRun = {
      id: newId(2),
      companyId,
      period,
      status,
      createdBy: mine ? DEMO_USER_ID : OTHER_USER_ID,
      createdAt: `${period.slice(0, 8)}28T10:15:00+04:00`,
      deletedAt: null,
    };
    runs.push(run);
    staff.slice(0, count).forEach((employee, i) => {
      entries.push({
        id: newId(4),
        runId: run.id,
        employeeId: employee.id,
        age_60_plus: i % 7 === 4,
        extra: {},
        values: fakeValues(14000 + ((i * 3700) % 31000), i % 6 === 4 ? 0 : 635),
      });
    });
  }
}

let seeded = false;
/**
 * Fills the store on first use. Done lazily, not at import time, so this module has no
 * side effects and production builds can drop it completely.
 */
function ensureSeeded() {
  if (seeded) return;
  seeded = true;
  seed(ABC, "X", 12, [
    ["2026-09-01", "draft", 12, true],
    ["2026-08-01", "approved", 12, true],
    ["2026-07-01", "approved", 11, false],
    ["2026-06-01", "approved", 11, true],
    ["2026-05-01", "approved", 10, false],
    ["2026-04-01", "approved", 10, true],
  ]);
  seed(XYZ, "Y", 4, [
    ["2026-09-01", "approved", 4, false],
    ["2026-08-01", "approved", 4, false],
  ]);
  seed(BIG, "B", 1250, [["2026-09-01", "draft", 1250, true]]);

  // Soft-deleted rows, so "show deleted" has something to show: a run and an employee of ABC.
  seed(ABC, "Z", 1, [["2026-03-01", "approved", 1, false]]);
  const deletedAt = "2026-04-02T09:30:00+04:00";
  runs.find((run) => run.companyId === ABC && run.period === "2026-03-01")!.deletedAt = deletedAt;
  const departed = employees.find((e) => e.companyId === ABC && e.national_id.startsWith("Z"))!;
  departed.surname = "DEPARTED";
  departed.deleted_at = deletedAt;
}

const pause = (ms: number) => {
  ensureSeeded();
  return new Promise((resolve) => setTimeout(resolve, ms));
};
const roleIn = (companyId: string) =>
  demoMemberships.find((m) => m.company.id === companyId)?.role ?? null;

function requireAdmin(companyId: string) {
  if (roleIn(companyId) !== "admin") {
    throw Object.assign(new Error("PH_NOT_ADMIN"), { code: "42501" });
  }
}

function summarise(run: DemoRun): RunSummary {
  return {
    id: run.id,
    period: run.period,
    status: run.status,
    createdBy: run.createdBy,
    createdAt: run.createdAt,
    entryCount: entries.filter((entry) => entry.runId === run.id).length,
  };
}

const liveRuns = (companyId: string) =>
  runs
    .filter((run) => run.companyId === companyId && run.deletedAt === null)
    .sort((a, b) => b.period.localeCompare(a.period));

export async function demoFetchMemberships(): Promise<Membership[]> {
  await pause(300);
  return demoMemberships;
}

export async function demoFetchOverview(companyId: string) {
  await pause(400);
  const companyRuns = liveRuns(companyId);
  const latest = companyRuns[0];
  return {
    employeeCount: employees.filter((e) => e.companyId === companyId && e.deleted_at === null)
      .length,
    runCount: companyRuns.length,
    recentRuns: companyRuns.slice(0, 5).map(summarise),
    latestRunNetPay: latest
      ? sumMoney(entries.filter((e) => e.runId === latest.id).map((e) => e.values.net_pay))
      : null,
  };
}

export async function demoFetchRuns(companyId: string): Promise<RunSummary[]> {
  await pause(350);
  return liveRuns(companyId).map(summarise);
}

export async function demoFetchRunEntries(runId: string): Promise<PayrollRow[]> {
  await pause(450);
  return entries
    .filter((entry) => entry.runId === runId)
    .map((entry) => {
      const employee = employees.find((e) => e.id === entry.employeeId)!;
      return {
        id: entry.id,
        national_id: employee.national_id,
        surname: employee.surname,
        other_names: employee.other_names,
        employment_type: employee.employment_type,
        age_60_plus: entry.age_60_plus,
        extra: entry.extra,
        ...entry.values,
      };
    });
}

export async function demoFetchImportContext(
  companyId: string,
  period: string,
): Promise<{ employees: ExistingEmployee[]; run: ExistingRun | null }> {
  await pause(300);
  const run = runs.find((r) => r.companyId === companyId && r.period === period);
  return {
    employees: employees.filter((e) => e.companyId === companyId),
    run: run ? { id: run.id, status: run.status, deleted_at: run.deletedAt } : null,
  };
}

export async function demoImportRun(
  companyId: string,
  period: string,
  rows: readonly PayrollRow[],
  replace: boolean,
): Promise<ImportResult> {
  await pause(700);
  requireAdmin(companyId);

  let run = runs.find((r) => r.companyId === companyId && r.period === period);
  let outcome: ImportResult["outcome"] = "created";
  if (run) {
    if (!replace) throw new Error("PH_RUN_EXISTS");
    if (run.deletedAt === null && run.status === "approved") throw new Error("PH_RUN_APPROVED");
    outcome = run.deletedAt === null ? "replaced" : "revived";
    run.deletedAt = null;
    run.status = "draft";
  } else {
    run = {
      id: newId(2),
      companyId,
      period,
      status: "draft",
      createdBy: DEMO_USER_ID,
      createdAt: new Date().toISOString(),
      deletedAt: null,
    };
    runs.push(run);
  }

  let employeesNew = 0;
  const keep = new Set<string>();
  for (const row of rows) {
    let employee = employees.find(
      (e) => e.companyId === companyId && e.national_id === row.national_id,
    );
    if (!employee) {
      employee = {
        id: newId(3),
        companyId,
        national_id: row.national_id,
        surname: row.surname,
        other_names: row.other_names,
        employment_type: row.employment_type,
        deleted_at: null,
      };
      employees.push(employee);
      employeesNew += 1;
    } else {
      Object.assign(employee, {
        surname: row.surname,
        other_names: row.other_names,
        employment_type: row.employment_type,
        deleted_at: null,
      });
    }
    keep.add(employee.id);

    const values = Object.fromEntries(NUMERIC_COLUMNS.map((c) => [c, row[c]])) as Record<
      NumericColumn,
      number
    >;
    const existing = entries.find((e) => e.runId === run.id && e.employeeId === employee.id);
    if (existing) {
      Object.assign(existing, { values, age_60_plus: row.age_60_plus, extra: row.extra });
    } else {
      entries.push({
        id: newId(4),
        runId: run.id,
        employeeId: employee.id,
        age_60_plus: row.age_60_plus,
        extra: row.extra,
        values,
      });
    }
  }

  let removed = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.runId === run.id && !keep.has(entry.employeeId)) {
      entries.splice(i, 1);
      removed += 1;
    }
  }

  return {
    runId: run.id,
    outcome,
    entries: rows.length,
    entriesRemoved: removed,
    employeesNew,
    employeesExisting: rows.length - employeesNew,
  };
}

function findRunAsAdmin(runId: string): DemoRun {
  const run = runs.find((r) => r.id === runId);
  if (!run) throw Object.assign(new Error("not found"), { code: "42501" });
  requireAdmin(run.companyId);
  return run;
}

export async function demoSetRunStatus(runId: string, status: RunStatus): Promise<void> {
  await pause(350);
  findRunAsAdmin(runId).status = status;
}

export async function demoSoftDeleteRun(runId: string): Promise<void> {
  await pause(350);
  findRunAsAdmin(runId).deletedAt = new Date().toISOString();
}

// ---------------------------------------------------------------------------------------------
// Raw tables, for the read-only Database page. Rows are produced in the same shape the real
// API returns, so they go through exactly the same validation as real data.

const CREATED = "2026-01-05T08:00:00+04:00";

function rawRows(table: DbTableName, companyId: string): Record<string, unknown>[] {
  switch (table) {
    case "companies":
      return demoMemberships
        .filter((m) => m.company.id === companyId)
        .map((m) => ({ ...m.company, created_at: CREATED }));
    case "company_members": {
      const role = roleIn(companyId);
      if (!role) return [];
      return [
        { company_id: companyId, user_id: DEMO_USER_ID, role, created_at: CREATED },
        { company_id: companyId, user_id: OTHER_USER_ID, role: "admin", created_at: CREATED },
      ];
    }
    case "employees":
      return employees
        .filter((e) => e.companyId === companyId)
        .map((e) => ({
          id: e.id,
          company_id: e.companyId,
          national_id: e.national_id,
          surname: e.surname,
          other_names: e.other_names,
          employment_type: e.employment_type,
          deleted_at: e.deleted_at,
          created_at: CREATED,
        }));
    case "payroll_runs":
      return runs
        .filter((r) => r.companyId === companyId)
        .map((r) => ({
          id: r.id,
          company_id: r.companyId,
          period: r.period,
          status: r.status,
          created_by: r.createdBy,
          created_at: r.createdAt,
          deleted_at: r.deletedAt,
        }));
    case "payroll_entries": {
      const companyRuns = new Map(
        runs.filter((r) => r.companyId === companyId).map((r) => [r.id, r]),
      );
      const byId = new Map(employees.map((e) => [e.id, e]));
      return entries
        .filter((entry) => companyRuns.has(entry.runId))
        .map((entry) => {
          const run = companyRuns.get(entry.runId)!;
          const employee = byId.get(entry.employeeId)!;
          return {
            id: entry.id,
            run_id: entry.runId,
            employee_id: entry.employeeId,
            ...entry.values,
            age_60_plus: entry.age_60_plus,
            extra: entry.extra,
            created_at: run.createdAt,
            payroll_runs: { company_id: run.companyId, deleted_at: run.deletedAt },
            employees: {
              surname: employee.surname,
              other_names: employee.other_names,
              national_id: employee.national_id,
            },
          };
        });
    }
  }
}

const isDeleted = (table: DbTableName, row: Record<string, unknown>) =>
  table === "payroll_entries"
    ? (row.payroll_runs as { deleted_at: string | null }).deleted_at !== null
    : (row.deleted_at ?? null) !== null;

function matchesSearch(table: DbTable, row: Record<string, unknown>, search: string): boolean {
  const term = search.trim().toLowerCase();
  if (!term) return true;
  if (table.name === "payroll_runs" && /^\d{4}-(0[1-9]|1[0-2])$/.test(term)) {
    return row.period === `${term}-01`;
  }
  const haystack =
    table.name === "payroll_entries"
      ? Object.values(row.employees as Record<string, unknown>)
      : table.searchColumns.map((column) => row[column]);
  return haystack.some((value) =>
    String(value ?? "")
      .toLowerCase()
      .includes(term),
  );
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a ?? "").localeCompare(String(b ?? ""));
}

export async function demoFetchTablePage(
  table: DbTable,
  companyId: string,
  query: TableQuery,
  parse: (table: DbTable, raw: unknown) => DbRow,
): Promise<TablePage> {
  await pause(250);
  const matching = rawRows(table.name, companyId)
    .filter((row) => query.showDeleted || !isDeleted(table.name, row))
    .filter((row) => matchesSearch(table, row, query.search))
    .sort((a, b) => {
      const direction = query.sort.ascending ? 1 : -1;
      const primary = compare(a[query.sort.column], b[query.sort.column]) * direction;
      if (primary !== 0) return primary;
      for (const key of table.keyColumns) {
        const tie = compare(a[key], b[key]);
        if (tie !== 0) return tie;
      }
      return 0;
    });
  const from = query.page * query.pageSize;
  return {
    rows: matching.slice(from, from + query.pageSize).map((raw) => parse(table, raw)),
    total: matching.length,
  };
}

export async function demoFetchTableCounts(
  companyId: string,
  showDeleted: boolean,
): Promise<TableCounts> {
  await pause(200);
  const count = (table: DbTableName) =>
    rawRows(table, companyId).filter((row) => showDeleted || !isDeleted(table, row)).length;
  return {
    companies: count("companies"),
    employees: count("employees"),
    payroll_runs: count("payroll_runs"),
    payroll_entries: count("payroll_entries"),
    company_members: count("company_members"),
  };
}
