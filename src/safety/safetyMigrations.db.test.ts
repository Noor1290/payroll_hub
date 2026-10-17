// @vitest-environment node
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STORAGE_STAND_IN } from "@/test/storageStandIn";

/**
 * Migrations 0015 (keep_awake) and 0016 (a new shared setup needs an admin of at least one
 * company), run after 0001 to 0014 in a real Postgres (PGlite), used the way the Data API does:
 * as the role "authenticated" (or "anon") with a user id in the request claims.
 *
 * Fake data only.
 */
const files = import.meta.glob<string>("../../supabase/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const migrations = Object.entries(files)
  .map(([path, sql]) => ({ name: path.split("/").pop()!, sql }))
  .sort((a, b) => a.name.localeCompare(b.name));
const file = (prefix: string) => migrations.find((m) => m.name.startsWith(prefix))!.sql.replace(/\r\n/g, "\n");

const A = "00000000-0000-4000-8000-0000000000a1"; // admin of ABC
const V = "00000000-0000-4000-8000-0000000000a2"; // viewer of ABC, admin of nothing
const O = "00000000-0000-4000-8000-0000000000a3"; // member of nothing
const F = "00000000-0000-4000-8000-0000000000a4"; // the owner of a brand-new dashboard
const ABC = "10000000-0000-4000-8000-000000000001";
const FIRST = "10000000-0000-4000-8000-000000000002";
const S1 = "30000000-0000-4000-8000-000000000001";
const S2 = "30000000-0000-4000-8000-000000000002";
const S3 = "30000000-0000-4000-8000-000000000003";
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
  ${STORAGE_STAND_IN}
`;

const SEED = `
  insert into auth.users (id) values ('${A}'), ('${V}'), ('${O}'), ('${F}');
  insert into public.companies (id, name, brn) values ('${ABC}', 'ABC Co Ltd', 'C1');
  insert into public.company_members (company_id, user_id, role) values
    ('${ABC}', '${A}', 'admin'), ('${ABC}', '${V}', 'viewer');
`;

async function freshDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SUPABASE_STAND_INS);
  for (const { sql } of migrations) await db.exec(`set role migration_owner; ${sql}; reset role;`);
  await db.exec(SEED);
  return db;
}

type Role = "authenticated" | "anon";

async function call<T>(db: PGlite, user: string | null, sql: string, params: unknown[] = [], role: Role = "authenticated") {
  await db.exec(`set role ${role}`);
  await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(user ? { sub: user, role } : { role })]);
  try {
    const { rows } = await db.query<{ result: T }>(sql, params);
    return { result: rows[0]?.result as T, error: null };
  } catch (error) {
    const { code, message } = error as { code?: string; message?: string };
    return { result: null, error: `${code} ${message}` };
  } finally {
    await db.exec("reset role; select set_config('request.jwt.claims', '', false);");
  }
}

const saveShared = (db: PGlite, user: string | null, id: string, expected = 0, name = "Shared column setup", role: Role = "authenticated") =>
  call<{ shared_setup_id: string; revision: number }>(
    db,
    user,
    "select public.save_payroll_shared_setup($1::uuid, $2, $3::jsonb, $4::int, '[]'::jsonb) as result",
    [id, name, JSON.stringify({ globalColumns: [] }), expected],
    role,
  );

const setups = async (db: PGlite) =>
  (await db.query<{ n: number }>("select count(*)::int as n from public.payroll_shared_setups")).rows[0]!.n;

/** The last single-row result of running a migration file: its verification row. */
async function verificationRow(db: PGlite, sql: string): Promise<Record<string, unknown>> {
  const results = await db.exec(`set role migration_owner; ${sql}; reset role;`);
  return results.filter((r) => r.rows.length === 1 && r.fields.length > 3).at(-1)!.rows[0] as Record<string, unknown>;
}

describe("the two migrations' own checks", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDatabase();
  }, SETUP_TIMEOUT);
  afterAll(() => db.close());

  for (const prefix of ["0015", "0016"]) {
    it(`${prefix} ends with one row in which every column is true, and can be run again`, async () => {
      const row = await verificationRow(db, file(prefix));
      expect(Object.keys(row).length).toBeGreaterThanOrEqual(6);
      for (const [column, value] of Object.entries(row)) expect(value, column).toBe(true);
    });
  }
});

describe("0015: keep_awake()", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDatabase();
  }, SETUP_TIMEOUT);
  afterAll(() => db.close());

  it("answers true to the anon key and to a signed-in user", async () => {
    expect(await call(db, null, "select public.keep_awake() as result", [], "anon")).toEqual({ result: true, error: null });
    expect(await call(db, O, "select public.keep_awake() as result")).toEqual({ result: true, error: null });
  });

  it("only adds that one function", () => {
    const sql = file("0015").replace(/--.*$/gm, "");
    expect([...sql.matchAll(/create (?:or replace )?(\w+)/g)].map((m) => m[1])).toEqual(["function"]);
    expect(sql).not.toMatch(/\b(drop|alter|truncate|delete\s+from|update\s+public|insert\s+into)\b/i);
    expect(sql.match(/\$\$[\s\S]*?\$\$/g)).toEqual(["$$\n  select true;\n$$"]);
  });

  it("leaves every other function closed to anon", async () => {
    const { rows } = await db.query<{ name: string }>(`
      select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')`);
    expect(rows.map((row) => row.name)).toEqual(["keep_awake"]);
  });
});

