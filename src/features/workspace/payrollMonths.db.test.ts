// @vitest-environment node
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STORAGE_STAND_IN } from "@/test/storageStandIn";

/**
 * Runs migrations 0001 to 0014 in a real Postgres (PGlite) and uses 0014 the way the Data API
 * does: as the role "authenticated" (or "anon") with a user id in the request claims.
 *
 * Fake data only.
 */
const files = import.meta.glob<string>("../../../supabase/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const migrations = Object.entries(files)
  .map(([path, sql]) => ({ name: path.split("/").pop()!, sql }))
  .sort((a, b) => a.name.localeCompare(b.name));

const A = "00000000-0000-4000-8000-0000000000a1"; // admin of ABC, XYZ and NEW
const V = "00000000-0000-4000-8000-0000000000a2"; // viewer of ABC
const O = "00000000-0000-4000-8000-0000000000a3"; // member of nothing
const B = "00000000-0000-4000-8000-0000000000a4"; // admin of ABC and XYZ (a second admin)
const C = "00000000-0000-4000-8000-0000000000a5"; // admin of XYZ only
const ABC = "10000000-0000-4000-8000-000000000001";
const XYZ = "10000000-0000-4000-8000-000000000002";
const NEW = "10000000-0000-4000-8000-000000000003";
const S1 = "30000000-0000-4000-8000-000000000001";
const SETUP_TIMEOUT = 120_000;

const SHARED = {
  identityFields: [{ id: "f1", key: "employeeId", name: "ID" }],
  idFieldKey: "employeeId",
  globalColumns: [
    { id: "c1", key: "basicSalary", name: "Basic Salary", type: "input", decimals: 2 },
  ],
};
const COMPANY = { columns: [], customFields: [] };

/** One month of fake employees, as the payroll app keeps it. */
const month = (salary = 18115) => [
  { id: "e1", values: { employeeId: "TST001", name: "Test One", basicSalary: salary } },
  {
    id: "e2",
    values: { employeeId: "TST002", name: "Test Two", basicSalary: 62500.5, age60: true },
  },
  { id: "e3", values: { employeeId: "TST003", name: "Test Three" } },
];

const SUPABASE_STAND_INS = `
  create role anon nologin;
  create role authenticated nologin;
  create role migration_owner nologin nosuperuser bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
  $$;
  grant usage on schema auth to anon, authenticated, migration_owner;
  grant references on auth.users to migration_owner;
  alter schema public owner to migration_owner;
  ${STORAGE_STAND_IN}
`;

const SEED = `
  insert into auth.users (id) values ('${A}'), ('${V}'), ('${O}'), ('${B}'), ('${C}');
  insert into public.companies (id, name, brn) values
    ('${ABC}', 'ABC Co Ltd', 'C1'), ('${XYZ}', 'XYZ Trading Ltd', 'C2'),
    ('${NEW}', 'New Venture Ltd', 'C3');
  insert into public.company_members (company_id, user_id, role) values
    ('${ABC}', '${A}', 'admin'), ('${XYZ}', '${A}', 'admin'), ('${NEW}', '${A}', 'admin'),
    ('${ABC}', '${V}', 'viewer'),
    ('${ABC}', '${B}', 'admin'), ('${XYZ}', '${B}', 'admin'),
    ('${XYZ}', '${C}', 'admin');
`;

async function freshDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SUPABASE_STAND_INS);
  for (const { sql } of migrations) {
    await db.exec(`set role migration_owner; ${sql}; reset role;`);
  }
  await db.exec(SEED);
  return db;
}

type Role = "authenticated" | "anon";
type Outcome<T> = { result: T; error: null } | { result: null; error: string };

async function as<T>(
  db: PGlite,
  role: Role,
  user: string | null,
  work: () => Promise<T>,
): Promise<Outcome<T>> {
  await db.exec(`set role ${role}`);
  await db.query("select set_config('request.jwt.claims', $1, false)", [
    JSON.stringify(user ? { sub: user, role } : { role }),
  ]);
  try {
    return { result: await work(), error: null };
  } catch (error) {
    const { code, message } = error as { code?: string; message?: string };
    return { result: null, error: `${code} ${message}` };
  } finally {
    await db.exec("reset role; select set_config('request.jwt.claims', '', false);");
  }
}

