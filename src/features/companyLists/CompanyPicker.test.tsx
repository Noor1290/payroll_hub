import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext, type AuthContextValue } from "@/features/auth/auth-context";
import { CompanyContext, type CompanyContextValue } from "@/features/company/company-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Membership } from "@/lib/supabase/schemas";
import { fake, type Call } from "@/test/fakeClient";
import { appReloads, pickerRequest } from "./companyListData";
import { CompanyPickerHost } from "./CompanyPickerHost";
import { saveFailureText } from "./pickerText";

/** The full-page company picker, with the fake client as the database. FAKE companies only. */

vi.mock("@/lib/supabase/client", async () => ({
  supabase: (await import("@/test/fakeClient")).fake.client,
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

const ME = "00000000-0000-4000-8000-0000000000a1";
const ABC = "10000000-0000-4000-8000-000000000001";
const XYZ = "10000000-0000-4000-8000-000000000002";
const DEF = "10000000-0000-4000-8000-000000000003";
const memberships: Membership[] = [
  {
    role: "admin",
    company: { id: ABC, name: "ABC Co Ltd", address: null, brn: "C1234567", vat: null },
  },
  {
    role: "admin",
    company: { id: DEF, name: "DEF Ltd", address: null, brn: "C3333333", vat: null },
  },
  {
    role: "viewer",
    company: { id: XYZ, name: "XYZ Trading Ltd", address: null, brn: "C2222222", vat: null },
  },
];
const auth: AuthContextValue = {
  status: "signed-in",
  user: { id: ME, email: "admin@example.com", isDemo: false },
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
  memberships,
  current: memberships[0]!,
  isAdmin: true,
  canAddCompany: true,
  select: () => {},
};

const table = (calls: Call[]) => fake.arg(calls, "from") as string | undefined;
const rpcCalls = () => fake.state.queries.filter((calls) => calls[0]![0] === "rpc");

function open(appId: "payslip" | "mra-returns" = "payslip") {
  pickerRequest.set({
    appId,
    appName: appId,
    lists: appId === "payslip" ? ["payslips"] : ["csg", "prgf"],
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TooltipProvider>
        <AuthContext.Provider value={auth}>
          <CompanyContext.Provider value={companies}>
            <CompanyPickerHost />
          </CompanyContext.Provider>
        </AuthContext.Provider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fake.reset((calls) => {
    if (table(calls) === "company_app_lists")
      return { data: [{ company_id: ABC, list: "payslips" }] };
    if (calls[0]![1] === "set_company_app_lists") return { data: { added: 1, removed: 0 } };
    return { data: [] };
  });
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});
afterEach(() => {
  cleanup();
  act(() => pickerRequest.set(null));
});

describe("the company picker", () => {
  it("shows every company as a card, the selected ones pressed, and the counter", async () => {
    open();
    const card = await screen.findByRole("button", { name: /ABC Co Ltd/ });
    expect(screen.getByRole("dialog", { name: "Choose companies" })).toBeTruthy();
    expect(card.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /DEF Ltd/ }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(screen.getByText("1 of 3 companies selected")).toBeTruthy();
    // Not an admin: no button, a lock instead.
    expect(screen.queryByRole("button", { name: /XYZ Trading Ltd/ })).toBeNull();
    expect(screen.getAllByLabelText("Only an admin can change this")).toHaveLength(1);
  });

  it("selects with a tap, saves only the change with Done, then reloads the app", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: /DEF Ltd/ }));
    expect(screen.getByText("2 of 3 companies selected")).toBeTruthy();
    const reloadsBefore = appReloads.get().payslip ?? 0;
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await vi.waitFor(() => expect(pickerRequest.get()).toBeNull());
    expect(rpcCalls()).toHaveLength(1);
    expect(rpcCalls()[0]![0]).toEqual([
      "rpc",
      "set_company_app_lists",
      { p_changes: [{ company_id: DEF, list: "payslips", on: true }] },
    ]);
    expect(toast.success).toHaveBeenCalledWith("Payslip list saved: 2 companies.");
    expect(appReloads.get().payslip).toBe(reloadsBefore + 1);
  });

  it("Done with nothing changed saves nothing and reloads nothing", async () => {
    open();
    await screen.findByRole("button", { name: /DEF Ltd/ });
    const reloadsBefore = appReloads.get().payslip ?? 0;
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(pickerRequest.get()).toBeNull();
    expect(rpcCalls()).toHaveLength(0);
    expect(appReloads.get().payslip ?? 0).toBe(reloadsBefore);
  });

  it("asks before leaving with changes, and keeps them on Keep choosing", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: /DEF Ltd/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const ask = await screen.findByRole("alertdialog", { name: "Leave without saving?" });
    fireEvent.click(within(ask).getByRole("button", { name: "Keep choosing" }));
    expect(pickerRequest.get()).not.toBeNull();
    expect(screen.getByText("2 of 3 companies selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Leave" }),
    );
    expect(pickerRequest.get()).toBeNull();
    expect(rpcCalls()).toHaveLength(0);
  });

  it("search, chips, Select all and Clear", async () => {
    open();
    await screen.findByRole("button", { name: /DEF Ltd/ });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "c333" } });
    expect(screen.queryByRole("button", { name: /ABC Co Ltd/ })).toBeNull();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "nothing" } });
    expect(screen.getByText('No company matches "nothing".')).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });

    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByText("2 of 3 companies selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Not selected" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(screen.getByRole("radio", { name: "All" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByText("0 of 3 companies selected")).toBeTruthy();
  });

  it("MRA Returns: a CSG and a PRGF switch on each card, saved together", async () => {
    fake.reset((calls) => {
      if (table(calls) === "company_app_lists") return { data: [{ company_id: ABC, list: "csg" }] };
      if (calls[0]![1] === "set_company_app_lists") return { data: { added: 2, removed: 1 } };
      return { data: [] };
    });
    open("mra-returns");
    const csg = await screen.findByRole("button", { name: "CSG, ABC Co Ltd" });
    expect(csg.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("CSG 1 · PRGF 0 of 3")).toBeTruthy();
    fireEvent.click(csg);
    fireEvent.click(screen.getByRole("button", { name: "PRGF, ABC Co Ltd" }));
    fireEvent.click(screen.getByRole("button", { name: "CSG, DEF Ltd" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await vi.waitFor(() => expect(pickerRequest.get()).toBeNull());
    expect(rpcCalls()).toHaveLength(1);
    expect(rpcCalls()[0]![0]).toEqual([
      "rpc",
      "set_company_app_lists",
      {
        p_changes: [
          { company_id: ABC, list: "csg", on: false },
          { company_id: ABC, list: "prgf", on: true },
          { company_id: DEF, list: "csg", on: true },
        ],
      },
    ]);
    expect(toast.success).toHaveBeenCalledWith("MRA Returns lists saved: CSG 1, PRGF 1.");
  });

  it("a refused save keeps the picker open and says why", async () => {
    fake.reset((calls) => {
      if (table(calls) === "company_app_lists") return { data: [] };
      if (calls[0]![1] === "set_company_app_lists") {
        return { error: { code: "42501", message: "PH_NOT_ADMIN" } };
      }
      return { data: [] };
    });
    open();
    fireEvent.click(await screen.findByRole("button", { name: /DEF Ltd/ }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "The list wasn't saved: you're not an admin of every company you changed.",
      ),
    );
    expect(pickerRequest.get()).not.toBeNull();
    expect(saveFailureText({ message: "PH_NOT_ADMIN" })).toContain("not an admin");
  });
});
