// @vitest-environment node
import { PGlite } from "@electric-sql/pglite";
import { STORAGE_STAND_IN } from "@/test/storageStandIn";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 0023 (companies from an Excel file) in a real Postgres (PGlite), used the way the
 * Data API does: as the role "authenticated" (or "anon") with a user id in the request claims,
 * so these tests hold when the dashboard is bypassed. Fake data only.
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
const V = "00000000-0000-4000-8000-0000000000a2"; // viewer of ABC only
const O = "00000000-0000-4000-8000-0000000000a3"; // member of nothing
const B = "00000000-0000-4000-8000-0000000000a4"; // admin of XYZ
const ABC = "10000000-0000-4000-8000-000000000001";
const XYZ = "10000000-0000-4000-8000-000000000002";
const S_ABC = "20000000-0000-4000-8000-000000000001"; // shared setup used by ABC
const S_XYZ = "20000000-0000-4000-8000-000000000002"; // shared setup used by XYZ (A only a viewer)
const T_CSG = "30000000-0000-4000-8000-000000000001"; // MRA template used by ABC
const T_PRGF = "30000000-0000-4000-8000-000000000002"; // MRA template used by ABC
const T_XYZ = "30000000-0000-4000-8000-000000000003"; // MRA template used by XYZ
const SETUP_TIMEOUT = 120_000;

const SUPABASE_STAND_INS = `
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
  truncate public.companies cascade;
  delete from public.mra_templates;
  delete from public.payroll_shared_setups;
  delete from auth.users;
  insert into auth.users (id, email) values
    ('${A}', 'a@example.com'), ('${V}', 'v@example.com'), ('${O}', 'o@example.com'),
    ('${B}', 'b@example.com');
  insert into public.companies (id, name, brn) values
    ('${ABC}', 'ABC Co Ltd', 'C1234567'), ('${XYZ}', 'XYZ Trading Ltd', 'c 7654321');
  insert into public.company_members (company_id, user_id, role) values
    ('${ABC}', '${A}', 'admin'), ('${ABC}', '${V}', 'viewer'),
    ('${XYZ}', '${B}', 'admin'), ('${XYZ}', '${A}', 'viewer');
  insert into public.payroll_shared_setups (id, name, body, revision) values
    ('${S_ABC}', 'Main setup', '{"identityFields": [], "globalColumns": []}', 1),
    ('${S_XYZ}', 'XYZ setup', '{"identityFields": [], "globalColumns": []}', 1);
  insert into public.payroll_company_setups (company_id, shared_setup_id, body, revision) values
    ('${ABC}', '${S_ABC}', '{"columns": [], "customFields": []}', 1),
    ('${XYZ}', '${S_XYZ}', '{"columns": [], "customFields": []}', 1);
  insert into public.mra_templates (id, name, body, revision) values
    ('${T_CSG}', 'MRA CSG (PACO)', '{}', 1), ('${T_PRGF}', 'MRA PRGF', '{}', 1),
    ('${T_XYZ}', 'MRA CSG (PACO)', '{}', 1);
  insert into public.mra_template_companies (template_id, company_id, own_values, revision) values
    ('${T_CSG}', '${ABC}', '{}', 1), ('${T_PRGF}', '${ABC}', '{}', 1), ('${T_XYZ}', '${XYZ}', '{}', 1);
`;

type Role = "authenticated" | "anon";
type Outcome<T> = { result: T; error: null } | { result: null; error: string };

let db: PGlite;

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

interface Input {
  name?: string;
  brn?: string;
  address?: string | null;
  vat?: string | null;
  details?: unknown;
  mra?: unknown;
  setup?: string | null;
  templates?: string[];
}

const create = (user: string | null, input: Input = {}, role: Role = "authenticated") =>
  as(role, user, async () => {
    const { rows } = await db.query<{ result: Record<string, unknown> }>(
      "select public.create_company_with_details($1, $2, $3, $4, $5, $6, $7, $8) as result",
      [
        input.name ?? "New Venture Ltd",
        input.brn ?? "C 0011223",
        input.address ?? null,
        input.vat ?? null,
        JSON.stringify(input.details ?? []),
        input.mra === undefined ? null : JSON.stringify(input.mra),
        input.setup ?? null,
        input.templates ?? [],
      ],
    );
    return rows[0]!.result;
  });

const count = async (sql: string, params: unknown[] = []) =>
  Number(
    (await db.query<{ n: number }>(`select count(*)::int as n from ${sql}`, params)).rows[0]!.n,
  );
