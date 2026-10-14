// @vitest-environment node
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STORAGE_STAND_IN } from "@/test/storageStandIn";

/**
 * Runs migrations 0001 to 0013 in a real Postgres (PGlite) and uses 0013 the way the Data API
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
const B = "00000000-0000-4000-8000-0000000000a4"; // admin of XYZ only
const D = "00000000-0000-4000-8000-0000000000a5"; // admin of OTHER, viewer of ABC
const ABC = "10000000-0000-4000-8000-000000000001";
const XYZ = "10000000-0000-4000-8000-000000000002";
const NEW = "10000000-0000-4000-8000-000000000003";
const OTHER = "10000000-0000-4000-8000-000000000004";
const S1 = "30000000-0000-4000-8000-000000000001";
const S2 = "30000000-0000-4000-8000-000000000002";
const SETUP_TIMEOUT = 120_000;

// What the payroll app sends: the identity fields, the ID field and the Global columns.
const SHARED = {
  identityFields: [{ id: "f1", key: "employeeId", name: "ID" }],
  idFieldKey: "employeeId",
  globalColumns: [
    {
      id: "c1",
      key: "basicSalary",
      name: "Basic Salary",
      type: "input",
      category: "earnings",
      valueType: "number",
      decimals: 2,
    },
    {
      id: "c2",
      key: "employeeCsg",
      name: "Employee CSG",
      type: "formula",
      formula: "basicSalary * 0.015",
      category: "deductions",
      decimals: 2,
    },
  ],
};
const COMPANY = { columns: [], customFields: [] };

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
  insert into auth.users (id) values ('${A}'), ('${V}'), ('${O}'), ('${B}'), ('${D}');
  insert into public.companies (id, name, brn) values
    ('${ABC}', 'ABC Co Ltd', 'C1'), ('${XYZ}', 'XYZ Trading Ltd', 'C2'),
    ('${NEW}', 'New Venture Ltd', 'C3'), ('${OTHER}', 'Other Co Ltd', 'C4');
  insert into public.company_members (company_id, user_id, role) values
    ('${ABC}', '${A}', 'admin'), ('${XYZ}', '${A}', 'admin'), ('${NEW}', '${A}', 'admin'),
    ('${ABC}', '${V}', 'viewer'),
    ('${XYZ}', '${B}', 'admin'),
    ('${OTHER}', '${D}', 'admin'), ('${ABC}', '${D}', 'viewer');
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

interface SharedSave {
  id?: string;
  name?: string;
  body?: unknown;
  expected?: number;
  companies?: unknown;
}
interface SharedSaved {
  shared_setup_id: string;
  revision: number;
  companies: { company_id: string; revision: number }[];
}
const saveShared = (
  db: PGlite,
  user: string | null,
  s: SharedSave = {},
  role: Role = "authenticated",
) =>
  one<SharedSaved>(
    db,
    user,
    "select public.save_payroll_shared_setup($1::uuid, $2, $3::jsonb, $4::int, $5::jsonb) as result",
    [
      s.id ?? S1,
      s.name ?? "Shared column setup",
      JSON.stringify(s.body ?? SHARED),
      s.expected ?? 0,
      JSON.stringify(s.companies ?? []),
    ],
    role,
  );

const attach = (
  db: PGlite,
  user: string | null,
  company: string,
  shared = S1,
  body: unknown = COMPANY,
) =>
  one<{ revision: number; shared_setup_id: string }>(
    db,
    user,
    "select public.attach_payroll_company($1::uuid, $2::uuid, $3::jsonb) as result",
    [company, shared, JSON.stringify(body)],
  );

const saveCompany = (
  db: PGlite,
  user: string | null,
  company: string,
  expected: number,
  body: unknown = COMPANY,
) =>
  one<{ revision: number }>(
    db,
    user,
    "select public.save_payroll_company_setup($1::uuid, $2::jsonb, $3::int) as result",
    [company, JSON.stringify(body), expected],
  );

const access = (db: PGlite, user: string, shared = S1) =>
  one<{ can_change: boolean; companies: number; admin_of: number }>(
    db,
    user,
    "select public.payroll_shared_setup_access($1::uuid) as result",
    [shared],
  );

const seenShared = async (db: PGlite, user: string | null, role: Role = "authenticated") =>
  one<number>(
    db,
    user,
    "select count(*)::int as result from public.payroll_shared_setups",
    [],
    role,
  );

describe("migration 0013: its own check", () => {
  it(
    "ends with one row in which every column is true, and can be run again",
    async () => {
      const db = await freshDatabase();
      const sql = migrations.find((m) => m.name.startsWith("0013"))!.sql;
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
      .find((m) => m.name.startsWith("0013"))!
      .sql.replace(/\r\n/g, "\n")
      .replace(/--.*$/gm, "");
    expect(sql).not.toMatch(/\bdrop\s+(table|column|schema|index|function|type)\b/i);
    expect(sql).not.toMatch(
      /\balter\s+table\s+public\.(?!payroll_shared_setups|payroll_shared_setup_history|payroll_company_setups|payroll_company_setup_history)/i,
    );
    // ("truncate" does appear, as a privilege name in the verification query.)
    expect(sql).not.toMatch(/\btruncate\s+(table\s+)?\w+\./i);
    // The only "create or replace" of something that existed before is delete_company.
    const replaced = [...sql.matchAll(/create or replace function public\.(\w+)/g)].map(
      (m) => m[1],
    );
    expect(replaced.sort()).toEqual([
      "attach_payroll_company",
      "can_change_payroll_shared_setup",
      "can_read_payroll_shared_setup",
      "delete_company",
      "payroll_shared_setup_access",
      "save_payroll_company_setup",
      "save_payroll_shared_setup",
    ]);
    // Deletes and updates only inside functions.
    const outside = sql.replace(/\$\$[\s\S]*?\$\$/g, "");
    expect(outside).not.toMatch(/\b(delete\s+from|update)\s+public\./i);
    // Revisions are never dropped: Phase 3 months will point at them.
    const bodies = sql.match(/\$\$[\s\S]*?\$\$/g)!.join("\n");
    expect(bodies).not.toMatch(
      /delete\s+from\s+public\.payroll_(shared|company)_setup_history[^;]*revision/i,
    );
  });
});

describe("a new shared setup", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDatabase();
  }, SETUP_TIMEOUT);
  afterAll(() => db.close());

  it("needs someone signed in", async () => {
    expect((await saveShared(db, null, {}, "anon")).error).toMatch(/permission denied/);
    expect(await count(db, "public.payroll_shared_setups")).toBe(0);
  });

  it("refuses bad input: name, body, size, revision, companies", async () => {
    const bad: [SharedSave, RegExp][] = [
      [{ name: "  " }, /PH_INVALID_INPUT/],
      [{ name: "x".repeat(81) }, /PH_INVALID_INPUT/],
      [{ body: [1] }, /PH_INVALID_INPUT/],
      [{ body: { text: "x".repeat(263_000) } }, /PH_TOO_LARGE/],
      [{ expected: -1 }, /PH_INVALID_INPUT/],
      [{ companies: {} }, /PH_INVALID_INPUT/],
      [{ companies: [{ body: {}, expected_revision: 1 }] }, /PH_INVALID_INPUT/],
      [{ companies: [{ company_id: ABC, body: {} }] }, /PH_INVALID_INPUT/],
      [{ companies: [{ company_id: ABC, body: [], expected_revision: 1 }] }, /PH_INVALID_INPUT/],
      [{ companies: [{ company_id: ABC, body: {}, expected_revision: 0 }] }, /PH_INVALID_INPUT/],
      [{ companies: [{ company_id: ABC, body: {}, expected_revision: 1 }] }, /PH_INVALID_INPUT/],
      [{ expected: 3 }, /PH_NOT_FOUND/],
    ];
    for (const [input, error] of bad) {
      expect((await saveShared(db, A, input)).error, JSON.stringify(input).slice(0, 80)).toMatch(
        error,
      );
    }
    expect(await count(db, "public.payroll_shared_setups")).toBe(0);
  });

  it("is created at revision 1 with the id the app chose, the body stored exactly, and the revision kept", async () => {
    const saved = await saveShared(db, A);
    expect(saved.error).toBeNull();
    expect(saved.result).toMatchObject({ shared_setup_id: S1, revision: 1, companies: [] });
    expect(
      await scalar(db, "select body as result from public.payroll_shared_setups where id = $1", [
        S1,
      ]),
    ).toEqual(SHARED);
    expect(
      await count(db, "public.payroll_shared_setup_history", `shared_setup_id = '${S1}'`),
    ).toBe(1);
  });

  it("stores the same save once when it is sent twice", async () => {
    expect((await saveShared(db, A)).error).toMatch(/PH_STALE/);
    expect(await count(db, "public.payroll_shared_setups")).toBe(1);
  });

  it("before any company is attached, only its creator can see or change it", async () => {
    expect((await seenShared(db, A)).result).toBe(1);
    for (const user of [V, O, B, D]) expect((await seenShared(db, user)).result, user).toBe(0);
    expect((await seenShared(db, null, "anon")).error).toMatch(/permission denied/);
    expect((await saveShared(db, B, { expected: 1, body: { taken: true } })).error).toMatch(
      /PH_NOT_FOUND/,
    );
    expect((await access(db, B)).result).toEqual({ can_change: false, companies: 0, admin_of: 0 });
    expect((await access(db, A)).result).toEqual({ can_change: true, companies: 0, admin_of: 0 });
  });
});

describe("attaching companies, and who may read and change the shared setup", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDatabase();
    await saveShared(db, A);
  }, SETUP_TIMEOUT);
  afterAll(() => db.close());

  it("attaching needs an admin of the company who may also change the shared setup", async () => {
    expect((await attach(db, V, ABC)).error).toMatch(/PH_NOT_ADMIN/); // viewer of ABC
    expect((await attach(db, O, ABC)).error).toMatch(/PH_NOT_ADMIN/);
    expect((await attach(db, B, XYZ)).error).toMatch(/PH_NOT_FOUND/); // admin of XYZ, cannot see S1
    expect((await attach(db, A, OTHER)).error).toMatch(/PH_NOT_ADMIN/); // not a member of OTHER
    expect((await attach(db, A, ABC, S2)).error).toMatch(/PH_NOT_FOUND/);
    expect(await count(db, "public.payroll_company_setups")).toBe(0);

    const attached = await attach(db, A, ABC);
    expect(attached.error).toBeNull();
    expect(attached.result).toMatchObject({ revision: 1, shared_setup_id: S1 });
    expect(await count(db, "public.payroll_company_setup_history", `company_id = '${ABC}'`)).toBe(
      1,
    );
  });

  it("a company is attached once: a second attach is refused, never a second row", async () => {
    expect((await attach(db, A, ABC)).error).toMatch(/PH_ALREADY_ATTACHED/);
    await saveShared(db, A, { id: S2 });
    expect((await attach(db, A, ABC, S2)).error).toMatch(/PH_ALREADY_ATTACHED/);
    expect(await count(db, "public.payroll_company_setups", `company_id = '${ABC}'`)).toBe(1);
  });

  it("once a company is attached, any of its members can read the shared setup and its revisions", async () => {
    expect((await seenShared(db, V)).result).toBe(1); // viewer of ABC: S1 only
    expect((await seenShared(db, D)).result).toBe(1);
    expect((await seenShared(db, O)).result).toBe(0);
    expect((await seenShared(db, B)).result).toBe(0); // XYZ is not attached yet
    expect(
      (
        await one<number>(
          db,
          V,
          "select count(*)::int as result from public.payroll_shared_setup_history",
        )
      ).result,
    ).toBe(1);
    expect(
      (
        await one<number>(
          db,
          O,
          "select count(*)::int as result from public.payroll_shared_setup_history",
        )
      ).result,
    ).toBe(0);
    expect(
      (
        await one<number>(
          db,
          V,
          "select count(*)::int as result from public.payroll_company_setups",
        )
      ).result,
    ).toBe(1);
    expect(
      (
        await one<number>(
          db,
          B,
          "select count(*)::int as result from public.payroll_company_setups",
        )
      ).result,
    ).toBe(0);
  });

  it("an admin of some but not all attached companies can read it, and cannot change it or attach to it", async () => {
    expect((await attach(db, A, XYZ)).error).toBeNull();
    // B is an admin of XYZ only; ABC is attached too.
    expect((await seenShared(db, B)).result).toBe(1);
    expect((await access(db, B)).result).toEqual({ can_change: false, companies: 2, admin_of: 1 });
    expect((await saveShared(db, B, { expected: 1, body: { changed: "by B" } })).error).toMatch(
      /PH_NOT_ADMIN/,
    );
    // D is an admin of OTHER and a viewer of ABC: can read, cannot attach OTHER.
    expect((await access(db, D)).result).toEqual({ can_change: false, companies: 2, admin_of: 0 });
    expect((await attach(db, D, OTHER)).error).toMatch(/PH_NOT_ADMIN/);
    // A viewer can read and not change.
    expect((await saveShared(db, V, { expected: 1 })).error).toMatch(/PH_NOT_ADMIN/);
    expect(
      await scalar(
        db,
        "select revision as result from public.payroll_shared_setups where id = $1",
        [S1],
      ),
    ).toBe(1);
  });

  it("an admin of every attached company can change it, and the change reaches every one of them", async () => {
    expect((await access(db, A)).result).toEqual({ can_change: true, companies: 2, admin_of: 2 });
    const changed = {
      ...SHARED,
      globalColumns: [
        ...SHARED.globalColumns,
        { id: "c3", key: "bonus", name: "Bonus", type: "input" },
      ],
    };
    const saved = await saveShared(db, A, { expected: 1, body: changed });
    expect(saved.error).toBeNull();
    expect(saved.result!.revision).toBe(2);
    // What each company sees through its own attachment.
    const reach = await scalar<unknown[]>(
      db,
      `select jsonb_agg(s.body order by cs.company_id) as result
       from public.payroll_company_setups cs join public.payroll_shared_setups s on s.id = cs.shared_setup_id`,
    );
    expect(reach).toEqual([changed, changed]);
  });

  it("refuses a save of the shared setup that carries an old revision, and never overwrites", async () => {
    expect((await saveShared(db, A, { expected: 1, body: { old: true } })).error).toMatch(
      /PH_STALE/,
    );
    expect(
      await scalar(
        db,
        "select revision as result from public.payroll_shared_setups where id = $1",
        [S1],
      ),
    ).toBe(2);
  });

  it("saves company setups with the shared setup all or nothing, and only companies attached to it", async () => {
    const renamed = {
      columns: [{ id: "k1", key: "allowance", name: "Allowance", formula: "bonus * 2" }],
      customFields: [],
    };
    // One company's revision is old: nothing at all is stored.
    const refused = await saveShared(db, A, {
      expected: 2,
      body: { changed: 3 },
      companies: [
        { company_id: ABC, body: renamed, expected_revision: 1 },
        { company_id: XYZ, body: renamed, expected_revision: 7 },
      ],
    });
    expect(refused.error).toMatch(/PH_STALE/);
    expect(
      await scalar(
        db,
        "select revision as result from public.payroll_shared_setups where id = $1",
        [S1],
      ),
    ).toBe(2);
    expect(
      await scalar(
        db,
        `select revision as result from public.payroll_company_setups where company_id = '${ABC}'`,
      ),
    ).toBe(1);

    // NEW is not attached to S1.
    expect(
      (
        await saveShared(db, A, {
          expected: 2,
          companies: [{ company_id: NEW, body: renamed, expected_revision: 1 }],
        })
      ).error,
    ).toMatch(/PH_NOT_FOUND/);

    const saved = await saveShared(db, A, {
      expected: 2,
      body: { changed: 3 },
      companies: [
        { company_id: ABC, body: renamed, expected_revision: 1 },
        { company_id: XYZ, body: renamed, expected_revision: 1 },
      ],
    });
    expect(saved.error).toBeNull();
    expect(saved.result).toMatchObject({
      revision: 3,
      companies: [
        { company_id: ABC, revision: 2 },
        { company_id: XYZ, revision: 2 },
      ],
    });
    expect(
      await scalar(
        db,
        `select body as result from public.payroll_company_setups where company_id = '${XYZ}'`,
      ),
    ).toEqual(renamed);
    expect(await count(db, "public.payroll_company_setup_history", `company_id = '${XYZ}'`)).toBe(
      2,
    );
  });

  it("nobody writes the tables directly", async () => {
    for (const sql of [
      `insert into public.payroll_shared_setups (id, name, body, revision) values ('${S2}', 'x', '{}', 1)`,
      `update public.payroll_shared_setups set name = 'x'`,
      `update public.payroll_company_setups set body = '{}'`,
      `delete from public.payroll_company_setups`,
      `delete from public.payroll_shared_setup_history`,
      `delete from public.payroll_company_setup_history`,
    ]) {
      expect(
        (await as(db, "authenticated", A, () => db.query(sql))).error,
        sql.slice(0, 50),
      ).toMatch(/permission denied/);
    }
  });
});

describe("a company's own setup", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDatabase();
    await saveShared(db, A);
    await attach(db, A, ABC);
    await attach(db, A, XYZ);
  }, SETUP_TIMEOUT);
  afterAll(() => db.close());

  it("is saved by an admin of that company only, even one who cannot change the shared setup", async () => {
    expect((await saveCompany(db, V, ABC, 1)).error).toMatch(/PH_NOT_ADMIN/);
    expect((await saveCompany(db, O, ABC, 1)).error).toMatch(/PH_NOT_ADMIN/);
    expect((await saveCompany(db, B, ABC, 1)).error).toMatch(/PH_NOT_ADMIN/);
    expect((await saveCompany(db, null, ABC, 1)).error).toMatch(
      /PH_NOT_SIGNED_IN|permission denied/,
    );
    // B is an admin of XYZ, though not of every company the shared setup is attached to.
    const own = {
      columns: [{ id: "x1", key: "xyzOnly", name: "XYZ only", type: "input" }],
      customFields: [],
    };
    const saved = await saveCompany(db, B, XYZ, 1, own);
    expect(saved.error).toBeNull();
    expect(saved.result).toMatchObject({ revision: 2 });
    expect(
      await scalar(
        db,
        `select body as result from public.payroll_company_setups where company_id = '${XYZ}'`,
      ),
    ).toEqual(own);
  });

  it("refuses an old revision, a company with no setup, and bad input", async () => {
    expect((await saveCompany(db, B, XYZ, 1)).error).toMatch(/PH_STALE/);
    expect((await saveCompany(db, A, NEW, 1)).error).toMatch(/PH_NOT_FOUND/);
    expect((await saveCompany(db, A, ABC, 0)).error).toMatch(/PH_INVALID_INPUT/);
    expect((await saveCompany(db, A, ABC, 1, [1])).error).toMatch(/PH_INVALID_INPUT/);
    expect((await saveCompany(db, A, ABC, 1, { text: "x".repeat(263_000) })).error).toMatch(
      /PH_TOO_LARGE/,
    );
    expect(
      await scalar(
        db,
        `select revision as result from public.payroll_company_setups where company_id = '${ABC}'`,
      ),
    ).toBe(1);
  });

  it("keeps every revision, none dropped, each with the shared setup it was attached to", async () => {
    let revision = 1;
    for (let i = 0; i < 210; i++) {
      const saved = await saveCompany(db, A, ABC, revision, {
        columns: [],
        customFields: [],
        n: i,
      });
      expect(saved.error).toBeNull();
      revision = saved.result!.revision;
    }
    expect(revision).toBe(211);
    expect(await count(db, "public.payroll_company_setup_history", `company_id = '${ABC}'`)).toBe(
      211,
    );
    expect(
      await scalar(
        db,
        `select min(revision)::int as result from public.payroll_company_setup_history where company_id = '${ABC}'`,
      ),
    ).toBe(1);
    expect(
      await count(
        db,
        "public.payroll_company_setup_history",
        `company_id = '${ABC}' and shared_setup_id <> '${S1}'`,
      ),
    ).toBe(0);
  });

  it("is read by the company's members only, revisions included", async () => {
    const seen = (user: string) =>
      one<number>(
        db,
        user,
        "select count(*)::int as result from public.payroll_company_setup_history",
      );
    expect((await seen(V)).result).toBe(211); // ABC only
    expect((await seen(B)).result).toBe(2); // XYZ only
    expect((await seen(O)).result).toBe(0);
  });
});

describe("delete_company after 0013", () => {
  it(
    "removes the company's own setup and revisions; the shared setup goes with the last company attached to it",
    async () => {
      const db = await freshDatabase();
      await saveShared(db, A);
      await saveShared(db, A, { id: S2 });
      await attach(db, A, ABC);
      await attach(db, A, XYZ);
      await attach(db, A, NEW, S2);
      await saveCompany(db, A, XYZ, 1);
      await saveShared(db, A, { expected: 1, body: { changed: true } });

      const deleteCompany = (id: string, name: string) =>
        one<Record<string, unknown>>(
          db,
          A,
          "select public.delete_company($1::uuid, $2) as result",
          [id, name],
        );

      const first = await deleteCompany(XYZ, "XYZ Trading Ltd");
      expect(first.error).toBeNull();
      expect(first.result).toMatchObject({
        payroll_company_setups: 1,
        payroll_company_setup_history: 2,
        payroll_shared_setups: 0,
        payroll_shared_setup_history: 0,
      });
      // ABC still uses S1.
      expect(await count(db, "public.payroll_shared_setups", `id = '${S1}'`)).toBe(1);
      expect(await count(db, "public.payroll_company_setups")).toBe(2);

      const last = await deleteCompany(ABC, "ABC Co Ltd");
      expect(last.result).toMatchObject({
        payroll_company_setups: 1,
        payroll_company_setup_history: 1,
        payroll_shared_setups: 1,
        payroll_shared_setup_history: 2,
      });
      expect(await count(db, "public.payroll_shared_setups", `id = '${S1}'`)).toBe(0);
      expect(
        await count(db, "public.payroll_shared_setup_history", `shared_setup_id = '${S1}'`),
      ).toBe(0);
      // NEW and its own shared setup are not affected.
      expect(await count(db, "public.payroll_company_setups", `company_id = '${NEW}'`)).toBe(1);
      expect(await count(db, "public.payroll_shared_setups", `id = '${S2}'`)).toBe(1);
      await db.close();
    },
    SETUP_TIMEOUT,
  );
});
