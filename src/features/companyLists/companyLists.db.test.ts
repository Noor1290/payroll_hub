// @vitest-environment node
import { PGlite } from "@electric-sql/pglite";
import { STORAGE_STAND_IN } from "@/test/storageStandIn";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Migration 0024 (company lists and status) in a real Postgres (PGlite), used the way the Data
 * API does: as the role "authenticated" (or "anon") with a user id in the request claims. The
 * same stand-ins as templateOwnValues.db.test.ts. Fake data only.
 */
const files = import.meta.glob<string>("../../../supabase/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const migrations = Object.entries(files)
  .map(([path, sql]) => ({ name: path.split("/").pop()!, sql }))
  .sort((a, b) => a.name.localeCompare(b.name));

const A = "00000000-0000-4000-8000-0000000000a1"; // admin of ABC and DEF, viewer of GHI
const V = "00000000-0000-4000-8000-0000000000a2"; // viewer of ABC
const O = "00000000-0000-4000-8000-0000000000a3"; // member of nothing
const ABC = "10000000-0000-4000-8000-000000000001";
const DEF = "10000000-0000-4000-8000-000000000003";
const GHI = "10000000-0000-4000-8000-000000000004";
const RUN = "20000000-0000-4000-8000-000000000001";
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
    ('${ABC}', 'ABC Co Ltd', 'C1'), ('${DEF}', 'DEF Ltd', 'C3'), ('${GHI}', 'GHI Ltd', 'C4');
  insert into public.company_members (company_id, user_id, role) values
    ('${ABC}', '${A}', 'admin'), ('${ABC}', '${V}', 'viewer'), ('${DEF}', '${A}', 'admin'),
    ('${GHI}', '${A}', 'viewer');
  insert into public.payroll_runs (id, company_id, period, status) values
    ('${RUN}', '${ABC}', '2026-11-01', 'draft');
`;

describe("0024: company lists and status", () => {
  let db: PGlite;

  const as = async <T>(user: string | null, sql: string, params: unknown[] = []) => {
    await db.exec(
      `set request.jwt.claim.sub = '${user ?? ""}'; set role ${user ? "authenticated" : "anon"};`,
    );
    try {
      return await db.query<T>(sql, params);
    } finally {
      await db.exec("reset role;");
    }
  };
  const change = (user: string | null, changes: unknown) =>
    as<{ r: { added: number; removed: number } }>(
      user,
      "select public.set_company_app_lists($1::jsonb) as r",
      [JSON.stringify(changes)],
    );
  const lists = async (user: string | null) =>
    (
      await as<{ company_id: string; list: string }>(
        user,
        "select company_id, list from public.company_app_lists order by company_id, list",
      )
    ).rows.map((row) => `${row.company_id.slice(-1)}:${row.list}`);
  const record = (user: string | null, company: string, totals: object = { csg: 1200.5 }) =>
    as<{ r: { run_status: string | null; month_revision: number | null } }>(
      user,
      "select public.record_mra_file($1, '2026-11-01', 'csg', 3, $2::jsonb, false) as r",
      [company, JSON.stringify(totals)],
    );

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(STAND_INS);
    for (const { sql } of migrations) {
      await db.exec(`set role migration_owner; ${sql}; reset role;`);
    }
    await db.exec(SEED);
  }, SETUP_TIMEOUT);
  afterAll(() => db.close());

  it("verification row: one row, every column true", async () => {
    const sql = migrations.find((m) => m.name.startsWith("0024"))!.sql;
    const query = sql.slice(sql.indexOf("-- ---------- verification"));
    const result = await db.query<Record<string, boolean>>(query);
    expect(result.rows).toHaveLength(1);
    expect(Object.keys(result.rows[0]!)).toHaveLength(9);
    expect(result.rows[0]).toEqual(
      Object.fromEntries(Object.keys(result.rows[0]!).map((key) => [key, true])),
    );
  });

  it("starts with every company switched off", async () => {
    expect(await lists(A)).toEqual([]);
  });

  it("an admin switches companies on in several lists in one save", async () => {
    const saved = await change(A, [
      { company_id: ABC, list: "payslips", on: true },
      { company_id: ABC, list: "csg", on: true },
      { company_id: DEF, list: "csg", on: true },
    ]);
    expect(saved.rows[0]!.r).toEqual({ added: 3, removed: 0 });
    expect(await lists(A)).toEqual(["1:csg", "1:payslips", "3:csg"]);
  });

  it("is read by the company's members only", async () => {
    expect(await lists(V)).toEqual(["1:csg", "1:payslips"]);
    expect(await lists(O)).toEqual([]);
    await expect(lists(null)).rejects.toThrow();
  });

  it("switches off, and saving the same again changes nothing", async () => {
    const off = await change(A, [
      { company_id: DEF, list: "csg", on: false },
      { company_id: ABC, list: "payslips", on: true },
    ]);
    expect(off.rows[0]!.r).toEqual({ added: 0, removed: 1 });
    expect(await lists(A)).toEqual(["1:csg", "1:payslips"]);
  });

  it("refuses the whole save when one company is not the caller's to change", async () => {
    await expect(
      change(A, [
        { company_id: DEF, list: "prgf", on: true },
        { company_id: GHI, list: "prgf", on: true },
      ]),
    ).rejects.toThrow("PH_NOT_ADMIN");
    await expect(change(V, [{ company_id: ABC, list: "csg", on: false }])).rejects.toThrow(
      "PH_NOT_ADMIN",
    );
    await expect(change(O, [{ company_id: ABC, list: "csg", on: false }])).rejects.toThrow(
      "PH_NOT_ADMIN",
    );
    await expect(change(null, [])).rejects.toThrow();
    // Someone who is admin of no company is refused before the input is looked at.
    await expect(change(V, "not a list")).rejects.toThrow("PH_NOT_ADMIN");
    expect(await lists(A)).toEqual(["1:csg", "1:payslips"]);
  });

  it("refuses changes that are not valid", async () => {
    const bad = [
      { company_id: ABC, list: "pdf", on: true },
      { company_id: ABC, list: "csg", on: "yes" },
      { company_id: "not-an-id", list: "csg", on: true },
      { company_id: ABC, list: "csg", on: true, extra: 1 },
      "ABC",
    ];
    for (const one of bad) {
      await expect(change(A, [one])).rejects.toThrow("PH_INVALID_INPUT");
    }
    await expect(change(A, { company_id: ABC })).rejects.toThrow("PH_INVALID_INPUT");
    await expect(
      change(A, [
        { company_id: ABC, list: "csg", on: true },
        { company_id: ABC, list: "csg", on: false },
      ]),
    ).rejects.toThrow("PH_INVALID_INPUT");
  });

  it("cannot be written directly", async () => {
    await expect(
      as(A, `insert into public.company_app_lists (company_id, list) values ('${DEF}', 'prgf')`),
    ).rejects.toThrow();
    await expect(as(A, "delete from public.company_app_lists")).rejects.toThrow();
  });

  it("records an MRA file, looking up the run's status itself", async () => {
    const made = await record(A, ABC);
    expect(made.rows[0]!.r).toMatchObject({ run_status: "draft", month_revision: null });
    const read = await as<{ kind: string; employee_count: number; made_by: string }>(
      V,
      "select kind, employee_count, made_by from public.mra_file_records",
    );
    expect(read.rows).toEqual([{ kind: "csg", employee_count: 3, made_by: A }]);
    expect((await as(O, "select * from public.mra_file_records")).rows).toEqual([]);
  });

  it("records MRA files for admins only, with totals that are numbers", async () => {
    await expect(record(V, ABC)).rejects.toThrow("PH_NOT_ADMIN");
    await expect(record(A, GHI)).rejects.toThrow("PH_NOT_ADMIN");
    await expect(record(A, ABC, { name: "Someone" })).rejects.toThrow("PH_INVALID_INPUT");
    await expect(
      as(
        A,
        `insert into public.mra_file_records (company_id, period, kind, employee_count, totals, warnings)
             values ('${ABC}', '2026-11-01', 'csg', 1, '{}', false)`,
      ),
    ).rejects.toThrow();
  });

  it("records who approved a run and when, and setting it back", async () => {
    await as(A, `update public.payroll_runs set status = 'approved' where id = '${RUN}'`);
    // Saving the same status again is not a change.
    await as(A, `update public.payroll_runs set status = 'approved' where id = '${RUN}'`);
    await as(A, `update public.payroll_runs set status = 'draft' where id = '${RUN}'`);
    const read = await as<{ status: string; changed_by: string }>(
      V,
      "select status, changed_by from public.payroll_run_approvals order by changed_at, status desc",
    );
    expect(read.rows).toEqual([
      { status: "approved", changed_by: A },
      { status: "draft", changed_by: A },
    ]);
    expect((await as(O, "select * from public.payroll_run_approvals")).rows).toEqual([]);
    await expect(
      as(
        A,
        `insert into public.payroll_run_approvals (run_id, company_id, period, status)
             values ('${RUN}', '${ABC}', '2026-11-01', 'approved')`,
      ),
    ).rejects.toThrow();
  });

  it("delete_company removes the lists and both records with the company", async () => {
    const deleted = await as<{ r: Record<string, number> }>(
      A,
      "select public.delete_company($1, 'ABC Co Ltd') as r",
      [ABC],
    );
    expect(deleted.rows[0]!.r).toMatchObject({
      app_lists: 2,
      mra_file_records: 1,
      run_approvals: 2,
      runs: 1,
    });
    const left = await db.query<{ n: number }>(
      `select (select count(*) from public.company_app_lists)
            + (select count(*) from public.mra_file_records)
            + (select count(*) from public.payroll_run_approvals) as n`,
    );
    expect(Number(left.rows[0]!.n)).toBe(0);
  });
});
