// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readXlsxSheet } from "@/lib/xlsx/readXlsx";
import { buildReport } from "./companyImport";
import { isEmployeeTickable, type CompanyEmployees, type EmployeePreview } from "./employeeImport";
import {
  employeeFailure,
  employeesDone,
  monthContent,
  NOT_SHOWN,
  type EmployeeReportLine,
} from "./employeeSave";

// Saving the employees (EMPLOYEES_IMPORT_PLAN.md, Stage 3): the month as it will be saved, the
// report's wording, and that the report file never holds an ID or a figure. Fake data only.

const row = (over: Partial<EmployeePreview>): EmployeePreview => ({
  row: { line: 2, brnTyped: "C0000101", brn: "C0000101", reference: "", cells: [] },
  status: "new",
  ticked: true,
  label: "",
  surname: "",
  problems: [],
  warning: null,
  changes: [],
  values: {},
  employeeId: null,
  ...over,
});
const company = (rows: EmployeePreview[]): CompanyEmployees => ({
  brn: "C0000101",
  name: "TEST Alpha Ltd",
  period: "2026-10-01",
  newMonth: false,
  problem: null,
  rows,
  notInFile: 0,
  companyId: "10000000-0000-4000-8000-0000000000a1",
});
const SAVED = [
  { id: "oct-1", values: { id: "T0101", basic: 30000 }, extra: "kept" },
  { id: "oct-2", values: { id: "T0202" } },
];

describe("the month as it will be saved", () => {
  it("keeps everyone, applies only the ticked changes, and adds the ticked new employees at the end", () => {
    const update = row({ status: "update", employeeId: "oct-1", values: { basic: 31000 } });
    const unticked = row({ status: "update", employeeId: "oct-2", values: { id: "T9999" } });
    const added = row({ status: "new", values: { id: "new-1", values: { id: "T0303" } } });
    const notTicked = row({ status: "new", values: { id: "new-2", values: { id: "T0404" } } });
    const ticks = new Set([update, added]);
    const out = monthContent(
      company([update, unticked, added, notTicked, row({ status: "problem" })]),
      SAVED,
      (item) => ticks.has(item),
    );
    expect(out.employees).toEqual([
      { id: "oct-1", values: { id: "T0101", basic: 31000 }, extra: "kept" },
      { id: "oct-2", values: { id: "T0202" } },
      { id: "new-1", values: { id: "T0303" } },
    ]);
    expect([out.added, out.updated]).toEqual([[added], [update]]);
    // What was read is not changed.
    expect(SAVED[0]!.values.basic).toBe(30000);
  });

  it("a problem row is never saved, even if something says it is ticked", () => {
    const out = monthContent(company([row({ status: "problem" })]), [], () => true);
    expect(out.employees).toEqual([]);
    expect(isEmployeeTickable(row({ status: "problem" }))).toBe(false);
  });
});

describe("the report", () => {
  const lines: EmployeeReportLine[] = [
    {
      line: 2,
      brn: "C0000101",
      company: "TEST Alpha Ltd",
      surname: "Testone",
      result: "Updated",
      what: "Updated in October 2026",
      before: `Surname: Testone\nBasic Salary: ${NOT_SHOWN}`,
      after: `Surname: Testonee\nBasic Salary: ${NOT_SHOWN}`,
    },
    {
      line: 3,
      brn: "C0000101",
      company: "TEST Alpha Ltd",
      surname: "Testnew",
      result: "Added",
      what: "Added to October 2026",
      before: "",
      after: `ID: ${NOT_SHOWN}\nSurname: Testnew`,
    },
    {
      line: 4,
      brn: "C0000101",
      company: "TEST Alpha Ltd",
      surname: "",
      result: "Problem",
      what: "Not changed: the month was saved by someone else after the preview. Upload the file again.",
      before: "",
      after: "",
    },
  ];

  it("has an Employees sheet with the approved columns; the ID is never in it", async () => {
    const sheet = await readXlsxSheet(buildReport([], new Date(), lines), "Employees");
    const text = sheet!.map((cells) => cells.map((cell) => cell?.text ?? ""));
    expect(text[0]).toEqual([
      "BRN",
      "Company",
      "Row",
      "ID",
      "Surname",
      "What happened",
      "Before",
      "After",
    ]);
    expect(text.slice(1).map((cells) => cells[3])).toEqual([NOT_SHOWN, NOT_SHOWN, NOT_SHOWN]);
    expect(text[1]![5]).toBe("Updated in October 2026");
  });

  it("a report with no employees has no Employees sheet", async () => {
    expect(await readXlsxSheet(buildReport([]), "Employees")).toBeNull();
  });

  it("counts what was saved", () => {
    expect(employeesDone(lines)).toBe("1 employee added, 1 updated, 1 not saved");
    expect(employeesDone(lines.slice(0, 1))).toBe("0 employees added, 1 updated");
  });

  it("says why a company's employees were not saved, in plain words", () => {
    const err = (message: string, code = "P0001") => ({ code, message });
    expect(employeeFailure(err("PH_STALE"), "2026-10-01")).toBe(
      "Not changed: the month was saved by someone else after the preview. Upload the file again.",
    );
    expect(employeeFailure(err("PH_MONTH_APPROVED: 2026-10"), "2026-10-01")).toBe(
      "Not changed: October 2026 was approved after the preview, so it can't be changed.",
    );
    expect(employeeFailure(err("PH_NOT_ADMIN", "42501"), "2026-10-01")).toBe(
      "Not changed: you are no longer an admin of this company.",
    );
    expect(employeeFailure(err("PH_TOO_LARGE", "54000"), "2026-10-01")).toBe(
      "Not changed: the month would be larger than the dashboard accepts (5000 employees or 1 MB).",
    );
    expect(employeeFailure(err("nope", "PGRST202"), "2026-10-01")).toContain(
      "supabase/migrations/0019_import_payroll_company.sql",
    );
  });
});
