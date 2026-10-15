import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthContext, type AuthContextValue } from "@/features/auth/auth-context";
import { CompanyContext, type CompanyContextValue } from "@/features/company/company-context";
import { demoMemberships } from "@/lib/demo/demoData";
import { runSessionCleanup } from "@/lib/sessionCleanup";
import { BridgeDialogs } from "./BridgeDialogs";
import { exchangeContext, exchangeContextLoading } from "./exchangeContext";

/**
 * Known issue 4: what the dashboard's handlers wait on is set from the dashboard's own state. Right
 * after a reload or a sign-in, someone is signed in while the companies are still loading: then
 * "still loading" is on, so an app that asks waits instead of being told nobody is signed in.
 * FAKE values only.
 */
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

const ABC = demoMemberships.find((m) => m.company.brn === "C1234567")!;
const signedIn: AuthContextValue = {
  status: "signed-in",
  user: { id: "00000000-0000-4000-8000-000000000001", email: "admin@example.com", isDemo: true },
  notice: null,
  signIn: async () => null,
  signInDemo: null,
  signOut: async () => {},
  clearNotice: () => {},
};
const companies = (more: Partial<CompanyContextValue>): CompanyContextValue => ({
  status: "ready",
  failure: null,
  retry: () => {},
  memberships: [ABC],
  current: ABC,
  isAdmin: true,
  canAddCompany: true,
  select: () => {},
  ...more,
});
const show = (auth: AuthContextValue, company: CompanyContextValue) => (
  <AuthContext.Provider value={auth}>
    <CompanyContext.Provider value={company}>
      <BridgeDialogs />
    </CompanyContext.Provider>
  </AuthContext.Provider>
);

afterEach(() => {
  cleanup();
  runSessionCleanup();
});

describe("the dashboard says when it is still loading who is signed in", () => {
  it("signed in, companies loading: still loading; then loaded: the context is there and loading is over", () => {
    const view = render(
      show(signedIn, companies({ status: "loading", current: null, memberships: [] })),
    );
    expect(exchangeContextLoading.get()).toBe(true);
    expect(exchangeContext.get()).toBeNull();
    view.rerender(show(signedIn, companies({})));
    expect(exchangeContextLoading.get()).toBe(false);
    expect(exchangeContext.get()?.membership.company.brn).toBe("C1234567");
  });

  it("companies that could not be loaded, or no user: not loading, so nobody is kept waiting", () => {
    const view = render(
      show(signedIn, companies({ status: "error", current: null, memberships: [] })),
    );
    expect(exchangeContextLoading.get()).toBe(false);
    view.rerender(
      show(
        { ...signedIn, status: "signed-out", user: null },
        companies({ status: "loading", current: null }),
      ),
    );
    expect(exchangeContextLoading.get()).toBe(false);
  });
});
