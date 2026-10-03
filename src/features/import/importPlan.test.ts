import { describe, expect, it } from "vitest";
import { NUMERIC_COLUMNS, type NumericColumn, type PayrollRow } from "@/config/payrollFields";
import type { Membership } from "@/lib/supabase/schemas";
import {
  companyDifferences,
  diffEmployees,
  matchCompanyByBrn,
  runConflict,
  toRpcRow,
  type ExistingEmployee,
} from "./importPlan";

const membership = (name: string, brn: string | null, role: Membership["role"]): Membership => ({
  role,
  company: { id: name, name, address: "Mauritius", brn, vat: "12%" },
});

const zeroes = Object.fromEntries(NUMERIC_COLUMNS.map((c) => [c, 0])) as Record<
  NumericColumn,
  number
>;
const row = (national_id: string, surname: string, more: Partial<PayrollRow> = {}): PayrollRow => ({
  id: national_id,
  national_id,
  surname,
  other_names: "JANE",
  employment_type: "Full Time",
  age_60_plus: false,
  extra: {},
  ...zeroes,
  ...more,
});
const stored = (
  national_id: string,
  surname: string,
  more: Partial<ExistingEmployee> = {},
): ExistingEmployee => ({
  national_id,
  surname,
  other_names: "JANE",
  employment_type: "Full Time",
  deleted_at: null,
  ...more,
});

describe("matchCompanyByBrn", () => {
  const memberships = [
    membership("ABC Co Ltd", "C1234567", "admin"),
    membership("XYZ Trading Ltd", "C7654321", "viewer"),
    membership("No BRN Ltd", null, "admin"),
  ];

  it("finds the company with the same BRN, with the user's role in it", () => {
    const match = matchCompanyByBrn(memberships, "C7654321");
    expect(match).toMatchObject({ kind: "matched", membership: { role: "viewer" } });
  });

  it("ignores case and surrounding spaces", () => {
    expect(matchCompanyByBrn(memberships, " c1234567 ").kind).toBe("matched");
  });

  it("reports an unknown BRN rather than creating or guessing a company", () => {
    expect(matchCompanyByBrn(memberships, "C0000000")).toEqual({
      kind: "unknown",
      brn: "C0000000",
    });
  });

  it("reports a file with no BRN, and never matches a company that has none", () => {
    expect(matchCompanyByBrn(memberships, null)).toEqual({ kind: "no-brn" });
    expect(matchCompanyByBrn(memberships, "  ")).toEqual({ kind: "no-brn" });
  });
});

describe("companyDifferences", () => {
  const company = membership("ABC Co Ltd", "C1234567", "admin").company;

  it("is empty when the file agrees with the database", () => {
    expect(
      companyDifferences(
        { name: "ABC Co Ltd", address: "Mauritius", brn: "C1234567", vat: "12%" },
        company,
      ),
    ).toEqual([]);
  });

  it("lists each differing detail", () => {
    const differences = companyDifferences(
      { name: "ABC Company Ltd", address: "Port Louis", brn: "C1234567", vat: "15%" },
      company,
    );
    expect(differences).toHaveLength(3);
    expect(differences[0]).toContain("ABC Company Ltd");
  });

  it("does not warn about details the file leaves out", () => {
    expect(
      companyDifferences(
        { name: "ABC Co Ltd", address: null, brn: "C1234567", vat: null },
        company,
      ),
    ).toEqual([]);
  });
});

describe("diffEmployees", () => {
  it("counts new, changed, unchanged and restored employees", () => {
    const existing = [
      stored("A", "SAME"),
      stored("B", "OLD NAME"),
      stored("C", "GONE", { deleted_at: "2026-01-01T00:00:00Z" }),
      stored("Z", "NOT IN FILE"),
    ];
    const rows = [row("A", "SAME"), row("B", "NEW NAME"), row("C", "GONE"), row("D", "BRAND NEW")];
    expect(diffEmployees(rows, existing)).toEqual({
      new: 1,
      changed: 1,
      unchanged: 1,
      restored: 1,
    });
  });

  it("treats a change to other names or employment type as changed", () => {
    const existing = [stored("A", "DOE"), stored("B", "DOE")];
    const rows = [
      row("A", "DOE", { other_names: "JANET" }),
      row("B", "DOE", { employment_type: "Part Time" }),
    ];
    expect(diffEmployees(rows, existing).changed).toBe(2);
  });

  it("treats null and missing optional details as the same", () => {
    const existing = [stored("A", "DOE", { other_names: null, employment_type: null })];
    const rows = [row("A", "DOE", { other_names: null, employment_type: null })];
    expect(diffEmployees(rows, existing)).toEqual({
      new: 0,
      changed: 0,
      unchanged: 1,
      restored: 0,
    });
  });
});

describe("runConflict", () => {
  it("has no conflict when no run exists", () => {
    expect(runConflict(null)).toEqual({ kind: "none" });
  });

  it("offers Replace for a draft", () => {
    expect(runConflict({ id: "r", status: "draft", deleted_at: null }).kind).toBe("replace-draft");
  });

  it("blocks an approved run", () => {
    expect(runConflict({ id: "r", status: "approved", deleted_at: null }).kind).toBe(
      "blocked-approved",
    );
  });

  it("revives a soft-deleted run, even one that was approved", () => {
    expect(
      runConflict({ id: "r", status: "approved", deleted_at: "2026-01-01T00:00:00Z" }).kind,
    ).toBe("revive-deleted");
  });
});

describe("toRpcRow", () => {
  it("sends every column the import function reads, and nothing display-only", () => {
    const payload = toRpcRow(row("A", "DOE", { net_pay: 18169.12, extra: { Bonus: 1 } }));
    expect(Object.keys(payload).sort()).toEqual(
      [
        "national_id",
        "surname",
        "other_names",
        "employment_type",
        "age_60_plus",
        "extra",
        ...NUMERIC_COLUMNS,
      ].sort(),
    );
    expect(payload.net_pay).toBe(18169.12);
    expect(payload.extra).toEqual({ Bonus: 1 });
  });
});
