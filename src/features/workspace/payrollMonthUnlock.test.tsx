import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext, type AuthContextValue } from "@/features/auth/auth-context";
import { CompanyContext, type CompanyContextValue } from "@/features/company/company-context";
import { verifyPassword } from "@/features/unlock/verifyPassword";
import { clearTransferLog } from "@/features/transfer/transferLog";
import { dataRequests } from "@/lib/bridge/bridge";
import { demoMemberships } from "@/lib/demo/demoData";
import { runSessionCleanup } from "@/lib/sessionCleanup";
import { isUnlocked, lock } from "@/lib/unlock";
import { exchangeContext } from "./appData";
import { BridgeDialogs } from "./BridgeDialogs";
import { answerPayrollMonthRequest } from "./payrollMonthData";

/**
 * The payroll app asks the dashboard to unlock (its month's table is covered while the gate is
 * locked). The dashboard asks for the password, and nothing else: no "Send" step, nothing sent
 * to the app but whether it is open. FAKE values only.
 */
vi.mock("@/features/unlock/verifyPassword", () => ({ verifyPassword: vi.fn() }));
const verify = vi.mocked(verifyPassword);
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

const ME = "00000000-0000-4000-8000-000000000001";
const ABC = demoMemberships.find((m) => m.company.brn === "C1234567")!;
const auth: AuthContextValue = {
  status: "signed-in",
  user: { id: ME, email: "admin@example.com", isDemo: true },
  notice: null,
  signIn: async () => null,
  signInDemo: null,
  signOut: async () => {},
  clearNotice: () => {},
};
const companies: CompanyContextValue = {
  status: "ready",
  failure: null,
  retry: () => {},
  memberships: [ABC],
  current: ABC,
  isAdmin: true,
  canAddCompany: true,
  select: () => {},
};

const showDialogs = () =>
  render(
    <AuthContext.Provider value={auth}>
      <CompanyContext.Provider value={companies}>
        <BridgeDialogs />
      </CompanyContext.Provider>
    </AuthContext.Provider>,
  );
const askToUnlock = () =>
  answerPayrollMonthRequest("payroll", {
    dataType: "payroll-month",
    params: { action: "unlock", brn: "C1234567" },
  });

beforeEach(() => {
  lock();
  verify.mockReset();
});
afterEach(() => {
  cleanup();
  runSessionCleanup();
  clearTransferLog();
  lock();
});

describe("the payroll app asks the dashboard to unlock", () => {
  it("asks only for the password, then answers the app by itself, with nothing but 'unlocked'", async () => {
    showDialogs();
    const answer = askToUnlock();
    expect(
      await screen.findByRole("alertdialog", {
        name: "Payroll System needs the dashboard unlocked",
      }),
    ).toBeTruthy();
    expect(screen.getByText(/Nothing is sent to the app by this/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Send/ })).toBeNull();

    verify.mockResolvedValue(null);
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "fake-password-1" } });
    fireEvent.submit(screen.getByLabelText("Password").closest("form")!);

    expect(await answer).toEqual({
      ok: true,
      dataType: "payroll-month",
      rows: [{ unlocked: true }],
      meta: { label: "ABC Co Ltd", brn: "C1234567", role: "admin" },
    });
    expect(isUnlocked()).toBe(true);
    await waitFor(() => expect(dataRequests.get()).toHaveLength(0));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("'Not now' leaves it locked and tells the app so", async () => {
    showDialogs();
    const answer = askToUnlock();
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(await answer).toMatchObject({ ok: false, code: "denied" });
    expect(isUnlocked()).toBe(false);
  });

  it("is not asked at all when the dashboard is already unlocked", async () => {
    verify.mockResolvedValue(null);
    const { grantUnlock } = await import("@/lib/unlock");
    grantUnlock(10);
    exchangeContext.set({ viewer: { id: ME, isDemo: true }, membership: ABC });
    expect(await askToUnlock()).toMatchObject({ ok: true, rows: [{ unlocked: true }] });
    expect(dataRequests.get()).toHaveLength(0);
  });
});