function one<T>(
  db: PGlite,
  user: string | null,
  sql: string,
  params: unknown[] = [],
  role: Role = "authenticated",
) {
  return as(db, role, user, async () => {
    const { rows } = await db.query<{ result: T }>(sql, params);
    return rows[0]?.result as T;
  });
}

async function scalar<T>(db: PGlite, sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await db.query<{ result: T }>(sql, params);
  return rows[0]!.result;
}

const count = (db: PGlite, table: string, where = "true") =>
  scalar<number>(db, `select count(*)::int as result from ${table} where ${where}`);

// ---------- the setup the months are saved with (migration 0013) ----------

const saveShared = (db: PGlite, user: string, expected: number, body: unknown = SHARED) =>
  one<{ revision: number }>(
    db,
    user,
    "select public.save_payroll_shared_setup($1::uuid, 'Shared column setup', $2::jsonb, $3::int, '[]'::jsonb) as result",
    [S1, JSON.stringify(body), expected],
  );
const attach = (db: PGlite, user: string, company: string) =>
  one<{ revision: number }>(
    db,
    user,
    "select public.attach_payroll_company($1::uuid, $2::uuid, $3::jsonb) as result",
    [company, S1, JSON.stringify(COMPANY)],
  );

/** ABC and XYZ attached to S1 (revision 1 each); NEW has no setup. */
async function setUp(): Promise<PGlite> {
  const db = await freshDatabase();
  await saveShared(db, A, 0);
  await attach(db, A, ABC);
  await attach(db, A, XYZ);
  return db;
}

// ---------- the months ----------

interface MonthSave {
  company?: string;
  period?: string;
  employees?: unknown;
  expected?: number;
  shared?: number | null;
  own?: number | null;
  keep?: boolean;
}
interface MonthSaved {
  revision: number;
  period: string;
  employee_count: number;
  shared_revision: number;
  company_revision: number;
}
const saveMonth = (
  db: PGlite,
  user: string | null,
  s: MonthSave = {},
  role: Role = "authenticated",
) =>
  one<MonthSaved>(
    db,
    user,
    "select public.save_payroll_month($1::uuid, $2::date, $3::jsonb, $4::int, $5::int, $6::int, $7::boolean) as result",
    [
      s.company ?? ABC,
      s.period ?? "2026-10-01",
      JSON.stringify(s.employees ?? month()),
      s.expected ?? 0,
      s.shared === undefined ? 1 : s.shared,
      s.own === undefined ? 1 : s.own,
      s.keep ?? false,
    ],
    role,
  );

const storedMonth = (db: PGlite, company = ABC, period = "2026-10-01") =>
  scalar<unknown>(
    db,
    "select employees as result from public.payroll_months where company_id = $1 and period = $2",
    [company, period],
  );
const revisionOf = (db: PGlite, company = ABC, period = "2026-10-01") =>
  scalar<number>(
    db,
    "select revision as result from public.payroll_months where company_id = $1 and period = $2",
    [company, period],
  );

