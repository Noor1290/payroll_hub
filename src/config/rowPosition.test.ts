import { describe, expect, it } from "vitest";
import {
  exportColumns,
  inTableOrder,
  RESERVED_EXTRA_KEYS,
  ROW_POSITION_KEY,
  splitRowPosition,
  toExportRow,
  type PayrollRow,
} from "./payrollFields";

// The order of the Employee Table, kept inside `extra` (P5). FAKE values only.
const row = (national_id: string, position?: number) => ({ national_id, position });

describe("the order of the Employee Table", () => {
  it("follows the position, whatever the IDs are", () => {
    const rows = [row("A3", 2), row("A1", 3), row("A2", 1)];
    expect(inTableOrder(rows).map((one) => one.national_id)).toEqual(["A2", "A3", "A1"]);
  });

  it("a run saved before positions were kept goes by ID, never at random", () => {
    const rows = [row("T10"), row("T2"), row("T1")];
    expect(inTableOrder(rows).map((one) => one.national_id)).toEqual(["T1", "T2", "T10"]);
  });

  it("puts a row with no position after those that have one", () => {
    const rows = [row("A1"), row("Z9", 1)];
    expect(inTableOrder(rows).map((one) => one.national_id)).toEqual(["Z9", "A1"]);
  });

  it("does not change the list it is given", () => {
    const rows = [row("B", 2), row("A", 1)];
    inTableOrder(rows);
    expect(rows[0]!.national_id).toBe("B");
  });
});

describe("the position stays out of sight", () => {
  it("is taken out of extra, and the company's own columns stay", () => {
    expect(splitRowPosition({ Bonus: 5, [ROW_POSITION_KEY]: 7 })).toEqual({
      extra: { Bonus: 5 },
      position: 7,
    });
  });

  it("an older run has none, and anything else is not a position", () => {
    expect(splitRowPosition({ Bonus: 5 }).position).toBeUndefined();
    expect(splitRowPosition({ [ROW_POSITION_KEY]: "7" }).position).toBeUndefined();
  });

  it("is never a column for an app, and a file cannot use the name", () => {
    expect(exportColumns(["Bonus", ROW_POSITION_KEY])).not.toContain(ROW_POSITION_KEY);
    expect(RESERVED_EXTRA_KEYS.has(ROW_POSITION_KEY)).toBe(true);
  });

  it("does not reach an app's row, even if a row still carried it", () => {
    const stored = {
      national_id: "A1",
      surname: "DOE",
      extra: { Bonus: 5, [ROW_POSITION_KEY]: 1 },
    } as unknown as PayrollRow;
    const out = toExportRow(stored, { name: "ABC", address: "", brn: "C1", vat: "" } as never);
    expect(out).toMatchObject({ Bonus: 5 });
    expect(out).not.toHaveProperty(ROW_POSITION_KEY);
  });
});
