import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthContext, type AuthContextValue } from "@/features/auth/auth-context";
import { CompanyContext, type CompanyContextValue } from "@/features/company/company-context";
import { demoMemberships } from "@/lib/demo/demoData";
import { lock } from "@/lib/unlock";
import { ExplorerPage } from "./ExplorerPage";

/**
 * TODO C12 (rehearsal): with no company, the Data explorer asked for the password first, and only
 * then said there was nothing to show. The company comes first now. FAKE values only.
 */
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

const auth: AuthContextValue = {
  status: "signed-in",
  user: { id: "00000000-0000-4000-8000-000000000001", email: "admin@example.com", isDemo: true },
  notice: null,
  signIn: async () => null,
  signInDemo: null,
  signOut: async () => {},
  clearNotice: () => {},
};
const ABC = demoMemberships.find((m) => m.company.brn === "C1234567")!;
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
const show = (company: CompanyContextValue) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <AuthContext.Provider value={auth}>
          <CompanyContext.Provider value={company}>
            <ExplorerPage />
          </CompanyContext.Provider>
        </AuthContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

afterEach(() => {
  cleanup();
  lock();
});

describe("Data explorer: the company before the password", () => {
  it("with no company, says so and asks for no password", () => {
    show(companies({ memberships: [], current: null }));
    expect(screen.getByText("You're not a member of any company yet")).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("with a company, asks for the password before anything is shown", () => {
    show(companies({}));
    expect(screen.getByText("Confirm your password to continue")).toBeTruthy();
    expect(screen.queryByText("You're not a member of any company yet")).toBeNull();
  });
});
