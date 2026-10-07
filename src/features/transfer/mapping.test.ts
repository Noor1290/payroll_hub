import { describe, expect, it } from "vitest";
import sample from "../../../samples/ABC Co Ltd-pdf-fill-2026-09.json?raw";
import olderSample from "../../../samples/ABC Co Ltd-pdf-fill-2026-10.json?raw";
import { getApp, type ExpectedField } from "@/config/apps.config";
import { parsePayrollRows } from "@/features/import/parsePayroll";
import {
  autoMap,
  buildOutput,
  effectiveMapping,
  missingRequired,
  normaliseName,
  sensitiveColumnsSent,
  tableFromReceived,
  tableFromRun,
  validateRows,
  type SourceColumn,
  type SourceRow,
} from "./mapping";

const pdfFields = getApp("pdf-editor")!.expectedFields;
const original = JSON.parse(sample) as Record<string, unknown>[];

const column = (key: string, more: Partial<SourceColumn> = {}): SourceColumn => ({
  key,
  label: key,
  type: "string",
  sensitive: false,
  money: false,
  ...more,
});
const field = (key: string, more: Partial<ExpectedField> = {}): ExpectedField => ({
  key,
  label: key,
  type: "string",
  required: false,
  sensitive: false,
  ...more,
});
const row = (number: number, values: Record<string, unknown>): SourceRow => ({
  id: String(number),
  number,
  values,
});
const all = (columns: SourceColumn[]) => new Set(columns.map((c) => c.key));

describe("source tables", () => {
  it("turns received rows into a table, trimming strings and using known field details", () => {
    const table = tableFromReceived(original);
    expect(table.rows).toHaveLength(6);
    expect(table.rows[1]!.values.Surname).toBe("PALMYRE");
    expect(table.columns.find((c) => c.key === "ID")).toMatchObject({
      label: "National ID",
      sensitive: true,
    });
    expect(table.columns.find((c) => c.key === "Net Pay")).toMatchObject({
      type: "number",
      money: true,
      sensitive: true,
    });
    expect(table.columns.find((c) => c.key === "Surname")?.sensitive).toBe(false);
  });

  it("treats a field it doesn't know as sensitive", () => {
    const table = tableFromReceived(original);
    expect(table.columns.find((c) => c.key === "Bonus")).toMatchObject({
      type: "number",
      sensitive: true,
      money: false,
    });
  });

  it("turns a saved run into the same shape, with the company on every row", () => {
    const parsed = parsePayrollRows(original);
    const table = tableFromRun(parsed.rows, parsed.company!);
    expect(table.rows).toHaveLength(6);
    expect(table.rows[0]!.number).toBe(1);
    expect(table.rows[0]!.values).toMatchObject({
      ID: "X0000000000001",
      Surname: "DOE",
      "Age 60+": "No",
      BRN: "C1234567",
      "Company Name": "ABC Co Ltd",
    });
    expect(table.columns.map((c) => c.key)).toContain("Bonus");
  });

  it('shows "Employee CSG" once, as a masked money column, and never its storage name', () => {
    const parsed = parsePayrollRows(original);
    const table = tableFromRun(parsed.rows, parsed.company!);
    const keys = table.columns.map((c) => c.key);
    expect(keys.filter((key) => key === "Employee CSG")).toHaveLength(1);
    expect(keys).not.toContain("employee_csg");
    expect(keys).not.toContain("employee_nsf");
    expect(table.columns.find((c) => c.key === "Employee CSG")).toMatchObject({
      type: "number",
      money: true,
      sensitive: true,
    });
    expect(table.rows[0]!.values["Employee CSG"]).toBe(279.53);
  });
});

describe("autoMap", () => {
  it("matches the payroll export to the PDF filler's fields one for one", () => {
    const table = tableFromReceived(original);
    const mapping = autoMap(table.columns, pdfFields);
    // Everything the payroll app exports; the date is the dashboard's own and is not in a file.
    for (const expected of pdfFields.filter((f) => f.key !== "Date of Employment")) {
      expect(mapping[expected.key]).toBe(expected.key);
    }
    expect(mapping).not.toHaveProperty("Date of Employment");
  });

  it("matches by normalised name: case, spaces and punctuation don't matter", () => {
    expect(normaliseName("Net Pay")).toBe(normaliseName(" net_pay "));
    const mapping = autoMap(
      [column("net_pay"), column("EMPLOYEE-ID"), column("fulltime/parttime")],
      [field("Net Pay"), field("Employee ID"), field("Full time / Part time")],
    );
    expect(mapping).toEqual({
      "Net Pay": "net_pay",
      "Employee ID": "EMPLOYEE-ID",
      "Full time / Part time": "fulltime/parttime",
    });
  });

  it("also matches on labels", () => {
    const mapping = autoMap(
      [column("ID", { label: "National ID" })],
      [field("national_id", { label: "National ID" })],
    );
    expect(mapping).toEqual({ national_id: "ID" });
  });

  it("leaves a field unmapped rather than guessing, and never uses a column twice", () => {
    const mapping = autoMap(
      [column("Total")],
      [field("Total"), field("total"), field("Something else")],
    );
    expect(mapping).toEqual({ Total: "Total" });
  });
});