const companyByBrn = async (brn: string) =>
  (await db.query<Record<string, unknown>>("select * from public.companies where brn = $1", [brn]))
    .rows[0];
/** Everything a company created here could have left behind, counted. */
const traces = async () => ({
  companies: await count("public.companies"),
  members: await count("public.company_members"),
  details: await count("public.company_details"),
  mra: await count("public.mra_company_details"),
  setups: await count("public.payroll_company_setups"),
  setupHistory: await count("public.payroll_company_setup_history"),
  templateLinks: await count("public.mra_template_companies"),
});

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STAND_INS);
  for (const { sql } of migrations) await db.exec(`set role migration_owner; ${sql}; reset role;`);
}, SETUP_TIMEOUT);
afterAll(() => db.close());
beforeEach(async () => {
  await db.exec(SEED);
});

describe("0023: the migration", () => {
  it("answers one row, all true, and can be run again", async () => {
    const results = await db.exec(
      `set role migration_owner; ${migration("0023").sql}; reset role;`,
    );
    const row = results.filter((r) => r.rows.length === 1 && r.fields.length > 3).at(-1)!.rows[0];
    expect(Object.keys(row as object)).toHaveLength(5);
    expect(Object.values(row as object).every((value) => value === true)).toBe(true);
  });

  it("changes no company", async () => {
    const before = await traces();
    await db.exec(`set role migration_owner; ${migration("0023").sql}; reset role;`);
    expect(await traces()).toEqual(before);
  });
});

describe("0023: who may create companies from a file (also when the dashboard is bypassed)", () => {
  it.each([
    ["a viewer of a company", V],
    ["a member of nothing", O],
  ])("refuses %s, and stores nothing", async (_who, user) => {
    const before = await traces();
    const outcome = await create(user);
    expect(outcome.error).toContain("PH_NOT_ADMIN");
    expect(await traces()).toEqual(before);
  });

  it("refuses an anonymous visitor, who may not even call it", async () => {
    const outcome = await create(null, {}, "anon");
    expect(outcome.error).toMatch(/permission denied/);
    expect(await count("public.companies")).toBe(2);
  });

  it("checks who is calling before anything else: a member of nothing with no BRN is still PH_NOT_ADMIN", async () => {
    expect((await create(O, { brn: "" })).error).toContain("PH_NOT_ADMIN");
  });
});

describe("0023: one company, all of it", () => {
  it("creates the company, its details, its MRA details, the caller as admin, its setup and templates", async () => {
    const outcome = await create(A, {
      name: "  New Venture Ltd ",
      brn: " c 001 1223 ",
      address: "1 Main Road, Port Louis",
      vat: "VAT0012345",
      details: [
        { label: "TAN", value: "00123456" },
        { label: "Website contact", value: "Jane Doe" },
      ],
      mra: { ern: "013341", telephone: "212 3456", mobile: "5 712 3456", declarant: "Jane Doe" },
      setup: S_ABC,
      templates: [T_CSG, T_PRGF],
    });
    expect(outcome.error).toBeNull();
    const company = await companyByBrn("C0011223");
    expect(company).toMatchObject({
      name: "New Venture Ltd",
      address: "1 Main Road, Port Louis",
      vat: "VAT0012345",
    });
    const id = company!.id as string;
    expect(outcome.result).toMatchObject({
      id,
      brn: "C0011223",
      details: 2,
      setup: true,
      templates: 2,
    });

    const members = await db.query(
      "select user_id, role from public.company_members where company_id = $1",
      [id],
    );
    expect(members.rows).toEqual([{ user_id: A, role: "admin" }]);
    const details = await db.query(
      "select label, value, field_type, is_sensitive, sort_order from public.company_details where company_id = $1 order by sort_order",
      [id],
    );
    expect(details.rows).toEqual([
      { label: "TAN", value: "00123456", field_type: "text", is_sensitive: false, sort_order: 0 },
      {
        label: "Website contact",
        value: "Jane Doe",
        field_type: "text",
        is_sensitive: false,
        sort_order: 1,
      },
    ]);
    const mra = await db.query(
      "select ern, telephone, mobile, declarant, revision from public.mra_company_details where company_id = $1",
      [id],
    );
    expect(mra.rows).toEqual([
      {
        ern: "013341",
        telephone: "212 3456",
        mobile: "5 712 3456",
        declarant: "Jane Doe",
        revision: 1,
      },
    ]);
    const setup = await db.query(
      "select shared_setup_id, body, revision from public.payroll_company_setups where company_id = $1",
      [id],
    );
    expect(setup.rows).toEqual([
      { shared_setup_id: S_ABC, body: { columns: [], customFields: [] }, revision: 1 },
    ]);
    expect(await count("public.payroll_company_setup_history where company_id = $1", [id])).toBe(1);
    const templates = await db.query(
      "select template_id, own_values from public.mra_template_companies where company_id = $1 order by template_id",
      [id],
    );
    expect(templates.rows).toEqual([
      { template_id: T_CSG, own_values: {} },
      { template_id: T_PRGF, own_values: {} },
    ]);
  });

  it("creates just the company and its admin when nothing else is given", async () => {
    const before = await traces();
    expect((await create(A, { setup: null, templates: [] })).error).toBeNull();
    const after = await traces();
    expect(after).toEqual({
      ...before,
      companies: before.companies + 1,
      members: before.members + 1,
    });
  });

  it("stores no MRA details when every one is empty", async () => {
    expect(
      (await create(A, { mra: { ern: "", telephone: " ", mobile: "", declarant: "" } })).error,
    ).toBeNull();
    expect(await count("public.mra_company_details")).toBe(0);
  });
});

