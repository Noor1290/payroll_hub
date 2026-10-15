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
  OPTIONAL_TABLES,
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

const OTHER_USER = "0b0b0b0b-0000-4000-8000-0000000000b2";
const TEMPLATE = "50000000-0000-4000-8000-000000000001";
const SHARED_SETUP = "a0000000-0000-4000-8000-000000000001";

const ratesRow = (more: Record<string, unknown> = {}) => ({
  id: "60000000-0000-4000-8000-000000000001",
  company_id: COMPANY,
  effective_from: "2025-07-01",
  revision: 1,
  nsf_employee_rate: 1,
  nsf_ceiling: 28570,
  nsf_exempt_at_60: true,
  csg_employee_rate_low: 1.5,
  csg_employee_rate_high: 3,
  csg_threshold: 50000,
  source_note: "Sample figures, not the real ones",
  created_by: VIEWER.id,
  created_at: NOW,
  ...more,
});

const templateRow = (more: Record<string, unknown> = {}) => ({
  id: TEMPLATE,
  company_id: COMPANY,
  name: "Monthly payslip",
  draft_body: { title: "Payslip", lines: [{ label: "Basic salary" }] },
  draft_revision: 3,
  created_by: OTHER_USER,
  created_at: NOW,
  updated_by: VIEWER.id,
  updated_at: NOW,
  ...more,
});

const versionRow = (more: Record<string, unknown> = {}) => ({
  id: "70000000-0000-4000-8000-000000000001",
  template_id: TEMPLATE,
  company_id: COMPANY,
  version: 2,
  name: "Monthly payslip",
  body: { title: "Payslip", lines: [{ label: "Basic salary" }] },
  published_by: OTHER_USER,
  published_at: NOW,
  ...more,
});

const issuedRow = (more: Record<string, unknown> = {}) => ({
  id: "80000000-0000-4000-8000-000000000001",
  company_id: COMPANY,
  employee_id: EMPLOYEE,
  period: "2026-09-01",
  revision: 1,
  template_id: TEMPLATE,
  template_version: 2,
  rates_snapshot: { nsf_ceiling: 28570 },
  lines: [{ label: "Basic salary", amount: 25000 }],
  accepted_differences: [],
  issued_by: VIEWER.id,
  issued_at: NOW,
  ...more,
});

const PAYSLIP_TABLES = [
  "statutory_rates",
  "payslip_templates",
  "payslip_template_versions",
  "issued_payslips",
] as const;

const calls = (method: string) => db.state.calls.filter(([name]) => name === method);

beforeEach(() => {
  db.state.calls = [];
  db.state.result = { data: [], count: 0, error: null };
});

