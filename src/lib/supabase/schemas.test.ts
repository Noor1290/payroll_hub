import { describe, expect, it } from "vitest";
import { membershipRowSchema, moneySchema, runSummaryRowSchema, toRunSummary } from "./schemas";

const COMPANY_ID = "10000000-0000-4000-8000-000000000001";
const RUN_ID = "20000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000001";

describe("membershipRowSchema", () => {
  const company = {
    id: COMPANY_ID,
    name: "ABC Co Ltd",
    address: null,
    brn: "C1234567",
    vat: "12%",
  };

  it("accepts a membership with its embedded company", () => {
    expect(membershipRowSchema.parse({ role: "admin", companies: company }).role).toBe("admin");
  });

  it("rejects an unknown role instead of guessing", () => {
    expect(membershipRowSchema.safeParse({ role: "owner", companies: company }).success).toBe(
      false,
    );
  });

  it("rejects a membership whose company is missing", () => {
    expect(membershipRowSchema.safeParse({ role: "viewer", companies: null }).success).toBe(false);
  });
});

describe("runSummaryRowSchema", () => {
  const row = {
    id: RUN_ID,
    period: "2026-09-01",
    status: "draft",
    created_by: USER_ID,
    created_at: "2026-09-28T10:15:00+00:00",
    payroll_entries: [{ count: 12 }],
  };

  it("maps a row, reading the embedded entry count", () => {
    expect(toRunSummary(runSummaryRowSchema.parse(row))).toEqual({
      id: RUN_ID,
      period: "2026-09-01",
      status: "draft",
      createdBy: USER_ID,
      createdAt: "2026-09-28T10:15:00+00:00",
      entryCount: 12,
    });
  });

  it("treats a missing count as zero entries", () => {
    const parsed = runSummaryRowSchema.parse({ ...row, payroll_entries: [] });
    expect(toRunSummary(parsed).entryCount).toBe(0);
  });

  it("rejects a period that is not the first of a month", () => {
    expect(runSummaryRowSchema.safeParse({ ...row, period: "2026-09-15" }).success).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(runSummaryRowSchema.safeParse({ ...row, status: "paid" }).success).toBe(false);
  });
});

describe("moneySchema", () => {
  it("accepts numbers and numeric strings without changing the value", () => {
    expect(moneySchema.parse(18169.12)).toBe(18169.12);
    expect(moneySchema.parse("18169.12")).toBe(18169.12);
    expect(moneySchema.parse(0)).toBe(0);
  });

  it("rejects anything that is not a plain number", () => {
    for (const bad of [null, "", "12,000", "abc", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(moneySchema.safeParse(bad).success).toBe(false);
    }
  });
});
