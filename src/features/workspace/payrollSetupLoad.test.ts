import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoMemberships } from "@/lib/demo/demoData";
import { demoForgetPayrollSetups } from "@/lib/demo/demoPayrollSetups";
import { runSessionCleanup } from "@/lib/sessionCleanup";
import { exchangeContext } from "./appData";

/**
 * The payroll app's "load" of a column setup waits for the database twice, not three times
 * (speed fix F6, Payroll\SPEED_CHECK): once the company's own setup is read, the shared setup,
 * who may change it, the companies attached to it and the memberships are read at the same time.
 * Each read is recorded as it starts and ends. The demo store answers; FAKE values only.
 */
const events: string[] = [];
vi.mock("@/lib/supabase/payrollSetups", async (original) => {
  const real = await original<typeof import("@/lib/supabase/payrollSetups")>();
  const logged =
    <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) =>
    async (...args: A) => {
      events.push(`${name} starts`);
      try {
        return await fn(...args);
      } finally {
        events.push(`${name} ends`);
      }
    };
  return {
    ...real,
    fetchCompanySetup: logged("own", real.fetchCompanySetup),
    fetchSharedSetup: logged("shared", real.fetchSharedSetup),
    fetchSharedSetupAccess: logged("access", real.fetchSharedSetupAccess),
    fetchAttachedCompanySetups: logged("attached", real.fetchAttachedCompanySetups),
  };
});
const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  loading: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));
const { answerPayrollSetupRequest, savePayrollSetupFromApp } = await import("./payrollSetupData");
const setups = await import("@/lib/supabase/payrollSetups");

const ME = "00000000-0000-4000-8000-000000000001";
const ABC = demoMemberships.find((m) => m.company.brn === "C1234567")!;
const S1 = "30000000-0000-4000-8000-000000000001";
const SHARED = {
  identityFields: [{ id: "f1", key: "employeeId", name: "ID" }],
  idFieldKey: "employeeId",
  globalColumns: [],
};
const request = (params: Record<string, unknown>) =>
  answerPayrollSetupRequest({ dataType: "payroll-setup", params });
const send = (row: Record<string, unknown>) =>
  savePayrollSetupFromApp({ dataType: "payroll-setup", rows: [row] });

beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  demoForgetPayrollSetups();
  exchangeContext.set({ viewer: { id: ME, isDemo: true }, membership: ABC });
  await send({
    action: "save-shared",
    brn: "C1234567",
    shared_setup_id: S1,
    name: "Shared column setup",
    body: SHARED,
    expected_revision: 0,
  });
  await send({
    action: "attach-company",
    brn: "C1234567",
    shared_setup_id: S1,
    body: { columns: [], customFields: [] },
  });
  events.length = 0;
});
afterEach(() => {
  runSessionCleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("payroll-setup: load", () => {
  it("reads the shared setup, its access and its companies at the same time, after the company's own", async () => {
    const loaded = await request({ action: "load" });
    expect(loaded).toMatchObject({
      ok: true,
      rows: [
        { kind: "shared", shared_setup_id: S1 },
        { kind: "company", selected: true },
      ],
    });
    expect(events.slice(0, 2)).toEqual(["own starts", "own ends"]);
    // All three start before the first of them ends.
    const firstEnd = events.findIndex((e, i) => i >= 2 && e.endsWith("ends"));
    expect(events.slice(2, firstEnd).sort()).toEqual([
      "access starts",
      "attached starts",
      "shared starts",
    ]);
  });

  it("still says there is no setup when the shared one can't be read, whatever the other reads did", async () => {
    vi.spyOn(setups, "fetchSharedSetup").mockResolvedValueOnce(null);
    vi.spyOn(setups, "fetchSharedSetupAccess").mockRejectedValueOnce(new Error("PH_NOT_FOUND"));
    expect(await request({ action: "load" })).toMatchObject({ ok: false, code: "not-found" });
  });
});
