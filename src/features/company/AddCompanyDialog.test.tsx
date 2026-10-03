import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext, type AuthContextValue } from "@/features/auth/auth-context";
import { queryClient } from "@/lib/queryClient";
import type { Membership } from "@/lib/supabase/schemas";
import { AddCompanyDialog } from "./AddCompanyDialog";
import { CompanyContext, type CompanyContextValue } from "./company-context";
import { addCompanyOpen } from "./createCompany";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/client", () => ({ supabase: { rpc } }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const NEW_ID = "10000000-0000-4000-8000-000000000009";
const ROW = { id: NEW_ID, name: "New Venture Ltd", address: null, brn: "C7654321", vat: null };

const auth: AuthContextValue = {
  status: "signed-in",
  user: { id: "00000000-0000-4000-8000-0000000000a1", email: "admin@example.com", isDemo: false },
  notice: null,
  signIn: async () => null,
  signInDemo: null,
  signOut: async () => {},
  clearNotice: () => {},
};

const select = vi.fn();
const membership = (role: Membership["role"]): Membership => ({
  role,
  company: {
    id: "10000000-0000-4000-8000-000000000001",
    name: "ABC Co Ltd",
    address: null,
    brn: "C1234567",
    vat: null,
  },
});

function renderDialog(role: Membership["role"] = "admin") {
  const current = membership(role);
  const company: CompanyContextValue = {
    status: "ready",
    failure: null,
    retry: () => {},
    memberships: [current],
    current,
    isAdmin: role === "admin",
    canAddCompany: role === "admin",
    select,
  };
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>
        <CompanyContext.Provider value={company}>
          <AddCompanyDialog />
        </CompanyContext.Provider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

const fill = (label: RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Add company" }));
const open = () => act(() => addCompanyOpen.set(true));

beforeEach(() => {
  rpc.mockReset();
  select.mockReset();
  toast.success.mockReset();
});
afterEach(() => {
  cleanup();
  addCompanyOpen.set(false);
  queryClient.clear();
});

describe("<AddCompanyDialog>", () => {
  it("is not offered to a viewer, even if something tries to open it", () => {
    renderDialog("viewer");
    open();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the four fields and the note about the BRN matching the payroll exports", () => {
    renderDialog();
    open();
    expect(screen.getByRole("dialog")).toBeTruthy();
    for (const label of [/Company name/, /^BRN/, /Address/, /VAT/]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    expect(
      screen.getByText(/must be exactly the BRN in this company's payroll JSON exports/),
    ).toBeTruthy();
  });

  it("stops an incomplete form before anything is sent, and says what is missing", () => {
    renderDialog();
    open();
    fill(/Company name/, "   ");
    submit();

    expect(rpc).not.toHaveBeenCalled();
    expect(screen.getByText("Enter the company's name.")).toBeTruthy();
    expect(screen.getByText("Enter the BRN.")).toBeTruthy();
    expect(screen.getByLabelText(/Company name/).getAttribute("aria-invalid")).toBe("true");
  });

  it("sends trimmed values, selects the new company, refreshes the list and confirms", async () => {
    rpc.mockResolvedValue({ data: ROW, error: null });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    renderDialog();
    open();
    fill(/Company name/, "  New Venture Ltd ");
    fill(/^BRN/, " C7654321 ");
    submit();

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(rpc).toHaveBeenCalledWith("create_company", {
      p_name: "New Venture Ltd",
      p_address: null,
      p_brn: "C7654321",
      p_vat: null,
    });
    expect(select).toHaveBeenCalledWith(NEW_ID);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["memberships"] });
    expect(toast.success.mock.calls[0]![0]).toBe("New Venture Ltd added");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the dialog open on a duplicate BRN and marks the BRN field", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "23505", message: "PH_DUPLICATE_BRN" } });
    renderDialog();
    open();
    fill(/Company name/, "Copy Ltd");
    fill(/^BRN/, "C1234567");
    submit();

    expect((await screen.findByRole("alert")).textContent).toContain(
      "A company with this BRN already exists",
    );
    expect(screen.getByLabelText(/^BRN/).getAttribute("aria-invalid")).toBe("true");
    expect((screen.getByLabelText(/Company name/) as HTMLInputElement).value).toBe("Copy Ltd");
    expect(select).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it.each([
    [{ code: "42501", message: "PH_NOT_ADMIN" }, "You're not allowed to add companies"],
    [
      { code: "PGRST202", message: "not found" },
      "Adding companies isn't set up in the database yet",
    ],
    [new TypeError("Failed to fetch"), "Can't reach the database"],
  ])("explains %o", async (error, title) => {
    if (error instanceof Error) rpc.mockRejectedValue(error);
    else rpc.mockResolvedValue({ data: null, error });
    renderDialog();
    open();
    fill(/Company name/, "New Venture Ltd");
    fill(/^BRN/, "C7654321");
    submit();

    expect((await screen.findByRole("alert")).textContent).toContain(title);
    expect(screen.getByRole("dialog")).toBeTruthy();
    // The form can be corrected and sent again.
    expect(
      (screen.getByRole("button", { name: "Add company" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("starts empty each time it is opened", async () => {
    renderDialog();
    open();
    fill(/Company name/, "Half typed");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    open();
    expect((screen.getByLabelText(/Company name/) as HTMLInputElement).value).toBe("");
  });
});