describe("migration 0014: its own check", () => {
  it(
    "ends with one row in which every column is true, and can be run again",
    async () => {
      const db = await freshDatabase();
      const sql = migrations.find((m) => m.name.startsWith("0014"))!.sql;
      const results = await db.exec(`set role migration_owner; ${sql}; reset role;`);
      const row = results.filter((r) => r.rows.length === 1 && r.fields.length > 3).at(-1)!
        .rows[0] as Record<string, unknown>;
      expect(Object.keys(row).length).toBeGreaterThanOrEqual(12);
      for (const [column, value] of Object.entries(row)) expect(value, column).toBe(true);
      await db.close();
    },
    SETUP_TIMEOUT,
  );

  it("adds only: no earlier table, column or row is touched by the file", () => {
    const sql = migrations
      .find((m) => m.name.startsWith("0014"))!
      .sql.replace(/\r\n/g, "\n")
      .replace(/--.*$/gm, "");
    expect(sql).not.toMatch(/\bdrop\s+(table|column|schema|index|function|type)\b/i);
    expect(sql).not.toMatch(/\balter\s+table\s+public\.(?!payroll_months|payroll_month_history)/i);
    expect(sql).not.toMatch(/\btruncate\s+(table\s+)?\w+\./i);
    // The only "create or replace" of something that existed before is delete_company.
    const replaced = [...sql.matchAll(/create or replace function public\.(\w+)/g)].map(
      (m) => m[1],
    );
    expect(replaced.sort()).toEqual([
      "delete_company",
      "payroll_month_employee_count",
      "payroll_month_rename_key",
      "payroll_month_value_keys",
      "save_payroll_key_change",
      "save_payroll_month",
    ]);
    // Deletes and updates only inside functions.
    const outside = sql.replace(/\$\$[\s\S]*?\$\$/g, "");
    expect(outside).not.toMatch(/\b(delete\s+from|update)\s+public\./i);
    // Inside them, a month's history is deleted only by delete_company, and never a
    // setup revision.
    const bodies = sql.match(/\$\$[\s\S]*?\$\$/g)!;
    const deleting = bodies.filter((body) => /delete\s+from\s+public\.payroll_month/i.test(body));
    expect(deleting).toHaveLength(1);
    expect(deleting[0]).toMatch(/PH_NAME_MISMATCH/);
    expect(bodies.join("\n")).not.toMatch(
      /delete\s+from\s+public\.payroll_(shared|company)_setup_history[^;]*revision/i,
    );
  });

  it("does not use the employees, payroll_runs or payroll_entries tables, except to delete a company", () => {
    const sql = migrations.find((m) => m.name.startsWith("0014"))!.sql.replace(/--.*$/gm, "");
    const bodies = sql.match(/\$\$[\s\S]*?\$\$/g)!;
    for (const body of bodies.filter((b) => !/PH_NAME_MISMATCH/.test(b))) {
      expect(body).not.toMatch(/public\.(employees|payroll_runs|payroll_entries)\b/);
    }
  });
});

