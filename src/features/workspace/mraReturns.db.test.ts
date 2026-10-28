// @vitest-environment node
import { PGlite } from "@electric-sql/pglite";
import { FUNCTIONS, TABLES } from "@/safety/nonmemberChecks";
import { STORAGE_STAND_IN } from "@/test/storageStandIn";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Migration 0020 (MRA Returns) in a real Postgres (PGlite), used the way the Data API does: as
 * the role "authenticated" (or "anon") with a user id in the request claims. The same
 * stand-ins as templateInUse.db.test.ts. Fake data only.
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

const A = "00000000-0000-4000-8000-0000000000a1"; // admin of ABC and DEF, viewer of XYZ
const V = "00000000-0000-4000-8000-0000000000a2"; // viewer of ABC
const O = "00000000-0000-4000-8000-0000000000a3"; // member of nothing
const B = "00000000-0000-4000-8000-0000000000a4"; // admin of XYZ only
const C = "00000000-0000-4000-8000-0000000000a5"; // admin of ABC and XYZ
const ABC = "10000000-0000-4000-8000-000000000001";
const XYZ = "10000000-0000-4000-8000-000000000002";
const DEF = "10000000-0000-4000-8000-000000000003";
const T1 = "40000000-0000-4000-8000-000000000001";
const T2 = "40000000-0000-4000-8000-000000000002";
const T3 = "40000000-0000-4000-8000-000000000003";
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
  insert into auth.users (id) values ('${A}'), ('${V}'), ('${O}'), ('${B}'), ('${C}');
  insert into public.companies (id, name, brn) values
    ('${ABC}', 'ABC Co Ltd', 'C1'), ('${XYZ}', 'XYZ Trading Ltd', 'C2'), ('${DEF}', 'DEF Ltd', 'C3');
  insert into public.company_members (company_id, user_id, role) values
    ('${ABC}', '${A}', 'admin'), ('${ABC}', '${V}', 'viewer'), ('${DEF}', '${A}', 'admin'),
    ('${XYZ}', '${B}', 'admin'), ('${XYZ}', '${A}', 'viewer'),
    ('${ABC}', '${C}', 'admin'), ('${XYZ}', '${C}', 'admin');
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

/** What a user sees of a table through row level security. */
const visible = (db: PGlite, user: string | null, table: string, role: Role = "authenticated") =>
  as(db, role, user, async () => (await db.query(`select * from public.${table}`)).rows.length);

async function selfCheck(db: PGlite, number: string): Promise<Record<string, unknown>> {
  const results = await db.exec(`set role migration_owner; ${migration(number).sql}; reset role;`);
  return results.filter((r) => r.rows.length === 1 && r.fields.length > 3).at(-1)!
    .rows[0] as Record<string, unknown>;
}

interface Saved {
  template_id: string;
  name: string;
  revision: number;
}

const BODY = {
  rows: [{ kind: "copy", cells: ["MRA", "PACO", "V1.0"] }],
  settings: { encoding: "windows-1252" },
};
const OTHER_BODY = { rows: [{ kind: "copy", cells: ["MRA", "PRGF", "V1.0"] }] };

const save = (
  db: PGlite,
  user: string | null,
  template: string,
  company: string,
  name: string,
  body: unknown,
  expected: number,
  role: Role = "authenticated",
) =>
  one<Saved>(
    db,
    user,
    "select public.save_mra_template($1::uuid, $2::uuid, $3, $4::jsonb, $5::int) as result",
    [template, company, name, JSON.stringify(body), expected],
    role,
  );

const attach = (db: PGlite, user: string | null, template: string, company: string, values = {}) =>
  one<{ revision: number }>(
    db,
    user,
    "select public.attach_mra_template($1::uuid, $2::uuid, $3::jsonb) as result",
    [template, company, JSON.stringify(values)],
  );

