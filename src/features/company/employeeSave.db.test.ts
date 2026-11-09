// @vitest-environment node
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_STAND_IN } from "@/test/storageStandIn";
import type { XlsxCell } from "@/lib/xlsx/readXlsx";

/**
 * Saving the employees of the companies import (EMPLOYEES_IMPORT_PLAN.md, Stage 3) against every
 * migration in a real Postgres (PGlite): the dashboard's own code (runEmployeeImport) calls
 * import_payroll_company (0019) through a stand-in client that runs each call as the signed-in
 * user, the way the Data API does. Approved, stale and not-admin are refused by the database; one
 * company failing does not stop the others. TEST companies and fake employees only.
 */
const state = vi.hoisted(() => ({
  db: null as unknown as import("@electric-sql/pglite").PGlite,
  user: "",
}));

vi.mock("@/lib/supabase/client", () => {
  async function as<T>(work: () => Promise<T>): Promise<T> {
    await state.db.exec("set role authenticated");
    await state.db.query("select set_config('request.jwt.claims', $1, false)", [
      JSON.stringify({ sub: state.user, role: "authenticated" }),
    ]);
    try {
      return await work();
    } finally {
      await state.db.exec("reset role; select set_config('request.jwt.claims', '', false);");
    }
  }
  const failure = (error: unknown) => {
    const { code, message } = error as { code?: string; message?: string };
    return { data: null, error: { code, message } };
  };
  return {
    supabase: {
      async rpc(name: string, args: Record<string, unknown>) {
        if (name !== "import_payroll_company") throw new Error(`unexpected rpc ${name}`);
        const json = (value: unknown) => (value === null ? null : JSON.stringify(value));
        try {
          const { rows } = await as(() =>
            state.db.query<{ result: unknown }>(
              "select public.import_payroll_company($1::uuid, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb) as result",
              [
                args.p_company_id,
                json(args.p_new_company),
                json(args.p_setup),
                json(args.p_expected),
                json(args.p_months),
              ],
            ),
          );
          return { data: rows[0]!.result, error: null };
        } catch (error) {
          return failure(error);
        }
      },
      // Only what reading a just-created company's setup needs: one row by one column.
      from(table: string) {
        const filters: [string, unknown][] = [];
        const query = {
          select: () => query,
          eq: (column: string, value: unknown) => (filters.push([column, value]), query),
          async maybeSingle() {
            const [column, value] = filters[0]!;
            try {
              const { rows } = await as(() =>
                state.db.query<{ r: unknown }>(
                  `select to_jsonb(t) as r from public.${table} t where ${column} = $1`,
                  [value],
                ),
              );
              return { data: rows[0]?.r ?? null, error: null };
            } catch (error) {
              return failure(error);
            }
          },
        };
        return query;
      },
    },
  };
});

const { readEmployeesSheet, previewEmployees, isEmployeeTickable } =
  await import("./employeeImport");
const { runEmployeeImport } = await import("./employeeSave");
const { setupFields } = await import("./employeeSheet");
type EmployeeContext = import("./employeeImport").EmployeeContext;
type ExistingCompany = import("./employeeImport").ExistingCompany;
type EmployeePreview = import("./employeeImport").EmployeePreview;