describe("saving a month", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await setUp();
  }, SETUP_TIMEOUT);
  afterAll(() => db.close());

  it("needs someone signed in who is an admin of the company", async () => {
    expect((await saveMonth(db, null, {}, "anon")).error).toMatch(/permission denied/);
    expect((await saveMonth(db, V)).error).toMatch(/PH_NOT_ADMIN/); // viewer of ABC
    expect((await saveMonth(db, O)).error).toMatch(/PH_NOT_ADMIN/);
    expect((await saveMonth(db, C)).error).toMatch(/PH_NOT_ADMIN/); // admin of XYZ only
    expect(await count(db, "public.payroll_months")).toBe(0);
  });

  it("needs the company to have a column setup, and the revisions to be that setup's", async () => {
    expect((await saveMonth(db, A, { company: NEW })).error).toMatch(/PH_NOT_FOUND/);
    expect((await saveMonth(db, A, { shared: 2 })).error).toMatch(/PH_INVALID_INPUT/);
    expect((await saveMonth(db, A, { own: 5 })).error).toMatch(/PH_INVALID_INPUT/);
    expect((await saveMonth(db, A, { shared: null })).error).toMatch(/PH_INVALID_INPUT/);
    expect(await count(db, "public.payroll_months")).toBe(0);
  });

  it("refuses a malformed month: the date, the list, an employee, a repeated id, the size", async () => {
    const big = Array.from({ length: 5001 }, (_, i) => ({ id: `e${i}`, values: {} }));
    const huge = [{ id: "e1", values: { note: "x".repeat(1_050_000) } }];
    const bad: [MonthSave, RegExp][] = [
      [{ period: "2026-10-02" }, /PH_INVALID_INPUT|check/],
      [{ period: "1999-12-01" }, /PH_INVALID_INPUT/],
      [{ period: "2101-01-01" }, /PH_INVALID_INPUT/],
      [{ employees: {} }, /PH_INVALID_INPUT/],
      [{ employees: [{ values: {} }] }, /PH_INVALID_INPUT/],
      [{ employees: [{ id: "", values: {} }] }, /PH_INVALID_INPUT/],
      [{ employees: [{ id: 7, values: {} }] }, /PH_INVALID_INPUT/],
      [{ employees: [{ id: "e1", values: [] }] }, /PH_INVALID_INPUT/],
      [{ employees: [{ id: "e1" }] }, /PH_INVALID_INPUT/],
      [
        {
          employees: [
            { id: "e1", values: {} },
            { id: "e1", values: {} },
          ],
        },
        /PH_INVALID_INPUT/,
      ],
      [{ employees: big }, /PH_TOO_LARGE/],
      [{ employees: huge }, /PH_TOO_LARGE/],
      [{ expected: -1 }, /PH_INVALID_INPUT/],
      [{ expected: 3 }, /PH_NOT_FOUND/],
    ];
    for (const [input, error] of bad) {
      expect((await saveMonth(db, A, input)).error, JSON.stringify(input).slice(0, 60)).toMatch(
        error,
      );
    }
    expect(await count(db, "public.payroll_months")).toBe(0);
    expect(await count(db, "public.payroll_month_history")).toBe(0);
  });

  it("stores a new month at revision 1, exactly as sent, with the setup revisions it was saved with", async () => {
    const saved = await saveMonth(db, A);
    expect(saved.error).toBeNull();
    expect(saved.result).toMatchObject({
      revision: 1,
      period: "2026-10-01",
      employee_count: 3,
      shared_revision: 1,
      company_revision: 1,
    });
    expect(await storedMonth(db)).toEqual(month());
    const row = await scalar<Record<string, unknown>>(
      db,
      "select to_jsonb(pm) - 'employees' - 'created_at' - 'updated_at' as result from public.payroll_months pm",
    );
    expect(row).toMatchObject({
      company_id: ABC,
      shared_setup_id: S1,
      employee_count: 3,
      value_keys: ["age60", "basicSalary", "employeeId", "name"],
      created_by: A,
      updated_by: A,
    });
  });

  it("stores the same save once when it is sent twice, and refuses an old revision", async () => {
    expect((await saveMonth(db, A)).error).toMatch(/PH_STALE/);
    expect((await saveMonth(db, A, { expected: 1, employees: month(19115) })).error).toBeNull();
    expect((await saveMonth(db, A, { expected: 1, employees: month(20000) })).error).toMatch(
      /PH_STALE/,
    );
    expect(await revisionOf(db)).toBe(2);
    expect(await storedMonth(db)).toEqual(month(19115));
  });

  it("keeps a record of every save, and a month of another company or month is separate", async () => {
    expect(await count(db, "public.payroll_month_history", `company_id = '${ABC}'`)).toBe(2);
    expect((await saveMonth(db, A, { company: XYZ })).error).toBeNull();
    expect((await saveMonth(db, A, { period: "2026-09-01" })).error).toBeNull();
    expect(await count(db, "public.payroll_months")).toBe(3);
    expect(await revisionOf(db)).toBe(2);
  });

  it("an empty month (Delete All) is a revision like any other", async () => {
    const saved = await saveMonth(db, A, { period: "2026-09-01", expected: 1, employees: [] });
    expect(saved.result).toMatchObject({ revision: 2, employee_count: 0 });
    expect(await storedMonth(db, ABC, "2026-09-01")).toEqual([]);
  });
});

