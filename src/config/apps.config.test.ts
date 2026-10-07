import { describe, expect, it } from "vitest";
import sample from "../../samples/ABC Co Ltd-pdf-fill-2026-09.json?raw";
import olderSample from "../../samples/ABC Co Ltd-pdf-fill-2026-10.json?raw";
import { parsePayrollRows } from "@/features/import/parsePayroll";
import { appOrigin, APPS, appsAccepting, getApp, PAYROLL_RESULT } from "./apps.config";
import { HOSTING } from "./origins";
import { PAYROLL_FIELDS, toExportRow, type PayrollRow } from "./payrollFields";

describe("app registry", () => {
  it("uses the exact app URLs, with trailing slashes", () => {
    expect(getApp("payroll")?.url).toBe("https://noor1290.github.io/payroll_sys/");
    expect(getApp("pdf-editor")?.url).toBe("https://noor1290.github.io/pdf-form-filler/");
    expect(getApp("payslip")?.url).toBe("https://noor1290.github.io/payslip/");
    for (const app of APPS) expect(app.url.endsWith("/")).toBe(true);
  });

  it("derives each app's origin from its URL", () => {
    expect(appOrigin(getApp("payroll")!)).toBe(HOSTING.apps);
    expect(appOrigin(getApp("pdf-editor")!)).toBe("https://noor1290.github.io");
    expect(appOrigin(getApp("payslip")!)).toBe(HOSTING.apps);
  });

  it("has unique ids, and every app is active", () => {
    expect(new Set(APPS.map((app) => app.id)).size).toBe(APPS.length);
    expect(APPS.map((app) => app.status)).toEqual(["active", "active", "active"]);
  });

  it("registers what the payslip app may receive and send, and not issued payslips yet", () => {
    const payslip = getApp("payslip")!;
    expect(payslip.accepts).toEqual(["payroll-result", "statutory-rates", "payslip-template"]);
    expect(payslip.produces).toEqual(["statutory-rates", "payslip-template"]);
    expect([...payslip.accepts, ...payslip.produces]).not.toContain("payslip-issue");
    expect(payslip.expectedFields).toEqual(getApp("pdf-editor")!.expectedFields);
    // Nothing changes for the other apps, and payroll results still go to the same two.
    expect(getApp("payroll")).toMatchObject({ accepts: [], produces: ["payroll-result"] });
    expect(getApp("pdf-editor")).toMatchObject({ accepts: ["payroll-result"], produces: [] });
    expect(appsAccepting("statutory-rates").map((app) => app.id)).toEqual(["payslip"]);
    expect(appsAccepting("payslip-template").map((app) => app.id)).toEqual(["payslip"]);
  });

  it("builds Send-to destinations from `accepts`, leaving out the sender", () => {
    expect(appsAccepting(PAYROLL_RESULT, "payroll").map((app) => app.id)).toEqual([
      "pdf-editor",
      "payslip",
    ]);
    expect(appsAccepting(PAYROLL_RESULT, "pdf-editor").map((app) => app.id)).toEqual(["payslip"]);
    expect(appsAccepting("something-else")).toEqual([]);
  });

  it("gives consumers the payroll export's own field names as expected fields", () => {
    const keys = getApp("pdf-editor")!.expectedFields.map((field) => field.key);
    // The payroll export's own keys, then the one field the dashboard adds.
    expect(keys).toEqual([...PAYROLL_FIELDS.map((field) => field.jsonKey), "Date of Employment"]);
    expect(getApp("pdf-editor")!.expectedFields.at(-1)).toEqual({
      key: "Date of Employment",
      label: "Date of employment",
      type: "date",
      required: false,
      sensitive: false,
    });
    expect(getApp("pdf-editor")!.expectedFields.find((f) => f.key === "ID")).toMatchObject({
      required: true,
      sensitive: true,
    });
  });
});

describe("toExportRow", () => {
  it("turns a stored row back into the payroll app's export, value for value", () => {
    const original = JSON.parse(sample) as Record<string, unknown>[];
    const parsed = parsePayrollRows(original);
    expect(parsed.errors).toEqual([]);

    const exported = parsed.rows.map((row) => toExportRow(row, parsed.company!));

    // Same as the file, apart from the trimming the import always does.
    const trimmed = original.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]),
      ),
    );
    expect(exported).toEqual(trimmed);
  });

  it("survives a second import unchanged (export -> import -> export)", () => {
    const first = parsePayrollRows(JSON.parse(sample));
    const exported = first.rows.map((row) => toExportRow(row, first.company!));
    const second = parsePayrollRows(exported);
    expect(second.errors).toEqual([]);
    expect(second.rows).toEqual(first.rows);
  });
});

