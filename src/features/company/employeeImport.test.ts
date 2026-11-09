// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { XlsxCell } from "@/lib/xlsx/readXlsx";
import {
  companyLine,
  notInFileLine,
  previewEmployees,
  readEmployeesSheet,
  type EmployeeContext,
  type ExistingCompany,
} from "./employeeImport";
import { newCompaniesOf } from "./employeeImportData";
import { setupFields } from "./employeeSheet";
type PreviewRow = import("./companyImport").PreviewRow;

// The Employees sheet of an uploaded file: reading it, linking each row to its company, matching
// it to an employee, and every check of EMPLOYEES_IMPORT_PLAN.md §6, with the approved wording.
// TEST companies and fake employees only.

const SHARED = {
  identityFields: [
    { id: "f1", name: "ID", key: "id" },
    { id: "f2", name: "Surname", key: "surname" },
    { id: "f3", name: "Other names", key: "other_names" },
    { id: "f4", name: "Date of Employment", key: "doe", valueType: "date" },
  ],
  idFieldKey: "id",
  globalColumns: [
    { id: "c1", name: "Basic Salary", key: "basic", type: "input", category: "general" },
    { id: "c2", name: "Age 60+", key: "age60", type: "input", valueType: "checkbox" },
    { id: "c3", name: "Gross Pay", key: "gross", type: "formula", category: "general" },
  ],
};
const ALPHA_OWN = { columns: [{ id: "c9", name: "Bonus", key: "bonus", type: "input" }] };
const FIELDS = setupFields(SHARED, null);

const t = (text: string): XlsxCell => ({ text, kind: "text" });
const n = (text: string): XlsxCell => ({ text, kind: "number" });

const HEAD = [
  "Company BRN *",
  "Company name",
  "ID",
  "Surname",
  "Other names",
  "Date of Employment",
  "Basic Salary",
  "Age 60+",
  "Bonus",
  "Gross Pay",
  "Reference (leave as is)",
];
type Cells = Partial<Record<(typeof HEAD)[number], XlsxCell>>;
/** A sheet: the headings, then one row per object (by heading). */
const sheetOf = (rows: Cells[], head = HEAD): (XlsxCell | null)[][] => [
  head.map(t),
  ...rows.map((row) => head.map((h) => row[h] ?? null)),
];
const read = (rows: Cells[], head = HEAD) => {
  const result = readEmployeesSheet(sheetOf(rows, head));
  if (!result.ok) throw new Error(result.why);
  return result;
};

const OCTOBER = [
  { id: "oct-1", values: { id: "T0101", surname: "Testone", other_names: "Fake", basic: 30000 } },
  { id: "oct-2", values: { id: "T0202", surname: "Testtwo", other_names: "", age60: true } },
  { id: "oct-3", values: { id: "T0303", surname: "Testthree", doe: "2024-03-05" } },
];
const SEPTEMBER = [{ id: "sep-1", values: { id: "T0101", surname: "Testone" } }];

const alpha = (over: Partial<ExistingCompany> = {}): ExistingCompany => ({
  id: "10000000-0000-4000-8000-0000000000a1",
  name: "TEST Alpha Ltd",
  brn: "C0000101",
  fields: setupFields(SHARED, ALPHA_OWN),
  setupRevisions: { shared: 4, company: 1 },
  newest: {
    period: "2026-10-01",
    revision: 3,
    sharedRevision: 4,
    companyRevision: 1,
    employees: OCTOBER,
  },
  approved: false,
  referenced: new Map([["2026-09-01", SEPTEMBER]]),
  ...over,
});
const context = (over: Partial<EmployeeContext> = {}): EmployeeContext => ({
  existing: new Map([["C0000101", alpha()]]),
  notAdmin: new Map([["C0000404", "TEST Viewer Ltd"]]),
  newCompanies: new Map([["C0000105", { name: "TEST Delta Ltd", created: true }]]),
  newSetup: FIELDS,
  startPeriod: "2026-11-01",
  ...over,
});
let next = 0;
const makeId = () => `new-${++next}`;
const preview = (rows: Cells[], ctx = context(), head = HEAD) => {
  const r = read(rows, head);
  return previewEmployees(r.rows, r.headings, ctx, makeId);
};
const only = (rows: Cells[], ctx = context()) => {
  const p = preview(rows, ctx);
  return { company: p.companies[0]!, row: p.companies[0]!.rows[0]!, notices: p.notices };
};

