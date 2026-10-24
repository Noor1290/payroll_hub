// @vitest-environment node
import { PGlite } from "@electric-sql/pglite";
import { STORAGE_STAND_IN } from "@/test/storageStandIn";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 0018 in a real Postgres (PGlite), used the way the Data API does: as the role
 * "authenticated" (or "anon") with a user id in the request claims. The same stand-ins as
 * payslipMigrations.db.test.ts. Fake data only.
 */
const files = import.meta.glob<string>("../../../supabase/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const migrations = Object.entries(files)
  .map(([path, sql]) => ({ name: path.split("/").pop()!, sql }))
  .sort((a, b) => a.name.localeCompare(b.name));
const migration = (number: string) => migrations.find((m) => m.name.startsWith(number))!;

const A = "00000000-0000-4000-8000-0000000000a1"; // admin of ABC and of DEF, viewer of XYZ
const V = "00000000-0000-4000-8000-0000000000a2"; // viewer of ABC
const O = "00000000-0000-4000-8000-0000000000a3"; // member of nothing
const B = "00000000-0000-4000-8000-0000000000a4"; // admin of XYZ only
const ABC = "10000000-0000-4000-8000-000000000001";
const XYZ = "10000000-0000-4000-8000-000000000002";
const DEF = "10000000-0000-4000-8000-000000000003";
const EMPLOYEE = "30000000-0000-4000-8000-000000000001";
const EMPLOYEE_2 = "30000000-0000-4000-8000-000000000002";
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
  insert into auth.users (id) values ('${A}'), ('${V}'), ('${O}'), ('${B}');
  insert into public.companies (id, name, brn) values
    ('${ABC}', 'ABC Co Ltd', 'C1'), ('${XYZ}', 'XYZ Trading Ltd', 'C2'), ('${DEF}', 'DEF Ltd', 'C3');
  insert into public.company_members (company_id, user_id, role) values
    ('${ABC}', '${A}', 'admin'), ('${ABC}', '${V}', 'viewer'), ('${DEF}', '${A}', 'admin'),
    ('${XYZ}', '${B}', 'admin'), ('${XYZ}', '${A}', 'viewer');
  insert into public.employees (id, company_id, national_id, surname) values
    ('${EMPLOYEE}', '${ABC}', 'X1', 'DOE'), ('${EMPLOYEE_2}', '${ABC}', 'X2', 'ROE');
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

async function selfCheck(db: PGlite, number: string): Promise<Record<string, unknown>> {
  const results = await db.exec(`set role migration_owner; ${migration(number).sql}; reset role;`);
  return results.filter((r) => r.rows.length === 1 && r.fields.length > 3).at(-1)!
    .rows[0] as Record<string, unknown>;
}

interface Copied {
  template_id: string;
  name: string;
  version: number;
  draft_revision: number;
  created: boolean;
  published: boolean;
  published_at: string;
}

const copy = (
  db: PGlite,
  user: string | null,
  company: string,
  name: string,
  body: unknown,
  expected: number,
  role: Role = "authenticated",
) =>
  one<Copied>(
    db,
    user,
    `select public.publish_payslip_template_copy($1::uuid, $2, $3::jsonb, $4::int) as result`,
    [company, name, JSON.stringify(body), expected],
    role,
  );

const setInUse = (
  db: PGlite,
  user: string | null,
  company: string,
  template: string | null,
  version: number | null,
) =>
  one<{ template_id: string | null; version: number | null }>(
    db,
    user,
    `select public.set_payslip_template_in_use($1::uuid, $2::uuid, $3::int) as result`,
    [company, template, version],
  );

const columns = (db: PGlite, user: string | null, company: string, role: Role = "authenticated") =>
  one<{ period: string | null; employees: number; keys: string[] }>(
    db,
    user,
    `select public.payroll_run_columns($1::uuid) as result`,
    [company],
    role,
  );

const inUseOf = (db: PGlite, company: string) =>
  db
    .query<{ template_id: string; version: number }>(
      "select template_id, version from public.payslip_template_in_use where company_id = $1",
      [company],
    )
    .then((r) => r.rows[0] ?? null);

/** Everything about a company's templates, to show that a refused call changed nothing. */
const snapshot = async (db: PGlite, company: string) =>
  JSON.stringify(
    (
      await db.query(
        `select
           (select coalesce(jsonb_agg(t order by t.id), '[]') from public.payslip_templates t where t.company_id = $1) as templates,
           (select coalesce(jsonb_agg(v order by v.id), '[]') from public.payslip_template_versions v where v.company_id = $1) as versions,
           (select coalesce(jsonb_agg(u), '[]') from public.payslip_template_in_use u where u.company_id = $1) as in_use`,
        [company],
      )
    ).rows,
  );

const BODY = { labels: { title: "Payslip" }, lines: ["basic", "presence"] };
const OTHER_BODY = { labels: { title: "Pay slip" }, lines: ["basic"] };

describe("0018: the migration itself", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDatabase();
  }, SETUP_TIMEOUT);
  afterAll(() => db?.close());

  it("reports every check as true, the first time and when run again", async () => {
    for (let run = 0; run < 2; run++) {
      const check = await selfCheck(db, "0018");
      expect(Object.keys(check).length).toBeGreaterThan(8);
      for (const [name, value] of Object.entries(check)) expect(value, name).toBe(true);
    }
  });

  it("only adds: the new table starts empty and nothing else is written", async () => {
    expect(
      await scalar<number>(
        db,
        "select count(*)::int as result from public.payslip_template_in_use",
      ),
    ).toBe(0);
    const all = migration("0018").sql.replace(/--.*$/gm, "");
    // delete_company deletes by design (its body is checked in deleteCompanyMigration.test.ts);
    // everything else in the file may only write to the template tables, inside its functions.
    const start = all.indexOf("create or replace function public.delete_company(");
    const sql = all.slice(0, start) + all.slice(all.indexOf("$$;", start));
    expect(start).toBeGreaterThan(0);
    expect(sql).not.toMatch(/\balter table public\.(?!payslip_template_in_use\b)/i);
    expect(sql).not.toMatch(/\bdrop (table|column|function)\b/i);
    expect(sql).not.toMatch(/\b(update|delete from|insert into) public\.(?!payslip_template)/i);
  });
});