const saveValues = (
  db: PGlite,
  user: string | null,
  template: string,
  company: string,
  values: unknown,
  expected: number,
) =>
  one<{ revision: number }>(
    db,
    user,
    "select public.save_mra_template_values($1::uuid, $2::uuid, $3::jsonb, $4::int) as result",
    [template, company, JSON.stringify(values), expected],
  );

const detach = (
  db: PGlite,
  user: string | null,
  template: string,
  company: string,
  expected: number,
) =>
  one<{ deleted: boolean; name: string }>(
    db,
    user,
    "select public.detach_mra_template($1::uuid, $2::uuid, $3::int) as result",
    [template, company, expected],
  );

const access = (db: PGlite, user: string | null, template: string) =>
  one<{ can_change: boolean; companies: number; admin_of: number }>(
    db,
    user,
    "select public.mra_template_access($1::uuid) as result",
    [template],
  );

const saveDetails = (
  db: PGlite,
  user: string | null,
  company: string,
  details: { ern: string; telephone: string; mobile: string; declarant: string },
  expected: number,
  role: Role = "authenticated",
) =>
  one<{ ern: string; revision: number }>(
    db,
    user,
    "select public.save_mra_company_details($1::uuid, $2, $3, $4, $5, $6::int) as result",
    [company, details.ern, details.telephone, details.mobile, details.declarant, expected],
    role,
  );

const saveEmail = (
  db: PGlite,
  user: string | null,
  email: string,
  expected: number,
  role: Role = "authenticated",
) =>
  one<{ email: string; revision: number }>(
    db,
    user,
    "select public.save_mra_settings($1, $2::int) as result",
    [email, expected],
    role,
  );

/** Everything stored by 0020, to show that a refused call changed nothing. */
const snapshot = async (db: PGlite) =>
  JSON.stringify(
    (
      await db.query(
        `select
           (select coalesce(jsonb_agg(t order by t.id), '[]') from public.mra_templates t) as templates,
           (select coalesce(jsonb_agg(h order by h.template_id, h.revision), '[]') from public.mra_template_history h) as history,
           (select coalesce(jsonb_agg(c order by c.template_id, c.company_id), '[]') from public.mra_template_companies c) as links,
           (select coalesce(jsonb_agg(d order by d.company_id), '[]') from public.mra_company_details d) as details,
           (select coalesce(jsonb_agg(s order by s.user_id), '[]') from public.mra_settings s) as settings`,
      )
    ).rows,
  );

const DETAILS = { ern: "013341", telephone: "", mobile: "5798 0000", declarant: "A. SAMPLE" };

describe("0020: the migration itself", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDatabase();
  }, SETUP_TIMEOUT);
  afterAll(() => db?.close());

  it("reports every check as true, the first time and when run again", async () => {
    const first = await selfCheck(db, "0020");
    expect(Object.keys(first).length).toBeGreaterThanOrEqual(12);
    expect(
      Object.values(first).every((value) => value === true),
      JSON.stringify(first),
    ).toBe(true);
    const again = await selfCheck(db, "0020");
    expect(again).toEqual(first);
  });

  it("gives anonymous visitors nothing: no table and no function", async () => {
    for (const table of [
      "mra_templates",
      "mra_template_history",
      "mra_template_companies",
      "mra_company_details",
      "mra_settings",
    ]) {
      expect((await visible(db, null, table, "anon")).error).toMatch(/^42501 permission denied/);
    }
    expect((await save(db, null, T1, ABC, "MRA CSG (PACO)", BODY, 0, "anon")).error).toMatch(
      /^42501 permission denied/,
    );
    expect((await saveDetails(db, null, ABC, DETAILS, 0, "anon")).error).toMatch(
      /^42501 permission denied/,
    );
    expect((await saveEmail(db, null, "a@example.org", 0, "anon")).error).toMatch(
      /^42501 permission denied/,
    );
  });

  it("lets nobody write a table directly, not even an admin", async () => {
    for (const [table, row] of [
      ["mra_templates", `('${T1}', 'X', '{}', 1)`],
      ["mra_template_companies", `('${T1}', '${ABC}', '{}', 1)`],
    ] as const) {
      const outcome = await as(db, "authenticated", A, () =>
        db.query(`insert into public.${table} values ${row}`),
      );
      expect(outcome.error).toMatch(/^42501 permission denied/);
    }
    const update = await as(db, "authenticated", A, () =>
      db.query("update public.mra_company_details set ern = ern"),
    );
    expect(update.error).toMatch(/^42501 permission denied/);
  });
});