describe("reading the Employees sheet", () => {
  it("has no employees when the sheet is missing or has only its headings", () => {
    expect(readEmployeesSheet(null)).toEqual({ ok: true, rows: [], headings: [] });
    expect(readEmployeesSheet(sheetOf([]))).toEqual({ ok: true, rows: [], headings: [] });
  });

  it("reads each filled row with its BRN (capitals, no spaces), Reference and filled cells; empty rows are skipped", () => {
    const r = read([
      { "Company BRN *": t("c 000 0101"), Surname: t("Testone") },
      {},
      { ID: t("X") },
    ]);
    expect(r.rows.map((row) => [row.line, row.brn, row.cells.map((c) => c.heading)])).toEqual([
      [2, "C0000101", ["Surname"]],
      [4, "", ["ID"]],
    ]);
    // Company name and Reference are not columns of a company.
    expect(r.headings).not.toContain("Company name");
    expect(r.headings).not.toContain("Reference (leave as is)");
  });

  it("refuses a file whose sheet has no Company BRN column, a heading twice, or values with no heading", () => {
    expect(readEmployeesSheet(sheetOf([{ ID: t("1") }], ["ID"]))).toEqual({
      ok: false,
      why: 'The Employees sheet has no "Company BRN" column. Use the companies template.',
    });
    expect(readEmployeesSheet(sheetOf([{ ID: t("1") }], ["Company BRN", "ID", "id "]))).toEqual({
      ok: false,
      why: 'The heading "id" is there twice on the Employees sheet.',
    });
    expect(
      readEmployeesSheet([
        [t("Company BRN"), null],
        [t("C1"), t("lost")],
      ]),
    ).toEqual({
      ok: false,
      why: "Column B of the Employees sheet has values but no heading in row 1.",
    });
  });

  it("refuses more than 5000 employees", () => {
    const rows = Array.from({ length: 5001 }, () => [t("C0000101"), t("x")]);
    expect(readEmployeesSheet([[t("Company BRN"), t("ID")], ...rows])).toEqual({
      ok: false,
      why: "The Employees sheet has more than 5000 employees. Split it into two files.",
    });
  });
});

