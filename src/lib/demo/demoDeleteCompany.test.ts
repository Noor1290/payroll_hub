import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoDeleteCompany, demoFetchDeletePreview, demoMemberships } from "./demoData";

/**
 * The demo store mirrors delete_company (migration 0007). Its "ABC Co Ltd" has five approved
 * runs and one more that is approved AND soft-deleted, which the old rule refused.
 * Every figure here is fake demo data.
 */
const ABC = "10000000-0000-4000-8000-000000000001";
const XYZ = "10000000-0000-4000-8000-000000000002";

/** The demo store answers after a short pause; fake timers skip the wait. */
async function settle<T>(work: Promise<T>) {
  const outcome = work.then(
    (value) => ({ value, error: null }),
    (error: Error) => ({ value: null, error }),
  );
  await vi.runAllTimersAsync();
  return outcome;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("demoDeleteCompany", () => {
  it("counts approved runs, the soft-deleted one included", async () => {
    const { value } = await settle(demoFetchDeletePreview(ABC));
    expect(value).toMatchObject({ employees: 13, runs: 7, entries: 67, approvedRuns: 6 });
  });

  it("refuses a wrong name even when called directly, and deletes nothing", async () => {
    for (const wrong of ["abc co ltd", "ABC Co Ltd.", "ABC Co Ltd x", "ABC", ""]) {
      const { error } = await settle(demoDeleteCompany(ABC, wrong));
      expect(error?.message).toBe("PH_NAME_MISMATCH");
    }
    const { value } = await settle(demoFetchDeletePreview(ABC));
    expect(value).toMatchObject({ employees: 13, runs: 7, entries: 67 });
  });

  it("refuses a viewer, even with the right name", async () => {
    const { error } = await settle(demoDeleteCompany(XYZ, "XYZ Trading Ltd"));
    expect(error?.message).toBe("PH_NOT_ADMIN");
    expect(demoMemberships.some((m) => m.company.id === XYZ)).toBe(true);
  });

  it("deletes a company with approved runs and leaves nothing behind", async () => {
    const { value, error } = await settle(demoDeleteCompany(ABC, " ABC Co Ltd "));
    expect(error).toBeNull();
    expect(value).toMatchObject({ company_id: ABC, employees: 13, runs: 7, entries: 67 });

    const after = await settle(demoFetchDeletePreview(ABC));
    expect(after.value).toEqual({
      employees: 0,
      runs: 0,
      entries: 0,
      otherMembers: 0,
      details: 0,
      links: 0,
      approvedRuns: 0,
    });
    expect(demoMemberships.some((m) => m.company.id === ABC)).toBe(false);
    // The other companies are untouched.
    const other = await settle(demoFetchDeletePreview(XYZ));
    expect(other.value).toMatchObject({ employees: 4, runs: 2, entries: 8, approvedRuns: 2 });
  });
});
