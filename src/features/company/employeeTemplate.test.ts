import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readXlsxSheet } from "@/lib/xlsx/readXlsx";

vi.mock("@/lib/supabase/client", async () => ({
  supabase: (await import("@/test/fakeClient")).fake.client,
}));
const { fake } = await import("@/test/fakeClient");
const { buildFilledTemplate, buildTemplate } = await import("./companyImport");
const { CATEGORIES, employeeCounts, employeesSheet, referenceOf, setupFields, sheetColumns } =
  await import("./employeeSheet");
const { fetchTemplateEmployees } = await import("./employeeTemplateData");
const { grantUnlock, lock } = await import("@/lib/unlock");
type CurrentCompany = import("./companyUpdate").CurrentCompany;
type CompanyEmployees = import("./companyImport").CompanyEmployees;
type Call = import("@/test/fakeClient").Call;

// The Employees sheet of the two templates (EMPLOYEES_IMPORT_PLAN.md, Stage 1): its columns from
// each company's column setup, and the template with my companies filled in with the employees
// of each one's newest saved month, never with an ID (the NIC) or a figure. TEST companies and
// fake employees only.

const VIEWER = { id: "00000000-0000-4000-8000-0000000000a1", isDemo: false };
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SHARED = "20000000-0000-4000-8000-000000000001";
const AT = new Date(2026, 10, 9, 10, 0);

/** A shared setup as Payroll System saves it. */
const SHARED_BODY = {
  identityFields: [
    { id: "f1", name: "ID", key: "id" },
    { id: "f2", name: "Surname", key: "surname" },
    { id: "f3", name: "Other names", key: "other_names" },
    { id: "f4", name: "Date of Employment", key: "dateOfEmployment", valueType: "date" },
  ],
  idFieldKey: "id",
  globalColumns: [
    { id: "c1", name: "Basic Salary", key: "basic_salary", type: "input", category: "general" },
    {
      id: "c2",
      name: "Employee CSG",
      key: "csg_employee",
      type: "formula",
      category: "employeeContribution",
    },
    { id: "c3", name: "Rate", key: "rate_er", type: "input", category: "employerContribution" },
    { id: "c4", name: "Rate", key: "rate_ee", type: "input", category: "employeeContribution" },
    { id: "c5", name: "Full time / Part time", key: "ft", type: "input", valueType: "text" },
    { id: "c6", name: "Age 60+", key: "age60", type: "input", valueType: "checkbox" },
    { id: "c7", name: "", key: "nameless", type: "input" },
    { id: "c8", name: "Joined", key: "joined", type: "input", valueType: "date" },
  ],
};
/** TEST Alpha's own setup: one column of its own. */
const ALPHA_BODY = {
  columns: [{ id: "c9", name: "Bonus", key: "bonus", type: "input", category: "general" }],
};

const company = (n: number, name: string, brn: string): CurrentCompany => ({
  id: id(n),
  name,
  brn,
  address: null,
  vat: null,
  details: [],
  mra: null,
});
const ALPHA = company(1, "TEST Alpha Ltd", "C0000101");
const BETA = company(2, "TEST Beta Ltd", "C0000102");
const GAMMA = company(3, "TEST Gamma Ltd", "C0000103");

/** Fake employees: fake NICs and salaries that must never reach the file. */
const NIC_1 = "T0101801234561";
const NIC_2 = "T0202802345672";
const OCTOBER = [
  {
    id: "emp-a1",
    values: {
      id: NIC_1,
      surname: "Testone",
      other_names: "Fake Person",
      dateOfEmployment: "2024-03-05",
      basic_salary: 31234.56,
      ft: "Full Time",
      age60: true,
      bonus: 777.77,
      joined: "2024-03-05",
    },
  },
  {
    id: "emp-a2",
    values: { id: NIC_2, surname: "Testtwo", other_names: "", basic_salary: 18116.5 },
  },
];