describe("matching a row to an employee of the newest saved month", () => {
  it("adds a new employee, ticked, with what it is given", () => {
    const { company, row } = only([
      {
        "Company BRN *": t("C0000101"),
        ID: t("T0909"),
        Surname: t("Newperson"),
        "Date of Employment": t("01/11/2026"),
        "Basic Salary": t("Rs 18,115.00"),
      },
    ]);
    expect(company.period).toBe("2026-10-01");
    expect(row.status).toBe("new");
    expect(row.ticked).toBe(true);
    expect(row.values).toEqual({
      id: row.employeeId,
      values: { id: "T0909", surname: "Newperson", doe: "2026-11-01", basic: 18115 },
    });
    expect(row.changes.map((c) => `${c.heading} ${c.after}`)).toEqual([
      "ID T0909",
      "Surname Newperson",
      "Date of Employment 01/11/2026",
      "Basic Salary 18,115",
    ]);
  });

  it("matches by ID: a change is an update, unticked, with Before and After; the same values are No changes", () => {
    const p = preview([
      { "Company BRN *": t("C0000101"), ID: t("T0101"), "Basic Salary": t("31234.56") },
      {
        "Company BRN *": t("C0000101"),
        ID: t("T0202"),
        Surname: t("Testtwo"),
        "Age 60+": t("Yes"),
      },
    ]);
    const [update, same] = p.companies[0]!.rows;
    expect(update!.status).toBe("update");
    expect(update!.ticked).toBe(false);
    expect(update!.employeeId).toBe("oct-1");
    expect(update!.changes).toEqual([
      { heading: "Basic Salary", before: "30,000", after: "31,234.56" },
    ]);
    expect(update!.values).toEqual({ basic: 31234.56 });
    expect(same!.status).toBe("same");
  });

  it("an empty cell changes nothing", () => {
    const { row } = only([
      { "Company BRN *": t("C0000101"), ID: t("T0303"), Surname: t("Testthree") },
    ]);
    expect(row.status).toBe("same");
    expect(row.values).toEqual({});
    // A cell that is there but blank (spaces, or a formula giving "") is empty too.
    const blank = only([
      {
        "Company BRN *": t("C0000101"),
        ID: t("T0303"),
        Surname: t("Testthree"),
        "Other names": t("   "),
        "Date of Employment": t(""),
      },
    ]).row;
    expect(blank.status).toBe("same");
    expect(blank.values).toEqual({});
  });

  it("matches by Reference, where an ID typed in is a change of ID", () => {
    const { row } = only([
      {
        "Company BRN *": t("C0000101"),
        ID: t("T0102"),
        Surname: t("Testone"),
        "Reference (leave as is)": t("2026-10/oct-1"),
      },
    ]);
    expect(row.status).toBe("update");
    expect(row.changes).toEqual([{ heading: "ID", before: "T0101", after: "T0102" }]);
  });

  it("finds a row downloaded from an older month in the newest one, by that employee's ID", () => {
    const { row } = only([
      {
        "Company BRN *": t("C0000101"),
        Surname: t("Testonee"),
        "Reference (leave as is)": t("2026-09/sep-1"),
      },
    ]);
    expect(row.status).toBe("update");
    expect(row.employeeId).toBe("oct-1");
  });

  it("counts the employees of the month not in the file: they stay as they are", () => {
    const { company } = only([{ "Company BRN *": t("C0000101"), ID: t("T0101") }]);
    expect(company.notInFile).toBe(2);
    expect(notInFileLine(company)).toBe(
      "2 employees of October 2026 are not in the file: they stay as they are.",
    );
    expect(companyLine(company)).toBe(
      "C0000101 TEST Alpha Ltd: into October 2026: 0 new, 0 to update, 1 no changes, 0 problems",
    );
  });

  it("starts a company with no saved month in the month chosen", () => {
    const ctx = context({ existing: new Map([["C0000101", alpha({ newest: null })]]) });
    const { company, row } = only(
      [{ "Company BRN *": t("C0000101"), ID: t("T1"), Surname: t("A") }],
      ctx,
    );
    expect(company.period).toBe("2026-11-01");
    expect(company.newMonth).toBe(true);
    expect(row.status).toBe("new");
  });
});