describe("0023: the BRN", () => {
  it.each([
    ["the same BRN", "C1234567"],
    ["other capitals", "c1234567"],
    ["spaces inside", "C 123 4567"],
    ["a BRN stored with a space, typed without", "C7654321"],
  ])("refuses %s as PH_DUPLICATE_BRN, and stores nothing", async (_how, brn) => {
    const before = await traces();
    expect((await create(A, { brn })).error).toContain("PH_DUPLICATE_BRN");
    expect(await traces()).toEqual(before);
  });

  it("refuses a missing BRN, a BRN with odd characters, and a missing name", async () => {
    expect((await create(A, { brn: "  " })).error).toContain(
      "PH_INVALID_INPUT: the BRN is required",
    );
    expect((await create(A, { brn: "C123/456" })).error).toContain("letters and digits only");
    expect((await create(A, { name: " " })).error).toContain("PH_INVALID_INPUT");
    expect(await count("public.companies")).toBe(2);
  });
});

describe("0023: all or nothing", () => {
  it.each<[string, Input, string]>([
    [
      "an MRA detail the database refuses",
      { mra: { ern: "01-33", telephone: "", mobile: "", declarant: "" } },
      "PH_INVALID_INPUT",
    ],
    [
      "a column setup it may not use (only a viewer of a company using it)",
      { setup: S_XYZ },
      "PH_NOT_ADMIN",
    ],
    [
      "a column setup that does not exist",
      { setup: "20000000-0000-4000-8000-000000000099" },
      "PH_NOT_FOUND",
    ],
    ["an MRA template it may not use", { templates: [T_CSG, T_XYZ] }, "PH_NOT_FOUND"],
    ["two MRA templates with the same name", { templates: [T_CSG, T_CSG] }, "PH_ALREADY_ATTACHED"],
    ["a detail with no value", { details: [{ label: "TAN", value: " " }] }, "PH_INVALID_INPUT"],
    [
      "two details with the same label",
      {
        details: [
          { label: "TAN", value: "1" },
          { label: "tan", value: "2" },
        ],
      },
      "same label",
    ],
    [
      "a detail label that is too long",
      { details: [{ label: "x".repeat(81), value: "1" }] },
      "PH_INVALID_INPUT",
    ],
  ])("stores nothing of the company when %s", async (_what, input, error) => {
    const before = await traces();
    const outcome = await create(A, {
      details: [{ label: "TAN", value: "00123456" }],
      mra: { ern: "013341" },
      setup: S_ABC,
      templates: [T_CSG],
      ...input,
    });
    expect(outcome.error).toContain(error);
    expect(await traces()).toEqual(before);
    expect(await companyByBrn("C0011223")).toBeUndefined();
  });

  it("one company failing leaves the others created", async () => {
    const first = await create(A, { name: "First Ltd", brn: "C1000001", setup: S_ABC });
    const failing = await create(A, { name: "Second Ltd", brn: "C1000002", setup: S_XYZ });
    const third = await create(A, { name: "Third Ltd", brn: "C1000003", templates: [T_CSG] });
    expect(first.error).toBeNull();
    expect(failing.error).toContain("PH_NOT_ADMIN");
    expect(third.error).toBeNull();
    expect(await companyByBrn("C1000001")).toBeDefined();
    expect(await companyByBrn("C1000002")).toBeUndefined();
    expect(await companyByBrn("C1000003")).toBeDefined();
  });
});