describe("0018: publish_payslip_template_copy", () => {
  let db: PGlite;
  beforeEach(async () => {
    db = await freshDatabase();
  }, SETUP_TIMEOUT);
  afterAll(() => db?.close());

  it("makes a new template at version 1 in a company that has none with that name, used for its payslips", async () => {
    const made = await copy(db, A, DEF, "Monthly payslip", BODY, 0);
    expect(made.error).toBeNull();
    expect(made.result).toMatchObject({
      name: "Monthly payslip",
      version: 1,
      draft_revision: 1,
      created: true,
      published: true,
    });
    expect(await inUseOf(db, DEF)).toEqual({ template_id: made.result!.template_id, version: 1 });
    expect(
      await scalar(
        db,
        "select body as result from public.payslip_template_versions where company_id = $1",
        [DEF],
      ),
    ).toEqual(BODY);
  });

  it("gives a template with the same name (capitals ignored) the next version, keeping its own name and its history", async () => {
    const first = await copy(db, A, DEF, "Monthly Payslip", OTHER_BODY, 0);
    const second = await copy(db, A, DEF, "monthly payslip", BODY, first.result!.draft_revision);
    expect(second.error).toBeNull();
    expect(second.result).toMatchObject({
      template_id: first.result!.template_id,
      name: "Monthly Payslip",
      version: 2,
      draft_revision: 2,
      created: false,
      published: true,
    });
    const kept = await db.query<{ version: number; body: unknown }>(
      "select version, body from public.payslip_template_versions where company_id = $1 order by version",
      [DEF],
    );
    expect(kept.rows).toEqual([
      { version: 1, body: OTHER_BODY },
      { version: 2, body: BODY },
    ]);
    expect(await inUseOf(db, DEF)).toEqual({ template_id: first.result!.template_id, version: 2 });
  });

  it("adds no version when the latest one already is exactly this, and still makes it the one used", async () => {
    const first = await copy(db, A, DEF, "Monthly payslip", BODY, 0);
    await setInUse(db, A, DEF, null, null);
    const again = await copy(db, A, DEF, "Monthly payslip", BODY, 1);
    expect(again.result).toMatchObject({
      version: 1,
      draft_revision: 1,
      created: false,
      published: false,
    });
    expect(
      await scalar<number>(
        db,
        "select count(*)::int as result from public.payslip_template_versions",
      ),
    ).toBe(1);
    expect(await inUseOf(db, DEF)).toEqual({ template_id: first.result!.template_id, version: 1 });
  });

  it("refuses, changing nothing, when that company's draft moved on since it was checked", async () => {
    await copy(db, A, DEF, "Monthly payslip", OTHER_BODY, 0);
    const templateId = await scalar<string>(
      db,
      "select id as result from public.payslip_templates where company_id = $1",
      [DEF],
    );
    // Someone saves the draft there after the check (revision 1 -> 2).
    await one(
      db,
      A,
      "select public.save_payslip_template_draft($1, $2, 'Monthly payslip', $3::jsonb, 1)",
      [DEF, templateId, JSON.stringify({ mine: true })],
    );
    const before = await snapshot(db, DEF);
    const late = await copy(db, A, DEF, "Monthly payslip", BODY, 1);
    expect(late.error).toContain("PH_STALE");
    expect(await snapshot(db, DEF)).toBe(before);
  });

  it("refuses a second copy of a new template sent twice: never two templates", async () => {
    await copy(db, A, DEF, "Monthly payslip", BODY, 0);
    const twice = await copy(db, A, DEF, "Monthly payslip", BODY, 0);
    expect(twice.error).toContain("PH_STALE");
    expect(
      await scalar<number>(
        db,
        "select count(*)::int as result from public.payslip_templates where company_id = $1",
        [DEF],
      ),
    ).toBe(1);
  });

  it("refuses when the template checked is no longer there under that name", async () => {
    const gone = await copy(db, A, DEF, "Monthly payslip", BODY, 3);
    expect(gone.error).toContain("PH_STALE");
    expect(await snapshot(db, DEF)).toBe(await snapshot(db, XYZ));
  });

  it("stops at 50 templates", async () => {
    for (let n = 1; n <= 50; n++) {
      await one(db, A, "select public.save_payslip_template_draft($1, null, $2, '{}'::jsonb, 0)", [
        DEF,
        `T${n}`,
      ]);
    }
    const before = await snapshot(db, DEF);
    expect((await copy(db, A, DEF, "Monthly payslip", BODY, 0)).error).toContain("PH_LIMIT");
    expect(await snapshot(db, DEF)).toBe(before);
  });

  it("is for admins of THAT company only: a viewer, an admin of another company, a non-member and anon are refused", async () => {
    const before = await snapshot(db, ABC);
    expect((await copy(db, V, ABC, "Monthly payslip", BODY, 0)).error).toContain("PH_NOT_ADMIN");
    expect((await copy(db, B, ABC, "Monthly payslip", BODY, 0)).error).toContain("PH_NOT_ADMIN");
    expect((await copy(db, A, XYZ, "Monthly payslip", BODY, 0)).error).toContain("PH_NOT_ADMIN");
    expect((await copy(db, O, ABC, "Monthly payslip", BODY, 0)).error).toContain("PH_NOT_ADMIN");
    expect((await copy(db, null, ABC, "Monthly payslip", BODY, 0, "anon")).error).toMatch(
      /permission denied/,
    );
    expect(await snapshot(db, ABC)).toBe(before);
    expect(await snapshot(db, XYZ)).toBe(await snapshot(db, DEF));
  });

  it("checks its input after the permission check, and stores nothing then", async () => {
    expect((await copy(db, A, DEF, "  ", BODY, 0)).error).toContain("PH_INVALID_INPUT");
    expect((await copy(db, A, DEF, "Monthly payslip", [1, 2], 0)).error).toContain(
      "PH_INVALID_INPUT",
    );
    expect((await copy(db, A, DEF, "Monthly payslip", BODY, -1)).error).toContain(
      "PH_INVALID_INPUT",
    );
    expect((await copy(db, O, DEF, "  ", BODY, 0)).error).toContain("PH_NOT_ADMIN");
    expect(
      await scalar<number>(db, "select count(*)::int as result from public.payslip_templates"),
    ).toBe(0);
  });

  it("never touches issued payslips", async () => {
    const made = await copy(db, A, ABC, "Monthly payslip", OTHER_BODY, 0);
    await db.exec(
      `insert into public.payroll_runs (company_id, period) values ('${ABC}', '2026-09-01')`,
    );
    const issued = await one(
      db,
      A,
      "select public.issue_payslips($1::uuid, '2026-09-01'::date, $2::jsonb) as result",
      [
        ABC,
        JSON.stringify([
          {
            national_id: "X1",
            expected_revision: 0,
            template_id: made.result!.template_id,
            template_version: 1,
            rates: null,
            lines: [{ label: "Basic Salary", amount: 1000 }],
            accepted_differences: [],
          },
        ]),
      ],
    );
    expect(issued.error).toBeNull();
    const before = await scalar(
      db,
      "select jsonb_agg(p order by p.id) as result from public.issued_payslips p",
    );
    await copy(db, A, ABC, "Monthly payslip", BODY, made.result!.draft_revision);
    expect(
      await scalar(db, "select jsonb_agg(p order by p.id) as result from public.issued_payslips p"),
    ).toEqual(before);
  });
});

