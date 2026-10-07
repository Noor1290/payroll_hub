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
    expect(getApp("payslip")?.url).toBe("");
  });

  it("derives each app's origin from its URL", () => {
    expect(appOrigin(getApp("payroll")!)).toBe(HOSTING.apps);
    expect(appOrigin(getApp("pdf-editor")!)).toBe("https://noor1290.github.io");
    expect(appOrigin(getApp("payslip")!)).toBeNull();
  });

  it("has unique ids and a status for every app", () => {
    expect(new Set(APPS.map((app) => app.id)).size).toBe(APPS.length);
    expect(getApp("payslip")?.status).toBe("coming-soon");
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
    expect(keys).toEqual(PAYROLL_FIELDS.map((field) => field.jsonKey));
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