describe("the table list", () => {
  it("covers exactly these tables, and is read-only by construction", () => {
    expect(DB_TABLE_NAMES).toEqual([
      "companies",
      "employees",
      "payroll_runs",
      "payroll_entries",
      "company_members",
      "company_details",
      "company_links",
      "statutory_rates",
      "payslip_templates",
      "payslip_template_versions",
      "issued_payslips",
      "pdf_templates",
      "pdf_template_history",
      "payroll_shared_setups",
      "payroll_shared_setup_history",
      "payroll_company_setups",
      "payroll_company_setup_history",
      "payroll_months",
      "payroll_month_history",
    ]);
  });

  it("names the migration that creates each payslip table", () => {
    expect(OPTIONAL_TABLES).toMatchObject({
      statutory_rates: "0009_statutory_rates.sql",
      payslip_templates: "0010_payslip_templates.sql",
      payslip_template_versions: "0010_payslip_templates.sql",
      issued_payslips: "0011_issued_payslips.sql",
    });
  });

  it("marks issued payslips and the payroll months as admin-only, as their policies are", () => {
    expect(DB_TABLE_NAMES.filter((name) => DB_TABLES[name].adminOnly)).toEqual([
      "issued_payslips",
      "payroll_months",
      "payroll_month_history",
    ]);
  });

  it("masks template bodies and everything on an issued payslip, but not the statutory figures", () => {
    const sensitive = (name: (typeof DB_TABLE_NAMES)[number]) =>
      DB_TABLES[name].columns.filter((c) => c.sensitive).map((c) => c.key);

    // Company-wide figures set by law: nothing per employee in them.
    expect(sensitive("statutory_rates")).toEqual([]);
    expect(sensitive("payslip_templates")).toEqual(["draft_body"]);
    expect(sensitive("payslip_template_versions")).toEqual(["body"]);
    expect(sensitive("issued_payslips")).toEqual([
      "rates_snapshot",
      "lines",
      "accepted_differences",
    ]);
  });

  it("never searches inside a masked column of the payslip tables", () => {
    for (const name of PAYSLIP_TABLES) {
      const masked = DB_TABLES[name].columns.filter((c) => c.sensitive).map((c) => c.key);
      for (const column of DB_TABLES[name].searchColumns) expect(masked).not.toContain(column);
    }
  });

  it("has no column that would show a user id, even shortened, in the payslip tables", () => {
    for (const name of PAYSLIP_TABLES) {
      expect(DB_TABLES[name].columns.filter((c) => c.kind === "user")).toEqual([]);
    }
    const actors = (name: (typeof DB_TABLE_NAMES)[number]) =>
      DB_TABLES[name].columns.filter((c) => c.kind === "actor").map((c) => c.key);
    expect(actors("statutory_rates")).toEqual(["created_by"]);
    expect(actors("payslip_templates")).toEqual(["created_by", "updated_by"]);
    expect(actors("payslip_template_versions")).toEqual(["published_by"]);
    expect(actors("issued_payslips")).toEqual(["issued_by"]);
  });

  it("shows a PDF template's name, revision, file name, size and pages, and masks what the app wrote in it", () => {
    for (const name of ["pdf_templates", "pdf_template_history"] as const) {
      const table = DB_TABLES[name];
      const keys = table.columns.map((c) => c.key);
      expect(keys).toEqual(
        expect.arrayContaining([
          "company_id",
          "name",
          "revision",
          "pdf_file_name",
          "pdf_bytes",
          "pdf_pages",
        ]),
      );
      // The fields and company details are the app's: masked, and never searched.
      expect(table.columns.filter((c) => c.sensitive).map((c) => c.key)).toEqual(["body"]);
      expect(table.searchColumns).toEqual(["name", "pdf_file_name"]);
      // Who did it is "You" or "Another admin", never a user id.
      expect(table.columns.filter((c) => c.kind === "user")).toEqual([]);
      // Read-only like every table here, for members as well as admins, as its policy says.
      expect(table.adminOnly).toBeUndefined();
      expect(table.canBeDeleted).toBe(false);
      expect(OPTIONAL_TABLES[name]).toBe("0012_pdf_templates.sql");
    }
    const actors = (name: (typeof DB_TABLE_NAMES)[number]) =>
      DB_TABLES[name].columns.filter((c) => c.kind === "actor").map((c) => c.key);
    expect(actors("pdf_templates")).toEqual(["created_by", "updated_by"]);
    expect(actors("pdf_template_history")).toEqual(["saved_by"]);
    // A kept revision has no id of its own: the template and the revision number name it.
    expect(DB_TABLES.pdf_template_history.keyColumns).toEqual(["template_id", "revision"]);
  });

  it("reads a PDF template row as it is stored: no file content is in it, only the file's hash and size", () => {
    const row = {
      id: "90000000-0000-4000-8000-000000000001",
      company_id: COMPANY,
      name: "Statement of Emoluments",
      revision: 3,
      body: { boxes: [{ id: "b1", name: "Surname" }], employerFields: [] },
      pdf_file_name: "form.pdf",
      pdf_bytes: 983,
      pdf_pages: 1,
      pdf_sha256: "a".repeat(64),
      created_by: VIEWER.id,
      created_at: NOW,
      updated_by: OTHER_USER,
      updated_at: NOW,
    };
    const parsed = parseRow(DB_TABLES.pdf_templates, row, VIEWER.id);
    expect(parsed).toMatchObject({
      name: "Statement of Emoluments",
      revision: 3,
      pdf_file_name: "form.pdf",
      pdf_bytes: 983,
      pdf_pages: 1,
      created_by: "You",
      updated_by: "Another admin",
    });
    const kept = parseRow(
      DB_TABLES.pdf_template_history,
      {
        template_id: row.id,
        company_id: COMPANY,
        revision: 2,
        name: row.name,
        body: row.body,
        pdf_file_name: row.pdf_file_name,
        pdf_bytes: row.pdf_bytes,
        pdf_pages: row.pdf_pages,
        pdf_sha256: row.pdf_sha256,
        saved_by: null,
        saved_at: NOW,
      },
      VIEWER.id,
    );
    expect(kept.__key).toBe(`${row.id}:2`);
    expect(JSON.stringify([parsed, kept])).not.toContain(OTHER_USER);
  });

  it("reads both PDF template tables for the selected company only", async () => {
    for (const name of ["pdf_templates", "pdf_template_history"] as const) {
      db.state.calls.length = 0;
      db.state.result = { data: [], count: 0, error: null };
      await fetchTablePage(VIEWER, name, COMPANY, query());
      expect(calls("from").map((call) => call[1])).toEqual([name]);
      expect(calls("eq")).toContainEqual(["eq", "company_id", COMPANY]);
      expect(String(calls("select")[0]![1])).not.toContain("*");
    }
  });

  it("shows the payroll column setups' revisions, who and when, and masks what the app wrote in them", () => {
    const setups = [
      "payroll_shared_setups",
      "payroll_shared_setup_history",
      "payroll_company_setups",
      "payroll_company_setup_history",
    ] as const;
    for (const name of setups) {
      const table = DB_TABLES[name];
      // The columns and formulas are the app's: masked, and never searched.
      expect(
        table.columns.filter((c) => c.sensitive).map((c) => c.key),
        name,
      ).toEqual(["body"]);
      expect(table.searchColumns, name).not.toContain("body");
      expect(
        table.columns.map((c) => c.key),
        name,
      ).toContain("revision");
      expect(
        table.columns.filter((c) => c.kind === "user"),
        name,
      ).toEqual([]);
      // Members read them (migration 0013), so not admin-only; nothing is ever deleted here.
      expect(table.adminOnly, name).toBeUndefined();
      expect(table.canBeDeleted, name).toBe(false);
      expect(OPTIONAL_TABLES[name], name).toBe("0013_payroll_setups.sql");
    }
    const actors = (name: (typeof DB_TABLE_NAMES)[number]) =>
      DB_TABLES[name].columns.filter((c) => c.kind === "actor").map((c) => c.key);
    expect(actors("payroll_shared_setups")).toEqual(["created_by", "updated_by"]);
    expect(actors("payroll_company_setups")).toEqual(["created_by", "updated_by"]);
    expect(actors("payroll_shared_setup_history")).toEqual(["saved_by"]);
    expect(actors("payroll_company_setup_history")).toEqual(["saved_by"]);
    expect(DB_TABLES.payroll_shared_setup_history.keyColumns).toEqual([
      "shared_setup_id",
      "revision",
    ]);
    expect(DB_TABLES.payroll_company_setup_history.keyColumns).toEqual(["company_id", "revision"]);
  });

  it("masks every employee of a payroll month (salaries and national IDs), admins only, by month", () => {
    for (const name of ["payroll_months", "payroll_month_history"] as const) {
      const table = DB_TABLES[name];
      expect(
        table.columns.filter((c) => c.sensitive).map((c) => c.key),
        name,
      ).toEqual(["employees"]);
      expect(table.adminOnly, name).toBe(true);
      expect(table.monthColumn, name).toBe("period");
      // Nothing in a month is text that may be searched: only the month itself.
      expect(table.searchColumns, name).toEqual([]);
      expect(table.canBeDeleted, name).toBe(false);
      expect(OPTIONAL_TABLES[name], name).toBe("0014_payroll_months.sql");
      // The column keys a month holds are names only, shown as they are.
      expect(
        table.columns.find((c) => c.key === "employee_count")?.sensitive,
        name,
      ).toBeUndefined();
    }
    expect(DB_TABLES.payroll_months.columns.find((c) => c.key === "value_keys")).toMatchObject({
      kind: "list",
    });
    expect(DB_TABLES.payroll_months.keyColumns).toEqual(["company_id", "period"]);
    expect(DB_TABLES.payroll_month_history.keyColumns).toEqual([
      "company_id",
      "period",
      "revision",
    ]);
    // A record whose content was not kept has none.
    expect(
      DB_TABLES.payroll_month_history.columns.find((c) => c.key === "employees"),
    ).toMatchObject({
      nullable: true,
    });
  });

  it("reads a payroll month row as stored, and a history record without its content", () => {
    const month = parseRow(
      DB_TABLES.payroll_months,
      {
        company_id: COMPANY,
        period: "2026-10-01",
        revision: 4,
        shared_setup_id: SHARED_SETUP,
        shared_revision: 2,
        company_revision: 1,
        employee_count: 1,
        value_keys: ["basicSalary", "nationalId"],
        employees: [{ id: "e1", values: { nationalId: "X0000000000001", basicSalary: 18115 } }],
        created_by: OTHER_USER,
        created_at: NOW,
        updated_by: VIEWER.id,
        updated_at: NOW,
      },
      VIEWER.id,
    );
    expect(month).toMatchObject({ revision: 4, created_by: "Another admin", updated_by: "You" });
    expect(month.__key).toBe(`${COMPANY}:2026-10-01`);
    const record = parseRow(
      DB_TABLES.payroll_month_history,
      {
        company_id: COMPANY,
        period: "2026-10-01",
        revision: 3,
        shared_setup_id: SHARED_SETUP,
        shared_revision: 2,
        company_revision: 1,
        employee_count: 1,
        content_kept: false,
        employees: null,
        saved_by: null,
        saved_at: NOW,
      },
      VIEWER.id,
    );
    expect(record).toMatchObject({ content_kept: false, employees: null, saved_by: null });
    expect(JSON.stringify([month, record])).not.toContain(OTHER_USER);
  });

  it("reads a company's own setup and months by its id, and the shared setup through the company attached to it", async () => {
    const read = async (name: (typeof DB_TABLE_NAMES)[number]) => {
      db.state.calls.length = 0;
      db.state.result = { data: [], count: 0, error: null };
      await fetchTablePage(VIEWER, name, COMPANY, query());
      expect(calls("from").map((call) => call[1])).toEqual([name]);
      return String(calls("select")[0]![1]);
    };
    for (const name of [
      "payroll_company_setups",
      "payroll_company_setup_history",
      "payroll_months",
      "payroll_month_history",
    ] as const) {
      expect(await read(name), name).not.toContain("*");
      expect(calls("eq"), name).toContainEqual(["eq", "company_id", COMPANY]);
    }
    // The shared setup has no company of its own: only the one the selected company uses.
    expect(await read("payroll_shared_setups")).toContain(
      "payroll_company_setups!inner(company_id)",
    );
    expect(calls("eq")).toEqual([["eq", "payroll_company_setups.company_id", COMPANY]]);
    expect(await read("payroll_shared_setup_history")).toContain(
      "payroll_shared_setups!inner(payroll_company_setups!inner(company_id))",
    );
    expect(calls("eq")).toEqual([
      ["eq", "payroll_shared_setups.payroll_company_setups.company_id", COMPANY],
    ]);
  });

  it("masks every company detail value, and never searches inside them", () => {
    const details = DB_TABLES.company_details;
    expect(details.columns.filter((c) => c.sensitive).map((c) => c.key)).toEqual(["value"]);
    expect(details.searchColumns).not.toContain("value");
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

  it("says You or Another admin in the payslip tables, and keeps no user id", () => {
    const template = parseRow(DB_TABLES.payslip_templates, templateRow(), VIEWER.id);
    expect(template.created_by).toBe("Another admin");
    expect(template.updated_by).toBe("You");

    const rows = [
      template,
      parseRow(DB_TABLES.statutory_rates, ratesRow(), VIEWER.id),
      parseRow(DB_TABLES.payslip_template_versions, versionRow(), VIEWER.id),
      parseRow(DB_TABLES.issued_payslips, issuedRow(), VIEWER.id),
      parseRow(DB_TABLES.issued_payslips, issuedRow({ issued_by: OTHER_USER }), VIEWER.id),
    ];
    expect(rows.map((row) => row.created_by ?? row.published_by ?? row.issued_by)).toEqual([
      "Another admin",
      "You",
      "Another admin",
      "You",
      "Another admin",
    ]);
    const kept = JSON.stringify(rows);
    expect(kept).not.toContain(VIEWER.id);
    expect(kept).not.toContain(OTHER_USER);
    // Not even the shortened form the older tables use.
    expect(kept).not.toContain(shortId(OTHER_USER));

    // An account that was removed stays empty: it is nobody, not "Another admin".
    expect(
      parseRow(DB_TABLES.issued_payslips, issuedRow({ issued_by: null }), VIEWER.id).issued_by,
    ).toBeNull();
    // Without knowing who is looking, nobody is "You".
    expect(parseRow(DB_TABLES.issued_payslips, issuedRow()).issued_by).toBe("Another admin");
  });

  it("keeps a payslip-table row exactly as stored, and refuses one of the wrong shape", () => {
    const issued = parseRow(DB_TABLES.issued_payslips, issuedRow(), VIEWER.id);
    expect(issued.lines).toEqual([{ label: "Basic salary", amount: 25000 }]);
    expect(issued.accepted_differences).toEqual([]);
    expect(issued.rates_snapshot).toEqual({ nsf_ceiling: 28570 });
    expect(
      parseRow(DB_TABLES.issued_payslips, issuedRow({ rates_snapshot: null })).rates_snapshot,
    ).toBeNull();
    // A rate has up to 4 decimals and is kept as stored.
    const rates = parseRow(DB_TABLES.statutory_rates, ratesRow({ nsf_employee_rate: 1.0625 }));
    expect(rates.nsf_employee_rate).toBe(1.0625);

    expect(() => parseRow(DB_TABLES.issued_payslips, issuedRow({ lines: "nope" }))).toThrow(
      ZodError,
    );
    expect(() => parseRow(DB_TABLES.issued_payslips, issuedRow({ issued_by: "me" }))).toThrow(
      ZodError,
    );
    expect(() => parseRow(DB_TABLES.payslip_templates, templateRow({ draft_body: [] }))).toThrow(
      ZodError,
    );
    expect(() => parseRow(DB_TABLES.statutory_rates, ratesRow({ revision: 1.5 }))).toThrow(
      ZodError,
    );
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

  it("scopes each payslip table to the selected company, with no join", async () => {
    for (const table of PAYSLIP_TABLES) {
      db.state.calls = [];
      await fetchTablePage(VIEWER, table, COMPANY, query({ showDeleted: true }));
      expect([...calls("eq"), ...calls("is")]).toEqual([["eq", "company_id", COMPANY]]);
      expect(String(calls("select")[0]![1])).not.toMatch(/[(!]/);
    }
  });

  it("says who did it as it reads a page, without keeping the id", async () => {
    db.state.result = {
      data: [issuedRow(), issuedRow({ id: ENTRY, issued_by: OTHER_USER })],
      count: 2,
      error: null,
    };
    const page = await fetchTablePage(VIEWER, "issued_payslips", COMPANY, query());
    expect(page.rows.map((row) => row.issued_by)).toEqual(["You", "Another admin"]);
    expect(JSON.stringify(page)).not.toContain(OTHER_USER);
  });

  it("never sorts the payslip tables by who did it or by a JSON column", () => {
    const fallback = DB_TABLES.issued_payslips.defaultSort;
    for (const column of ["issued_by", "lines", "accepted_differences", "rates_snapshot"]) {
      expect(safeSort(DB_TABLES.issued_payslips, { column, ascending: true })).toEqual(fallback);
    }
    expect(
      safeSort(DB_TABLES.payslip_templates, { column: "updated_by", ascending: true }),
    ).toEqual(DB_TABLES.payslip_templates.defaultSort);
    expect(safeSort(DB_TABLES.issued_payslips, { column: "period", ascending: true })).toEqual({
      column: "period",
      ascending: true,
    });
  });

  it("finds a month in the payslip tables, and asks nothing when a search cannot match", async () => {
    await fetchTablePage(VIEWER, "statutory_rates", COMPANY, query({ search: "2025-07" }));
    expect(calls("eq")).toContainEqual(["eq", "effective_from", "2025-07-01"]);

    db.state.calls = [];
    await fetchTablePage(VIEWER, "issued_payslips", COMPANY, query({ search: " 2026-09 " }));
    expect(calls("eq")).toContainEqual(["eq", "period", "2026-09-01"]);
    expect(calls("or")).toEqual([]);

    // Issued payslips have no text to search: anything but a month matches nothing.
    db.state.calls = [];
    db.state.result = { data: [issuedRow()], count: 1, error: null };
    expect(
      await fetchTablePage(VIEWER, "issued_payslips", COMPANY, query({ search: "doe" })),
    ).toEqual({ rows: [], total: 0 });
    expect(db.state.calls).toEqual([]);
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
      company_details: 1250,
      company_links: 1250,
      statutory_rates: 1250,
      payslip_templates: 1250,
      payslip_template_versions: 1250,
      issued_payslips: 1250,
      pdf_templates: 1250,
      pdf_template_history: 1250,
      payroll_shared_setups: 1250,
      payroll_shared_setup_history: 1250,
      payroll_company_setups: 1250,
      payroll_company_setup_history: 1250,
      payroll_months: 1250,
      payroll_month_history: 1250,
    });
    for (const call of calls("select")) expect(call[2]).toEqual({ count: "exact", head: true });
    expect(calls("range")).toEqual([]);
  });

  it("does not even count an admin-only table for someone who is not an admin", async () => {
    db.state.result = { data: null as never, count: 4, error: null };
    const counts = await fetchTableCounts(VIEWER, COMPANY, false, false);
    expect(counts.issued_payslips).toBeNull();
    expect(counts.statutory_rates).toBe(4);
    expect(calls("from").map((call) => call[1])).not.toContain("issued_payslips");
  });
});
