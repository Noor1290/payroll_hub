import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { NUMERIC_COLUMNS } from "@/config/payrollFields";
import { classifyDataError } from "./errors";

type Call = [method: string, ...args: unknown[]];

/** A stand-in for the Supabase query builder that records every call made on it. */
const db = vi.hoisted(() => {
  const state = {
    calls: [] as Call[],
    result: { data: [] as unknown[], count: 0 as number | null, error: null as unknown },
  };
  const builder: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, property: string) {
        if (property === "then") {
          return (resolve: (value: unknown) => void) => resolve(state.result);
        }
        return (...args: unknown[]) => {
          state.calls.push([property, ...args]);
          return builder;
        };
      },
    },
  );
  return {
    state,
    client: {
      from: (name: string) => {
        state.calls.push(["from", name]);
        return builder;
      },
    },
  };
});

vi.mock("./client", () => ({ supabase: db.client }));

const {
  DB_TABLE_NAMES,
  DB_TABLES,
  fetchTableCounts,
  fetchTablePage,
  likeFilter,
  parseRow,
  safeSort,
  shortId,
} = await import("./database");

const VIEWER = { id: "00000000-0000-4000-8000-0000000000a1", isDemo: false };
const COMPANY = "10000000-0000-4000-8000-000000000001";
const RUN = "20000000-0000-4000-8000-000000000001";
const EMPLOYEE = "30000000-0000-4000-8000-000000000001";
const ENTRY = "40000000-0000-4000-8000-000000000001";
const NOW = "2026-09-28T10:15:00+00:00";

const query = (more: Record<string, unknown> = {}) => ({
  page: 0,
  pageSize: 50,
  sort: { column: "created_at", ascending: false },
  search: "",
  showDeleted: false,
  ...more,
});

const employeeRow = (more: Record<string, unknown> = {}) => ({
  id: EMPLOYEE,
  company_id: COMPANY,
  national_id: "X0000000000001",
  surname: "DOE",
  other_names: "JANE",
  employment_type: "Full Time",
  deleted_at: null,
  created_at: NOW,
  ...more,
});

const entryRow = (runDeletedAt: string | null = null) => ({
  id: ENTRY,
  run_id: RUN,
  employee_id: EMPLOYEE,
  ...Object.fromEntries(NUMERIC_COLUMNS.map((column) => [column, 100.5])),
  age_60_plus: false,
  extra: { Bonus: 1500 },
  created_at: NOW,
  payroll_runs: { company_id: COMPANY, deleted_at: runDeletedAt },
  employees: { surname: "DOE", other_names: "JANE", national_id: "X0000000000001" },
});

const calls = (method: string) => db.state.calls.filter(([name]) => name === method);

beforeEach(() => {
  db.state.calls = [];
  db.state.result = { data: [], count: 0, error: null };
});

describe("the table list", () => {
  it("covers exactly the five tables, and is read-only by construction", () => {
    expect(DB_TABLE_NAMES).toEqual([
      "companies",
      "employees",
      "payroll_runs",
      "payroll_entries",
      "company_members",
    ]);
  });

  it("marks national IDs and every salary or deduction figure as sensitive", () => {
    const sensitive = (name: (typeof DB_TABLE_NAMES)[number]) =>
      DB_TABLES[name].columns.filter((c) => c.sensitive).map((c) => c.key);

    expect(sensitive("employees")).toEqual(["national_id"]);
    expect(sensitive("payroll_entries")).toEqual(
      expect.arrayContaining([
        "basic_salary",
        "new_basic_salary",
        "gross_pay",
        "net_pay",
        "csg",
        "nsf",
        "paye",
        "levy",
        "prgf",
        "edf",
        "edf_monthly",
        "total_deductions",
        "total_mra_contributions",
        "extra",
      ]),
    );
    expect(sensitive("payroll_entries")).toHaveLength(NUMERIC_COLUMNS.length + 1);
    expect(sensitive("payroll_entries")).not.toContain("age_60_plus");
  });
});