describe("required-field enforcement", () => {
  const columns = [column("ID"), column("Surname"), column("Net Pay")];
  const fields = [
    field("ID", { required: true }),
    field("Surname", { required: true }),
    field("Net Pay", { required: true, type: "number" }),
    field("Other names"),
  ];

  it("passes when every required field has a source", () => {
    expect(missingRequired(autoMap(columns, fields), all(columns), fields)).toEqual([]);
  });

  it("reports a required field that is not mapped", () => {
    const mapping = { ...autoMap(columns, fields), Surname: "" };
    expect(missingRequired(mapping, all(columns), fields).map((f) => f.key)).toEqual(["Surname"]);
  });

  it("reports a required field whose column was deselected", () => {
    const mapping = autoMap(columns, fields);
    const selected = new Set(["ID", "Surname"]); // "Net Pay" unticked in the grid
    expect(missingRequired(mapping, selected, fields).map((f) => f.key)).toEqual(["Net Pay"]);
    expect(effectiveMapping(mapping, selected, fields)).toEqual({ ID: "ID", Surname: "Surname" });
  });

  it("does not require optional fields", () => {
    expect(
      missingRequired({ ID: "ID", Surname: "Surname", "Net Pay": "Net Pay" }, all(columns), fields),
    ).toEqual([]);
  });

  it("ignores a mapping to a column that doesn't exist", () => {
    const mapping = { ID: "Nope", Surname: "Surname", "Net Pay": "Net Pay" };
    expect(missingRequired(mapping, all(columns), fields).map((f) => f.key)).toEqual(["ID"]);
  });
});

describe("validateRows (type checks, row by row)", () => {
  const fields = [
    field("ID", { required: true }),
    field("Net Pay", { type: "number", required: true }),
    field("Age 60+", { type: "boolean", required: true }),
    field("Paid on", { type: "date" }),
    field("Other names"),
  ];
  const mapping = {
    ID: "ID",
    "Net Pay": "Net Pay",
    "Age 60+": "Age 60+",
    "Paid on": "Paid on",
    "Other names": "Other names",
  };

  it("accepts well-formed rows, including Yes/No booleans and empty optional fields", () => {
    const rows = [
      row(1, {
        ID: "X1",
        "Net Pay": 100.5,
        "Age 60+": "No",
        "Paid on": "2026-09-30",
        "Other names": "",
      }),
      row(2, { ID: 12345, "Net Pay": 0, "Age 60+": true, "Paid on": null }),
    ];
    expect(validateRows(rows, mapping, fields)).toEqual([]);
  });

  it("reports each problem with its row number and field", () => {
    const rows = [
      row(1, { ID: "X1", "Net Pay": 100, "Age 60+": "No" }),
      row(2, { ID: "", "Net Pay": "100", "Age 60+": "Maybe", "Paid on": "next week" }),
      row(7, { ID: "X7", "Net Pay": null, "Age 60+": "Yes", "Other names": { a: 1 } }),
    ];
    expect(validateRows(rows, mapping, fields)).toEqual([
      { row: 2, field: "ID", message: "is empty" },
      { row: 2, field: "Net Pay", message: "must be a number" },
      { row: 2, field: "Age 60+", message: 'must be "Yes" or "No"' },
      { row: 2, field: "Paid on", message: "must be a date" },
      { row: 7, field: "Net Pay", message: "is empty" },
      { row: 7, field: "Other names", message: "must be text" },
    ]);
  });

  it("accepts an optional number that is empty, and refuses one that is text", () => {
    const optional = [field("Employee CSG", { type: "number" })];
    const map = { "Employee CSG": "Employee CSG" };
    expect(
      validateRows(
        [row(1, {}), row(2, { "Employee CSG": null }), row(3, { "Employee CSG": "" })],
        map,
        optional,
      ),
    ).toEqual([]);
    expect(validateRows([row(4, { "Employee CSG": "279.53" })], map, optional)).toEqual([
      { row: 4, field: "Employee CSG", message: "must be a number" },
    ]);
  });

  it("only checks fields that are mapped", () => {
    const rows = [row(1, { ID: "X1", "Net Pay": "oops", "Age 60+": "No" })];
    expect(validateRows(rows, { ID: "ID" }, fields)).toEqual([]);
  });

  it("finds nothing wrong with the valid sample sent to the PDF filler", () => {
    const table = tableFromReceived(original);
    expect(validateRows(table.rows, autoMap(table.columns, pdfFields), pdfFields)).toEqual([]);
  });
});

