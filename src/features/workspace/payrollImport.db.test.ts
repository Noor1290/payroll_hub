// @vitest-environment node
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { STORAGE_STAND_IN } from "@/test/storageStandIn";

/**
 * Runs every migration in a real Postgres (PGlite) and uses 0019 the way the Data API does: as
 * the role "authenticated" (or "anon") with a user id in the request claims. One company of a
 * file is imported fully or not at all; an approved month is never replaced.
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
const C = "00000000-0000-4000-8000-0000000000a5"; // admin of XYZ only
const ABC = "10000000-0000-4000-8000-000000000001";
const XYZ = "10000000-0000-4000-8000-000000000002";
const NEW = "10000000-0000-4000-8000-000000000003";
const S1 = "30000000-0000-4000-8000-000000000001";
const S2 = "30000000-0000-4000-8000-000000000002";
const TIMEOUT = 120_000;

const SHARED = {
  identityFields: [{ id: "f1", key: "employeeId", name: "ID" }],
  idFieldKey: "employeeId",
  globalColumns: [{ id: "c1", key: "basicSalary", name: "Basic Salary", type: "input" }],
};
const COMPANY = { columns: [], customFields: [] };
const people = (salary = 18115) => [
  { id: "e1", values: { employeeId: "TST001", basicSalary: salary } },
  { id: "e2", values: { employeeId: "TST002", basicSalary: 62500.5 } },
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
  insert into auth.users (id) values ('${A}'), ('${V}'), ('${O}'), ('${C}');
  insert into public.companies (id, name, brn) values
    ('${ABC}', 'ABC Co Ltd', 'C1'), ('${XYZ}', 'XYZ Trading Ltd', 'C2'),
    ('${NEW}', 'New Venture Ltd', 'C3');
  insert into public.company_members (company_id, user_id, role) values
    ('${ABC}', '${A}', 'admin'), ('${XYZ}', '${A}', 'admin'), ('${NEW}', '${A}', 'admin'),
    ('${ABC}', '${V}', 'viewer'), ('${XYZ}', '${C}', 'admin');
`;

let db: PGlite;
// One database with every migration, then a copy per test: each test starts from the same state.
let template: File | Blob;

async function freshDatabase(): Promise<PGlite> {
  const fresh = new PGlite();
  await fresh.exec(SUPABASE_STAND_INS);
  for (const { sql } of migrations) {
    await fresh.exec(`set role migration_owner; ${sql}; reset role;`);
  }
  await fresh.exec(SEED);
  return fresh;
}

type Role = "authenticated" | "anon";
type Outcome<T> = { result: T; error: null } | { result: null; error: string };

async function as<T>(role: Role, user: string | null, work: () => Promise<T>): Promise<Outcome<T>> {
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

function call<T>(
  user: string | null,
  sql: string,
  params: unknown[] = [],
  role: Role = "authenticated",
) {
  return as(role, user, async () => {
    const { rows } = await db.query<{ result: T }>(sql, params);
    return rows[0]?.result as T;
  });
}

async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await db.query<{ result: T }>(sql, params);
  return rows[0]!.result;
}
const count = (table: string, where = "true") =>
  scalar<number>(`select count(*)::int as result from ${table} where ${where}`);

interface Imported {
  company_id: string;
  created: boolean;
  attached: boolean;
  shared_created: boolean;
  shared_revision: number;
  company_revision: number;
  months: { period: string; revision: number; employee_count: number; replaced: boolean }[];
}
interface ImportCall {
  company?: string | null;
  newCompany?: unknown;
  setup?: unknown;
  expected?: unknown;
  months?: unknown;
}
const month = (period: string, more: Record<string, unknown> = {}) => ({
  period,
  employees: people(),
  expected_revision: 0,
  replace: false,
  ...more,
});
const importCompany = (user: string | null, c: ImportCall, role: Role = "authenticated") =>
  call<Imported>(
    user,
    "select public.import_payroll_company($1::uuid, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb) as result",
    [
      c.company === undefined ? ABC : c.company,
      c.newCompany === undefined ? null : JSON.stringify(c.newCompany),
      c.setup === undefined ? null : JSON.stringify(c.setup),
      c.expected === undefined
        ? JSON.stringify({ shared_revision: 1, company_revision: 1 })
        : JSON.stringify(c.expected),
      JSON.stringify(c.months ?? [month("2026-10-01")]),
    ],
    role,
  );

/** ABC and XYZ attached to S1 (revision 1 each); NEW has no setup. */
async function setUp(): Promise<void> {
  const as1 = (sql: string, params: unknown[]) => call(A, sql, params);
  await as1(
    "select public.save_payroll_shared_setup($1::uuid, 'Shared column setup', $2::jsonb, 0, '[]'::jsonb) as result",
    [S1, JSON.stringify(SHARED)],
  );
  for (const company of [ABC, XYZ]) {
    await as1("select public.attach_payroll_company($1::uuid, $2::uuid, $3::jsonb) as result", [
      company,
      S1,
      JSON.stringify(COMPANY),
    ]);
  }
}