describe("what a month's history keeps of its content", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await setUp();
    await saveMonth(db, A); // revision 1, by A
    await saveMonth(db, A, { expected: 1, employees: month(1) }); // 2, by A, the same day
  }, SETUP_TIMEOUT);
  afterAll(() => db.close());

  const kept = (revision: number) =>
    scalar<unknown>(
      db,
      `select employees as result from public.payroll_month_history
       where company_id = '${ABC}' and period = '2026-10-01' and revision = ${revision}`,
    );

  it("not each save of one person on one day: those are only recorded", async () => {
    expect(await kept(1)).toBeNull();
    expect(await kept(2)).toBeNull();
    expect(await count(db, "public.payroll_month_history")).toBe(2);
  });

  it("what someone else saved, when another admin saves over it", async () => {
    expect((await saveMonth(db, B, { expected: 2, employees: month(2) })).error).toBeNull();
    expect(await kept(2)).toEqual(month(1));
    expect(await kept(3)).toBeNull();
  });

  it("what was there, when the save asks for it to be kept (Save mine over it, an import)", async () => {
    expect(
      (await saveMonth(db, B, { expected: 3, employees: month(3), keep: true })).error,
    ).toBeNull();
    expect(await kept(3)).toEqual(month(2));
  });

  it("the last revision of a day, once a save comes in on a later day", async () => {
    await db.exec(
      `update public.payroll_months set updated_at = now() - interval '2 days' where company_id = '${ABC}'`,
    );
    expect((await saveMonth(db, B, { expected: 4, employees: month(4) })).error).toBeNull();
    expect(await kept(4)).toEqual(month(3));
    expect(await kept(5)).toBeNull();
  });
});

describe("who can read the months", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await setUp();
    await saveMonth(db, A);
    await saveMonth(db, A, { company: XYZ });
  }, SETUP_TIMEOUT);
  afterAll(() => db.close());

  const seen = (user: string | null, table: string, role: Role = "authenticated") =>
    one<number>(db, user, `select count(*)::int as result from public.${table}`, [], role);

  it("admins of the company read its months and their history", async () => {
    expect((await seen(A, "payroll_months")).result).toBe(2);
    expect((await seen(A, "payroll_month_history")).result).toBe(2);
    expect((await seen(C, "payroll_months")).result).toBe(1); // XYZ only
  });

  it("a viewer of the company sees nothing at all, not even a count; nor does anyone else", async () => {
    for (const table of ["payroll_months", "payroll_month_history"]) {
      expect((await seen(V, table)).result, table).toBe(0);
      expect((await seen(O, table)).result, table).toBe(0);
      expect((await seen(null, table, "anon")).error, table).toMatch(/permission denied/);
    }
  });

  it("nobody writes a row directly, admins included", async () => {
    const attempts = [
      `insert into public.payroll_months (company_id, period, revision, shared_setup_id, shared_revision, company_revision, employees, employee_count)
       values ('${ABC}', '2026-01-01', 1, '${S1}', 1, 1, '[]', 0)`,
      `update public.payroll_months set employees = '[]'`,
      `delete from public.payroll_months`,
      `update public.payroll_month_history set employees = '[]'`,
      `delete from public.payroll_month_history`,
    ];
    for (const sql of attempts) {
      expect((await as(db, "authenticated", A, () => db.query(sql))).error, sql).toMatch(
        /permission denied/,
      );
    }
    expect(await count(db, "public.payroll_months")).toBe(2);
    expect(await storedMonth(db)).toEqual(month());
  });

  it("the helpers cannot be called from outside the save functions", async () => {
    for (const sql of [
      "select public.payroll_month_employee_count('[]'::jsonb) as result",
      "select public.payroll_month_value_keys('[]'::jsonb) as result",
      "select public.payroll_month_rename_key('[]'::jsonb, 'a', 'b') as result",
    ]) {
      expect((await one(db, A, sql)).error, sql).toMatch(/permission denied/);
    }
  });
});

