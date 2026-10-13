// @vitest-environment node
import { PGlite } from "@electric-sql/pglite";
import { STORAGE_STAND_IN } from "@/test/storageStandIn";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NUMERIC_COLUMNS } from "@/config/payrollFields";

/**
 * Audit: two companies whose employees share the same IDs never mix. Runs every migration in a
 * real Postgres (PGlite, in memory) and uses the database the way the dashboard does: as the
 * role "authenticated" with a user id in the request claims. Nothing here touches the live
 * Supabase project. See payslipMigrations.db.test.ts for what stands in for Supabase.
 *
 * TEST data only: "TEST Co A" / "TEST Co B", employee IDs starting "TST".
 */
const files = import.meta.glob<string>("../../supabase/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const migrations = Object.entries(files)
  .map(([path, sql]) => ({ name: path.split("/").pop()!, sql }))
  .sort((a, b) => a.name.localeCompare(b.name));

const ADMIN_A = "00000000-0000-4000-8000-0000000000a1"; // admin of TEST Co A only
const ADMIN_B = "00000000-0000-4000-8000-0000000000b1"; // admin of TEST Co B only
const BOTH = "00000000-0000-4000-8000-0000000000c1"; // admin of both
const CO_A = "10000000-0000-4000-8000-00000000000a";
const CO_B = "10000000-0000-4000-8000-00000000000b";
const SEPTEMBER = "2026-09-01";
const OCTOBER = "2026-10-01";
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
  insert into auth.users (id) values ('${ADMIN_A}'), ('${ADMIN_B}'), ('${BOTH}');
  insert into public.companies (id, name, brn) values
    ('${CO_A}', 'TEST Co A', 'TEST-BRN-A'), ('${CO_B}', 'TEST Co B', 'TEST-BRN-B');
  insert into public.company_members (company_id, user_id, role) values
    ('${CO_A}', '${ADMIN_A}', 'admin'), ('${CO_B}', '${ADMIN_B}', 'admin'),
    ('${CO_A}', '${BOTH}', 'admin'), ('${CO_B}', '${BOTH}', 'admin');
`;

type Outcome<T> = { result: T; error: null } | { result: null; error: string };

async function as<T>(db: PGlite, user: string, work: () => Promise<T>): Promise<Outcome<T>> {
  await db.exec("set role authenticated");
  await db.query("select set_config('request.jwt.claims', $1, false)", [
    JSON.stringify({ sub: user, role: "authenticated" }),
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

/** Rows a signed-in user gets from a query: what row level security lets them see. */
function seenBy<T>(db: PGlite, user: string, sql: string, params: unknown[] = []) {
  return as(db, user, async () => (await db.query<T>(sql, params)).rows);
}

/** One employee's line of a run, every money column set from `netPay` so mix-ups show. */
function entry(nationalId: string, surname: string, netPay: number) {
  return {
    national_id: nationalId,
    surname,
    other_names: null,
    employment_type: null,
    age_60_plus: false,
    extra: { employee_csg: netPay / 100 },
    ...Object.fromEntries(NUMERIC_COLUMNS.map((column) => [column, netPay])),
  };
}

const importRun = (
  db: PGlite,
  user: string,
  company: string,
  period: string,
  rows: unknown[],
  replace = false,
) =>
  as(db, user, async () => {
    await db.query("select public.import_payroll_run($1::uuid, $2::date, $3::jsonb, $4)", [
      company,
      period,
      JSON.stringify(rows),
      replace,
    ]);
    return true;
  });

/** [national id, net pay] of every entry of a company's month, read as `user`. */
async function netPays(db: PGlite, user: string, company: string, period: string) {
  const seen = await seenBy<{ national_id: string; net_pay: string }>(
    db,
    user,
    `select e.national_id, p.net_pay::text as net_pay
     from public.payroll_entries p
     join public.payroll_runs r on r.id = p.run_id
     join public.employees e on e.id = p.employee_id
     where r.company_id = $1 and r.period = $2
     order by e.national_id`,
    [company, period],
  );
  return seen.result?.map((row) => [row.national_id, Number(row.net_pay)]) ?? seen.error;
}

describe("two companies with the same employee IDs", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(SUPABASE_STAND_INS);
    for (const { sql } of migrations) {
      await db.exec(`set role migration_owner; ${sql}; reset role;`);
    }
    await db.exec(SEED);

    // TEST Co A: TST001 and TST002 in September, TST001 (with a rise) and TST003 in October.
    // TEST Co B: TST001 and TST002 in September, different people with different figures.
    const imports = [
      await importRun(db, ADMIN_A, CO_A, SEPTEMBER, [
        entry("TST001", "ALPHA", 18750),
        entry("TST002", "BETA", 100000),
      ]),
      await importRun(db, ADMIN_A, CO_A, OCTOBER, [
        entry("TST001", "ALPHA", 20000),
        entry("TST003", "GAMMA", 60000),
      ]),
      await importRun(db, ADMIN_B, CO_B, SEPTEMBER, [
        entry("TST001", "OTHER", 77000),
        entry("TST002", "ANOTHER", 5000),
      ]),
    ];
    for (const outcome of imports) expect(outcome.error).toBeNull();
  }, SETUP_TIMEOUT);

  afterAll(() => db?.close());

  it("keeps one employee record per company for the same ID", async () => {
    const { rows } = await db.query<{ company: string; national_id: string; surname: string }>(
      `select c.name as company, e.national_id, e.surname
       from public.employees e join public.companies c on c.id = e.company_id
       order by c.name, e.national_id`,
    );
    expect(rows).toEqual([
      { company: "TEST Co A", national_id: "TST001", surname: "ALPHA" },
      { company: "TEST Co A", national_id: "TST002", surname: "BETA" },
      { company: "TEST Co A", national_id: "TST003", surname: "GAMMA" },
      { company: "TEST Co B", national_id: "TST001", surname: "OTHER" },
      { company: "TEST Co B", national_id: "TST002", surname: "ANOTHER" },
    ]);
  });

  it("gives each company's month its own figures for the same ID", async () => {
    expect(await netPays(db, BOTH, CO_A, SEPTEMBER)).toEqual([
      ["TST001", 18750],
      ["TST002", 100000],
    ]);
    expect(await netPays(db, BOTH, CO_B, SEPTEMBER)).toEqual([
      ["TST001", 77000],
      ["TST002", 5000],
    ]);
  });

  it("keeps the months of one company apart: an employee in only one month is only there", async () => {
    expect(await netPays(db, ADMIN_A, CO_A, OCTOBER)).toEqual([
      ["TST001", 20000],
      ["TST003", 60000],
    ]);
    expect(await netPays(db, ADMIN_A, CO_A, SEPTEMBER)).toEqual([
      ["TST001", 18750],
      ["TST002", 100000],
    ]);
  });

  it("shows an admin of one company nothing of the other: no employee, run or entry", async () => {
    for (const [user, own, other] of [
      [ADMIN_A, CO_A, CO_B],
      [ADMIN_B, CO_B, CO_A],
    ] as const) {
      for (const table of ["employees", "payroll_runs"]) {
        const seen = await seenBy<{ company_id: string }>(
          db,
          user,
          `select distinct company_id from public.${table}`,
        );
        expect(seen.result, `${table} seen by ${user}`).toEqual([{ company_id: own }]);
      }
      expect(await netPays(db, user, other, SEPTEMBER)).toEqual([]);
    }
  });

  it("refuses an import into a company the user is not an admin of, and stores nothing", async () => {
    const before = await netPays(db, BOTH, CO_B, SEPTEMBER);
    const refused = await importRun(
      db,
      ADMIN_A,
      CO_B,
      SEPTEMBER,
      [entry("TST001", "INTRUDER", 1)],
      true,
    );
    expect(refused.error).toMatch(/PH_NOT_ADMIN|42501/);
    expect(await netPays(db, BOTH, CO_B, SEPTEMBER)).toEqual(before);
  });

  it("importing a month again for one company changes nothing for the other", async () => {
    const again = await importRun(
      db,
      ADMIN_A,
      CO_A,
      SEPTEMBER,
      [entry("TST001", "ALPHA", 19000), entry("TST002", "BETA", 100000)],
      true,
    );
    expect(again.error).toBeNull();
    expect(await netPays(db, BOTH, CO_A, SEPTEMBER)).toEqual([
      ["TST001", 19000],
      ["TST002", 100000],
    ]);
    expect(await netPays(db, BOTH, CO_B, SEPTEMBER)).toEqual([
      ["TST001", 77000],
      ["TST002", 5000],
    ]);
    // October of the same company is untouched too.
    expect(await netPays(db, BOTH, CO_A, OCTOBER)).toEqual([
      ["TST001", 20000],
      ["TST003", 60000],
    ]);
  });

  describe("issued payslips", () => {
    const templates: Record<string, string> = {};
    const slip = (company: string, netPay: number) => ({
      national_id: "TST001",
      expected_revision: 0,
      template_id: templates[company],
      template_version: 1,
      rates: null,
      lines: [{ label: "Net pay", amount: netPay }],
      accepted_differences: [],
    });
    const issue = (user: string, company: string, period: string, payslips: unknown[]) =>
      as(db, user, async () => {
        await db.query("select public.issue_payslips($1::uuid, $2::date, $3::jsonb)", [
          company,
          period,
          JSON.stringify(payslips),
        ]);
        return true;
      });
    const issuedFor = async (user: string, company: string, period: string) => {
      const seen = await as(db, user, async () => {
        const { rows } = await db.query<{ result: { national_id: string; lines: unknown }[] }>(
          "select public.issued_payslips_for_month($1::uuid, $2::date) as result",
          [company, period],
        );
        return rows[0]!.result;
      });
      return seen.result?.map((row) => [row.national_id, row.lines]) ?? seen.error;
    };

    beforeAll(async () => {
      for (const [user, company] of [
        [ADMIN_A, CO_A],
        [ADMIN_B, CO_B],
      ] as const) {
        const saved = await as(db, user, async () => {
          const { rows } = await db.query<{ result: { template_id: string } }>(
            "select public.save_payslip_template_draft($1::uuid, null, 'Monthly', '{}'::jsonb, 0) as result",
            [company],
          );
          return rows[0]!.result.template_id;
        });
        expect(saved.error).toBeNull();
        templates[company] = saved.result!;
        const published = await as(db, user, async () => {
          await db.query("select public.publish_payslip_template($1::uuid, $2::uuid, 1)", [
            company,
            saved.result,
          ]);
          return true;
        });
        expect(published.error).toBeNull();
      }
      expect((await issue(ADMIN_A, CO_A, SEPTEMBER, [slip(CO_A, 19000)])).error).toBeNull();
      expect((await issue(ADMIN_B, CO_B, SEPTEMBER, [slip(CO_B, 77000)])).error).toBeNull();
    }, SETUP_TIMEOUT);

    it("each company's history holds its own payslip for the shared ID", async () => {
      expect(await issuedFor(BOTH, CO_A, SEPTEMBER)).toEqual([
        ["TST001", [{ label: "Net pay", amount: 19000 }]],
      ]);
      expect(await issuedFor(BOTH, CO_B, SEPTEMBER)).toEqual([
        ["TST001", [{ label: "Net pay", amount: 77000 }]],
      ]);
    });

    it("an admin of one company gets nothing when asking for the other's month", async () => {
      expect(await issuedFor(ADMIN_A, CO_B, SEPTEMBER)).toEqual([]);
      expect(await issuedFor(ADMIN_B, CO_A, SEPTEMBER)).toEqual([]);
    });

    it("a month nothing was issued for is empty: the first month has nothing to compare with", async () => {
      expect(await issuedFor(ADMIN_A, CO_A, "2026-08-01")).toEqual([]);
      expect(await issuedFor(ADMIN_A, CO_A, OCTOBER)).toEqual([]);
    });

    it("one company cannot issue with the other's template, or for the other company", async () => {
      const foreignTemplate = await issue(ADMIN_A, CO_A, OCTOBER, [
        { ...slip(CO_A, 1), template_id: templates[CO_B] },
      ]);
      expect(foreignTemplate.error).toMatch(/PH_UNKNOWN_TEMPLATE/);
      const foreignCompany = await issue(ADMIN_A, CO_B, OCTOBER, [slip(CO_B, 1)]);
      expect(foreignCompany.error).toMatch(/PH_NOT_ADMIN/);
      expect(await issuedFor(BOTH, CO_B, OCTOBER)).toEqual([]);
    });

    it("a re-issue for one company adds a revision there and leaves the other company's payslip alone", async () => {
      const again = await issue(ADMIN_A, CO_A, SEPTEMBER, [
        { ...slip(CO_A, 19500), expected_revision: 1 },
      ]);
      expect(again.error).toBeNull();
      expect(await issuedFor(BOTH, CO_A, SEPTEMBER)).toEqual([
        ["TST001", [{ label: "Net pay", amount: 19500 }]],
      ]);
      expect(await issuedFor(BOTH, CO_B, SEPTEMBER)).toEqual([
        ["TST001", [{ label: "Net pay", amount: 77000 }]],
      ]);
      const { rows } = await db.query<{ company_id: string; revisions: number }>(
        `select company_id, count(*)::int as revisions from public.issued_payslips
         group by company_id order by company_id`,
      );
      expect(rows).toEqual([
        { company_id: CO_A, revisions: 2 },
        { company_id: CO_B, revisions: 1 },
      ]);
    });
  });

  it("deleting one company removes its data and leaves the other's exactly as it was", async () => {
    const before = await netPays(db, BOTH, CO_B, SEPTEMBER);
    const deleted = await as(db, ADMIN_A, async () => {
      await db.query("select public.delete_company($1::uuid, $2)", [CO_A, "TEST Co A"]);
      return true;
    });
    expect(deleted.error).toBeNull();
    const { rows } = await db.query<{ name: string; employees: number; entries: number }>(
      `select c.name,
         (select count(*)::int from public.employees e where e.company_id = c.id) as employees,
         (select count(*)::int from public.payroll_entries p
            join public.payroll_runs r on r.id = p.run_id where r.company_id = c.id) as entries
       from public.companies c order by c.name`,
    );
    expect(rows).toEqual([{ name: "TEST Co B", employees: 2, entries: 2 }]);
    expect(await netPays(db, ADMIN_B, CO_B, SEPTEMBER)).toEqual(before);
  });
});