beforeEach(async () => {
  if (!template) {
    db = await freshDatabase();
    await setUp();
    template = await db.dumpDataDir();
    await db.close();
  }
  db = new PGlite({ loadDataDir: template });
}, TIMEOUT);

describe("migration 0019: its own check", () => {
  it("answers one row, every column true", async () => {
    const sql = migrations.find((m) => m.name.startsWith("0019"))!.sql;
    const results = await db.exec(`set role migration_owner; ${sql}; reset role;`);
    const check = results.find((r) => r.fields.some((f) => f.name === "exists_once"))!;
    expect(check.rows).toHaveLength(1);
    expect(Object.values(check.rows[0]!).every((v) => v === true)).toBe(true);
  });

  it("only adds a function: no table, policy or other function is created or replaced", () => {
    const sql = migrations.find((m) => m.name.startsWith("0019"))!.sql.replace(/--.*$/gm, "");
    expect(sql.match(/create or replace function public\.(\w+)/g)).toEqual([
      "create or replace function public.import_payroll_company",
    ]);
    expect(sql).not.toMatch(
      /create\s+(table|policy|index)|alter\s+table|drop\s|insert\s+into|update\s+public|delete\s+from/i,
    );
  });
});

describe("who may import", () => {
  it("only someone signed in who is an admin of that company, or of any company for a new one", async () => {
    expect((await importCompany(V, {})).error).toContain("PH_NOT_ADMIN");
    expect(
      (await importCompany(O, { company: null, newCompany: { name: "Fake New Ltd", brn: "C9" } }))
        .error,
    ).toContain("PH_NOT_ADMIN");
    expect((await importCompany(null, {})).error).toContain("PH_NOT_SIGNED_IN");
    expect((await importCompany(null, {}, "anon")).error).toMatch(/permission denied/);
    expect(await count("public.payroll_months")).toBe(0);
    expect(await count("public.companies")).toBe(3);
  });

  it("checks who is calling before it looks at what was sent", async () => {
    expect((await importCompany(V, { months: [] })).error).toContain("PH_NOT_ADMIN");
    expect((await importCompany(A, { months: [] })).error).toContain("PH_INVALID_INPUT");
  });
});