describe("a change of key: the setup and every month, together", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await setUp();
    await saveMonth(db, A); // ABC 2026-10, revision 1
    await saveMonth(db, A, { period: "2026-09-01" }); // ABC 2026-09
    await saveMonth(db, A, { company: XYZ }); // XYZ 2026-10
    // A month that does not hold the key at all.
    await saveMonth(db, A, {
      period: "2026-08-01",
      employees: [{ id: "e9", values: { name: "Nine" } }],
    });
  }, SETUP_TIMEOUT);
  afterAll(() => db.close());

  const renamed = (body: typeof SHARED, from: string, to: string) =>
    JSON.parse(JSON.stringify(body).replaceAll(`"${from}"`, `"${to}"`)) as typeof SHARED;

  const keyChange = (
    user: string,
    moves: unknown,
    shared: unknown = null,
    company: unknown = null,
  ) =>
    one<{
      setup: { revision: number };
      months: { company_id: string; period: string; revision: number }[];
    }>(
      db,
      user,
      "select public.save_payroll_key_change($1::jsonb, $2::jsonb, $3::jsonb) as result",
      [JSON.stringify(moves), JSON.stringify(shared), JSON.stringify(company)],
    );

  const sharedChange = (expected: number, body: unknown) => ({
    setup_id: S1,
    name: "Shared column setup",
    body,
    expected_revision: expected,
    companies: [],
  });

  it("refuses malformed input before anything is stored", async () => {
    const body = renamed(SHARED, "basicSalary", "basicPay");
    const bad: [unknown, unknown, unknown][] = [
      [[], sharedChange(1, body), null],
      [[{ old_key: "basicSalary" }], sharedChange(1, body), null],
      [[{ old_key: "basicSalary", new_key: "basicSalary" }], sharedChange(1, body), null],
      [[{ old_key: "basic salary", new_key: "basicPay" }], sharedChange(1, body), null],
      [
        [{ old_key: "basicSalary", new_key: "basicPay", company_id: "x" }],
        sharedChange(1, body),
        null,
      ],
      [[{ old_key: "basicSalary", new_key: "basicPay" }], null, null],
      [
        [{ old_key: "basicSalary", new_key: "basicPay" }],
        sharedChange(1, body),
        { company_id: ABC, body: COMPANY, expected_revision: 1 },
      ],
      [[{ old_key: "basicSalary", new_key: "basicPay" }], sharedChange(0, body), null],
    ];
    for (const [moves, shared, company] of bad) {
      expect((await keyChange(A, moves, shared, company)).error).toMatch(/PH_INVALID_INPUT/);
    }
    expect(await scalar(db, "select revision as result from public.payroll_shared_setups")).toBe(1);
  });

  it("is all or nothing: when any part is refused, neither the setup nor a month changes", async () => {
    const body = renamed(SHARED, "basicSalary", "basicPay");
    // Someone else saved the shared setup since: the setup part is refused.
    expect(
      (await keyChange(A, [{ old_key: "basicSalary", new_key: "basicPay" }], sharedChange(7, body)))
        .error,
    ).toMatch(/PH_STALE/);
    // The setup part would be stored, but a key is to move in a company not attached to it.
    expect(
      (
        await keyChange(
          A,
          [
            { old_key: "basicSalary", new_key: "basicPay", company_id: null },
            { old_key: "name", new_key: "fullName", company_id: NEW },
          ],
          sharedChange(1, body),
        )
      ).error,
    ).toMatch(/PH_NOT_FOUND/);
    expect(await scalar(db, "select revision as result from public.payroll_shared_setups")).toBe(1);
    expect(await storedMonth(db)).toEqual(month());
    expect(await revisionOf(db)).toBe(1);
  });

  it("an admin of only some of the companies the key reaches cannot do it", async () => {
    const body = renamed(SHARED, "basicSalary", "basicPay");
    expect(
      (await keyChange(C, [{ old_key: "basicSalary", new_key: "basicPay" }], sharedChange(1, body)))
        .error,
    ).toMatch(/PH_NOT_ADMIN/);
    expect(
      (await keyChange(V, [{ old_key: "basicSalary", new_key: "basicPay" }], sharedChange(1, body)))
        .error,
    ).toMatch(/PH_NOT_ADMIN/);
    expect(await revisionOf(db, XYZ)).toBe(1);
  });

  it("a Global key: the setup is saved and the values move in every month of every attached company", async () => {
    const body = renamed(SHARED, "basicSalary", "basicPay");
    const changed = await keyChange(
      A,
      [{ old_key: "basicSalary", new_key: "basicPay", company_id: null }],
      sharedChange(1, body),
    );
    expect(changed.error).toBeNull();
    expect(changed.result!.setup).toMatchObject({ revision: 2 });
    expect(
      changed.result!.months.map((m) => `${m.company_id}:${m.period}:${m.revision}`).sort(),
    ).toEqual([`${ABC}:2026-09-01:2`, `${ABC}:2026-10-01:2`, `${XYZ}:2026-10-01:2`].sort());
    const moved = (salary = 18115) =>
      month(salary).map((e) => {
        if (!("basicSalary" in e.values)) return e;
        const { basicSalary, ...rest } = e.values;
        return { ...e, values: { ...rest, basicPay: basicSalary } };
      });
    expect(await storedMonth(db)).toEqual(moved());
    expect(await storedMonth(db, XYZ)).toEqual(moved());
    // Each moved month records the setup revision it now matches.
    expect(
      await scalar(
        db,
        `select array_agg(distinct shared_revision) as result from public.payroll_months where 'basicPay' = any(value_keys)`,
      ),
    ).toEqual([2]);
    // A month that did not hold the key is not touched, and gets no new revision.
    expect(await revisionOf(db, ABC, "2026-08-01")).toBe(1);
    expect(await storedMonth(db, ABC, "2026-08-01")).toEqual([
      { id: "e9", values: { name: "Nine" } },
    ]);
    // Every move is a recorded revision.
    expect(await count(db, "public.payroll_month_history")).toBe(7);
  });

  it("a company column's key: only that company's months move, with a company setup save", async () => {
    const changed = await keyChange(
      A,
      [{ old_key: "age60", new_key: "aged60", company_id: XYZ }],
      null,
      {
        company_id: XYZ,
        body: { columns: [{ key: "aged60" }], customFields: [] },
        expected_revision: 1,
      },
    );
    expect(changed.error).toBeNull();
    expect(changed.result!.months).toEqual([
      { company_id: XYZ, period: "2026-10-01", revision: 3 },
    ]);
    expect(JSON.stringify(await storedMonth(db, XYZ))).toContain('"aged60"');
    expect(JSON.stringify(await storedMonth(db, ABC))).toContain('"age60"');
    expect(
      await scalar(
        db,
        `select company_revision as result from public.payroll_months where company_id = '${XYZ}'`,
      ),
    ).toBe(2);
  });

  it("a company setup cannot carry a move into another company's months", async () => {
    expect(
      (
        await keyChange(A, [{ old_key: "name", new_key: "fullName", company_id: ABC }], null, {
          company_id: XYZ,
          body: COMPANY,
          expected_revision: 2,
        })
      ).error,
    ).toMatch(/PH_INVALID_INPUT/);
    expect(
      (
        await keyChange(A, [{ old_key: "name", new_key: "fullName", company_id: null }], null, {
          company_id: XYZ,
          body: COMPANY,
          expected_revision: 2,
        })
      ).error,
    ).toMatch(/PH_INVALID_INPUT/);
  });
});