const cellsOf = async (bytes: Uint8Array, sheet: string) =>
  (await readXlsxSheet(bytes, sheet))!.map((row) => row.map((cell) => cell?.text ?? ""));

beforeEach(() => fake.reset());
afterEach(() => lock());

describe("a company's columns, from its column setup", () => {
  const fields = setupFields(SHARED_BODY, ALPHA_BODY);

  it("lists the identity fields, then the Input columns by category, with a name two columns share headed with its category", () => {
    expect(fields.fields.map((f) => [f.heading, f.kind, f.valueType])).toEqual([
      ["ID", "identity", "text"],
      ["Surname", "identity", "text"],
      ["Other names", "identity", "text"],
      ["Date of Employment", "identity", "date"],
      ["Basic Salary", "input", "number"],
      ["Full time / Part time", "input", "text"],
      ["Age 60+", "input", "checkbox"],
      ["Joined", "input", "date"],
      ["Bonus", "input", "number"],
      ["Rate (Employee Contribution)", "input", "number"],
      ["Rate (Employer Contribution)", "input", "number"],
    ]);
  });

  it("never offers a formula column, and knows which identity field is the ID", () => {
    expect(fields.formulas).toEqual(["Employee CSG"]);
    expect(fields.fields.some((f) => f.heading === "Employee CSG")).toBe(false);
    expect(fields.idKey).toBe("id");
    expect(fields.fields.filter((f) => f.isId).map((f) => f.key)).toEqual(["id"]);
  });

  it("skips what Payroll System could not have saved, and a body with no lists", () => {
    expect(setupFields({}, null)).toEqual({ fields: [], formulas: [], idKey: null });
    expect(
      setupFields({ identityFields: [null, { name: "No key" }, { key: "k", name: " " }] }, null)
        .fields,
    ).toEqual([]);
  });

  it("uses Payroll System's category labels, in its order (Payroll_sys src/lib/categories.js, 9 Nov 2026)", () => {
    expect(CATEGORIES).toEqual([
      { id: "general", label: "General" },
      { id: "employeeContribution", label: "Employee Contribution" },
      { id: "employerContribution", label: "Employer Contribution" },
      { id: "otherDeductions", label: "Other Deductions" },
    ]);
  });
});

describe("the columns of a sheet for several companies", () => {
  it("takes every column of every company once, saying which companies have one when not all do", () => {
    const columns = sheetColumns([
      { company: "TEST Alpha Ltd", fields: setupFields(SHARED_BODY, ALPHA_BODY) },
      { company: "TEST Beta Ltd", fields: setupFields(SHARED_BODY, null) },
    ]);
    const bonus = columns.find((c) => c.heading === "Bonus");
    expect(bonus?.onlyFor).toEqual(["TEST Alpha Ltd"]);
    expect(columns.find((c) => c.heading === "Basic Salary")?.onlyFor).toBeNull();
    expect(columns.filter((c) => c.heading === "Surname")).toHaveLength(1);
  });

  it("is ID, Surname and Other names when no setup is known", () => {
    expect(sheetColumns([]).map((c) => c.heading)).toEqual(["ID", "Surname", "Other names"]);
  });
});