describe("0018: set_payslip_template_in_use and the table", () => {
  let db: PGlite;
  let template: string;
  beforeAll(async () => {
    db = await freshDatabase();
    template = (await copy(db, A, ABC, "Monthly payslip", BODY, 0)).result!.template_id;
    await copy(db, A, ABC, "Monthly payslip", OTHER_BODY, 1);
  }, SETUP_TIMEOUT);
  afterAll(() => db?.close());

  it("names one of the company's published versions, and clears it", async () => {
    expect((await setInUse(db, A, ABC, template, 1)).result).toMatchObject({
      template_id: template,
      version: 1,
    });
    expect(await inUseOf(db, ABC)).toEqual({ template_id: template, version: 1 });
    expect((await setInUse(db, A, ABC, null, null)).result).toEqual({
      template_id: null,
      version: null,
    });
    expect(await inUseOf(db, ABC)).toBeNull();
  });

  it("refuses a version that does not exist, another company's template, and half a choice", async () => {
    expect((await setInUse(db, A, ABC, template, 9)).error).toContain("PH_NOT_FOUND");
    expect((await setInUse(db, A, DEF, template, 1)).error).toContain("PH_NOT_FOUND");
    expect((await setInUse(db, A, ABC, template, null)).error).toContain("PH_INVALID_INPUT");
    expect((await setInUse(db, A, ABC, null, 1)).error).toContain("PH_INVALID_INPUT");
  });

  it("is for admins only: a viewer, a non-member and anon are refused", async () => {
    await setInUse(db, A, ABC, template, 2);
    expect((await setInUse(db, V, ABC, template, 1)).error).toContain("PH_NOT_ADMIN");
    expect((await setInUse(db, O, ABC, template, 1)).error).toContain("PH_NOT_ADMIN");
    expect((await setInUse(db, B, ABC, null, null)).error).toContain("PH_NOT_ADMIN");
    const anon = await one(
      db,
      null,
      "select public.set_payslip_template_in_use($1::uuid, null, null)",
      [ABC],
      "anon",
    );
    expect(anon.error).toMatch(/permission denied/);
    expect(await inUseOf(db, ABC)).toEqual({ template_id: template, version: 2 });
  });

  it("is read by members only, and written by nobody directly", async () => {
    const read = (user: string | null, role: Role = "authenticated") =>
      as(
        db,
        role,
        user,
        async () => (await db.query("select * from public.payslip_template_in_use")).rows.length,
      );
    expect((await read(A)).result).toBe(1);
    expect((await read(V)).result).toBe(1);
    expect((await read(O)).result).toBe(0);
    expect((await read(B)).result).toBe(0);
    expect((await read(null, "anon")).error).toMatch(/permission denied/);

    for (const sql of [
      `insert into public.payslip_template_in_use (company_id, template_id, version) values ('${DEF}', '${template}', 1)`,
      `update public.payslip_template_in_use set version = 1`,
      `delete from public.payslip_template_in_use`,
    ]) {
      expect((await as(db, "authenticated", A, () => db.query(sql))).error).toMatch(
        /permission denied/,
      );
    }
    expect(await inUseOf(db, ABC)).toEqual({ template_id: template, version: 2 });
  });

  it("goes with its company: delete_company removes it and counts it", async () => {
    const deleted = await one<Record<string, number>>(
      db,
      A,
      "select public.delete_company($1::uuid, 'ABC Co Ltd') as result",
      [ABC],
    );
    expect(deleted.error).toBeNull();
    expect(deleted.result).toMatchObject({
      template_in_use: 1,
      templates: 1,
      template_versions: 2,
    });
    expect(
      await scalar<number>(
        db,
        "select count(*)::int as result from public.payslip_template_in_use",
      ),
    ).toBe(0);
  });
});

