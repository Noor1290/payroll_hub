import { describe, expect, it } from "vitest";
import validSample from "../../../samples/ABC Co Ltd-pdf-fill-2026-09.json?raw";
import olderSample from "../../../samples/ABC Co Ltd-pdf-fill-2026-10.json?raw";
import invalidSample from "../../../samples/INVALID rows-pdf-fill-2026-09.json?raw";
import mixedSample from "../../../samples/INVALID mixed companies-pdf-fill-2026-09.json?raw";
import {
  checkMoney,
  parsePayrollFile,
  periodFromFileName,
  periodFromMonthInput,
} from "./parsePayroll";

// FAKE values only.
const base = {
  ID: "X0000000000000",
  Surname: "DOE",
  "Other names": "JANE",
  "Basic Salary": 18000,
  "Govt Increment": 635,
  "New Basic Salary": 18635,
  "Full time / Part time": "Full Time ",
  Allowances: 0,
  Emoluments: 18635,
  Travelling: 0,
  "Gross Pay": 18635,
  "Age 60+": "No",
  CSG: 559.05,
  NSF: 449.5,
  PAYE: 0,
  "Total deductions": 465.88,
  "Net Pay": 18169.12,
  Levy: 270,
  PRGF: 838.58,
  "Total MRA contributions": 2580.1,
  EDF: 390000,
  "EDF (monthly)": 30000,
  Total: 0,
  "Company Name": "ABC Co Ltd",
  Address: "Mauritius",
  BRN: "C1234567",
  VAT: "12%",
};
const parse = (...rows: unknown[]) => parsePayrollFile(JSON.stringify(rows));

describe("parsePayrollFile: mapping", () => {
  it("maps every known field to its column without changing the numbers", () => {
    const { rows, errors, fatal } = parse(base);
    expect(fatal).toBeNull();
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({
      id: "1",
      national_id: "X0000000000000",
      surname: "DOE",
      other_names: "JANE",
      employment_type: "Full Time",
      age_60_plus: false,
      basic_salary: 18000,
      govt_increment: 635,
      new_basic_salary: 18635,
      gross_pay: 18635,
      csg: 559.05,
      nsf: 449.5,
      total_deductions: 465.88,
      net_pay: 18169.12,
      prgf: 838.58,
      total_mra_contributions: 2580.1,
      edf: 390000,
      edf_monthly: 30000,
      total: 0,
      extra: {},
    });
  });

  it("does not recalculate: inconsistent figures are stored as exported", () => {
    const { rows } = parse({ ...base, "Gross Pay": 1, "Net Pay": 999999 });
    expect(rows[0]).toMatchObject({ gross_pay: 1, net_pay: 999999 });
  });

  it("trims every string, including keys and values inside unknown fields", () => {
    const { rows, company } = parse({
      ...base,
      Surname: "PALMYRE ",
      "Other names": "  JEAN  ",
      " Note ": "  hello ",
      "Company Name": " ABC Co Ltd ",
    });
    expect(rows[0]).toMatchObject({ surname: "PALMYRE", other_names: "JEAN" });
    expect(rows[0]?.extra).toEqual({ Note: "hello" });
    expect(company?.name).toBe("ABC Co Ltd");
  });

  it("puts unknown keys in extra so new fields never break the import", () => {
    const { rows, errors } = parse({ ...base, Bonus: 1500, Notes: { a: 1 } });
    expect(errors).toEqual([]);
    expect(rows[0]?.extra).toEqual({ Bonus: 1500, Notes: { a: 1 } });
  });

  it("matches keys regardless of case and stray spaces", () => {
    const { ["Net Pay"]: netPay, ...rest } = base;
    const { rows, errors } = parse({ ...rest, "net  pay ": netPay });
    expect(errors).toEqual([]);
    expect(rows[0]?.net_pay).toBe(18169.12);
    expect(rows[0]?.extra).toEqual({});
  });

  it('reads "Age 60+" Yes/No in any case', () => {
    expect(parse({ ...base, "Age 60+": "YES" }).rows[0]?.age_60_plus).toBe(true);
    expect(parse({ ...base, "Age 60+": "no " }).rows[0]?.age_60_plus).toBe(false);
  });

  it("allows optional text to be absent and stores null", () => {
    const { rows, errors } = parse({ ...base, "Other names": "", "Full time / Part time": " " });
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ other_names: null, employment_type: null });
  });

  it("returns the file's company details", () => {
    expect(parse(base).company).toEqual({
      name: "ABC Co Ltd",
      address: "Mauritius",
      brn: "C1234567",
      vat: "12%",
    });
  });
});