describe("a company that exists", () => {
  it("adds its months in one step, worked out with its setup as it is now", async () => {
    const { result, error } = await importCompany(A, {
      months: [month("2026-07-01"), month("2026-08-01"), month("2026-09-01")],
    });
    expect(error).toBeNull();
    expect(result).toMatchObject({
      company_id: ABC,
      created: false,
      attached: false,
      shared_revision: 1,
      company_revision: 1,
    });
    expect(result!.months.map((m) => [m.period, m.revision, m.replaced])).toEqual([
      ["2026-07-01", 1, false],
      ["2026-08-01", 1, false],
      ["2026-09-01", 1, false],
    ]);
    expect(await count("public.payroll_months", `company_id = '${ABC}'`)).toBe(3);
  });

  it("replaces a saved month only when asked, as a new revision keeping the previous one", async () => {
    await importCompany(A, { months: [month("2026-10-01")] });
    // Not asked: refused, nothing changes.
    expect(
      (await importCompany(A, { months: [month("2026-10-01", { expected_revision: 1 })] })).error,
    ).toContain("PH_STALE");
    const { result } = await importCompany(A, {
      months: [
        month("2026-10-01", { expected_revision: 1, replace: true, employees: people(20000) }),
      ],
    });
    expect(result!.months).toEqual([
      { period: "2026-10-01", revision: 2, employee_count: 2, replaced: true },
    ]);
    expect(
      await scalar<boolean>(
        `select employees is not null as result from public.payroll_month_history where company_id = '${ABC}' and revision = 1`,
      ),
    ).toBe(true);
    expect(
      await scalar<string>(
        `select employees -> 0 -> 'values' ->> 'basicSalary' as result from public.payroll_months where company_id = '${ABC}'`,
      ),
    ).toBe("20000");
  });

  it("never replaces a month whose run is approved, and then stores nothing of the company", async () => {
    await importCompany(A, { months: [month("2026-10-01")] });
    await db.exec(
      `insert into public.payroll_runs (company_id, period, status) values ('${ABC}', '2026-10-01', 'approved')`,
    );
    const { error } = await importCompany(A, {
      months: [month("2026-11-01"), month("2026-10-01", { expected_revision: 1, replace: true })],
    });
    expect(error).toContain("PH_MONTH_APPROVED: 2026-10");
    // November, before it in the same call, was not stored either.
    expect(await count("public.payroll_months", `company_id = '${ABC}'`)).toBe(1);
    // A draft run does not protect the month; a run soft-deleted does not either.
    await db.exec(`update public.payroll_runs set status = 'draft' where company_id = '${ABC}'`);
    expect(
      (
        await importCompany(A, {
          months: [month("2026-10-01", { expected_revision: 1, replace: true })],
        })
      ).error,
    ).toBeNull();
  });

  it("an approved run does not stop a month that is not saved yet from being added", async () => {
    await db.exec(
      `insert into public.payroll_runs (company_id, period, status) values ('${ABC}', '2026-10-01', 'approved')`,
    );
    expect((await importCompany(A, { months: [month("2026-10-01")] })).error).toBeNull();
  });

  it("is refused as stale when its setup changed since the file was checked", async () => {
    expect(
      (await importCompany(A, { expected: { shared_revision: 2, company_revision: 1 } })).error,
    ).toContain("PH_STALE");
    expect((await importCompany(A, { expected: null })).error).toContain("PH_INVALID_INPUT");
    expect(await count("public.payroll_months")).toBe(0);
  });

  it("stores nothing when one month of it is refused", async () => {
    const { error } = await importCompany(A, {
      months: [month("2026-09-01"), month("2026-10-01", { employees: [{ id: "x" }] })],
    });
    expect(error).toContain("PH_INVALID_INPUT");
    expect(await count("public.payroll_months")).toBe(0);
  });

  it("gets a column setup when it has none yet (NEW), all or nothing with its months", async () => {
    const { result, error } = await importCompany(A, {
      company: NEW,
      expected: null,
      setup: { shared_setup_id: S1, create: false, company_body: COMPANY },
    });
    expect(error).toBeNull();
    expect(result).toMatchObject({
      company_id: NEW,
      created: false,
      attached: true,
      shared_created: false,
    });
    expect(await count("public.payroll_company_setups", `company_id = '${NEW}'`)).toBe(1);
    // A setup sent for a company that has one is refused.
    expect(
      (
        await importCompany(A, {
          setup: { shared_setup_id: S1, create: false, company_body: COMPANY },
        })
      ).error,
    ).toContain("PH_STALE");
  });
});

