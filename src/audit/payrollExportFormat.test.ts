import { describe, expect, it } from "vitest";
import { toExportRow } from "@/config/payrollFields";
import { parsePayrollRows } from "@/features/import/parsePayroll";

/**
 * Audit: what the dashboard makes of the file the payroll app exports ("Export for PDF fill
 * (JSON)" with Company Details ticked), for the cases the end-to-end audit met.
 *
 * TEST data only: companies "TEST Co A" / "TEST Co B", employee IDs starting "TST".
 */

/** One employee as the payroll app exports them when its columns carry the dashboard's names. */
function exportRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ID: "TST001",
    Surname: "TESTER",
    "Other names": "Alpha",
    "Basic Salary": 18115,
    "Govt Increment": 635,
    "New Basic Salary": 18750,
    "Full time / Part time": "Full Time",
    Allowances: 0,
    Emoluments: 18750,
    Travelling: 1250,
    "Gross Pay": 20000,
    "Age 60+": "No",
    "Employee CSG": 281.25,
    "Employee NSF": 187.5,
    PAYE: 0,
    "Total deductions": 468.75,
    "Net Pay": 19531.25,
    CSG: 562.5,
    NSF: 468.75,
    Levy: 0,
    PRGF: 0,
    "Total MRA contributions": 1031.25,
    EDF: 390000,
    "EDF (monthly)": 30000,
    Total: 0,
    "Company Name": "TEST Co A",
    Address: "1 Test Street\nTestville",
    BRN: "TEST-BRN-A",
    ...overrides,
  };
}

/** A copy of a row without the keys named. */
function without(row: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));
}

describe("a payroll export whose columns carry the dashboard's names", () => {
  it("is accepted, with the employee's and the employer's CSG kept apart", () => {
    const parsed = parsePayrollRows([exportRow(), exportRow({ ID: "TST002", Surname: "TESTER2" })]);
    expect(parsed.fatal).toBeNull();
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(2);
    const [first] = parsed.rows;
    // Employer's share: a column of its own. Employee's share: kept in `extra`.
    expect(first!.csg).toBe(562.5);
    expect(first!.nsf).toBe(468.75);
    expect(first!.extra).toEqual({ employee_csg: 281.25, employee_nsf: 187.5 });
    expect(first!.net_pay).toBe(19531.25);
    expect(parsed.company).toEqual({
      name: "TEST Co A",
      address: "1 Test Street\nTestville",
      brn: "TEST-BRN-A",
      vat: null,
    });
  });

  it("goes back out to the other apps with the same figures under the same names", () => {
    const parsed = parsePayrollRows([exportRow()]);
    const out = toExportRow(parsed.rows[0]!, parsed.company!);
    for (const key of [
      "Basic Salary",
      "Gross Pay",
      "Employee CSG",
      "Employee NSF",
      "CSG",
      "NSF",
      "PAYE",
      "Total deductions",
      "Net Pay",
    ]) {
      expect(out[key], key).toBe(exportRow()[key]);
    }
    expect(out["Company Name"]).toBe("TEST Co A");
    expect(out.BRN).toBe("TEST-BRN-A");
  });

  it("keeps a column the dashboard does not know, untouched", () => {
    const parsed = parsePayrollRows([exportRow({ "Shift Bonus": 125.5, Status: "Probation" })]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]!.extra).toMatchObject({ "Shift Bonus": 125.5, Status: "Probation" });
    expect(toExportRow(parsed.rows[0]!, parsed.company!)).toMatchObject({
      "Shift Bonus": 125.5,
      Status: "Probation",
    });
  });
});

describe("a payroll export with two columns both called CSG", () => {
  // Since the payroll app's fix, two columns that share a name are exported as
  // "CSG (Employee Contribution)" and "CSG (Employer Contribution)". The dashboard knows the
  // employer's figure only as "CSG" and the employee's only as "Employee CSG".
  const clashing = {
    ...without(exportRow(), "CSG", "Employee CSG"),
    "CSG (Employee Contribution)": 281.25,
    "CSG (Employer Contribution)": 562.5,
  };

  it("is refused, naming CSG as missing: neither figure is stored as 0 or under the wrong name", () => {
    const parsed = parsePayrollRows([clashing]);
    expect(parsed.rows).toEqual([]);
    expect(parsed.errors).toEqual([{ row: 1, field: "CSG", message: "is missing" }]);
  });

  // RISK, kept as evidence: before that fix the same payroll setup exported ONE key "CSG"
  // holding the employer's figure, which the dashboard accepted, with no employee CSG at all.
  it("evidence: the old single-key file was accepted, without the employee's CSG", () => {
    const old = without(exportRow({ CSG: 562.5 }), "Employee CSG");
    const parsed = parsePayrollRows([old]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]!.csg).toBe(562.5);
    expect(parsed.rows[0]!.extra).toEqual({ employee_nsf: 187.5 });
  });
});

describe("figures the payroll app could not work out", () => {
  it('the text "Error" in a money column is refused, naming the row and the column', () => {
    const parsed = parsePayrollRows([exportRow(), exportRow({ ID: "TST002", PAYE: "Error" })]);
    expect(parsed.errors).toEqual([{ row: 2, field: "PAYE", message: "must be a number" }]);
    expect(parsed.rows.map((row) => row.national_id)).toEqual(["TST001"]);
  });

  it("a figure with more than 2 decimals is refused, not rounded", () => {
    const parsed = parsePayrollRows([exportRow({ "Net Pay": 19531.255 })]);
    expect(parsed.errors).toEqual([
      { row: 1, field: "Net Pay", message: "has more than 2 decimal places" },
    ]);
  });

  it("a missing figure is refused, never taken as 0", () => {
    const row = without(exportRow(), "Gross Pay");
    expect(parsePayrollRows([row]).errors).toEqual([
      { row: 1, field: "Gross Pay", message: "is missing" },
    ]);
  });
});

describe("two companies", () => {
  it("the same employee ID in two companies' files is read separately, each with its own figures", () => {
    const a = parsePayrollRows([exportRow()]);
    const b = parsePayrollRows([
      exportRow({ "Company Name": "TEST Co B", BRN: "TEST-BRN-B", "Net Pay": 77000 }),
    ]);
    expect([a.company!.brn, a.rows[0]!.national_id, a.rows[0]!.net_pay]).toEqual([
      "TEST-BRN-A",
      "TST001",
      19531.25,
    ]);
    expect([b.company!.brn, b.rows[0]!.national_id, b.rows[0]!.net_pay]).toEqual([
      "TEST-BRN-B",
      "TST001",
      77000,
    ]);
  });

  it("one file holding both companies is refused as a whole", () => {
    const parsed = parsePayrollRows([
      exportRow(),
      exportRow({ ID: "TST002", "Company Name": "TEST Co B", BRN: "TEST-BRN-B" }),
    ]);
    expect(parsed.fatal).toBe(
      "This file mixes more than one company (BRNs: TEST-BRN-A, TEST-BRN-B). Each file must contain one company only.",
    );
    expect(parsed.rows).toEqual([]);
  });

  it("the same ID twice in one file is refused without printing the ID", () => {
    const parsed = parsePayrollRows([exportRow(), exportRow()]);
    expect(parsed.errors).toEqual([{ row: 2, field: "ID", message: "is the same as row 1" }]);
  });
});
