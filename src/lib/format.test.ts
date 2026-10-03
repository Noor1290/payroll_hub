import { describe, expect, it } from "vitest";
import { formatCount, formatMoney, formatPeriod, sumMoney } from "./format";

describe("formatMoney", () => {
  it("shows rupees with two decimals and thousands separators", () => {
    expect(formatMoney(18169.12)).toBe("Rs 18,169.12");
    expect(formatMoney(0)).toBe("Rs 0.00");
    expect(formatMoney(390000)).toBe("Rs 390,000.00");
  });
});

describe("formatCount", () => {
  it("groups thousands", () => {
    expect(formatCount(1234)).toBe("1,234");
  });
});

describe("formatPeriod", () => {
  it("names the month without shifting across timezones", () => {
    expect(formatPeriod("2026-09-01")).toBe("September 2026");
    expect(formatPeriod("2026-01-01")).toBe("January 2026");
    expect(formatPeriod("2026-12-01", "short")).toBe("Dec 2026");
  });

  it("returns the input unchanged when it is not a period", () => {
    expect(formatPeriod("soon")).toBe("soon");
    expect(formatPeriod("2026-13-01")).toBe("2026-13-01");
  });
});

describe("sumMoney", () => {
  it("adds without floating-point drift", () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(sumMoney([0.1, 0.2])).toBe(0.3);
    expect(sumMoney([18169.12, 559.05, 449.5])).toBe(19177.67);
  });

  it("is zero for no values", () => {
    expect(sumMoney([])).toBe(0);
  });
});