describe("the checks (EMPLOYEES_IMPORT_PLAN.md §6)", () => {
  const problemsOf = (rows: Cells[], ctx = context()) => {
    const p = preview(rows, ctx);
    return p.companies.map((c) => ({
      line: companyLine(c),
      rows: c.rows.map((r) => [r.status, ...r.problems]),
    }));
  };

  it("No Company BRN", () => {
    expect(problemsOf([{ ID: t("T1"), Surname: t("A") }])).toEqual([
      {
        line: "No Company BRN. Each employee needs the BRN of their company.",
        rows: [["problem"]],
      },
    ]);
  });

  it("a BRN in neither the file nor the dashboard", () => {
    expect(problemsOf([{ "Company BRN *": t("C0099999"), ID: t("T1") }])[0]!.line).toBe(
      "BRN C0099999 is not on the Companies sheet and is not one of your companies in the dashboard.",
    );
  });

  it("a company you are not admin of", () => {
    expect(problemsOf([{ "Company BRN *": t("C0000404"), ID: t("T1") }])[0]!.line).toBe(
      "C0000404 TEST Viewer Ltd: You are not an admin of C0000404 TEST Viewer Ltd, so its employees can't be changed here.",
    );
  });

  it("a new company that is not being created, or has no column setup chosen", () => {
    const notCreated = context({
      newCompanies: new Map([["C0000105", { name: "TEST Delta Ltd", created: false }]]),
    });
    expect(problemsOf([{ "Company BRN *": t("C0000105"), ID: t("T1") }], notCreated)[0]!.line).toBe(
      "C0000105 TEST Delta Ltd: Its company, C0000105, is not being created, so its employees can't be added.",
    );
    expect(
      problemsOf([{ "Company BRN *": t("C0000105"), ID: t("T1") }], context({ newSetup: null }))[0]!
        .line,
    ).toBe(
      "C0000105 TEST Delta Ltd: Choose a column setup for the new companies above to add their employees.",
    );
    // With both: added to the month chosen, with the setup chosen.
    const ok = preview([{ "Company BRN *": t("C0000105"), ID: t("T1"), Surname: t("A") }]);
    expect(ok.companies[0]!.period).toBe("2026-11-01");
    expect(ok.companies[0]!.rows[0]!.status).toBe("new");
  });

  it("a company with no column setup, or none chosen as the ID", () => {
    const noSetup = context({ existing: new Map([["C0000101", alpha({ fields: null })]]) });
    expect(problemsOf([{ "Company BRN *": t("C0000101"), ID: t("T1") }], noSetup)[0]!.line).toBe(
      "C0000101 TEST Alpha Ltd: C0000101 TEST Alpha Ltd has no column setup in Payroll System yet, so employees can't be added to it.",
    );
    const noId = context({
      existing: new Map([
        ["C0000101", alpha({ fields: setupFields({ ...SHARED, idFieldKey: null }, null) })],
      ]),
    });
    expect(problemsOf([{ "Company BRN *": t("C0000101"), ID: t("T1") }], noId)[0]!.line).toBe(
      "C0000101 TEST Alpha Ltd: The column setup of C0000101 has no identity field chosen as the ID, so employees can't be matched. Choose one in Payroll System.",
    );
  });

  it("an approved newest month is never changed", () => {
    const approved = context({ existing: new Map([["C0000101", alpha({ approved: true })]]) });
    const result = problemsOf(
      [{ "Company BRN *": t("C0000101"), ID: t("T0909"), Surname: t("A") }],
      approved,
    );
    expect(result[0]!.line).toBe(
      "C0000101 TEST Alpha Ltd: October 2026 of C0000101 is approved and can't be changed. Start November 2026 in Payroll System first, then upload again.",
    );
    expect(result[0]!.rows).toEqual([["problem"]]);
  });

  it("no ID, and no Surname for a new employee", () => {
    expect(problemsOf([{ "Company BRN *": t("C0000101"), Surname: t("A") }])[0]!.rows).toEqual([
      ["problem", "No ID. Each employee needs an ID."],
    ]);
    expect(problemsOf([{ "Company BRN *": t("C0000101"), ID: t("T9") }])[0]!.rows).toEqual([
      ["problem", "No Surname. A new employee needs a Surname."],
    ]);
  });

  it("the same ID twice for one company in the file: neither row is used; in two companies it is fine", () => {
    const rows = problemsOf([
      { "Company BRN *": t("C0000101"), ID: t("T9"), Surname: t("A") },
      { "Company BRN *": t("C0000101"), ID: t("T9"), Surname: t("B") },
      { "Company BRN *": t("C0000105"), ID: t("T9"), Surname: t("A") },
    ]);
    const twice =
      "ID T9 is used twice for C0000101 (rows 2 and 3). Each employee needs their own ID.";
    expect(rows[0]!.rows).toEqual([
      ["problem", twice],
      ["problem", twice],
    ]);
    expect(rows[1]!.rows).toEqual([["new"]]);
  });

  it("an ID that is in the month twice already", () => {
    const doubled = alpha({
      newest: {
        ...alpha().newest!,
        employees: [...OCTOBER, { id: "oct-9", values: { id: "T0101" } }],
      },
    });
    const ctx = context({ existing: new Map([["C0000101", doubled]]) });
    expect(problemsOf([{ "Company BRN *": t("C0000101"), ID: t("T0101") }], ctx)[0]!.rows).toEqual([
      ["problem", "ID T0101 is in October 2026 twice already. Correct it in Payroll System first."],
    ]);
  });

  it("the same Reference twice, and a Reference that matches no employee", () => {
    const ref = { "Company BRN *": t("C0000101"), "Reference (leave as is)": t("2026-10/oct-2") };
    const same =
      "Rows 2 and 3 have the same Reference: one was probably copied. For a new employee, empty its Reference cell.";
    expect(problemsOf([ref, ref])[0]!.rows).toEqual([
      ["problem", same],
      ["problem", same],
    ]);
    expect(
      problemsOf([
        { "Company BRN *": t("C0000101"), "Reference (leave as is)": t("2026-10/gone") },
      ])[0]!.rows,
    ).toEqual([
      [
        "problem",
        "This row's Reference does not match an employee of C0000101. For a new employee, empty its Reference cell.",
      ],
    ]);
  });

  it("a date that is not one, and text in a figure column", () => {
    expect(
      problemsOf([
        {
          "Company BRN *": t("C0000101"),
          ID: t("T0101"),
          "Date of Employment": t("31/02/2026"),
          "Basic Salary": t("n/a"),
        },
      ])[0]!.rows,
    ).toEqual([
      [
        "problem",
        'Date of Employment: "31/02/2026" is not a date. Type it as DD/MM/YYYY, for example 05/03/2024.',
        'Basic Salary: "n/a" is not a number.',
      ],
    ]);
  });

  it("a filled cell under a column that company does not have is a Problem", () => {
    // Bonus is TEST Alpha's own column; the new company's setup has no Bonus.
    expect(
      problemsOf([
        { "Company BRN *": t("C0000105"), ID: t("T1"), Surname: t("A"), Bonus: t("5") },
      ])[0]!.rows,
    ).toEqual([
      [
        "problem",
        "Bonus: C0000105 has no column called Bonus. Leave it empty, or add the column in Payroll System first.",
      ],
    ]);
  });

  it("an ID typed as a number: a warning, unticked but tickable", () => {
    const { row } = only([{ "Company BRN *": t("C0000101"), ID: n("7"), Surname: t("A") }]);
    expect(row.status).toBe("new");
    expect(row.ticked).toBe(false);
    expect(row.warning).toBe(
      "The ID was typed as a number, so Excel may have dropped leading zeros. Check it before ticking.",
    );
  });

  it("notices: a formula column filled in, and headings no company has", () => {
    const { notices, row } = only(
      [{ "Company BRN *": t("C0000101"), ID: t("T0101"), "Gross Pay": t("99") }],
      context(),
    );
    expect(row.status).toBe("same");
    expect(notices).toEqual([
      "Gross Pay is worked out by Payroll System, so its values in the file are not imported.",
    ]);
    const extra = preview([{ "Company BRN *": t("C0000101"), ID: t("T0101") }], context(), [
      ...HEAD,
      "Notes",
    ]);
    expect(extra.notices).toEqual([
      "These headings are not a column of any company in the file, so they are not imported: Notes.",
    ]);
  });

  it("a cell Excel could not work out (#N/A)", () => {
    const { row } = only([
      {
        "Company BRN *": t("C0000101"),
        ID: t("T0101"),
        "Basic Salary": { text: "#N/A", kind: "error" },
      },
    ]);
    expect(row.problems).toEqual(['The value in "Basic Salary" can\'t be read (#N/A).']);
  });
});

