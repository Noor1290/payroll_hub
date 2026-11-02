// @vitest-environment node
import { PGlite } from "@electric-sql/pglite";
import { STORAGE_STAND_IN } from "@/test/storageStandIn";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Migration 0022 in a real Postgres (PGlite), used the way the Data API does: as the role
 * "authenticated" (or "anon") with a user id in the request claims. The same stand-ins as
 * templateInUse.db.test.ts. Fake data only.
 */
const files = import.meta.glob<string>("../../../supabase/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const migrations = Object.entries(files)
  .map(([path, sql]) => ({ name: path.split("/").pop()!, sql }))
  .sort((a, b) => a.name.localeCompare(b.name));
const undo = import.meta.glob<string>("../../../supabase/undo/0022*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

const A = "00000000-0000-4000-8000-0000000000a1"; // admin of ABC and DEF
const V = "00000000-0000-4000-8000-0000000000a2"; // viewer of ABC
const O = "00000000-0000-4000-8000-0000000000a3"; // member of nothing
const ABC = "10000000-0000-4000-8000-000000000001";
const DEF = "10000000-0000-4000-8000-000000000003";
const SETUP_TIMEOUT = 120_000;

const STAND_INS = `
  create role anon nologin;
  create role authenticated nologin;
  create role migration_owner nologin nosuperuser bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth to anon, authenticated, migration_owner;
  grant references on auth.users to migration_owner;
  alter schema public owner to migration_owner;
  ${STORAGE_STAND_IN}
`;

const SEED = `
  insert into auth.users (id) values ('${A}'), ('${V}'), ('${O}');
  insert into public.companies (id, name, brn) values
    ('${ABC}', 'ABC Co Ltd', 'C1'), ('${DEF}', 'DEF Ltd', 'C3');
  insert into public.company_members (company_id, user_id, role) values
    ('${ABC}', '${A}', 'admin'), ('${ABC}', '${V}', 'viewer'), ('${DEF}', '${A}', 'admin');
`;

describe("0022: a company's own values for a payslip template", () => {
  let db: PGlite;
  let template: string;

  const as = async <T,>(user: string | null, sql: string, params: unknown[] = []) => {
    await db.exec(
      `set request.jwt.claim.sub = '${user ?? ""}'; set role ${user ? "authenticated" : "anon"};`,
    );
    try {
      return await db.query<T>(sql, params);
    } finally {
      await db.exec("reset role;");
    }
  };
  const save = (user: string | null, company: string, id: string, values: object, revision: number) =>
    as<{ r: { values_revision: number } }>(
      user,
      "select public.save_payslip_template_values($1, $2, $3, $4) as r",
      [company, id, JSON.stringify(values), revision],
    );
  const copy = (company: string, body: object, revision: number) =>
    as(A, "select public.publish_payslip_template_copy($1, 'Monthly', $2, $3)", [
      company,
      JSON.stringify(body),
      revision,
    ]);

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(STAND_INS);
    for (const { sql } of migrations) {
      await db.exec(`set role migration_owner; ${sql}; reset role;`);
    }
    await db.exec(SEED);
    await copy(ABC, { schema: 2, one: 1 }, 0);
    const found = await db.query<{ id: string }>(
      `select id from public.payslip_templates where company_id = '${ABC}'`,
    );
    template = found.rows[0]!.id;
  }, SETUP_TIMEOUT);
  afterAll(() => db.close());

  it("verification row: one row, every column true", async () => {
    const sql = migrations.find((m) => m.name.startsWith("0022"))!.sql;
    const query = sql.slice(sql.indexOf("-- ---------- verification"));
    const result = await db.query<Record<string, boolean>>(query);
    expect(result.rows).toHaveLength(1);
    expect(Object.keys(result.rows[0]!)).toHaveLength(8);
    expect(Object.values(result.rows[0]!).every((value) => value === true)).toBe(true);
  });

  it("starts empty, and an admin replaces the values, revision by revision", async () => {
    const saved = await save(A, ABC, template, { c1: "Port Louis branch" }, 1);
    expect(saved.rows[0]!.r.values_revision).toBe(2);
    const read = await as<{ own_values: object; values_revision: number }>(
      V,
      `select own_values, values_revision from public.payslip_templates where id = '${template}'`,
    );
    expect(read.rows[0]).toEqual({ own_values: { c1: "Port Louis branch" }, values_revision: 2 });
  });

  it("refuses an old revision and stores nothing", async () => {
    await expect(save(A, ABC, template, { c1: "Older" }, 1)).rejects.toThrow("PH_STALE");
  });

  it("publishing to the company does not touch its own values", async () => {
    const before = await db.query<{ draft_revision: number }>(
      `select draft_revision from public.payslip_templates where id = '${template}'`,
    );
    await copy(ABC, { schema: 2, one: 2 }, before.rows[0]!.draft_revision);
    const read = await db.query<{ own_values: object; draft_body: object }>(
      `select own_values, draft_body from public.payslip_templates where id = '${template}'`,
    );
    expect(read.rows[0]!.draft_body).toEqual({ schema: 2, one: 2 });
    expect(read.rows[0]!.own_values).toEqual({ c1: "Port Louis branch" });
  });

  it("is for admins of that company only, checked in the database", async () => {
    await expect(save(V, ABC, template, {}, 2)).rejects.toThrow("PH_NOT_ADMIN");
    await expect(save(O, ABC, template, {}, 2)).rejects.toThrow("PH_NOT_ADMIN");
    await expect(save(null, ABC, template, {}, 2)).rejects.toThrow();
  });

  it("cannot reach a template of another company, even for an admin of both", async () => {
    await expect(save(A, DEF, template, {}, 2)).rejects.toThrow("PH_NOT_FOUND");
  });

  it("cannot be written directly", async () => {
    await expect(as(A, `update public.payslip_templates set own_values = '{}'`)).rejects.toThrow();
  });

  it("the undo script does nothing as it is, and names what it would drop", () => {
    const text = Object.values(undo)[0]!;
    const live = text.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("--"));
    expect(live).toEqual([]);
    expect(text).toContain("drop function if exists public.save_payslip_template_values");
  });
});