const files = import.meta.glob<string>("../../../supabase/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const migrations = Object.entries(files)
  .map(([path, sql]) => ({ name: path.split("/").pop()!, sql }))
  .sort((a, b) => a.name.localeCompare(b.name));

const A = "00000000-0000-4000-8000-0000000000a1"; // admin of ALPHA and BETA
const C = "00000000-0000-4000-8000-0000000000a5"; // admin of ALPHA too: saves behind A's back
const ALPHA = "10000000-0000-4000-8000-000000000001";
const BETA = "10000000-0000-4000-8000-000000000002";
const S1 = "30000000-0000-4000-8000-000000000001";
const VIEWER = { id: A, isDemo: false };
const TIMEOUT = 120_000;

const SHARED = {
  identityFields: [
    { id: "f1", key: "id", name: "ID" },
    { id: "f2", key: "surname", name: "Surname" },
    { id: "f3", key: "other_names", name: "Other names" },
  ],
  idFieldKey: "id",
  globalColumns: [
    { id: "c1", key: "basic", name: "Basic Salary", type: "input", category: "general" },
  ],
};
const FIELDS = setupFields(SHARED, { columns: [] });
const OCTOBER = [
  { id: "oct-1", values: { id: "T0101", surname: "Testone", other_names: "Fake", basic: 30000 } },
  { id: "oct-2", values: { id: "T0202", surname: "Testtwo", basic: 18115 } },
  { id: "oct-3", values: { id: "T0303", surname: "Testthree" } },
];

const STAND_INS = `
  create role anon nologin;
  create role authenticated nologin;
  create role migration_owner nologin nosuperuser bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
  $$;
  grant usage on schema auth to anon, authenticated, migration_owner;
  grant references, select on auth.users to migration_owner;
  alter schema public owner to migration_owner;
  ${STORAGE_STAND_IN}
`;
const SEED = `
  insert into auth.users (id) values ('${A}'), ('${C}');
  insert into public.companies (id, name, brn) values
    ('${ALPHA}', 'TEST Alpha Ltd', 'C0000101'), ('${BETA}', 'TEST Beta Ltd', 'C0000102');
  insert into public.company_members (company_id, user_id, role) values
    ('${ALPHA}', '${A}', 'admin'), ('${BETA}', '${A}', 'admin'), ('${ALPHA}', '${C}', 'admin');
`;

let template: File | Blob | undefined;

async function asUser<T>(user: string, work: () => Promise<T>): Promise<T> {
  await state.db.exec("set role authenticated");
  await state.db.query("select set_config('request.jwt.claims', $1, false)", [
    JSON.stringify({ sub: user, role: "authenticated" }),
  ]);
  try {
    return await work();
  } finally {
    await state.db.exec("reset role; select set_config('request.jwt.claims', '', false);");
  }
}
const sql = (user: string, text: string, params: unknown[] = []) =>
  asUser(user, () => state.db.query(text, params));
async function scalar<T>(text: string, params: unknown[] = []): Promise<T> {
  const { rows } = await state.db.query<{ result: T }>(text, params);
  return rows[0]!.result;
}

/** S1 shared by ALPHA and BETA (revision 1 each); ALPHA has October 2026 saved (revision 1). */
async function setUp() {
  await sql(
    A,
    "select public.save_payroll_shared_setup($1::uuid, 'TEST setup', $2::jsonb, 0, '[]'::jsonb)",
    [S1, JSON.stringify(SHARED)],
  );
  for (const company of [ALPHA, BETA]) {
    await sql(A, "select public.attach_payroll_company($1::uuid, $2::uuid, $3::jsonb)", [
      company,
      S1,
      JSON.stringify({ columns: [] }),
    ]);
  }
  await sql(
    A,
    "select public.save_payroll_month($1::uuid, '2026-10-01', $2::jsonb, 0, 1, 1, false)",
    [ALPHA, JSON.stringify(OCTOBER)],
  );
}

vi.setConfig({ testTimeout: 30_000 });
beforeEach(async () => {
  if (!template) {
    const fresh = new PGlite();
    await fresh.exec(STAND_INS);
    for (const { sql: text } of migrations) {
      await fresh.exec(`set role migration_owner; ${text}; reset role;`);
    }
    await fresh.exec(SEED);
    state.db = fresh;
    await setUp();
    template = await fresh.dumpDataDir();
    await fresh.close();
  }
  state.db = new PGlite({ loadDataDir: template });
  state.user = A;
}, TIMEOUT);

// ---------- the preview, as the dialog makes it ----------

const t = (text: string): XlsxCell => ({ text, kind: "text" });
const HEAD = ["Company BRN *", "ID", "Surname", "Other names", "Basic Salary"];
const sheet = (rows: string[][]) => [HEAD.map(t), ...rows.map((row) => row.map(t))];

const alphaNow = (): ExistingCompany => ({
  id: ALPHA,
  name: "TEST Alpha Ltd",
  brn: "C0000101",
  fields: FIELDS,
  setupRevisions: { shared: 1, company: 1 },
  newest: {
    period: "2026-10-01",
    revision: 1,
    sharedRevision: 1,
    companyRevision: 1,
    employees: OCTOBER,
  },
  approved: false,
  referenced: new Map(),
});
const betaNow = (): ExistingCompany => ({
  ...alphaNow(),
  id: BETA,
  name: "TEST Beta Ltd",
  brn: "C0000102",
  newest: null,
});
const context = (over: Partial<EmployeeContext> = {}): EmployeeContext => ({
  existing: new Map([
    ["C0000101", alphaNow()],
    ["C0000102", betaNow()],
  ]),
  notAdmin: new Map(),
  newCompanies: new Map(),
  newSetup: FIELDS,
  startPeriod: "2026-11-01",
  ...over,
});
let next = 0;
function previewOf(rows: string[][], ctx = context()) {
  const read = readEmployeesSheet(sheet(rows));
  if (!read.ok) throw new Error(read.why);
  return previewEmployees(read.rows, read.headings, ctx, () => `new-${++next}`);
}
/** Ticks as the owner would: everything tickable, unless a row is named. */
const tickAll = (item: EmployeePreview) => isEmployeeTickable(item);

const FILE = [
  // ALPHA: a change for oct-1, a new employee
  ["C0000101", "T0101", "", "", "31234.56"],
  ["C0000101", "T0404", "Testfour", "New Hire", "21500"],
  // BETA: no saved month: starts in November 2026
  ["C0000102", "T0505", "Testfive", "", "19000"],
];

async function month(company: string, period: string) {
  return (
    await state.db.query<{
      revision: number;
      employees: { id: string; values: Record<string, unknown> }[];
    }>(
      "select revision, employees from public.payroll_months where company_id = $1 and period = $2",
      [company, period],
    )
  ).rows[0];
}

describe("saving the ticked employees", () => {
  it("adds and updates in the newest month as a new revision, keeps the previous one, and leaves everyone else as they were", async () => {
    const preview = previewOf(FILE);
    const lines = await runEmployeeImport(VIEWER, preview, context(), new Map(), tickAll);
    expect(lines.map((l) => [l.line, l.result, l.what])).toEqual([
      [2, "Updated", "Updated in October 2026"],
      [3, "Added", "Added to October 2026"],
      [4, "Added", "Added to November 2026"],
    ]);
    const october = (await month(ALPHA, "2026-10-01"))!;
    expect(october.revision).toBe(2);
    expect(october.employees.map((e) => [e.id, e.values.basic])).toEqual([
      ["oct-1", 31234.56],
      ["oct-2", 18115],
      ["oct-3", undefined],
      [expect.stringMatching(/^new-/), 21500],
    ]);
    // Untouched values of the updated employee stay.
    expect(october.employees[0]!.values).toMatchObject({ surname: "Testone", other_names: "Fake" });
    // History > Restore can undo it: revision 1's content is kept.
    expect(
      await scalar<boolean>(
        `select content_kept as result from public.payroll_month_history where company_id = '${ALPHA}' and period = '2026-10-01' and revision = 1`,
      ),
    ).toBe(true);
    const november = (await month(BETA, "2026-11-01"))!;
    expect(november.revision).toBe(1);
    expect(november.employees.map((e) => e.values)).toEqual([
      { id: "T0505", surname: "Testfive", basic: 19000 },
    ]);
  });

  it("an unticked change is not made; the report says so", async () => {
    const preview = previewOf(FILE.slice(0, 2));
    const lines = await runEmployeeImport(
      VIEWER,
      preview,
      context(),
      new Map(),
      (item) => item.status === "new",
    );
    expect(lines.map((l) => l.what)).toEqual(["Not ticked.", "Added to October 2026"]);
    const october = (await month(ALPHA, "2026-10-01"))!;
    expect(october.employees[0]!.values.basic).toBe(30000);
    expect(october.employees).toHaveLength(4);
  });

  it("refuses a month approved after the preview, and stores nothing of that company", async () => {
    const preview = previewOf(FILE.slice(0, 2));
    await state.db.exec(
      `insert into public.payroll_runs (company_id, period, status) values ('${ALPHA}', '2026-10-01', 'approved')`,
    );
    const lines = await runEmployeeImport(VIEWER, preview, context(), new Map(), tickAll);
    expect(lines.map((l) => [l.result, l.what])).toEqual([
      [
        "Problem",
        "Not changed: October 2026 was approved after the preview, so it can't be changed.",
      ],
      [
        "Problem",
        "Not changed: October 2026 was approved after the preview, so it can't be changed.",
      ],
    ]);
    expect((await month(ALPHA, "2026-10-01"))!.revision).toBe(1);
  });

  it("refuses a month someone else saved after the preview", async () => {
    const preview = previewOf(FILE.slice(0, 2));
    await sql(
      C,
      "select public.save_payroll_month($1::uuid, '2026-10-01', $2::jsonb, 1, 1, 1, false)",
      [ALPHA, JSON.stringify(OCTOBER.slice(0, 2))],
    );
    const lines = await runEmployeeImport(VIEWER, preview, context(), new Map(), tickAll);
    expect(new Set(lines.map((l) => l.what))).toEqual(
      new Set([
        "Not changed: the month was saved by someone else after the preview. Upload the file again.",
      ]),
    );
    const october = (await month(ALPHA, "2026-10-01"))!;
    expect(october.revision).toBe(2);
    expect(october.employees).toHaveLength(2);
  });

  it("refuses when the column setup was saved after the preview", async () => {
    const preview = previewOf(FILE.slice(2));
    await sql(A, "select public.save_payroll_company_setup($1::uuid, $2::jsonb, 1)", [
      BETA,
      JSON.stringify({ columns: [] }),
    ]);
    const moved = await scalar<number>(
      `select revision as result from public.payroll_company_setups where company_id = '${BETA}'`,
    );
    expect(moved).toBe(2);
    const lines = await runEmployeeImport(VIEWER, preview, context(), new Map(), tickAll);
    expect(lines[0]!.what).toContain("saved by someone else after the preview");
    expect(await month(BETA, "2026-11-01")).toBeUndefined();
  });

  it("refuses a company the user is no longer an admin of", async () => {
    const preview = previewOf(FILE.slice(0, 2));
    await state.db.exec(
      `update public.company_members set role = 'viewer' where company_id = '${ALPHA}' and user_id = '${A}'`,
    );
    const lines = await runEmployeeImport(VIEWER, preview, context(), new Map(), tickAll);
    expect(lines[0]!.what).toBe("Not changed: you are no longer an admin of this company.");
    expect((await month(ALPHA, "2026-10-01"))!.revision).toBe(1);
  });

  it("one company failing does not stop the others", async () => {
    const preview = previewOf(FILE);
    await state.db.exec(
      `insert into public.payroll_runs (company_id, period, status) values ('${ALPHA}', '2026-10-01', 'approved')`,
    );
    const progress: [number, number][] = [];
    const lines = await runEmployeeImport(VIEWER, preview, context(), new Map(), tickAll, (d, t) =>
      progress.push([d, t]),
    );
    expect(lines.map((l) => l.result)).toEqual(["Problem", "Problem", "Added"]);
    expect((await month(ALPHA, "2026-10-01"))!.revision).toBe(1);
    expect((await month(BETA, "2026-11-01"))!.employees).toHaveLength(1);
    expect(progress).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
  });

  it("saves into a company created by the same import, with its setup read again", async () => {
    const created = await asUser(A, async () => {
      const { rows } = await state.db.query<{ result: { id: string } }>(
        "select public.create_company_with_details('TEST Delta Ltd', 'C0000105', null, null, '[]'::jsonb, null, $1::uuid, '{}'::uuid[]) as result",
        [S1],
      );
      return rows[0]!.result.id;
    });
    const ctx = context({
      newCompanies: new Map([["C0000105", { name: "TEST Delta Ltd", created: true }]]),
    });
    const preview = previewOf([["C0000105", "T0808", "Testeight", "", "19000"]], ctx);
    const lines = await runEmployeeImport(
      VIEWER,
      preview,
      ctx,
      new Map([["C0000105", created]]),
      tickAll,
    );
    expect(lines.map((l) => l.what)).toEqual(["Added to November 2026"]);
    expect((await month(created, "2026-11-01"))!.employees[0]!.values.surname).toBe("Testeight");
  });

  it("a company that was not created gets nothing, and says why", async () => {
    const ctx = context({
      newCompanies: new Map([["C0000105", { name: "TEST Delta Ltd", created: true }]]),
    });
    const preview = previewOf([["C0000105", "T0808", "Testeight", "", ""]], ctx);
    const lines = await runEmployeeImport(VIEWER, preview, ctx, new Map(), tickAll);
    expect(lines.map((l) => [l.result, l.what])).toEqual([
      ["Problem", "Not added: its company was not created."],
    ]);
  });
});