describe("which companies of the Companies sheet are being created", () => {
  const item = (brn: string, status: PreviewRow["status"], ticked: boolean): PreviewRow =>
    ({ row: { brn, name: `TEST ${brn}` }, status, ticked }) as unknown as PreviewRow;

  it("a new row ticked is; unticked, a problem or a second row is not; one in the dashboard is not a new company", () => {
    const found = newCompaniesOf([
      item("C1", "new", true),
      item("C2", "new", false),
      item("C3", "problem", false),
      item("C4", "update", false),
      item("C1", "twice", false),
    ]);
    expect([...found]).toEqual([
      ["C1", { name: "TEST C1", created: true }],
      ["C2", { name: "TEST C2", created: false }],
      ["C3", { name: "TEST C3", created: false }],
    ]);
  });
});

describe("the surname each row carries to the report", () => {
  it("is the file's Surname, also on a row with a problem", () => {
    const p = preview([
      {
        "Company BRN *": t("C0000101"),
        ID: t("T0606"),
        Surname: t("Testsix"),
        "Date of Employment": t("31/02/2026"),
      },
      { "Company BRN *": t("C0000101"), ID: t("T0707"), Surname: t("Testseven") },
      { "Company BRN *": t("C0000101"), ID: t("T0101"), "Basic Salary": t("1") },
    ]);
    expect(p.companies[0]!.rows.map((row) => [row.status, row.surname])).toEqual([
      ["problem", "Testsix"],
      ["new", "Testseven"],
      ["update", "Testone"],
    ]);
  });
});