describe("0016: a new shared setup needs an admin of at least one company", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDatabase();
  }, SETUP_TIMEOUT);
  afterAll(() => db.close());

  it("refuses someone who belongs to no company, and stores nothing", async () => {
    expect((await saveShared(db, O, S1)).error).toMatch(/^42501 PH_NOT_ADMIN/);
    expect(await setups(db)).toBe(0);
  });

  it("refuses someone who is only a viewer, and stores nothing", async () => {
    expect((await saveShared(db, V, S1)).error).toMatch(/^42501 PH_NOT_ADMIN/);
    expect(await setups(db)).toBe(0);
  });

  it("refuses before looking at the input: a bad name still gets PH_NOT_ADMIN (the safety check relies on it)", async () => {
    expect((await saveShared(db, O, S1, 0, "")).error).toMatch(/^42501 PH_NOT_ADMIN/);
    // An admin with the same bad input is told about the input.
    expect((await saveShared(db, A, S1, 0, "")).error).toMatch(/PH_INVALID_INPUT/);
  });

  it("still refuses anon outright", async () => {
    expect((await saveShared(db, null, S1, 0, "x", "anon")).error).toMatch(/permission denied/);
  });

  it("lets an admin create one, as before", async () => {
    expect((await saveShared(db, A, S1)).result).toMatchObject({ shared_setup_id: S1, revision: 1 });
    expect(await setups(db)).toBe(1);
  });

  it("keeps the first company, then first setup flow working", async () => {
    // A brand-new dashboard: the owner creates the first company and their admin membership in
    // the SQL editor (the first-time setup block of 0001), then works in the dashboard.
    await db.exec(`
      insert into public.companies (id, name, brn) values ('${FIRST}', 'First Co Ltd', 'C9');
      insert into public.company_members (company_id, user_id, role) values ('${FIRST}', '${F}', 'admin');
    `);
    expect((await saveShared(db, F, S2)).result).toMatchObject({ shared_setup_id: S2, revision: 1 });
    const attached = await call<{ revision: number }>(
      db,
      F,
      "select public.attach_payroll_company($1::uuid, $2::uuid, '{\"columns\":[]}'::jsonb) as result",
      [FIRST, S2],
    );
    expect(attached.error).toBeNull();
    expect((await saveShared(db, F, S2, 1, "Renamed")).result).toMatchObject({ revision: 2 });
  });

  it("leaves changing an existing setup as it was: its creator may change it while nothing is attached, even with no admin role left", async () => {
    expect((await saveShared(db, A, S3)).error).toBeNull();
    await db.exec(`delete from public.company_members where user_id = '${A}'`);
    expect((await saveShared(db, A, S3, 1, "Changed")).result).toMatchObject({ revision: 2 });
    // ...but cannot create another one.
    expect((await saveShared(db, A, "30000000-0000-4000-8000-000000000004")).error).toMatch(/PH_NOT_ADMIN/);
    // Someone else still cannot see or change it ("not found", as in 0013).
    expect((await saveShared(db, O, S3, 2)).error).toMatch(/PH_NOT_FOUND/);
  });

  it("is the 0013 function plus the two blocks marked 0016, and nothing else", () => {
    const extract = (sql: string) =>
      sql.slice(
        sql.indexOf("create or replace function public.save_payroll_shared_setup("),
        sql.indexOf("\n", sql.indexOf("grant execute on function public.save_payroll_shared_setup(") + 70) + 1,
      );
    const without0016 = extract(file("0016")).replace(
      /\n *-- ---------- 0016:[\s\S]*?-- ---------- end of 0016 ----------\n/g,
      "\n",
    );
    expect(without0016.replace(/\n\n\n/g, "\n\n")).toBe(extract(file("0013")));
    const replaced = [...file("0016").matchAll(/create or replace function public\.(\w+)/g)].map((m) => m[1]);
    expect(replaced).toEqual(["save_payroll_shared_setup"]);
    expect(file("0016").replace(/--.*$/gm, "")).not.toMatch(/\b(drop|alter|truncate)\b/i);
  });
});