describe("parseRow", () => {
  it("accepts a well-formed row and adds its key and deleted flag", () => {
    const row = parseRow(DB_TABLES.employees, employeeRow());
    expect(row).toMatchObject({ surname: "DOE", __key: EMPLOYEE, __deleted: false });
    expect(parseRow(DB_TABLES.employees, employeeRow({ deleted_at: NOW })).__deleted).toBe(true);
  });

  it("refuses a row that doesn't match the expected shape, rather than showing it", () => {
    expect(() => parseRow(DB_TABLES.employees, employeeRow({ surname: 42 }))).toThrow(ZodError);
    const missing: Record<string, unknown> = employeeRow();
    delete missing.national_id;
    expect(() => parseRow(DB_TABLES.employees, missing)).toThrow(ZodError);
    expect(() => parseRow(DB_TABLES.payroll_entries, { ...entryRow(), net_pay: "lots" })).toThrow(
      ZodError,
    );
    try {
      parseRow(DB_TABLES.employees, employeeRow({ id: "not-a-uuid" }));
    } catch (error) {
      expect(classifyDataError(error).kind).toBe("unexpected-shape");
    }
  });

  it("keeps user ids only in shortened form", () => {
    const user = "00000000-0000-4000-8000-0000000000a1";
    const member = parseRow(DB_TABLES.company_members, {
      company_id: COMPANY,
      user_id: user,
      role: "admin",
      created_at: NOW,
    });
    expect(member.user_id).toBe("00000000…");
    expect(JSON.stringify(member)).not.toContain(user);
    expect(member.__key).not.toContain(user);

    // Two users whose ids start the same still get different row keys.
    const other = parseRow(DB_TABLES.company_members, {
      company_id: COMPANY,
      user_id: "00000000-0000-4000-8000-0000000000a2",
      role: "viewer",
      created_at: NOW,
    });
    expect(other.user_id).toBe(member.user_id);
    expect(other.__key).not.toBe(member.__key);

    const run = parseRow(DB_TABLES.payroll_runs, {
      id: RUN,
      company_id: COMPANY,
      period: "2026-09-01",
      status: "draft",
      created_by: user,
      created_at: NOW,
      deleted_at: null,
    });
    expect(run.created_by).toBe(shortId(user));
  });

  it("drops the joined tables from an entry, and takes its deleted flag from its run", () => {
    const row = parseRow(DB_TABLES.payroll_entries, entryRow());
    expect(row).not.toHaveProperty("payroll_runs");
    expect(row).not.toHaveProperty("employees");
    expect(row.extra).toEqual({ Bonus: 1500 });
    expect(row.__deleted).toBe(false);
    expect(parseRow(DB_TABLES.payroll_entries, entryRow(NOW)).__deleted).toBe(true);
  });
});

describe("likeFilter", () => {
  it("builds a quoted, case-insensitive contains filter for each column", () => {
    expect(likeFilter(["surname", "other_names"], " doe ")).toBe(
      'surname.ilike."*doe*",other_names.ilike."*doe*"',
    );
  });

  it("stops user text from being read as filter syntax or wildcards", () => {
    expect(likeFilter(["name"], 'a,b.c(d)"e')).toBe('name.ilike."*a,b.c(d)\\"e*"');
    expect(likeFilter(["name"], "100%_x")).toBe('name.ilike."*100\\\\%\\\\_x*"');
  });
});

describe("safeSort", () => {
  it("only sorts by a real column of the table", () => {
    expect(safeSort(DB_TABLES.employees, { column: "surname", ascending: false })).toEqual({
      column: "surname",
      ascending: false,
    });
    expect(safeSort(DB_TABLES.employees, { column: "id; drop table", ascending: true })).toEqual(
      DB_TABLES.employees.defaultSort,
    );
    expect(safeSort(DB_TABLES.payroll_entries, { column: "extra", ascending: true })).toEqual(
      DB_TABLES.payroll_entries.defaultSort,
    );
  });
});