describe('parsePayrollFile: "Employee CSG" and "Employee NSF"', () => {
  it("stores both inside extra under their column names, with the numbers unchanged", () => {
    const { rows, errors } = parse({ ...base, "Employee CSG": 279.53, "Employee NSF": 186.35 });
    expect(errors).toEqual([]);
    expect(rows[0]?.extra).toEqual({ employee_csg: 279.53, employee_nsf: 186.35 });
  });

  it("keeps them next to unknown fields, which still travel untouched", () => {
    const { rows } = parse({ ...base, "employee  csg ": 279.53, Bonus: 1500 });
    expect(rows[0]?.extra).toEqual({ Bonus: 1500, employee_csg: 279.53 });
  });

  it.each([
    ["the key is not there", {}],
    ["the value is null", { "Employee CSG": null, "Employee NSF": null }],
    ['the value is ""', { "Employee CSG": "", "Employee NSF": "" }],
    ["the value is only spaces", { "Employee CSG": "  ", "Employee NSF": " " }],
  ])("treats them as absent, not as an error and not as 0, when %s", (_name, more) => {
    const { rows, errors } = parse({ ...base, ...more });
    expect(errors).toEqual([]);
    expect(rows[0]?.extra).toEqual({});
  });

  it("accepts one without the other", () => {
    const { rows, errors } = parse({ ...base, "Employee NSF": 186.35 });
    expect(errors).toEqual([]);
    expect(rows[0]?.extra).toEqual({ employee_nsf: 186.35 });
  });

  it("keeps a real 0: it is a figure, not a missing one", () => {
    const { rows, errors } = parse({ ...base, "Employee CSG": 279.53, "Employee NSF": 0 });
    expect(errors).toEqual([]);
    expect(rows[0]?.extra).toEqual({ employee_csg: 279.53, employee_nsf: 0 });
  });

  it("refuses text, like the other money fields", () => {
    expect(parse({ ...base, "Employee CSG": "279.53", "Employee NSF": "n/a" }).errors).toEqual([
      { row: 1, field: "Employee CSG", message: "must be a number" },
      { row: 1, field: "Employee NSF", message: "must be a number" },
    ]);
    expect(parse({ ...base, "Employee CSG": true }).errors).toEqual([
      { row: 1, field: "Employee CSG", message: "must be a number" },
    ]);
  });

  it("never rounds: more than 2 decimals is a row error", () => {
    expect(parse({ ...base, "Employee CSG": 279.525 }).errors).toEqual([
      { row: 1, field: "Employee CSG", message: "has more than 2 decimal places" },
    ]);
  });

  it("refuses an unknown field that uses one of the reserved storage names", () => {
    const { rows, errors } = parse({ ...base, employee_csg: 1 });
    expect(rows).toEqual([]);
    expect(errors).toEqual([
      { row: 1, field: "employee_csg", message: "is a name the dashboard reserves" },
    ]);
  });
});

describe("parsePayrollFile: row-level errors", () => {
  it("reports the row number and field for each problem, and never drops a row silently", () => {
    const { rows, errors, rowCount } = parse(
      base,
      { ...base, ID: "X2", "Net Pay": "twenty thousand" },
      { ...base, ID: "X3", "Age 60+": "Maybe", Surname: "  " },
    );
    expect(rowCount).toBe(3);
    expect(rows).toHaveLength(1);
    expect(errors).toEqual([
      { row: 2, field: "Net Pay", message: "must be a number" },
      { row: 3, field: "Surname", message: "is missing" },
      { row: 3, field: "Age 60+", message: 'must be "Yes" or "No"' },
    ]);
  });

  it("reports a missing numeric field instead of assuming zero", () => {
    const rest: Record<string, unknown> = { ...base };
    delete rest["Gross Pay"];
    expect(parse(rest).errors).toEqual([{ row: 1, field: "Gross Pay", message: "is missing" }]);
  });

  it("does not accept numbers written as text", () => {
    expect(parse({ ...base, CSG: "559.05" }).errors).toEqual([
      { row: 1, field: "CSG", message: "must be a number" },
    ]);
  });

  it("flags a repeated ID by pointing at the first row, without printing the ID", () => {
    const { errors } = parse(base, { ...base, Surname: "OTHER" });
    expect(errors).toEqual([{ row: 2, field: "ID", message: "is the same as row 1" }]);
    expect(JSON.stringify(errors)).not.toContain(base.ID);
  });

  it("flags a row that is not an object", () => {
    expect(parse(base, 42).errors).toEqual([
      { row: 2, field: "(row)", message: "is not an object" },
    ]);
  });
});

describe("parsePayrollFile: file-level errors", () => {
  it("rejects invalid JSON, non-arrays and empty files with a clear message", () => {
    expect(parsePayrollFile("{not json").fatal).toMatch(/valid JSON/);
    expect(parsePayrollFile(JSON.stringify(base)).fatal).toMatch(/list of employees/);
    expect(parsePayrollFile("[]").fatal).toMatch(/no employees/);
  });

  it("refuses a file that mixes BRNs", () => {
    const result = parse(base, { ...base, ID: "X2", BRN: "C7654321" });
    expect(result.fatal).toMatch(/more than one company/);
    expect(result.fatal).toContain("C1234567");
    expect(result.fatal).toContain("C7654321");
    expect(result.rows).toEqual([]);
  });

  it("still detects mixed BRNs when the rows have other errors", () => {
    const result = parse({ ...base, CSG: "x" }, { ...base, ID: "X2", BRN: "C7654321", CSG: "y" });
    expect(result.fatal).toMatch(/more than one company/);
  });
});