describe("0020: templates follow the Global columns rule", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDatabase();
  }, SETUP_TIMEOUT);
  afterAll(() => db?.close());

  it("makes a template for a company an admin is working in, with its first revision kept", async () => {
    const made = await save(db, C, T1, ABC, "  MRA CSG (PACO)  ", BODY, 0);
    expect(made.error).toBeNull();
    expect(made.result).toMatchObject({ template_id: T1, name: "MRA CSG (PACO)", revision: 1 });
    const { rows } = await db.query<{ revision: number; company_id: string; own_values: unknown }>(
      `select h.revision, c.company_id, c.own_values from public.mra_template_history h
         join public.mra_template_companies c on c.template_id = h.template_id`,
    );
    expect(rows).toEqual([{ revision: 1, company_id: ABC, own_values: {} }]);
  });

  it("refuses a viewer, a non-member and an admin of another company, changing nothing", async () => {
    const before = await snapshot(db);
    for (const user of [V, O, B]) {
      expect((await save(db, user, T2, ABC, "Mine", BODY, 0)).error).toContain("PH_NOT_ADMIN");
      expect((await save(db, user, T1, ABC, "Mine", BODY, 1)).error).toContain("PH_NOT_ADMIN");
      expect((await saveValues(db, user, T1, ABC, { x: 1 }, 1)).error).toContain("PH_NOT_ADMIN");
      expect((await detach(db, user, T1, ABC, 1)).error).toContain("PH_NOT_ADMIN");
    }
    expect((await save(db, null, T2, ABC, "Mine", BODY, 0)).error).toContain("PH_NOT_SIGNED_IN");
    expect(await snapshot(db)).toBe(before);
  });

  it("shows a template only to admins of a company using it", async () => {
    expect((await visible(db, A, "mra_templates")).result).toBe(1);
    expect((await visible(db, C, "mra_template_history")).result).toBe(1);
    for (const user of [V, O, B]) {
      expect((await visible(db, user, "mra_templates")).result).toBe(0);
      expect((await visible(db, user, "mra_template_history")).result).toBe(0);
      expect((await visible(db, user, "mra_template_companies")).result).toBe(0);
      expect((await access(db, user, T1)).result).toEqual({
        can_change: false,
        companies: 0,
        admin_of: 0,
      });
    }
  });

  it("uses it in another company only for someone who may change it", async () => {
    // B is an admin of XYZ but cannot see the template: told it does not exist.
    expect((await attach(db, B, T1, XYZ)).error).toContain("PH_NOT_FOUND");
    // A sees it (admin of ABC) but is only a viewer of XYZ.
    expect((await attach(db, A, T1, XYZ)).error).toContain("PH_NOT_ADMIN");
    // C is an admin of both.
    const attached = await attach(db, C, T1, XYZ, { "2:7": "xyz@example.org" });
    expect(attached.error).toBeNull();
    expect(attached.result).toMatchObject({ revision: 1 });
    expect((await attach(db, C, T1, XYZ)).error).toContain("PH_ALREADY_ATTACHED");
  });

  it("lets only an admin of EVERY company using it change it; each admin keeps its own values", async () => {
    expect((await access(db, A, T1)).result).toEqual({
      can_change: false,
      companies: 2,
      admin_of: 1,
    });
    expect((await access(db, B, T1)).result).toEqual({
      can_change: false,
      companies: 2,
      admin_of: 1,
    });
    expect((await access(db, C, T1)).result).toEqual({
      can_change: true,
      companies: 2,
      admin_of: 2,
    });

    expect((await save(db, A, T1, ABC, "MRA CSG (PACO)", OTHER_BODY, 1)).error).toContain(
      "PH_NOT_ADMIN",
    );
    expect((await save(db, B, T1, XYZ, "MRA CSG (PACO)", OTHER_BODY, 1)).error).toContain(
      "PH_NOT_ADMIN",
    );

    // Each admin changes the values of their own company, and only those.
    expect(
      (await saveValues(db, A, T1, ABC, { "2:7": "abc@example.org" }, 1)).result,
    ).toMatchObject({
      revision: 2,
    });
    expect((await saveValues(db, B, T1, XYZ, { "2:7": "x@example.org" }, 1)).result).toMatchObject({
      revision: 2,
    });
    expect((await saveValues(db, B, T1, ABC, {}, 2)).error).toContain("PH_NOT_ADMIN");
    // B sees XYZ's values, never ABC's.
    const seen = await as(
      db,
      "authenticated",
      B,
      async () =>
        (
          await db.query<{ company_id: string }>(
            "select company_id from public.mra_template_companies",
          )
        ).rows,
    );
    expect(seen.result).toEqual([{ company_id: XYZ }]);

    const saved = await save(db, C, T1, ABC, "MRA CSG (PACO)", OTHER_BODY, 1);
    expect(saved.result).toMatchObject({ revision: 2 });
  });

  it("refuses a save over a revision someone else replaced, changing nothing", async () => {
    const before = await snapshot(db);
    expect((await save(db, C, T1, ABC, "MRA CSG (PACO)", BODY, 1)).error).toContain("PH_STALE");
    expect((await saveValues(db, A, T1, ABC, {}, 1)).error).toContain("PH_STALE");
    // A new template with an id that is taken is not a new template.
    expect((await save(db, C, T1, ABC, "Again", BODY, 0)).error).toContain("PH_STALE");
    expect(await snapshot(db)).toBe(before);
  });

  it("keeps every revision in the history, each with its own body", async () => {
    const { rows } = await db.query<{ revision: number; body: unknown }>(
      `select revision, body from public.mra_template_history where template_id = $1 order by revision`,
      [T1],
    );
    expect(rows).toEqual([
      { revision: 1, body: BODY },
      { revision: 2, body: OTHER_BODY },
    ]);
  });

  it("keeps names unique in each company, whatever the capitals", async () => {
    expect((await save(db, C, T2, ABC, "mra csg (paco)", BODY, 0)).error).toContain(
      "PH_DUPLICATE_NAME",
    );
    expect((await save(db, A, T2, DEF, "MRA PRGF", BODY, 0)).result).toMatchObject({ revision: 1 });
    // DEF already has "MRA PRGF": T1 cannot be renamed to it once it is used there...
    expect((await save(db, C, T3, ABC, "MRA PRGF", BODY, 0)).result).toMatchObject({ revision: 1 });
    // ...and a template named like one of DEF's cannot be used in DEF.
    expect((await attach(db, A, T3, DEF)).error).toContain("PH_DUPLICATE_NAME");
    expect((await save(db, C, T1, ABC, "mra prgf", BODY, 2)).error).toContain("PH_DUPLICATE_NAME");
  });

  it("refuses bad input after the permission check, and a body over 256 KB", async () => {
    const big = { text: "x".repeat(262_200) };
    expect((await save(db, C, T1, ABC, "MRA CSG (PACO)", big, 2)).error).toContain("PH_TOO_LARGE");
    expect((await save(db, C, T1, ABC, "", BODY, 2)).error).toContain("PH_INVALID_INPUT");
    expect((await save(db, C, T1, ABC, "x".repeat(81), BODY, 2)).error).toContain(
      "PH_INVALID_INPUT",
    );
    const notObject = await one(
      db,
      C,
      "select public.save_mra_template($1::uuid, $2::uuid, 'X', '[]'::jsonb, 2) as result",
      [T1, ABC],
    );
    expect(notObject.error).toContain("PH_INVALID_INPUT");
    expect((await saveValues(db, A, T1, ABC, { text: "x".repeat(65_600) }, 2)).error).toContain(
      "PH_TOO_LARGE",
    );
  });

  it("takes a template out of a company, and deletes it with its history from the last one", async () => {
    expect((await detach(db, B, T1, XYZ, 1)).error).toContain("PH_STALE");
    expect((await detach(db, B, T1, XYZ, 2)).result).toMatchObject({
      deleted: false,
      name: "MRA CSG (PACO)",
    });
    expect((await visible(db, B, "mra_templates")).result).toBe(0);
    expect((await detach(db, B, T1, XYZ, 2)).error).toContain("PH_NOT_FOUND");

    expect((await detach(db, A, T1, ABC, 2)).result).toMatchObject({ deleted: true });
    const left = await db.query(
      `select (select count(*) from public.mra_templates where id = $1)::int as templates,
              (select count(*) from public.mra_template_history where template_id = $1)::int as history`,
      [T1],
    );
    expect(left.rows).toEqual([{ templates: 0, history: 0 }]);
  });

  it("allows at most 20 templates per company", async () => {
    const fresh = await freshDatabase();
    try {
      for (let i = 1; i <= 20; i += 1) {
        const id = `50000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
        expect((await save(fresh, A, id, DEF, `Template ${i}`, BODY, 0)).error).toBeNull();
      }
      const over = await save(
        fresh,
        A,
        "50000000-0000-4000-8000-000000000099",
        DEF,
        "One more",
        BODY,
        0,
      );
      expect(over.error).toContain("PH_LIMIT");
    } finally {
      await fresh.close();
    }
  });
});

describe("0020: a company's MRA details and a user's email", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDatabase();
  }, SETUP_TIMEOUT);
  afterAll(() => db?.close());

  it("stores the ERN as text, leading zeros kept, for an admin only", async () => {
    const saved = await saveDetails(db, A, ABC, { ...DETAILS, ern: " 013341 " }, 0);
    expect(saved.error).toBeNull();
    expect(saved.result).toMatchObject({ ern: "013341", revision: 1 });
    for (const user of [V, O, B]) {
      expect((await saveDetails(db, user, ABC, DETAILS, 1)).error).toContain("PH_NOT_ADMIN");
      expect((await visible(db, user, "mra_company_details")).result).toBe(0);
    }
    expect((await visible(db, A, "mra_company_details")).result).toBe(1);
  });

  it("refuses a stale save and values the MRA file cannot hold", async () => {
    const before = await snapshot(db);
    expect((await saveDetails(db, A, ABC, DETAILS, 0)).error).toContain("PH_STALE");
    expect((await saveDetails(db, A, DEF, DETAILS, 1)).error).toContain("PH_STALE");
    expect((await saveDetails(db, A, ABC, { ...DETAILS, ern: "01 33" }, 1)).error).toContain(
      "PH_INVALID_INPUT",
    );
    expect((await saveDetails(db, A, ABC, { ...DETAILS, mobile: "5798,0000" }, 1)).error).toContain(
      "PH_INVALID_INPUT",
    );
    expect(
      (await saveDetails(db, A, ABC, { ...DETAILS, declarant: "A\nSAMPLE" }, 1)).error,
    ).toContain("PH_INVALID_INPUT");
    expect(await snapshot(db)).toBe(before);
    expect((await saveDetails(db, A, ABC, { ...DETAILS, ern: "0001" }, 1)).result).toMatchObject({
      ern: "0001",
      revision: 2,
    });
  });

  it("keeps one email per user, read by that user only, saved by an admin of some company", async () => {
    expect((await saveEmail(db, A, " returns@example.org ", 0)).result).toMatchObject({
      email: "returns@example.org",
      revision: 1,
    });
    expect((await saveEmail(db, O, "o@example.org", 0)).error).toContain("PH_NOT_ADMIN");
    expect((await saveEmail(db, V, "v@example.org", 0)).error).toContain("PH_NOT_ADMIN");
    expect((await saveEmail(db, A, "x@example.org", 0)).error).toContain("PH_STALE");
    expect((await saveEmail(db, A, "a,b@example.org", 1)).error).toContain("PH_INVALID_INPUT");
    expect((await saveEmail(db, A, "no-at-sign", 1)).error).toContain("PH_INVALID_INPUT");
    expect((await visible(db, A, "mra_settings")).result).toBe(1);
    for (const user of [V, O, B, C]) {
      expect((await visible(db, user, "mra_settings")).result).toBe(0);
    }
    expect((await saveEmail(db, B, "", 0)).result).toMatchObject({ email: "", revision: 1 });
  });
});

describe("0020: delete_company also deletes the company's MRA data", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDatabase();
    // ABC alone uses T1; ABC and XYZ use T2; DEF alone uses T3.
    await save(db, C, T1, ABC, "MRA CSG (PACO)", BODY, 0);
    await save(db, C, T2, ABC, "MRA PRGF", OTHER_BODY, 0);
    await save(db, C, T2, ABC, "MRA PRGF", BODY, 1);
    await attach(db, C, T2, XYZ, { "2:7": "xyz@example.org" });
    await save(db, A, T3, DEF, "MRA PRGF", BODY, 0);
    await saveDetails(db, A, ABC, DETAILS, 0);
    await saveDetails(db, B, XYZ, DETAILS, 0);
    await saveEmail(db, A, "returns@example.org", 0);
  }, SETUP_TIMEOUT);
  afterAll(() => db?.close());

  it("deletes its links, its details and the templates no other company uses, with their history", async () => {
    const outcome = await one<Record<string, unknown>>(
      db,
      A,
      "select public.delete_company($1::uuid, 'ABC Co Ltd') as result",
      [ABC],
    );
    expect(outcome.error).toBeNull();
    expect(outcome.result).toMatchObject({
      mra_template_companies: 2,
      mra_templates: 1,
      mra_template_history: 1,
      mra_company_details: 1,
    });
    const { rows } = await db.query(
      `select
         (select jsonb_agg(id order by id) from public.mra_templates) as templates,
         (select jsonb_agg(jsonb_build_array(template_id, revision) order by template_id, revision)
            from public.mra_template_history) as history,
         (select jsonb_agg(jsonb_build_array(template_id, company_id) order by template_id)
            from public.mra_template_companies) as links,
         (select jsonb_agg(company_id) from public.mra_company_details) as details,
         (select count(*)::int from public.mra_settings) as settings`,
    );
    expect(rows).toEqual([
      {
        templates: [T2, T3],
        history: [
          [T2, 1],
          [T2, 2],
          [T3, 1],
        ],
        links: [
          [T2, XYZ],
          [T3, DEF],
        ],
        details: [XYZ],
        // A user's email is not the company's.
        settings: 1,
      },
    ]);
  });
});

describe("0020: the undo script", () => {
  const undoFiles = import.meta.glob<string>("../../../supabase/undo/0020_*.sql", {
    query: "?raw",
    import: "default",
    eager: true,
  });
  const undo = Object.values(undoFiles)[0]!;
  // Every line is commented out; using it means removing the "-- " at the start of each line.
  const body = undo.replace(/\r\n/g, "\n").split("\n");
  const header = body.findIndex((line, i) => i > 0 && line.startsWith("-- ====="));
  const runnable = body
    .slice(header + 1)
    .map((line) => line.replace(/^-- ?/, ""))
    .join("\n");
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDatabase();
  }, SETUP_TIMEOUT);
  afterAll(() => db?.close());

  it("does nothing as it is: every line is a comment", () => {
    expect(body.every((line) => line === "" || line.startsWith("--"))).toBe(true);
  });

  it("drops what 0020 added and puts back delete_company exactly as 0018 has it", async () => {
    const results = await db.exec(`set role migration_owner; ${runnable}; reset role;`);
    const check = results.filter((r) => r.rows.length === 1 && r.fields.length === 3).at(-1)!;
    expect(check.rows[0]).toEqual({
      tables_gone: true,
      functions_gone: true,
      delete_company_as_in_0018: true,
    });
    const source = (
      await db.query<{ src: string }>(
        "select prosrc as src from pg_proc where oid = 'public.delete_company(uuid, text)'::regprocedure",
      )
    ).rows[0]!.src;
    const in0018 = migration("0018").sql.replace(/\r\n/g, "\n");
    const start = in0018.indexOf("create or replace function public.delete_company(");
    const from = in0018.indexOf("$$", start) + 2;
    expect(source).toBe(in0018.slice(from, in0018.indexOf("$$;", from)));
    // A company can still be deleted, and 0020 can be run again afterwards.
    expect(
      (await one(db, A, "select public.delete_company($1::uuid, 'DEF Ltd') as result", [DEF]))
        .error,
    ).toBeNull();
    expect(Object.values(await selfCheck(db, "0020")).every((value) => value === true)).toBe(true);
  });
});

describe("0020: the non-member check's attempts, in a real database", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDatabase();
  }, SETUP_TIMEOUT);
  afterAll(() => db?.close());

  const mraFunctions = Object.entries(FUNCTIONS).filter(([name]) => name.includes("mra"));
  const mraTables = Object.entries(TABLES).filter(([name]) => name.startsWith("mra_"));

  /** Calls a function by its parameter names, as the Data API does, as the role and user given. */
  async function call(
    user: string | null,
    role: Role,
    name: string,
    args: Record<string, unknown>,
  ) {
    const { rows } = await db.query<{ arg: string; type: string }>(
      `select unnest(proargnames) as arg, unnest(proargtypes::regtype[]::text[]) as type
         from pg_proc where proname = $1`,
      [name],
    );
    const types = new Map(rows.map((row) => [row.arg, row.type]));
    const names = Object.keys(args);
    const values = names.map((arg) => {
      const value = args[arg];
      if (value === null || typeof value !== "object") return value;
      return JSON.stringify(value);
    });
    const list = names.map((arg, i) => `${arg} => $${i + 1}::${types.get(arg)}`).join(", ");
    return one(db, user, `select public.${name}(${list}) as result`, values, role);
  }

  it("covers the five tables and the nine functions 0020 adds", () => {
    expect(mraTables.map(([name]) => name).sort()).toEqual([
      "mra_company_details",
      "mra_settings",
      "mra_template_companies",
      "mra_template_history",
      "mra_templates",
    ]);
    expect(mraFunctions).toHaveLength(9);
  });

  it("is refused by each function's permission check, for a non-member and for anon", async () => {
    const before = await snapshot(db);
    for (const [name, spec] of mraFunctions) {
      const args = spec.args({ a: ABC, b: XYZ });
      const member = await call(O, "authenticated", name, args);
      if (spec.expect.kind === "write") {
        expect(member.error, name).toContain("PH_NOT_ADMIN");
      } else {
        expect(member.error, name).toBeNull();
        expect(spec.expect.ok(member.result), name).toBe(true);
      }
      expect((await call(null, "anon", name, args)).error, name).toMatch(
        /^42501 permission denied/,
      );
    }
    expect(await snapshot(db)).toBe(before);
  });

  it("stores nothing when a table is written directly, even by an admin of the company", async () => {
    const before = await snapshot(db);
    for (const user of [O, A]) {
      for (const [table, spec] of mraTables) {
        const row = spec.insert(ABC, user);
        const columns = Object.keys(row);
        const outcome = await as(db, "authenticated", user, () =>
          db.query(
            `insert into public.${table} (${columns.join(", ")}) values (${columns
              .map((_, i) => `$${i + 1}`)
              .join(", ")})`,
            columns.map((column) => {
              const value = row[column];
              return value !== null && typeof value === "object" ? JSON.stringify(value) : value;
            }),
          ),
        );
        expect(outcome.error, `${table} as ${user}`).toMatch(/^42501 permission denied/);
      }
    }
    expect(await snapshot(db)).toBe(before);
  });
});
