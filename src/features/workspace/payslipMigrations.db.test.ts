// @vitest-environment node
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Runs migrations 0001 to 0010 in a real Postgres (PGlite) and uses the three new ones the way
 * the Data API does: as the role "authenticated" (or "anon") with a user id in the request
 * claims. See deleteCompany.db.test.ts for what stands in for Supabase and what is not covered.
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
const migration = (number: string) => migrations.find((m) => m.name.startsWith(number))!;

const A = "00000000-0000-4000-8000-0000000000a1"; // admin of ABC, viewer of XYZ
const V = "00000000-0000-4000-8000-0000000000a2"; // viewer of ABC
const O = "00000000-0000-4000-8000-0000000000a3"; // member of nothing
const B = "00000000-0000-4000-8000-0000000000a4"; // admin of XYZ only
const ABC = "10000000-0000-4000-8000-000000000001";
const XYZ = "10000000-0000-4000-8000-000000000002";
const EMPLOYEE = "30000000-0000-4000-8000-000000000001";
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

const SEED = `
  insert into auth.users (id) values ('${A}'), ('${V}'), ('${O}'), ('${B}');
  insert into public.companies (id, name, brn) values
    ('${ABC}', 'ABC Co Ltd', 'C1'), ('${XYZ}', 'XYZ Trading Ltd', 'C2');
  insert into public.company_members (company_id, user_id, role) values
    ('${ABC}', '${A}', 'admin'), ('${ABC}', '${V}', 'viewer'),
    ('${XYZ}', '${B}', 'admin'), ('${XYZ}', '${A}', 'viewer');
  insert into public.employees (id, company_id, national_id, surname) values
    ('${EMPLOYEE}', '${ABC}', 'X1', 'DOE');
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

/** One value from one row, as a signed-in user. */
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

/** The last statement of each migration is a one-row self-check; every column must be true. */
async function selfCheck(db: PGlite, number: string): Promise<Record<string, unknown>> {
  const results = await db.exec(`set role migration_owner; ${migration(number).sql}; reset role;`);
  return results.filter((r) => r.rows.length === 1 && r.fields.length > 3).at(-1)!
    .rows[0] as Record<string, unknown>;
}

interface Rates {
  company?: string;
  month?: string;
  expected?: number;
  nsfRate?: number;
  ceiling?: number;
  exempt?: boolean;
  low?: number;
  high?: number;
  threshold?: number;
  note?: string | null;
}
const saveRates = (db: PGlite, user: string | null, r: Rates = {}, role: Role = "authenticated") =>
  one<{ effective_from: string; revision: number }>(
    db,
    user,
    `select public.save_statutory_rates($1::uuid, $2::date, $3::int, $4::numeric, $5::numeric,
       $6::boolean, $7::numeric, $8::numeric, $9::numeric, $10) as result`,
    [
      r.company ?? ABC,
      r.month ?? "2026-07-01",
      r.expected ?? 0,
      r.nsfRate ?? 1,
      r.ceiling ?? 29710,
      r.exempt ?? true,
      r.low ?? 1.5,
      r.high ?? 3,
      r.threshold ?? 50000,
      r.note === undefined ? null : r.note,
    ],
    role,
  );

const saveDraft = (
  db: PGlite,
  user: string | null,
  d: { company?: string; id?: string | null; name?: string; body?: unknown; expected?: number },
  role: Role = "authenticated",
) =>
  one<{ template_id: string; draft_revision: number }>(
    db,
    user,
    "select public.save_payslip_template_draft($1::uuid, $2::uuid, $3, $4::jsonb, $5::int) as result",
    [
      d.company ?? ABC,
      d.id ?? null,
      d.name ?? "Monthly",
      JSON.stringify(d.body ?? { lines: [] }),
      d.expected ?? 0,
    ],
    role,
  );

const publish = (db: PGlite, user: string | null, id: string, expected: number, company = ABC) =>
  one<{ template_id: string; version: number }>(
    db,
    user,
    "select public.publish_payslip_template($1::uuid, $2::uuid, $3::int) as result",
    [company, id, expected],
  );

describe("the migrations' own checks", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDatabase();
  }, SETUP_TIMEOUT);
  afterAll(() => db?.close());

  it.each(["0008", "0009", "0010"])(
    "%s can be run a second time and reports every check as true",
    async (number) => {
      const check = await selfCheck(db, number);
      expect(Object.keys(check).length).toBeGreaterThan(3);
      for (const [name, value] of Object.entries(check)) expect(value, name).toBe(true);
    },
  );
});

describe("0008: employees.date_of_employment", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDatabase();
  }, SETUP_TIMEOUT);
  afterAll(() => db?.close());

  const setDate = (user: string, value: string | null) =>
    one<string>(
      db,
      user,
      `update public.employees set date_of_employment = $1::date where id = $2
       returning date_of_employment::text as result`,
      [value, EMPLOYEE],
    );

  it("starts empty", async () => {
    const value = await one<string | null>(
      db,
      V,
      "select date_of_employment::text as result from public.employees where id = $1",
      [EMPLOYEE],
    );
    expect(value).toEqual({ result: null, error: null });
  });

  it("lets an admin set and clear it", async () => {
    expect((await setDate(A, "2019-03-04")).result).toBe("2019-03-04");
    expect((await setDate(A, null)).result).toBeNull();
    expect((await setDate(A, "2019-03-04")).result).toBe("2019-03-04");
  });

  it("changes nothing for a viewer or a stranger: no row is theirs to update", async () => {
    expect((await setDate(V, "2001-01-01")).result).toBeUndefined();
    expect((await setDate(O, "2001-01-01")).result).toBeUndefined();
    expect(
      await scalar(db, "select date_of_employment::text as result from public.employees"),
    ).toBe("2019-03-04");
  });

  it.each(["0206-01-01", "1899-12-31", "2101-01-01"])("refuses the slip %s", async (value) => {
    expect((await setDate(A, value)).error).toMatch(/23514/);
  });

  it("is kept when the month is imported again, with the employee's name changed", async () => {
    const numbers = Object.fromEntries(
      [
        "basic_salary",
        "govt_increment",
        "new_basic_salary",
        "allowances",
        "emoluments",
        "travelling",
        "gross_pay",
        "csg",
        "nsf",
        "paye",
        "total_deductions",
        "net_pay",
        "levy",
        "prgf",
        "total_mra_contributions",
        "edf",
        "edf_monthly",
        "total",
      ].map((column) => [column, 100]),
    );
    const row = {
      national_id: "X1",
      surname: "DOE-SMITH",
      age_60_plus: false,
      extra: {},
      ...numbers,
    };
    for (const replace of [false, true]) {
      const imported = await one(
        db,
        A,
        "select public.import_payroll_run($1::uuid, $2::date, $3::jsonb, $4) as result",
        [ABC, "2026-09-01", JSON.stringify([row]), replace],
      );
      expect(imported.error).toBeNull();
    }
    expect(
      await scalar(
        db,
        "select surname || ' ' || date_of_employment::text as result from public.employees",
      ),
    ).toBe("DOE-SMITH 2019-03-04");
  });
});

describe("0009: statutory_rates and save_statutory_rates", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDatabase();
  }, SETUP_TIMEOUT);
  afterAll(() => db?.close());

  const rows = () =>
    scalar<number>(db, "select count(*)::int as result from public.statutory_rates");

  it.each([
    ["a viewer of the company", "authenticated", V, /42501 PH_NOT_ADMIN/],
    ["a user who belongs to nothing", "authenticated", O, /42501 PH_NOT_ADMIN/],
    ["an admin of a different company", "authenticated", B, /42501 PH_NOT_ADMIN/],
    ["a signed-in role with no user id", "authenticated", null, /42501 PH_NOT_SIGNED_IN/],
    ["the anon role carrying an admin's id", "anon", A, /permission denied for function/],
  ] as const)("refuses %s", async (_who, role, user, expected) => {
    expect((await saveRates(db, user, {}, role)).error).toMatch(expected);
    expect(await rows()).toBe(0);
  });

  it.each([
    ["a day that is not the first", { month: "2026-07-15" }],
    ["a rate above 100", { nsfRate: 100.5 }],
    ["a negative rate", { low: -1 }],
    ["a rate with 5 decimals", { high: 3.00001 }],
    ["an amount with 3 decimals", { ceiling: 29710.005 }],
    ["a negative amount", { threshold: -1 }],
    ["a negative last-seen revision", { expected: -1 }],
    ["a note of 301 characters", { note: "x".repeat(301) }],
  ] as [string, Rates][])("refuses %s instead of rounding or guessing", async (_what, input) => {
    expect((await saveRates(db, A, input)).error).toMatch(/22023 PH_INVALID_INPUT/);
    expect(await rows()).toBe(0);
  });

  it("stores revision 1 for an admin, with the author and time set by the database", async () => {
    const saved = await saveRates(db, A, { note: "  Finance Act 2026  " });
    expect(saved.error).toBeNull();
    expect(saved.result).toMatchObject({ effective_from: "2026-07-01", revision: 1 });
    const row = await scalar<Record<string, unknown>>(
      db,
      "select to_jsonb(r) as result from public.statutory_rates r",
    );
    expect(row).toMatchObject({
      company_id: ABC,
      effective_from: "2026-07-01",
      revision: 1,
      nsf_employee_rate: 1,
      nsf_ceiling: 29710,
      nsf_exempt_at_60: true,
      csg_employee_rate_low: 1.5,
      csg_employee_rate_high: 3,
      csg_threshold: 50000,
      source_note: "Finance Act 2026",
      created_by: A,
    });
  });

  it("refuses the same save arriving twice (its first answer was lost): no second row", async () => {
    expect((await saveRates(db, A, { note: "Finance Act 2026" })).error).toMatch(/P0001 PH_STALE/);
    expect(await rows()).toBe(1);
  });

  it("refuses a correction that changes nothing", async () => {
    const same = await saveRates(db, A, { expected: 1, note: "Finance Act 2026" });
    expect(same.error).toMatch(/P0001 PH_NO_CHANGE/);
    expect(await rows()).toBe(1);
  });

  it("stores a real correction as the next revision and keeps the old one", async () => {
    const saved = await saveRates(db, A, { expected: 1, ceiling: 30000 });
    expect(saved.result).toMatchObject({ revision: 2 });
    expect(await rows()).toBe(2);
    expect((await saveRates(db, A, { expected: 1, ceiling: 31000 })).error).toMatch(/PH_STALE/);
  });

  it("numbers each month on its own", async () => {
    const saved = await saveRates(db, A, { month: "2027-07-01" });
    expect(saved.result).toMatchObject({ effective_from: "2027-07-01", revision: 1 });
  });

  it("lets members read every row, and others none", async () => {
    const count = "select count(*)::int as result from public.statutory_rates";
    expect((await one(db, V, count)).result).toBe(3);
    expect((await one(db, A, count)).result).toBe(3);
    expect((await one(db, B, count)).result).toBe(0);
    expect((await one(db, O, count)).result).toBe(0);
    expect((await one(db, null, count, [], "anon")).error).toMatch(/permission denied/);
  });

  it.each([
    `insert into public.statutory_rates (company_id, effective_from, revision, nsf_employee_rate,
       nsf_ceiling, nsf_exempt_at_60, csg_employee_rate_low, csg_employee_rate_high, csg_threshold)
     values ('${ABC}', '2026-01-01', 9, 1, 1, true, 1, 1, 1)`,
    "update public.statutory_rates set nsf_ceiling = 1",
    "delete from public.statutory_rates",
  ])("gives even an admin no direct write: %s", async (statement) => {
    const { error } = await as(db, "authenticated", A, () => db.exec(statement));
    expect(error).toContain("permission denied for table statutory_rates");
    expect(await rows()).toBe(3);
  });

  it("keeps the row, with an empty author, when the user account is removed", async () => {
    expect((await saveRates(db, B, { company: XYZ })).error).toBeNull();
    await db.exec(`delete from auth.users where id = '${B}'`);
    expect(
      await scalar(
        db,
        `select count(*)::int as result from public.statutory_rates
         where company_id = '${XYZ}' and created_by is null`,
      ),
    ).toBe(1);
  });
});

describe("0010: payslip templates", () => {
  let db: PGlite;
  let id: string;
  beforeAll(async () => {
    db = await freshDatabase();
  }, SETUP_TIMEOUT);
  afterAll(() => db?.close());

  const templates = () =>
    scalar<number>(db, "select count(*)::int as result from public.payslip_templates");

  it.each([
    ["a viewer of the company", "authenticated", V, /42501 PH_NOT_ADMIN/],
    ["a user who belongs to nothing", "authenticated", O, /42501 PH_NOT_ADMIN/],
    ["an admin of a different company", "authenticated", B, /42501 PH_NOT_ADMIN/],
    ["a signed-in role with no user id", "authenticated", null, /42501 PH_NOT_SIGNED_IN/],
    ["the anon role carrying an admin's id", "anon", A, /permission denied for function/],
  ] as const)("refuses a draft from %s", async (_who, role, user, expected) => {
    expect((await saveDraft(db, user, {}, role)).error).toMatch(expected);
    expect(await templates()).toBe(0);
  });

  it.each([
    ["an empty name", { name: "   " }, /22023 PH_INVALID_INPUT/],
    ["a name of 81 characters", { name: "x".repeat(81) }, /22023 PH_INVALID_INPUT/],
    ["a body that is a list", { body: [1, 2] }, /22023 PH_INVALID_INPUT/],
    ["a body that is text", { body: "hello" }, /22023 PH_INVALID_INPUT/],
    ["a new template that claims an earlier revision", { expected: 3 }, /22023 PH_INVALID_INPUT/],
    ["a body over 256 KB", { body: { pad: "x".repeat(262_200) } }, /54000 PH_TOO_LARGE/],
  ] as const)("refuses %s", async (_what, input, expected) => {
    expect((await saveDraft(db, A, input)).error).toMatch(expected);
    expect(await templates()).toBe(0);
  });

  it("creates a template at draft revision 1", async () => {
    const saved = await saveDraft(db, A, { name: "  Monthly  ", body: { lines: ["Basic"] } });
    expect(saved.error).toBeNull();
    expect(saved.result).toMatchObject({ draft_revision: 1, name: "Monthly" });
    id = saved.result!.template_id;
  });

  it("refuses a second template with the same name, whatever the capitals", async () => {
    expect((await saveDraft(db, A, { name: "MONTHLY" })).error).toMatch(/23505 PH_DUPLICATE_NAME/);
    expect(await templates()).toBe(1);
  });

  it("saves over the draft only when the caller saw the current revision", async () => {
    const next = await saveDraft(db, A, { id, body: { lines: ["Basic", "CSG"] }, expected: 1 });
    expect(next.result).toMatchObject({ template_id: id, draft_revision: 2 });
    // The same save again, or someone who still has revision 1 open: refused, nothing overwritten.
    const stale = await saveDraft(db, A, { id, body: { lines: ["OLD"] }, expected: 1 });
    expect(stale.error).toMatch(/P0001 PH_STALE/);
    expect(await scalar(db, "select draft_body as result from public.payslip_templates")).toEqual({
      lines: ["Basic", "CSG"],
    });
  });

  it("does not find another company's template", async () => {
    const other = await saveDraft(db, B, { company: XYZ, name: "Theirs" });
    const theirs = other.result!.template_id;
    expect((await saveDraft(db, A, { id: theirs, expected: 1 })).error).toMatch(
      /P0002 PH_NOT_FOUND/,
    );
    expect((await publish(db, A, theirs, 1)).error).toMatch(/P0002 PH_NOT_FOUND/);
  });

  it("publishes the draft the caller saw as version 1, and refuses a stale publish", async () => {
    expect((await publish(db, A, id, 1)).error).toMatch(/P0001 PH_STALE/);
    expect((await publish(db, V, id, 2)).error).toMatch(/42501 PH_NOT_ADMIN/);
    const published = await publish(db, A, id, 2);
    expect(published.result).toMatchObject({ template_id: id, version: 1 });
  });

  it("refuses to publish the same thing twice", async () => {
    expect((await publish(db, A, id, 2)).error).toMatch(/P0001 PH_NO_CHANGE/);
  });

  it("publishes a changed draft as version 2 and keeps version 1 as it was", async () => {
    await saveDraft(db, A, { id, body: { lines: ["Basic", "CSG", "NSF"] }, expected: 2 });
    expect((await publish(db, A, id, 3)).result).toMatchObject({ version: 2 });
    expect(
      await scalar(
        db,
        "select body as result from public.payslip_template_versions where version = 1",
      ),
    ).toEqual({ lines: ["Basic", "CSG"] });
  });

  it("lets a viewer read drafts and versions, and others nothing", async () => {
    const drafts = "select count(*)::int as result from public.payslip_templates";
    const versions = "select count(*)::int as result from public.payslip_template_versions";
    expect((await one(db, V, drafts)).result).toBe(1);
    expect((await one(db, V, versions)).result).toBe(2);
    expect((await one(db, O, drafts)).result).toBe(0);
    expect((await one(db, O, versions)).result).toBe(0);
    expect((await one(db, null, drafts, [], "anon")).error).toMatch(/permission denied/);
  });

  it.each([
    ["payslip_templates", "update public.payslip_templates set name = 'x'"],
    ["payslip_templates", "delete from public.payslip_templates"],
    ["payslip_template_versions", "update public.payslip_template_versions set body = '{}'"],
    ["payslip_template_versions", "delete from public.payslip_template_versions"],
  ])("gives even an admin no direct write on %s", async (table, statement) => {
    const { error } = await as(db, "authenticated", A, () => db.exec(statement));
    expect(error).toContain(`permission denied for table ${table}`);
  });

  it("stops at 50 templates per company", async () => {
    for (let n = 2; n <= 50; n++) {
      expect((await saveDraft(db, A, { name: `Template ${n}` })).error).toBeNull();
    }
    expect((await saveDraft(db, A, { name: "Template 51" })).error).toMatch(/54000 PH_LIMIT/);
  });
});

describe("delete_company after 0010", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDatabase();
  }, SETUP_TIMEOUT);
  afterAll(() => db?.close());

  it("removes the company's rates, templates and versions, counts them, and spares the other company", async () => {
    await saveRates(db, A);
    await saveRates(db, A, { expected: 1, ceiling: 30000 });
    await saveRates(db, B, { company: XYZ });
    const mine = (await saveDraft(db, A, {})).result!.template_id;
    await publish(db, A, mine, 1);
    await saveDraft(db, A, { name: "Second" });
    const theirs = (await saveDraft(db, B, { company: XYZ, name: "Theirs" })).result!.template_id;
    await publish(db, B, theirs, 1, XYZ);

    const deleted = await one(db, A, "select public.delete_company($1::uuid, $2) as result", [
      ABC,
      "ABC Co Ltd",
    ]);
    expect(deleted.error).toBeNull();
    expect(deleted.result).toEqual({
      company_id: ABC,
      entries: 0,
      runs: 0,
      employees: 1,
      details: 0,
      links: 0,
      rates: 2,
      templates: 2,
      template_versions: 1,
      members: 2,
    });

    // Every table with a foreign key to companies, found from the catalogue.
    const { rows } = await db.query<{ tbl: string; col: string }>(`
      select c.conrelid::regclass::text as tbl, a.attname as col
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      where c.contype = 'f' and c.confrelid = 'public.companies'::regclass`);
    const tables = rows.map((row) => row.tbl);
    expect(tables).toEqual(
      expect.arrayContaining(["statutory_rates", "payslip_templates", "payslip_template_versions"]),
    );
    for (const { tbl, col } of rows) {
      const left = (table: string) =>
        scalar<number>(db, `select count(*)::int as result from ${tbl} where ${col} = $1`, [table]);
      expect(await left(ABC), `rows left in ${tbl}`).toBe(0);
    }
    for (const table of ["statutory_rates", "payslip_templates", "payslip_template_versions"]) {
      expect(
        await scalar(db, `select count(*)::int as result from public.${table}`),
        `the other company's ${table}`,
      ).toBe(1);
    }
  });
});
