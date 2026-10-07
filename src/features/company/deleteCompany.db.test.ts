// @vitest-environment node
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Runs the real migration files in a real Postgres (PGlite: Postgres compiled to run inside
 * Node, nothing to install or start) and calls public.delete_company the way the Data API
 * does. If a later change weakens the function, these fail.
 *
 * What stands in for Supabase here, because PGlite is plain Postgres:
 *   - the roles "anon" and "authenticated" (real roles, created below);
 *   - auth.users (a table with only an id) and auth.uid() (Supabase's own definition, reading
 *     the same request.jwt.claims setting the Data API sets);
 *   - the Data API itself: a call is "set role" plus that setting, on one connection.
 * The migrations are run by a role that is not a superuser, like "postgres" on Supabase, so
 * SECURITY DEFINER gives the function an ordinary owner's rights, not unlimited ones.
 *
 * Not covered: Supabase's sign-in and JWT checking, and two sessions at once (PGlite has one
 * connection). Those are checked on the real project: README, "Test the security yourself".
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

const A = "00000000-0000-4000-8000-0000000000a1"; // admin of ABC, viewer of XYZ
const V = "00000000-0000-4000-8000-0000000000a2"; // viewer of ABC
const O = "00000000-0000-4000-8000-0000000000a3"; // member of nothing
const B = "00000000-0000-4000-8000-0000000000a4"; // admin of XYZ only
const ABC = "10000000-0000-4000-8000-000000000001";
const XYZ = "10000000-0000-4000-8000-000000000002";
const FUNCTION = "public.delete_company(uuid, text)";
/** Starting a database and running the migrations takes a few seconds on a slow machine. */
const SETUP_TIMEOUT = 120_000;

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
`;

/**
 * Two companies. ABC has a draft run, an approved run, a soft-deleted approved run and a
 * soft-deleted draft run, a soft-deleted employee, details (one sensitive) and links.
 */
const SEED = `
  insert into auth.users (id) values ('${A}'), ('${V}'), ('${O}'), ('${B}');
  insert into public.companies (id, name, brn) values
    ('${ABC}', 'ABC Co Ltd', 'C1'), ('${XYZ}', 'XYZ Trading Ltd', 'C2');
  insert into public.company_members (company_id, user_id, role) values
    ('${ABC}', '${A}', 'admin'), ('${ABC}', '${V}', 'viewer'),
    ('${XYZ}', '${B}', 'admin'), ('${XYZ}', '${A}', 'viewer');

  insert into public.employees (id, company_id, national_id, surname, deleted_at) values
    ('30000000-0000-4000-8000-000000000001', '${ABC}', 'X1', 'DOE', null),
    ('30000000-0000-4000-8000-000000000002', '${ABC}', 'X2', 'SAMPLE', null),
    ('30000000-0000-4000-8000-000000000003', '${ABC}', 'X3', 'DEPARTED', now()),
    ('30000000-0000-4000-8000-000000000009', '${XYZ}', 'Y1', 'OTHER', null);
  insert into public.payroll_runs (id, company_id, period, status, deleted_at) values
    ('20000000-0000-4000-8000-000000000001', '${ABC}', '2026-09-01', 'draft', null),
    ('20000000-0000-4000-8000-000000000002', '${ABC}', '2026-08-01', 'approved', null),
    ('20000000-0000-4000-8000-000000000003', '${ABC}', '2026-03-01', 'approved', now()),
    ('20000000-0000-4000-8000-000000000004', '${ABC}', '2026-02-01', 'draft', now()),
    ('20000000-0000-4000-8000-000000000009', '${XYZ}', '2026-09-01', 'approved', null);
  insert into public.payroll_entries (run_id, employee_id, net_pay) values
    ('20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 100),
    ('20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002', 100),
    ('20000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000001', 100),
    ('20000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000003', 100),
    ('20000000-0000-4000-8000-000000000004', '30000000-0000-4000-8000-000000000003', 100),
    ('20000000-0000-4000-8000-000000000009', '30000000-0000-4000-8000-000000000009', 100);
  insert into public.company_details (company_id, label, value, is_sensitive) values
    ('${ABC}', 'Tax office', 'Port Louis', false), ('${ABC}', 'Reference', 'R-1', true),
    ('${XYZ}', 'Tax office', 'Curepipe', false);
  insert into public.company_links (company_id, title, url) values
    ('${ABC}', 'Tax portal', 'https://example.org/tax'),
    ('${ABC}', 'Bank', 'https://example.org/bank'),
    ('${XYZ}', 'Tax portal', 'https://example.org/tax');
`;
const SEEDED = {
  companies: 2,
  company_members: 4,
  employees: 4,
  payroll_runs: 5,
  payroll_entries: 6,
  company_details: 3,
  company_links: 3,
};

/** A new database with the migrations up to and including the given number, and the seed. */
async function freshDatabase(upTo: number): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SUPABASE_STAND_INS);
  for (const migration of migrations) {
    if (Number(migration.name.slice(0, 4)) > upTo) continue;
    await db.exec(`set role migration_owner; ${migration.sql}; reset role;`);
  }
  await db.exec(SEED);
  return db;
}

type Outcome = { result: unknown; error: null } | { result: null; error: string };

/** Runs something as a role with the claims of a signed-in user (or of nobody). */
async function as<T>(
  db: PGlite,
  role: "authenticated" | "anon",
  user: string | null,
  work: () => Promise<T>,
): Promise<{ result: T; error: null } | { result: null; error: string }> {
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

/** Calls the function directly, with no dashboard in between. */
function call(
  db: PGlite,
  role: "authenticated" | "anon",
  user: string | null,
  name: string | null,
  company = ABC,
): Promise<Outcome> {
  return as(db, role, user, async () => {
    const { rows } = await db.query<{ result: unknown }>(
      "select public.delete_company($1::uuid, $2) as result",
      [company, name],
    );
    return rows[0]!.result;
  });
}

async function count(db: PGlite, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await db.query<{ n: number }>(sql, params);
  return rows[0]!.n;
}

/** How many rows each table holds. */
async function snapshot(db: PGlite): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of Object.keys(SEEDED)) {
    out[table] = await count(db, `select count(*)::int as n from public.${table}`);
  }
  return out;
}

/**
 * Rows a company still has, per table. The tables are not listed here: they are found from
 * the catalogue, as every table with a foreign key to companies, so a new one is included.
 */
async function leftovers(db: PGlite, company: string): Promise<Record<string, number>> {
  const { rows } = await db.query<{ tbl: string; col: string }>(`
    select c.conrelid::regclass::text as tbl, a.attname as col
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.confrelid = 'public.companies'::regclass
    order by 1`);
  const out: Record<string, number> = {};
  for (const { tbl, col } of rows) {
    out[tbl] = await count(db, `select count(*)::int as n from ${tbl} where ${col} = $1`, [
      company,
    ]);
  }
  out.companies = await count(db, "select count(*)::int as n from public.companies where id = $1", [
    company,
  ]);
  return out;
}

describe("delete_company before migration 0007", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDatabase(6);
  }, SETUP_TIMEOUT);
  afterAll(() => db?.close());

  it("refused this company because of its approved runs (the rule 0007 removes)", async () => {
    const { error } = await call(db, "authenticated", A, "ABC Co Ltd");
    expect(error).toMatch(/P0001 PH_HAS_APPROVED_RUNS/);
  });
});

describe("delete_company refusals (migration 0007)", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDatabase(7);
  }, SETUP_TIMEOUT);
  afterAll(() => db?.close());

  it("starts from the seeded rows, in every table that references companies", async () => {
    expect(await snapshot(db)).toEqual(SEEDED);
    expect(Object.keys(await leftovers(db, ABC)).sort()).toEqual([
      "companies",
      "company_details",
      "company_links",
      "company_members",
      "employees",
      "payroll_runs",
    ]);
  });

  it.each([
    ["a viewer of the company", "authenticated", V, /42501 PH_NOT_ADMIN/],
    ["a user who belongs to nothing", "authenticated", O, /42501 PH_NOT_ADMIN/],
    ["an admin of a different company", "authenticated", B, /42501 PH_NOT_ADMIN/],
    ["a signed-in role with no user id", "authenticated", null, /42501 PH_NOT_SIGNED_IN/],
    ["the anon role", "anon", null, /permission denied for function delete_company/],
    [
      "the anon role carrying an admin's id",
      "anon",
      A,
      /permission denied for function delete_company/,
    ],
  ] as const)("refuses %s, even with the right name", async (_who, role, user, expected) => {
    const { error } = await call(db, role, user, "ABC Co Ltd");
    expect(error).toMatch(expected);
    expect(await snapshot(db)).toEqual(SEEDED);
  });

  it("refuses an admin of ABC deleting XYZ, where they are only a viewer", async () => {
    const { error } = await call(db, "authenticated", A, "XYZ Trading Ltd", XYZ);
    expect(error).toMatch(/42501 PH_NOT_ADMIN/);
    expect(await snapshot(db)).toEqual(SEEDED);
  });

  it("gives the same answer for a company id that does not exist", async () => {
    const missing = "10000000-0000-4000-8000-00000000dead";
    const { error } = await call(db, "authenticated", A, "x", missing);
    expect(error).toMatch(/42501 PH_NOT_ADMIN/);
  });

  it.each([
    "abc co ltd",
    "ABC CO LTD",
    "ABC Co Ltd.",
    "ABC Co Lt",
    "ABC  Co Ltd",
    "XYZ Trading Ltd",
    "",
    "   ",
    null,
  ])("refuses an admin calling it directly with the wrong name %j", async (wrong) => {
    const { error } = await call(db, "authenticated", A, wrong);
    expect(error).toMatch(/22023 PH_NAME_MISMATCH/);
    expect(await snapshot(db)).toEqual(SEEDED);
  });

  it("left every row in place after all of those refusals", async () => {
    expect(await snapshot(db)).toEqual(SEEDED);
  });

  it.each([
    [`delete from public.companies where id = '${ABC}'`, "companies"],
    [`delete from public.company_members where company_id = '${ABC}'`, "company_members"],
  ])("still gives an admin no direct delete: %s", async (statement, table) => {
    const { error } = await as(db, "authenticated", A, () => db.exec(statement));
    expect(error).toContain(`permission denied for table ${table}`);
    expect(await snapshot(db)).toEqual(SEEDED);
  });

  describe("the function's own privileges", () => {
    const privileges = async () => {
      const { rows } = await db.query<{
        anon: boolean;
        authenticated: boolean;
        definer: boolean;
        config: string[];
        acl: string;
        owner_is_superuser: boolean;
      }>(`
        select
          has_function_privilege('anon', '${FUNCTION}', 'execute') as anon,
          has_function_privilege('authenticated', '${FUNCTION}', 'execute') as authenticated,
          p.prosecdef as definer, p.proconfig as config, p.proacl::text as acl,
          r.rolsuper as owner_is_superuser
        from pg_proc p join pg_roles r on r.oid = p.proowner
        where p.oid = '${FUNCTION}'::regprocedure`);
      return rows[0]!;
    };

    it("can be executed by authenticated, not by anon", async () => {
      const { anon, authenticated } = await privileges();
      expect(authenticated).toBe(true);
      expect(anon).toBe(false);
    });

    it("is not granted to PUBLIC", async () => {
      // A grant to PUBLIC shows in the access list as an entry with nothing before "=".
      expect((await privileges()).acl).not.toMatch(/(^|[{,])=X/);
    });

    it("is SECURITY DEFINER with an empty search_path, owned by an ordinary role", async () => {
      const { definer, config, owner_is_superuser } = await privileges();
      expect(definer).toBe(true);
      expect(config).toEqual(['search_path=""']);
      expect(owner_is_superuser).toBe(false);
    });

    it("exists exactly once", async () => {
      const sql = "select count(*)::int as n from pg_proc where proname = 'delete_company'";
      expect(await count(db, sql)).toBe(1);
    });

    it("is the same after running 0007 a second time", async () => {
      const before = await privileges();
      const again = migrations.find((m) => m.name === "0007_delete_company_any_runs.sql")!;
      await db.exec(`set role migration_owner; ${again.sql}; reset role;`);
      expect(await privileges()).toEqual(before);
      const sql = "select count(*)::int as n from pg_proc where proname = 'delete_company'";
      expect(await count(db, sql)).toBe(1);
    });
  });
});

describe("delete_company is all or nothing (migration 0007)", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDatabase(7);
  }, SETUP_TIMEOUT);
  afterAll(() => db?.close());

  it("rolls everything back when its last step fails", async () => {
    // Something the function does not know about still points at the company and refuses
    // to let it go, so deleting the company row (the last step) fails.
    await db.exec(`
      create table public.zz_blocker (
        company_id uuid references public.companies(id) on delete restrict
      );
      insert into public.zz_blocker values ('${ABC}');`);

    const { error } = await call(db, "authenticated", A, "ABC Co Ltd");
    expect(error).toMatch(/23001|23503/);

    await db.exec("drop table public.zz_blocker");
    expect(await snapshot(db)).toEqual(SEEDED);
  });
});

describe("delete_company deleting (migration 0007)", () => {
  let db: PGlite;
  let outcome: Outcome;
  beforeAll(async () => {
    db = await freshDatabase(7);
    // The name is passed with spaces around it: only those are ignored.
    outcome = await call(db, "authenticated", A, "  ABC Co Ltd  ");
  }, SETUP_TIMEOUT);
  afterAll(() => db?.close());

  it("lets an admin delete a company that has approved runs, one of them soft-deleted", () => {
    expect(outcome.error).toBeNull();
  });

  it("returns the counts of what it deleted, and nothing else", () => {
    expect(outcome.result).toEqual({
      company_id: ABC,
      entries: 5,
      runs: 4,
      employees: 3,
      details: 2,
      links: 2,
      members: 2,
    });
  });

  it("leaves nothing behind in any table that references companies", async () => {
    const left = await leftovers(db, ABC);
    expect(Object.keys(left).length).toBeGreaterThanOrEqual(6);
    for (const [table, rows] of Object.entries(left)) {
      expect(rows, `rows left in ${table}`).toBe(0);
    }
  });

  it("leaves no entries of the company (only the other company's one remains)", async () => {
    expect(await count(db, "select count(*)::int as n from public.payroll_entries")).toBe(1);
  });

  it("leaves no entry pointing at a missing run or employee", async () => {
    const orphans = await count(
      db,
      `select count(*)::int as n from public.payroll_entries e
       where not exists (select 1 from public.payroll_runs r where r.id = e.run_id)
          or not exists (select 1 from public.employees p where p.id = e.employee_id)`,
    );
    expect(orphans).toBe(0);
  });

  it("does not touch the other company", async () => {
    expect(await snapshot(db)).toEqual({
      companies: 1,
      company_members: 2,
      employees: 1,
      payroll_runs: 1,
      payroll_entries: 1,
      company_details: 1,
      company_links: 1,
    });
  });

  it("refuses to delete it a second time", async () => {
    const { error } = await call(db, "authenticated", A, "ABC Co Ltd");
    expect(error).toMatch(/42501 PH_NOT_ADMIN/);
  });
});
