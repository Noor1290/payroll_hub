import { describe, expect, it } from "vitest";
import { decideEmploymentDate, type StoredEmploymentDate } from "./employmentDateRule";

// FAKE dates only. Months are written as their first day.
const SEP = "2026-09-01";
const OCT = "2026-10-01";
const NOV = "2026-11-01";
const sent = (month: string | null): StoredEmploymentDate => ({ date: "2021-03-15", month, typed: false });
const typed = (month: string | null): StoredEmploymentDate => ({ date: "2021-03-15", month, typed: true });
const before0017: StoredEmploymentDate = { date: "2021-03-15", month: null, typed: null };

describe("decideEmploymentDate", () => {
  it("stores a date for an employee who has none", () => {
    expect(decideEmploymentDate({ date: null, month: null, typed: null }, "2021-03-15", OCT, null)).toBe("store");
  });

  describe("a date sent by the payroll app", () => {
    it("is replaced by a different date sent for a newer month", () => {
      expect(decideEmploymentDate(sent(OCT), "2021-04-01", NOV, OCT)).toBe("replace");
    });

    it("is replaced by a different date sent for the same month (the month sent again, corrected)", () => {
      expect(decideEmploymentDate(sent(OCT), "2021-04-01", OCT, NOV)).toBe("replace");
    });

    it("is NOT replaced by an older month sent again", () => {
      expect(decideEmploymentDate(sent(NOV), "2021-03-15", OCT, NOV)).toBe("same");
      expect(decideEmploymentDate(sent(NOV), "2020-01-02", OCT, NOV)).toBe("keep-newer");
      expect(decideEmploymentDate(sent(NOV), "2020-01-02", SEP, NOV)).toBe("keep-newer");
    });

    it("the same date sent for a newer month only notes the newer month", () => {
      expect(decideEmploymentDate(sent(OCT), "2021-03-15", NOV, OCT)).toBe("same-newer");
      expect(decideEmploymentDate(sent(OCT), "2021-03-15", OCT, OCT)).toBe("same");
    });
  });

  describe("a date typed in the Data explorer", () => {
    it("is kept while the months sent are not newer than the newest saved when it was typed", () => {
      expect(decideEmploymentDate(typed(OCT), "2020-01-02", OCT, OCT)).toBe("keep-newer");
      expect(decideEmploymentDate(typed(OCT), "2020-01-02", SEP, OCT)).toBe("keep-newer");
    });

    it("is replaced once a newer month is sent", () => {
      expect(decideEmploymentDate(typed(OCT), "2020-01-02", NOV, OCT)).toBe("replace");
    });

    it("typed when the company had no month saved yet: any month sent is newer", () => {
      expect(decideEmploymentDate(typed(null), "2020-01-02", SEP, null)).toBe("replace");
    });

    it("the same date sent for a newer month notes it; for an older one, nothing changes", () => {
      expect(decideEmploymentDate(typed(OCT), "2021-03-15", NOV, OCT)).toBe("same-newer");
      expect(decideEmploymentDate(typed(OCT), "2021-03-15", OCT, OCT)).toBe("same");
    });
  });

  describe("a date stored before migration 0017 (nothing recorded): treated as typed", () => {
    it("against the company's newest month saved before this import", () => {
      expect(decideEmploymentDate(before0017, "2020-01-02", OCT, OCT)).toBe("keep-newer");
      expect(decideEmploymentDate(before0017, "2020-01-02", SEP, OCT)).toBe("keep-newer");
      expect(decideEmploymentDate(before0017, "2020-01-02", NOV, OCT)).toBe("replace");
    });

    it("with no month saved before this import, the month sent is newer", () => {
      expect(decideEmploymentDate(before0017, "2020-01-02", OCT, null)).toBe("replace");
    });
  });
});