describe("buildOutput", () => {
  it("sends only the selected rows and the mapped fields, under the destination's names", () => {
    const rows = [
      row(1, { a: "one", b: 1, secret: "s1" }),
      row(3, { a: "three", b: 3, secret: "s3" }),
    ];
    const fields = [field("Name"), field("Amount", { type: "number" }), field("Unmapped")];
    expect(buildOutput(rows, { Name: "a", Amount: "b" }, fields)).toEqual([
      { Name: "one", Amount: 1 },
      { Name: "three", Amount: 3 },
    ]);
  });

  it("does not change values on the way through", () => {
    const table = tableFromReceived(original);
    const output = buildOutput(table.rows, autoMap(table.columns, pdfFields), pdfFields);
    expect(output[0]!["Net Pay"]).toBe(original[0]!["Net Pay"]);
    expect(output[0]!["CSG"]).toBe(original[0]!["CSG"]);
    // An unknown extra field is not something the PDF filler asked for, so it stays behind.
    expect(Object.keys(output[5]!)).not.toContain("Bonus");
    expect(Object.keys(output[0]!)).toEqual(
      pdfFields.map((f) => f.key).filter((key) => key !== "Date of Employment"),
    );
  });
});

describe("buildOutput: a figure the row does not have", () => {
  const fields = [
    field("Name"),
    field("Net Pay", { type: "number", required: true }),
    field("Employee CSG", { type: "number" }),
  ];
  const mapping = { Name: "Name", "Net Pay": "Net Pay", "Employee CSG": "Employee CSG" };

  it('leaves an empty optional number out of that row: no key, never "" and never 0', () => {
    const rows = [
      row(1, { Name: "A", "Net Pay": 1, "Employee CSG": 279.53 }),
      row(2, { Name: "B", "Net Pay": 2 }),
      row(3, { Name: "C", "Net Pay": 3, "Employee CSG": null }),
      row(4, { Name: "D", "Net Pay": 4, "Employee CSG": "" }),
      row(5, { Name: "E", "Net Pay": 5, "Employee CSG": 0 }),
    ];
    expect(buildOutput(rows, mapping, fields)).toEqual([
      { Name: "A", "Net Pay": 1, "Employee CSG": 279.53 },
      { Name: "B", "Net Pay": 2 },
      { Name: "C", "Net Pay": 3 },
      { Name: "D", "Net Pay": 4 },
      { Name: "E", "Net Pay": 5, "Employee CSG": 0 },
    ]);
  });

  it("still sends every other empty field exactly as before", () => {
    expect(buildOutput([row(1, { "Net Pay": null })], mapping, fields)).toEqual([
      { Name: "", "Net Pay": "" },
    ]);
  });

  it("sends a run saved without the figures with neither key, on every row", () => {
    const parsed = parsePayrollRows(JSON.parse(olderSample));
    const table = tableFromRun(parsed.rows, parsed.company!);
    const output = buildOutput(table.rows, autoMap(table.columns, pdfFields), pdfFields);
    expect(output).toHaveLength(6);
    for (const sent of output) {
      expect(sent).not.toHaveProperty("Employee CSG");
      expect(sent).not.toHaveProperty("Employee NSF");
    }
  });
});

describe("the date of employment in the wizard", () => {
  const parsed = parsePayrollRows(JSON.parse(olderSample));
  const withDates = parsed.rows.map((r, index) => ({
    ...r,
    employee_id: `30000000-0000-4000-8000-00000000000${index}`,
    date_of_employment: index === 0 ? "2019-03-04" : null,
  }));

  it("is a column of a saved run when the database has it, and not otherwise", () => {
    const table = tableFromRun(withDates, parsed.company!);
    expect(table.columns.find((c) => c.key === "Date of Employment")).toEqual({
      key: "Date of Employment",
      label: "Date of employment",
      type: "string",
      sensitive: false,
      money: false,
    });
    const without = tableFromRun(parsed.rows, parsed.company!);
    expect(without.columns.map((c) => c.key)).not.toContain("Date of Employment");
  });

  it("is sent for the employee who has one and left out for the others", () => {
    const table = tableFromRun(withDates, parsed.company!);
    const mapping = autoMap(table.columns, pdfFields);
    expect(mapping["Date of Employment"]).toBe("Date of Employment");
    expect(validateRows(table.rows, mapping, pdfFields)).toEqual([]);
    const output = buildOutput(table.rows, mapping, pdfFields);
    expect(output[0]!["Date of Employment"]).toBe("2019-03-04");
    for (const sent of output.slice(1)) expect(sent).not.toHaveProperty("Date of Employment");
  });

  it("is refused by the wizard when it is not a date", () => {
    const fields = [field("Date of Employment", { type: "date" })];
    const map = { "Date of Employment": "Date of Employment" };
    expect(validateRows([row(1, { "Date of Employment": "last March" })], map, fields)).toEqual([
      { row: 1, field: "Date of Employment", message: "must be a date" },
    ]);
  });
});

describe("sensitiveColumnsSent", () => {
  it("lists the sensitive columns the mapping sends, and only those", () => {
    const columns = [
      column("ID", { sensitive: true }),
      column("Surname"),
      column("Net Pay", { sensitive: true }),
      column("Gross Pay", { sensitive: true }),
    ];
    const sent = sensitiveColumnsSent({ a: "ID", b: "Surname", c: "Net Pay" }, columns);
    expect(sent.map((c) => c.key)).toEqual(["ID", "Net Pay"]);
  });
});