describe("a new company", () => {
  const NEW_CO = { name: "Fake Imported Ltd", brn: "C77", address: "7 Fake Road" };

  it("is created with its name, BRN and address, attached to an existing shared setup, with its months", async () => {
    const { result, error } = await importCompany(A, {
      company: null,
      newCompany: NEW_CO,
      expected: null,
      setup: {
        shared_setup_id: S1,
        create: false,
        company_body: { columns: [], customFields: [{ id: "x", label: "VAT", value: "1" }] },
      },
      months: [month("2026-09-01"), month("2026-10-01")],
    });
    expect(error).toBeNull();
    expect(result).toMatchObject({
      created: true,
      attached: true,
      shared_created: false,
      shared_setup_id: S1,
    });
    const id = result!.company_id;
    expect(
      await scalar<string>(
        `select name || '|' || brn || '|' || address as result from public.companies where id = '${id}'`,
      ),
    ).toBe("Fake Imported Ltd|C77|7 Fake Road");
    expect(
      await count(
        "public.company_members",
        `company_id = '${id}' and user_id = '${A}' and role = 'admin'`,
      ),
    ).toBe(1);
    expect(await count("public.payroll_months", `company_id = '${id}'`)).toBe(2);
  });

  it("can get a new shared setup made from the file", async () => {
    const { result } = await importCompany(A, {
      company: null,
      newCompany: NEW_CO,
      expected: null,
      setup: {
        shared_setup_id: S2,
        create: true,
        name: "Shared column setup",
        shared_body: SHARED,
        company_body: COMPANY,
      },
    });
    expect(result).toMatchObject({ created: true, shared_created: true, shared_setup_id: S2 });
    expect(await count("public.payroll_shared_setups", `id = '${S2}'`)).toBe(1);
  });

  it("is not created at all when anything of it fails: a BRN in use, a setup it may not join, a bad month", async () => {
    const before = await count("public.companies");
    // A BRN another company has (whatever the capitals).
    expect(
      (
        await importCompany(A, {
          company: null,
          newCompany: { ...NEW_CO, brn: " c1 " },
          expected: null,
          setup: { shared_setup_id: S1, create: false, company_body: COMPANY },
        })
      ).error,
    ).toContain("PH_DUPLICATE_BRN");
    // C is an admin of XYZ only: may not add a company to S1, which ABC uses too.
    expect(
      (
        await importCompany(C, {
          company: null,
          newCompany: NEW_CO,
          expected: null,
          setup: { shared_setup_id: S1, create: false, company_body: COMPANY },
        })
      ).error,
    ).toMatch(/PH_NOT_ADMIN|PH_FORBIDDEN|42501/);
    // A month that is refused.
    expect(
      (
        await importCompany(A, {
          company: null,
          newCompany: NEW_CO,
          expected: null,
          setup: {
            shared_setup_id: S2,
            create: true,
            name: "Shared column setup",
            shared_body: SHARED,
            company_body: COMPANY,
          },
          months: [month("2026-10-01", { employees: "not a list" })],
        })
      ).error,
    ).toContain("PH_INVALID_INPUT");
    // No setup at all for a new company.
    expect(
      (await importCompany(A, { company: null, newCompany: NEW_CO, expected: null })).error,
    ).toContain("PH_NOT_FOUND");
    expect(await count("public.companies")).toBe(before);
    expect(await count("public.payroll_shared_setups", `id = '${S2}'`)).toBe(0);
    expect(await count("public.company_members", `user_id = '${C}'`)).toBe(1);
  });

  it("needs exactly one of a company and a new company, and 1 to 24 months named once each", async () => {
    expect((await importCompany(A, { company: ABC, newCompany: NEW_CO })).error).toContain(
      "PH_INVALID_INPUT",
    );
    expect((await importCompany(A, { company: null })).error).toContain("PH_INVALID_INPUT");
    const many = Array.from({ length: 25 }, (_, i) =>
      month(`20${10 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}-01`),
    );
    expect((await importCompany(A, { months: many })).error).toContain("PH_INVALID_INPUT");
    expect(
      (await importCompany(A, { months: [month("2026-10-01"), month("2026-10-01")] })).error,
    ).toContain("PH_INVALID_INPUT");
    expect((await importCompany(A, { months: [month("2026-10-15")] })).error).toContain(
      "PH_INVALID_INPUT",
    );
  });
});