describe("fetchTablePage", () => {
  it("asks the API for one page at a time, including pages past row 1,000", async () => {
    db.state.result = { data: [employeeRow()], count: 2500, error: null };

    const page = await fetchTablePage(VIEWER, "employees", COMPANY, query({ page: 25 }));

    expect(calls("range")).toEqual([["range", 1250, 1299]]);
    expect(page.total).toBe(2500);
    expect(page.rows).toHaveLength(1);
    // The count comes from the server, so the page never has to load everything to know it.
    expect(calls("select")[0]![2]).toEqual({ count: "exact" });
  });

  it("never asks for more than 100 rows at once", async () => {
    await fetchTablePage(VIEWER, "employees", COMPANY, query({ page: 2, pageSize: 5000 }));
    expect(calls("range")).toEqual([["range", 200, 299]]);
  });

  it("scopes each table to the selected company and hides soft-deleted rows by default", async () => {
    const filters = async (table: (typeof DB_TABLE_NAMES)[number], showDeleted = false) => {
      db.state.calls = [];
      await fetchTablePage(VIEWER, table, COMPANY, query({ showDeleted }));
      return [...calls("eq"), ...calls("is")];
    };

    expect(await filters("companies")).toEqual([["eq", "id", COMPANY]]);
    expect(await filters("company_members")).toEqual([["eq", "company_id", COMPANY]]);
    expect(await filters("employees")).toEqual([
      ["eq", "company_id", COMPANY],
      ["is", "deleted_at", null],
    ]);
    expect(await filters("payroll_runs", true)).toEqual([["eq", "company_id", COMPANY]]);
    // Entries have no company of their own: they are reached through their run.
    expect(await filters("payroll_entries")).toEqual([
      ["eq", "payroll_runs.company_id", COMPANY],
      ["is", "payroll_runs.deleted_at", null],
    ]);
    expect(String(calls("select")[0]![1])).toContain("payroll_runs!inner(company_id, deleted_at)");
  });

  it("never selects from auth.users or with a wildcard", async () => {
    for (const table of DB_TABLE_NAMES) await fetchTablePage(VIEWER, table, COMPANY, query());
    const selected = calls("select").map((call) => String(call[1]));
    expect(calls("from").map((call) => call[1])).toEqual([...DB_TABLE_NAMES]);
    expect(selected.join(" ")).not.toMatch(/\*|auth|users\b/);
  });

  it("only ever reads: no insert, update, delete, upsert or rpc", async () => {
    for (const table of DB_TABLE_NAMES) {
      await fetchTablePage(VIEWER, table, COMPANY, query({ search: "doe" }));
    }
    await fetchTableCounts(VIEWER, COMPANY, true);
    const used = new Set(db.state.calls.map(([method]) => method));
    for (const write of ["insert", "update", "delete", "upsert", "rpc"]) {
      expect(used.has(write)).toBe(false);
    }
  });

  it("sorts on the server, with the row key as a tiebreaker so pages never overlap", async () => {
    await fetchTablePage(
      VIEWER,
      "employees",
      COMPANY,
      query({ sort: { column: "surname", ascending: true } }),
    );
    expect(calls("order")).toEqual([
      ["order", "surname", { ascending: true }],
      ["order", "id", { ascending: true }],
    ]);
  });

  it("searches on the server: text columns, a month for runs, the employee for entries", async () => {
    await fetchTablePage(VIEWER, "employees", COMPANY, query({ search: "doe" }));
    expect(calls("or")[0]).toEqual([
      "or",
      'surname.ilike."*doe*",other_names.ilike."*doe*",national_id.ilike."*doe*",employment_type.ilike."*doe*"',
    ]);

    db.state.calls = [];
    await fetchTablePage(VIEWER, "payroll_runs", COMPANY, query({ search: "2026-09" }));
    expect(calls("eq")).toContainEqual(["eq", "period", "2026-09-01"]);
    expect(calls("or")).toEqual([]);

    db.state.calls = [];
    await fetchTablePage(VIEWER, "payroll_entries", COMPANY, query({ search: "doe" }));
    expect(calls("or")[0]![2]).toEqual({ referencedTable: "employees" });
  });

  it("fails loudly on an unexpected response instead of showing wrong data", async () => {
    db.state.result = { data: [employeeRow({ surname: null })], count: 1, error: null };
    await expect(fetchTablePage(VIEWER, "employees", COMPANY, query())).rejects.toBeInstanceOf(
      ZodError,
    );

    db.state.result = { data: [employeeRow()], count: null, error: null };
    await expect(fetchTablePage(VIEWER, "employees", COMPANY, query())).rejects.toBeInstanceOf(
      ZodError,
    );
  });

  it("passes database errors on, and treats a page past the end as empty", async () => {
    db.state.result = {
      data: null as never,
      count: null,
      error: { code: "42501", message: "permission denied" },
    };
    await expect(fetchTablePage(VIEWER, "employees", COMPANY, query())).rejects.toMatchObject({
      code: "42501",
    });

    db.state.result = {
      data: null as never,
      count: null,
      error: { code: "PGRST103", message: "range" },
    };
    await expect(fetchTablePage(VIEWER, "employees", COMPANY, query({ page: 9 }))).resolves.toEqual(
      {
        rows: [],
        total: 0,
      },
    );
  });
});

describe("fetchTableCounts", () => {
  it("counts each table without fetching its rows", async () => {
    db.state.result = { data: null as never, count: 1250, error: null };
    const counts = await fetchTableCounts(VIEWER, COMPANY, false);
    expect(counts).toEqual({
      companies: 1250,
      employees: 1250,
      payroll_runs: 1250,
      payroll_entries: 1250,
      company_members: 1250,
    });
    for (const call of calls("select")) expect(call[2]).toEqual({ count: "exact", head: true });
    expect(calls("range")).toEqual([]);
  });
});
