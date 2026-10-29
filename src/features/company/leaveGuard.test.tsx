import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthContext, type AuthContextValue } from "@/features/auth/auth-context";
import { WorkspaceHost } from "@/features/workspace/WorkspaceHost";
import { bridge } from "@/lib/bridge/bridge";
import { queryClient } from "@/lib/queryClient";
import type { Membership } from "@/lib/supabase/schemas";
import { CompanyContext, useCompany, type CompanyContextValue } from "./company-context";
import { CompanyProvider } from "./CompanyProvider";
import { CompanySwitcher } from "./CompanySwitcher";
import { addCompanyOpen } from "./createCompany";
import { unsavedTitle } from "./leaveGuard";

/**
 * Rehearsal fix F1: the apps follow the company chosen in the dashboard. A change of company
 * reloads every app frame; before that, the user is asked if an app holds unsaved changes.
 * Before the fix, the company changed without a question and the frames kept the old company.
 */

const fetchMemberships = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/queries", () => ({ fetchMemberships }));

const company = (id: string, name: string): Membership => ({
  role: "admin",
  company: { id, name, address: null, brn: `C${id.slice(-7)}`, vat: null },
});
const A = company("10000000-0000-4000-8000-000000000001", "TEST Co A");
const B = company("10000000-0000-4000-8000-000000000002", "TEST Co B");

const auth: AuthContextValue = {
  status: "signed-in",
  user: { id: "00000000-0000-4000-8000-0000000000a1", email: "admin@example.com", isDemo: false },
  notice: null,
  signIn: async () => null,
  signInDemo: null,
  signOut: async () => {},
  clearNotice: () => {},
};

function Shown() {
  const { current } = useCompany();
  return <p data-testid="shown">{current?.company.name ?? "none"}</p>;
}

function renderProvider() {
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>
        <CompanyProvider>
          <TooltipProvider>
            <CompanySwitcher />
            <Shown />
          </TooltipProvider>
        </CompanyProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

const shown = () => screen.getByTestId("shown").textContent;
const openSwitcher = () => {
  const trigger = screen.getByRole("button", { name: /TEST Co A|TEST Co B/ });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
};

beforeEach(() => {
  localStorage.clear();
  fetchMemberships.mockResolvedValue([A, B]);
});
afterEach(() => {
  cleanup();
  addCompanyOpen.set(false);
  queryClient.clear();
  vi.restoreAllMocks();
});

describe("the question", () => {
  it("names the apps", () => {
    expect(unsavedTitle(["Payroll System"])).toBe("Payroll System has unsaved changes.");
    expect(unsavedTitle(["Payroll System", "Payslip Automation"])).toBe(
      "Payroll System and Payslip Automation have unsaved changes.",
    );
    expect(unsavedTitle(["Payroll System", "PDF Form Filler", "Payslip Automation"])).toBe(
      "Payroll System, PDF Form Filler and Payslip Automation have unsaved changes.",
    );
  });
});

describe("switching company", () => {
  it("switches straight away when no app holds unsaved changes", async () => {
    vi.spyOn(bridge, "unsavedApps").mockReturnValue([]);
    renderProvider();
    await waitFor(() => expect(shown()).toBe("TEST Co A"));
    openSwitcher();
    fireEvent.click(await screen.findByRole("menuitem", { name: /TEST Co B/ }));
    expect(shown()).toBe("TEST Co B");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("asks first when an app holds unsaved changes; Stay keeps the company", async () => {
    vi.spyOn(bridge, "unsavedApps").mockReturnValue(["payroll"]);
    renderProvider();
    await waitFor(() => expect(shown()).toBe("TEST Co A"));
    openSwitcher();
    fireEvent.click(await screen.findByRole("menuitem", { name: /TEST Co B/ }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Payroll System has unsaved changes.");
    expect(dialog.textContent).toContain("Switch anyway?");
    const stay = screen.getByRole("button", { name: "Stay on TEST Co A" });
    expect(document.activeElement).toBe(stay); // the safe answer is the default
    expect(shown()).toBe("TEST Co A");

    fireEvent.click(stay);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(shown()).toBe("TEST Co A");
  });

  it("switches on Switch anyway", async () => {
    vi.spyOn(bridge, "unsavedApps").mockReturnValue(["payslip", "payroll"]);
    renderProvider();
    await waitFor(() => expect(shown()).toBe("TEST Co A"));
    openSwitcher();
    fireEvent.click(await screen.findByRole("menuitem", { name: /TEST Co B/ }));
    const dialog = await screen.findByRole("alertdialog");
    // Named in the dashboard's own order, whatever order they said it in.
    expect(dialog.textContent).toContain(
      "Payroll System and Payslip Automation have unsaved changes.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Switch anyway" }));
    expect(shown()).toBe("TEST Co B");
  });

  it("runs 'afterwards' only once the company is switched, never on Stay (MRA open-profile)", async () => {
    vi.spyOn(bridge, "unsavedApps").mockReturnValue(["payroll"]);
    const afterwards = vi.fn();
    function Select() {
      const { select } = useCompany();
      return (
        <button type="button" onClick={() => select(B.company.id, { afterwards })}>
          Open B
        </button>
      );
    }
    render(
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={auth}>
          <CompanyProvider>
            <Select />
            <Shown />
          </CompanyProvider>
        </AuthContext.Provider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(shown()).toBe("TEST Co A"));
    fireEvent.click(screen.getByRole("button", { name: "Open B" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stay on TEST Co A" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(afterwards).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open B" }));
    fireEvent.click(await screen.findByRole("button", { name: "Switch anyway" }));
    expect(shown()).toBe("TEST Co B");
    expect(afterwards).toHaveBeenCalledTimes(1);
  });

  it("asks before Add company opens, because the new company is selected once added", async () => {
    vi.spyOn(bridge, "unsavedApps").mockReturnValue(["pdf-editor"]);
    renderProvider();
    await waitFor(() => expect(shown()).toBe("TEST Co A"));
    openSwitcher();
    fireEvent.click(await screen.findByRole("menuitem", { name: /Add company/ }));
    await screen.findByRole("alertdialog");
    expect(addCompanyOpen.get()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Switch anyway" }));
    expect(addCompanyOpen.get()).toBe(true);
  });
});

describe("the app frames follow the company", () => {
  const value = (current: Membership | null): CompanyContextValue => ({
    status: "ready",
    failure: null,
    retry: () => {},
    memberships: [A, B],
    current,
    isAdmin: true,
    canAddCompany: true,
    select: () => {},
  });
  const host = (current: Membership | null) => (
    <MemoryRouter>
      <TooltipProvider>
        <CompanyContext.Provider value={value(current)}>
          <WorkspaceHost visible />
        </CompanyContext.Provider>
      </TooltipProvider>
    </MemoryRouter>
  );

  it("reloads every frame on a change of company, and not on the first company or a re-render", () => {
    const attach = vi.spyOn(bridge, "attachFrame");
    const view = render(host(null));
    const mounted = attach.mock.calls.length;
    expect(mounted).toBe(4);

    act(() => view.rerender(host(A))); // the first company of the session
    act(() => view.rerender(host(A)));
    expect(attach.mock.calls.length).toBe(mounted);

    act(() => view.rerender(host(B)));
    expect(
      attach.mock.calls
        .slice(mounted)
        .map(([id]) => id)
        .sort(),
    ).toEqual(["mra-returns", "payroll", "payslip", "pdf-editor"]);
  });
});
