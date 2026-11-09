// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  cellValue,
  excelSerialToIso,
  parseCheckboxValue,
  parseNumberCell,
  readDate,
  readExcelDateCell,
} from "./employeeCells";

// The cell rules the dashboard holds a COPY of (Payroll_sys src/lib/excelImport.js and
// src/lib/dates.js, copied 9 November 2026). Pinned here by example, so a change to the copy is
// seen; a change in Payroll System must be made here too (docs/KNOWN_ISSUES.md).

describe("a figure (Payroll System's parseNumberCell)", () => {
  it.each([
    ["", 0],
    ["   ", 0],
    [18115, 18115],
    ["18115", 18115],
    ["18,115.00", 18115],
    ["18 115.50", 18115.5],
    ["18 115.50", 18115.5],
    ["Rs 18115", 18115],
    ["Rs. 18 115.50", 18115.5],
    ["MUR 1,000", 1000],
    ["18115 Rs", 18115],
    ["$12.5", 12.5],
    ["(1,200.00)", -1200],
    ["-1,200.00", -1200],
    ["+5", 5],
    [".5", 0.5],
    ["1e3", 1000],
  ])("reads %j as %d", (raw, value) => {
    expect(parseNumberCell(raw)).toEqual({ ok: true, value });
  });

  it.each([["n/a"], ["12,34"], ["1,2,3"], ["Rs"], ["12.5.6"], ["--5"], [Number.NaN], [true]])(
    "refuses %j",
    (raw) => {
      expect(parseNumberCell(raw)).toEqual({ ok: false });
    },
  );
});

describe("a tick (Payroll System's parseCheckboxValue)", () => {
  it.each([["Yes"], ["y"], ["TRUE"], ["1"], ["x"], [" X "]])("%j ticks it", (raw) => {
    expect(parseCheckboxValue(raw)).toBe(true);
  });
  it.each([["No"], ["0"], [""], ["maybe"], [null]])("%j leaves it unticked", (raw) => {
    expect(parseCheckboxValue(raw)).toBe(false);
  });
});

describe("a date (Payroll System's dates.js)", () => {
  it.each([
    ["05/03/2024", "2024-03-05"],
    ["5/3/2024", "2024-03-05"],
    ["05-03-2024", "2024-03-05"],
    ["05.03.2024", "2024-03-05"],
    ["2024-03-05", "2024-03-05"],
    ["29/02/2024", "2024-02-29"],
  ])("reads %j day first as %s", (raw, value) => {
    expect(readDate(raw)).toEqual({ value });
  });

  it.each([
    ["31/02/2026", true],
    ["29/02/2025", true],
    ["13/13/2020", true],
    ["01/01/1899", true],
    ["2024-3-5", false],
    ["05/03/24", false],
    ["5 March 2024", false],
    ["05/03-2024", false],
  ])("refuses %j", (raw, wellFormed) => {
    expect(readDate(raw)).toEqual({ unreadable: true, wellFormed });
  });

  it("reads an Excel date cell by its serial number, with Excel's 29 February 1900", () => {
    expect(excelSerialToIso(45356)).toBe("2024-03-05");
    expect(excelSerialToIso(45356.75)).toBe("2024-03-05");
    expect(excelSerialToIso(1)).toBe("1900-01-01");
    expect(excelSerialToIso(59)).toBe("1900-02-28");
    expect(excelSerialToIso(61)).toBe("1900-03-01");
    expect(excelSerialToIso(60)).toBeNull();
    expect(excelSerialToIso(0)).toBeNull();
    expect(excelSerialToIso("45356")).toBeNull();
  });

  it("reads a Date cell: a number, text, or nothing", () => {
    expect(readExcelDateCell(45356)).toEqual({ value: "2024-03-05" });
    expect(readExcelDateCell("05/03/2024")).toEqual({ value: "2024-03-05" });
    expect(readExcelDateCell("")).toEqual({ value: "" });
    expect(readExcelDateCell("soon")).toEqual({ unreadable: true });
  });
});

describe("a cell of the sheet, for each kind of column", () => {
  const text = (t: string) => ({ text: t, kind: "text" as const });
  const number = (t: string) => ({ text: t, kind: "number" as const });

  it("keeps text as it is (trimmed), a number typed in a Text field as its digits", () => {
    expect(cellValue("text", text("  Testone "))).toBe("Testone");
    expect(cellValue("text", number("7"))).toBe("7");
  });

  it("reads a figure, a tick and a date, and gives null for what can't be read", () => {
    expect(cellValue("number", number("31234.56"))).toBe(31234.56);
    expect(cellValue("number", text("Rs 18,115.00"))).toBe(18115);
    expect(cellValue("number", text("n/a"))).toBeNull();
    expect(cellValue("checkbox", text("Yes"))).toBe(true);
    expect(cellValue("checkbox", number("0"))).toBe(false);
    expect(cellValue("date", number("45356"))).toBe("2024-03-05");
    expect(cellValue("date", text("05/03/2024"))).toBe("2024-03-05");
    expect(cellValue("date", text("31/02/2026"))).toBeNull();
  });
});