describe("the blank template's Employees sheet", () => {
  it("has the headings of the most-used setup, no Reference and no rows", async () => {
    const bytes = buildTemplate(AT, { name: "Main setup", fields: setupFields(SHARED_BODY, null) });
    expect(await cellsOf(bytes, "Employees")).toEqual([
      [
        "Company BRN *",
        "Company name",
        "ID",
        "Surname",
        "Other names",
        "Date of Employment",
        "Basic Salary",
        "Full time / Part time",
        "Age 60+",
        "Joined",
        "Rate (Employee Contribution)",
        "Rate (Employer Contribution)",
      ],
    ]);
    const readMe = (await cellsOf(bytes, "Read me")).map((row) => row.join(" | "));
    expect(readMe).toContain("Employees sheet");
    expect(readMe.some((line) => line.includes('your column setup "Main setup"'))).toBe(true);
    expect(readMe).toContain(
      "An empty cell changes nothing; nobody is ever deleted. Employees of the month who are not in the file stay as they are.",
    );
    expect(readMe).toContain(
      "ID | For a new employee | The employee's ID (their NIC). An employee is recognised by it. | Text. Leading zeros are kept. | A0101801234567",
    );
  });

  it("formats the ID, text and date columns as Text, and leaves figures and ticks as numbers", () => {
    const { sheet } = employeesSheet({
      kind: "blank",
      setupName: "Main setup",
      fields: setupFields(SHARED_BODY, null),
    });
    const text = Object.fromEntries(
      sheet.rows[0]!.map((heading, at) => [heading, sheet.columns[at]!.text === true]),
    );
    expect(text).toMatchObject({
      "Company BRN *": true,
      ID: true,
      "Date of Employment": true,
      "Full time / Part time": true,
      Joined: true,
      "Basic Salary": false,
      "Age 60+": false,
    });
  });

  it("is ID, Surname and Other names with no setup", async () => {
    const rows = await cellsOf(buildTemplate(AT, null), "Employees");
    expect(rows).toEqual([["Company BRN *", "Company name", "ID", "Surname", "Other names"]]);
  });
});

describe("the template with my companies, filled in with their employees", () => {
  const employees = new Map<string, CompanyEmployees>([
    [
      ALPHA.id,
      { fields: setupFields(SHARED_BODY, ALPHA_BODY), period: "2026-10-01", employees: OCTOBER },
    ],
    // A setup but no saved month: no rows.
    [BETA.id, { fields: setupFields(SHARED_BODY, null), period: null, employees: [] }],
    // GAMMA has no setup at all.
  ]);
  const bytes = buildFilledTemplate([BETA, GAMMA, ALPHA], AT, employees);

  it("has one row per employee of the newest saved month, with a Reference, without the ID or any figure", async () => {
    const rows = await cellsOf(bytes, "Employees");
    expect(rows[0]).toEqual([
      "Company BRN *",
      "Company name",
      "ID",
      "Surname",
      "Other names",
      "Date of Employment",
      "Basic Salary",
      "Full time / Part time",
      "Age 60+",
      "Joined",
      "Bonus",
      "Rate (Employee Contribution)",
      "Rate (Employer Contribution)",
      "Reference (leave as is)",
    ]);
    const blankFigures = ["", "", "", "", "", "", ""];
    expect(rows.slice(1)).toEqual([
      [
        "C0000101",
        "TEST Alpha Ltd",
        "",
        "Testone",
        "Fake Person",
        "05/03/2024",
        ...blankFigures,
        "2026-10/emp-a1",
      ],
      ["C0000101", "TEST Alpha Ltd", "", "Testtwo", "", "", ...blankFigures, "2026-10/emp-a2"],
    ]);
  });

  it("holds no NIC and no figure anywhere in the file", async () => {
    for (const sheet of ["Read me", "Companies", "Employees"]) {
      const text = (await cellsOf(bytes, sheet)).flat().join("\n");
      for (const secret of [NIC_1, NIC_2, "31234", "18116", "777.77", "Full Time"]) {
        expect(text, `${sheet}: ${secret}`).not.toContain(secret);
      }
    }
  });

  it("says in the Read me that it is filled in, and which columns only some companies have", async () => {
    const readMe = (await cellsOf(bytes, "Read me")).map((row) => row.join(" | "));
    expect(readMe).toContain(
      "Filled in with the employees of each company's newest saved month. ID and the columns after the identity fields are left empty because they are sensitive: an empty cell changes nothing.",
    );
    expect(
      readMe.find((line) => line.startsWith("Bonus |"))?.includes("Only for: TEST Alpha Ltd."),
    ).toBe(true);
    expect(readMe.some((line) => line.startsWith("Reference (leave as is) |"))).toBe(true);
  });

  it("counts the employees and the companies they come from", () => {
    expect(
      employeeCounts([
        { name: "A", brn: "A1", fields: null, period: "2026-10-01", employees: OCTOBER },
        { name: "B", brn: "B1", fields: null, period: null, employees: [] },
      ]),
    ).toEqual({ employees: 2, companies: 1 });
    expect(referenceOf("2026-10-01", "emp-a1")).toBe("2026-10/emp-a1");
  });
});