describe('toExportRow: "Employee CSG" and "Employee NSF"', () => {
  const company = { name: "ABC Co Ltd", address: "Mauritius", brn: "C1234567", vat: "12%" };
  const stored = (extra: Record<string, unknown>): PayrollRow => ({
    ...parsePayrollRows(JSON.parse(olderSample)).rows[0]!,
    extra,
  });

  it("returns them under the payroll app's own names, value for value", () => {
    const row = toExportRow(stored({ employee_csg: 279.53, employee_nsf: 186.35 }), company);
    expect(row["Employee CSG"]).toBe(279.53);
    expect(row["Employee NSF"]).toBe(186.35);
  });

  it("never sends the storage names", () => {
    const row = toExportRow(stored({ employee_csg: 279.53, employee_nsf: 186.35 }), company);
    expect(row).not.toHaveProperty("employee_csg");
    expect(row).not.toHaveProperty("employee_nsf");
  });

  it('leaves an absent figure out: no key, never "" and never 0', () => {
    const older = parsePayrollRows(JSON.parse(olderSample));
    for (const row of older.rows.map((r) => toExportRow(r, older.company!))) {
      expect(row).not.toHaveProperty("Employee CSG");
      expect(row).not.toHaveProperty("Employee NSF");
    }
    const one = toExportRow(stored({ employee_nsf: 186.35 }), company);
    expect(one).not.toHaveProperty("Employee CSG");
    expect(one["Employee NSF"]).toBe(186.35);
  });

  it("sends a real 0 as 0", () => {
    const row = toExportRow(stored({ employee_csg: 279.53, employee_nsf: 0 }), company);
    expect(row["Employee NSF"]).toBe(0);
  });

  it.each([null, "", "279.53", Number.NaN, { a: 1 }])(
    "treats a stored %j as absent instead of sending it",
    (value) => {
      const row = toExportRow(stored({ employee_csg: value }), company);
      expect(row).not.toHaveProperty("Employee CSG");
      expect(row).not.toHaveProperty("employee_csg");
    },
  );

  it("lists both as optional, sensitive numbers for the apps that take payroll results", () => {
    for (const key of ["Employee CSG", "Employee NSF"]) {
      expect(getApp("pdf-editor")!.expectedFields.find((f) => f.key === key)).toEqual({
        key,
        label: key,
        type: "number",
        required: false,
        sensitive: true,
      });
    }
  });
});

describe('toExportRow: "Date of Employment"', () => {
  const company = { name: "ABC Co Ltd", address: "Mauritius", brn: "C1234567", vat: "12%" };
  const saved = (more: Partial<PayrollRow>): PayrollRow => ({
    ...parsePayrollRows(JSON.parse(olderSample)).rows[0]!,
    ...more,
  });

  it("adds it, as YYYY-MM-DD text, for an employee who has one", () => {
    const row = toExportRow(saved({ date_of_employment: "2019-03-04" }), company);
    expect(row["Date of Employment"]).toBe("2019-03-04");
  });

  it.each([null, undefined, "", "04/03/2019", "2019-02-30"])(
    'leaves the key out when the stored value is %j: never "" and never a guess',
    (value) => {
      const row = toExportRow(saved({ date_of_employment: value }), company);
      expect(row).not.toHaveProperty("Date of Employment");
    },
  );

  it("changes nothing else about the row", () => {
    const row = toExportRow(saved({ date_of_employment: "2019-03-04" }), company);
    delete row["Date of Employment"];
    expect(row).toEqual(toExportRow(saved({}), company));
  });

  it("is not taken from a file: an import leaves the key out, without an error", () => {
    const [first] = JSON.parse(olderSample) as Record<string, unknown>[];
    for (const key of ["Date of Employment", " date of  employment "]) {
      const parsed = parsePayrollRows([{ ...first, [key]: "1999-01-01" }]);
      expect(parsed.errors).toEqual([]);
      expect(parsed.rows[0]!.extra).toEqual({});
      expect(parsed.rows[0]!.date_of_employment).toBeUndefined();
    }
  });

  it("does not let an old stored copy of the key travel as an unknown field", () => {
    const row = toExportRow(saved({ extra: { "Date of Employment": "1999-01-01" } }), company);
    expect(row).not.toHaveProperty("Date of Employment");
  });
});