describe("0018: payroll_run_columns", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDatabase();
    await db.exec(`
      insert into public.payroll_runs (id, company_id, period) values
        ('40000000-0000-4000-8000-000000000001', '${ABC}', '2026-08-01'),
        ('40000000-0000-4000-8000-000000000002', '${ABC}', '2026-09-01');
      insert into public.payroll_runs (id, company_id, period, deleted_at) values
        ('40000000-0000-4000-8000-000000000003', '${ABC}', '2026-10-01', now());
      insert into public.payroll_entries (run_id, employee_id, basic_salary, net_pay, extra) values
        ('40000000-0000-4000-8000-000000000001', '${EMPLOYEE}', 20000, 19500, '{"old_column": 11.11}'),
        ('40000000-0000-4000-8000-000000000002', '${EMPLOYEE}', 25000, 24375.5,
          '{"employee_csg": 375.5, "Presence Bonus": 1234.56}'),
        ('40000000-0000-4000-8000-000000000002', '${EMPLOYEE_2}', 30000, 29250,
          '{"employee_csg": 450, "Absences": 777.77, "note": "SECRET TEXT"}'),
        ('40000000-0000-4000-8000-000000000003', '${EMPLOYEE}', 99999, 99999, '{"deleted_only": 42}');
    `);
  }, SETUP_TIMEOUT);
  afterAll(() => db?.close());

  it("gives the newest saved run's month, its size and the key names, sorted, and never a value", async () => {
    const found = await columns(db, A, ABC);
    expect(found.error).toBeNull();
    expect(found.result).toEqual({
      period: "2026-09-01",
      employees: 2,
      keys: ["Absences", "Presence Bonus", "employee_csg", "note"],
    });
    const text = JSON.stringify(found.result);
    for (const value of [
      "1234.56",
      "777.77",
      "375.5",
      "450",
      "SECRET",
      "25000",
      "24375.5",
      "99999",
      "deleted_only",
    ]) {
      expect(text).not.toContain(value);
    }
  });

  it("says when the company has no saved run", async () => {
    expect((await columns(db, A, DEF)).result).toEqual({ period: null, employees: 0, keys: [] });
  });

  it("is for admins of that company only, checked in the database", async () => {
    expect((await columns(db, V, ABC)).error).toContain("PH_NOT_ADMIN");
    expect((await columns(db, O, ABC)).error).toContain("PH_NOT_ADMIN");
    expect((await columns(db, B, ABC)).error).toContain("PH_NOT_ADMIN");
    expect((await columns(db, A, XYZ)).error).toContain("PH_NOT_ADMIN");
    expect((await columns(db, null, ABC, "anon")).error).toMatch(/permission denied/);
  });
});