describe("delete_company after 0014", () => {
  it(
    "removes the company's months and their history before its setup; the other company keeps its own",
    async () => {
      const db = await setUp();
      await saveMonth(db, A);
      await saveMonth(db, A, { expected: 1, employees: month(1) });
      await saveMonth(db, A, { company: XYZ });

      const deleteCompany = (id: string, name: string) =>
        one<Record<string, unknown>>(
          db,
          A,
          "select public.delete_company($1::uuid, $2) as result",
          [id, name],
        );

      const first = await deleteCompany(ABC, "ABC Co Ltd");
      expect(first.error).toBeNull();
      expect(first.result).toMatchObject({
        payroll_months: 1,
        payroll_month_history: 2,
        payroll_company_setups: 1,
        payroll_shared_setups: 0,
      });
      expect(await count(db, "public.payroll_months")).toBe(1);
      expect(await count(db, "public.payroll_month_history", `company_id = '${ABC}'`)).toBe(0);

      const last = await deleteCompany(XYZ, "XYZ Trading Ltd");
      expect(last.result).toMatchObject({
        payroll_months: 1,
        payroll_month_history: 1,
        payroll_shared_setups: 1,
      });
      expect(await count(db, "public.payroll_months")).toBe(0);
      expect(await count(db, "public.payroll_shared_setups")).toBe(0);
      await db.close();
    },
    SETUP_TIMEOUT,
  );
});