describe("checkMoney (decimals)", () => {
  it("keeps values with up to 2 decimals exactly", () => {
    expect(checkMoney(465.88)).toEqual({ ok: true, value: 465.88 });
    expect(checkMoney(2580.1)).toEqual({ ok: true, value: 2580.1 });
    expect(checkMoney(-12.5)).toEqual({ ok: true, value: -12.5 });
  });

  it("silently removes floating-point noise", () => {
    expect(checkMoney(0.1 + 0.2)).toEqual({ ok: true, value: 0.3 });
    expect(checkMoney(18169.12 + 1e-11)).toEqual({ ok: true, value: 18169.12 });
    expect(checkMoney(559.05 - 1e-11)).toEqual({ ok: true, value: 559.05 });
  });

  it("refuses real precision beyond 2 decimals instead of rounding it", () => {
    expect(checkMoney(12.3456)).toEqual({ ok: false, why: "has more than 2 decimal places" });
    expect(checkMoney(10.005)).toEqual({ ok: false, why: "has more than 2 decimal places" });
    expect(checkMoney(0.0001)).toEqual({ ok: false, why: "has more than 2 decimal places" });
  });

  it("refuses non-numbers and values too large for the column", () => {
    expect(checkMoney("12")).toMatchObject({ ok: false });
    expect(checkMoney(Number.NaN)).toMatchObject({ ok: false });
    expect(checkMoney(1e11)).toEqual({ ok: false, why: "is too large to store" });
  });
});

describe("periodFromFileName", () => {
  it("reads YYYY-MM from the usual export name", () => {
    expect(periodFromFileName("ABC Co Ltd-pdf-fill-2026-09.json")).toBe("2026-09-01");
  });

  it("uses the last YYYY-MM when the name contains several", () => {
    expect(periodFromFileName("2019-01 Holdings-pdf-fill-2026-12.json")).toBe("2026-12-01");
    expect(periodFromFileName("ABC-2026-09 (1).json")).toBe("2026-09-01");
  });

  it("returns null when there is no usable period", () => {
    expect(periodFromFileName("payroll.json")).toBeNull();
    expect(periodFromFileName("ABC-2026-13.json")).toBeNull();
    expect(periodFromFileName("ABC-2026-00.json")).toBeNull();
    expect(periodFromFileName("ABC-20260-09.json")).toBeNull();
  });
});

describe("periodFromMonthInput", () => {
  it("turns a month input into the first of that month", () => {
    expect(periodFromMonthInput("2026-09")).toBe("2026-09-01");
    expect(periodFromMonthInput("")).toBeNull();
    expect(periodFromMonthInput("2026-13")).toBeNull();
  });
});

describe("sample files", () => {
  it("the valid sample parses cleanly, trimmed, with the unknown field kept", () => {
    const result = parsePayrollFile(validSample);
    expect(result.fatal).toBeNull();
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(6);
    expect(result.rows.map((r) => r.surname)).toContain("PALMYRE");
    expect(result.rows.find((r) => r.surname === "FICTIF")?.extra).toEqual({
      Bonus: 1500,
      employee_csg: 317.03,
      employee_nsf: 186.35,
    });
    expect(result.company?.brn).toBe("C1234567");
  });

  it("the valid sample has both employee figures on every row; the older one has neither", () => {
    for (const row of parsePayrollFile(validSample).rows) {
      expect(Object.keys(row.extra)).toEqual(
        expect.arrayContaining(["employee_csg", "employee_nsf"]),
      );
    }
    const older = parsePayrollFile(olderSample);
    expect(older.errors).toEqual([]);
    for (const row of older.rows) {
      expect(row.extra).not.toHaveProperty("employee_csg");
      expect(row.extra).not.toHaveProperty("employee_nsf");
    }
  });

  it("the invalid sample produces a full error report", () => {
    const result = parsePayrollFile(invalidSample);
    expect(result.rows).toHaveLength(1);
    expect(result.errors.map((e) => `${e.row}:${e.field}`)).toEqual([
      "2:Net Pay",
      "3:ID",
      "4:Age 60+",
      "4:CSG",
      "4:Employee NSF",
      "5:Surname",
      "5:Gross Pay",
    ]);
  });

  it("the mixed-company sample is refused", () => {
    expect(parsePayrollFile(mixedSample).fatal).toMatch(/more than one company/);
  });
});