describe("reading the employees for the template", () => {
  const answer = (calls: Call[]) => {
    const from = fake.arg(calls, "from");
    const select = String(fake.arg(calls, "select"));
    if (from === "payroll_company_setups") {
      return {
        data: [ALPHA, BETA].map((c) => ({
          company_id: c.id,
          shared_setup_id: SHARED,
          body: c === ALPHA ? ALPHA_BODY : {},
          revision: 1,
          updated_by: null,
          updated_at: "2026-11-01T00:00:00Z",
        })),
      };
    }
    if (from === "payroll_shared_setups") {
      return {
        data: {
          id: SHARED,
          name: "Main setup",
          body: SHARED_BODY,
          revision: 4,
          updated_by: null,
          updated_at: "2026-11-01T00:00:00Z",
        },
      };
    }
    if (from === "payroll_months" && select === "company_id, period") {
      return {
        data: [
          { company_id: ALPHA.id, period: "2026-09-01" },
          { company_id: ALPHA.id, period: "2026-10-01" },
          { company_id: BETA.id, period: "2026-08-01" },
        ],
      };
    }
    if (from === "payroll_months") {
      const period = fake.arg(calls, "eq", 1);
      const month = (companyId: string) => ({
        company_id: companyId,
        period,
        revision: 2,
        shared_revision: 4,
        company_revision: 1,
        employee_count: OCTOBER.length,
        employees: OCTOBER,
        updated_by: null,
        updated_at: "2026-11-01T00:00:00Z",
      });
      return {
        data: period === "2026-10-01" ? [month(ALPHA.id)] : [month(BETA.id)],
      };
    }
    return { data: [] };
  };

  it("reads with the password gate locked: no password for this any more (hotfix 2)", async () => {
    lock();
    fake.reset(answer);
    const found = await fetchTemplateEmployees(VIEWER, [ALPHA, BETA]);
    expect(found.get(ALPHA.id)?.period).toBe("2026-10-01");
  });

  it("takes each company's newest saved month, in a few grouped requests", async () => {
    grantUnlock(5);
    fake.reset(answer);
    const found = await fetchTemplateEmployees(VIEWER, [ALPHA, BETA, GAMMA]);
    expect(found.get(ALPHA.id)?.period).toBe("2026-10-01");
    expect(found.get(BETA.id)?.period).toBe("2026-08-01");
    expect(found.get(ALPHA.id)?.fields?.fields.some((f) => f.heading === "Bonus")).toBe(true);
    expect(found.get(BETA.id)?.fields?.fields.some((f) => f.heading === "Bonus")).toBe(false);
    // No setup, so not in it.
    expect(found.has(GAMMA.id)).toBe(false);
    // One read of the setups, one of the shared setup, one of the periods, one per period.
    const tables = fake.state.queries.map((q) => fake.arg(q, "from"));
    expect(tables).toEqual([
      "payroll_company_setups",
      "payroll_shared_setups",
      "payroll_months",
      "payroll_months",
      "payroll_months",
    ]);
    // Only companies with a setup are asked for their months.
    const periods = fake.state.queries.find(
      (q) =>
        fake.arg(q, "from") === "payroll_months" && fake.arg(q, "select") === "company_id, period",
    )!;
    expect(fake.arg(periods, "in", 1)).toEqual([ALPHA.id, BETA.id]);
  });
});
