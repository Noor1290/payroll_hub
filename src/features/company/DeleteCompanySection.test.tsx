import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext, type AuthContextValue } from "@/features/auth/auth-context";
import { queryClient } from "@/lib/queryClient";
import type { Membership } from "@/lib/supabase/schemas";
import { grantUnlock, isUnlocked, lock } from "@/lib/unlock";
import { CompanyContext, type CompanyContextValue } from "./company-context";
import type { DeletePreview } from "./deleteCompany";
import { DeleteCompanySection } from "./DeleteCompanySection";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/client", () => ({ supabase: { rpc } }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const verify = vi.hoisted(() => vi.fn());
vi.mock("@/features/unlock/verifyPassword", () => ({ verifyPassword: verify }));

const preview = vi.hoisted(() => vi.fn());
vi.mock("./deleteCompany", async (original) => ({
  ...(await original<typeof import("./deleteCompany")>()),
  fetchDeletePreview: preview,
}));

const ABC = "10000000-0000-4000-8000-000000000001";
const XYZ = "10000000-0000-4000-8000-000000000002";
const USER = "00000000-0000-4000-8000-0000000000a1";
const CLEAR: DeletePreview = {
  employees: 3,
  runs: 2,
  entries: 5,
  otherMembers: 1,
  details: 2,
  links: 4,
  approvedRuns: 0,
};
/** Two of its runs are approved; one of those is soft-deleted (the count includes it). */
const WITH_APPROVED: DeletePreview = { ...CLEAR, runs: 4, entries: 9, approvedRuns: 2 };

const auth: AuthContextValue = {
  status: "signed-in",
  user: { id: USER, email: "admin@example.com", isDemo: false },
  notice: null,
  signIn: async () => null,
  signInDemo: null,
  signOut: async () => {},
  clearNotice: () => {},
};

const membership = (id: string, name: string, role: Membership["role"]): Membership => ({
  role,
  company: { id, name, address: null, brn: null, vat: null },
});
const ABC_ADMIN = membership(ABC, "ABC Co Ltd", "admin");
const XYZ_VIEWER = membership(XYZ, "XYZ Trading Ltd", "viewer");

const select = vi.fn();

function renderSection(
  current: Membership | null,
  memberships: Membership[] = current ? [current] : [],
) {
  const company: CompanyContextValue = {
    status: "ready",
    failure: null,
    retry: () => {},
    memberships,
    current,
    isAdmin: current?.role === "admin",
    canAddCompany: memberships.some((m) => m.role === "admin"),
    select,
  };
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>
        <CompanyContext.Provider value={company}>
          <DeleteCompanySection />
        </CompanyContext.Provider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

const openDialog = () => fireEvent.click(screen.getByRole("button", { name: /Delete ABC Co Ltd/ }));
const dialog = () => screen.getByRole("alertdialog");
const deleteButton = () =>
  within(dialog()).getByRole("button", { name: "Delete company" }) as HTMLButtonElement;
const trigger = () => screen.getByRole("button", { name: /Delete ABC Co Ltd/ });
const nameBox = () =>
  within(dialog()).getByRole("textbox", {
    name: "Type the company name to confirm",
  }) as HTMLInputElement;
const cancelButton = () => within(dialog()).getByRole("button", { name: "Cancel" });
const hint = () => within(dialog()).queryByText(/The name must match exactly/);
const type = (value: string) => fireEvent.change(nameBox(), { target: { value } });

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({
    data: { company_id: ABC, entries: 5, runs: 2, employees: 3, members: 2 },
    error: null,
  });
  preview.mockReset().mockResolvedValue(CLEAR);
  verify.mockReset().mockResolvedValue(null);
  select.mockReset();
  toast.success.mockReset();
});
afterEach(() => {
  cleanup();
  lock();
  queryClient.clear();
  localStorage.clear();
});

describe("who sees it", () => {
  it("is shown to an admin of the selected company", () => {
    renderSection(ABC_ADMIN);
    expect(screen.getByRole("heading", { name: "Danger zone" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Delete ABC Co Ltd/ })).toBeTruthy();
  });

  it("is not shown to a viewer, and nothing is read or called", () => {
    renderSection(XYZ_VIEWER);
    expect(screen.queryByRole("heading", { name: "Danger zone" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull();
    expect(preview).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("is not shown for a company the user only views, even if they are an admin elsewhere", () => {
    renderSection(XYZ_VIEWER, [ABC_ADMIN, XYZ_VIEWER]);
    expect(screen.queryByRole("heading", { name: "Danger zone" })).toBeNull();
  });

  it("is not shown when there is no company", () => {
    renderSection(null);
    expect(screen.queryByRole("heading", { name: "Danger zone" })).toBeNull();
  });
});

describe("the password gate", () => {
  it("asks for the password first: no counts, no name box, no Delete button, nothing read", () => {
    renderSection(ABC_ADMIN);
    openDialog();

    expect(within(dialog()).getByText(/Confirm your password to continue/)).toBeTruthy();
    expect(within(dialog()).getByLabelText("Password")).toBeTruthy();
    expect(within(dialog()).queryByRole("button", { name: "Delete company" })).toBeNull();
    expect(within(dialog()).queryByLabelText(/to confirm/)).toBeNull();
    expect(preview).not.toHaveBeenCalled();
  });

  it("moves on once the password is confirmed", async () => {
    renderSection(ABC_ADMIN);
    openDialog();
    fireEvent.change(within(dialog()).getByLabelText("Password"), { target: { value: "pw" } });
    fireEvent.submit(within(dialog()).getByLabelText("Password").closest("form")!);

    expect(await within(dialog()).findByLabelText(/to confirm/)).toBeTruthy();
    expect(verify).toHaveBeenCalledWith(auth.user, "pw");
    expect(preview).toHaveBeenCalledWith({ id: USER, isDemo: false }, ABC);
  });

  it("stays on the password step when the password is wrong", async () => {
    verify.mockResolvedValue({
      kind: "invalid-credentials",
      title: "That password isn't right",
      message: "Try again.",
    });
    renderSection(ABC_ADMIN);
    openDialog();
    fireEvent.change(within(dialog()).getByLabelText("Password"), { target: { value: "wrong" } });
    fireEvent.submit(within(dialog()).getByLabelText("Password").closest("form")!);

    expect((await within(dialog()).findByRole("alert")).textContent).toContain(
      "That password isn't right",
    );
    expect(within(dialog()).queryByLabelText(/to confirm/)).toBeNull();
    expect(preview).not.toHaveBeenCalled();
  });

  it("goes back to asking if the gate locks while the dialog is open", async () => {
    grantUnlock(10);
    renderSection(ABC_ADMIN);
    openDialog();
    await within(dialog()).findByLabelText(/to confirm/);

    act(() => lock());
    expect(within(dialog()).getByLabelText("Password")).toBeTruthy();
    expect(within(dialog()).queryByRole("button", { name: "Delete company" })).toBeNull();
  });
});

describe("confirming", () => {
  beforeEach(() => grantUnlock(10));

  it("shows how many employees, runs and entries go, and that it cannot be undone", async () => {
    renderSection(ABC_ADMIN);
    openDialog();
    await within(dialog()).findByLabelText(/to confirm/);

    const text = dialog().textContent ?? "";
    expect(within(dialog()).getByRole("heading", { name: "Delete ABC Co Ltd?" })).toBeTruthy();
    expect(within(dialog()).getByText("ABC Co Ltd")).toBeTruthy();
    expect(text).toContain("3 employees");
    expect(text).toContain("2 payroll runs (0 approved)");
    expect(text).toContain("5 payroll entries");
    expect(text).toContain("2 company details");
    expect(text).toContain("4 links");
    expect(text).toContain("access for you and 1 other person");
    expect(text).toContain("including deleted rows");
    expect(text).toContain("This cannot be undone from the dashboard");
    // No approved runs, so no extra warning.
    expect(text).not.toContain("will be deleted permanently");
  });

  it("says how many runs are approved and warns that they go too", async () => {
    preview.mockResolvedValue(WITH_APPROVED);
    renderSection(ABC_ADMIN);
    openDialog();
    await within(dialog()).findByLabelText(/to confirm/);

    const text = dialog().textContent ?? "";
    expect(text).toContain("3 employees");
    expect(text).toContain("4 payroll runs (2 approved)");
    expect(text).toContain("9 payroll entries");
    expect(text).toContain("2 approved runs will be deleted permanently.");
    expect(text).toContain("This cannot be undone from the dashboard");
    // Nothing blocks it any more: the name box and the button are there.
    expect(text).not.toMatch(/can't be deleted|back to draft/);
    expect(deleteButton().disabled).toBe(true);
  });

  it("words the warning for a single approved run", async () => {
    preview.mockResolvedValue({ ...WITH_APPROVED, runs: 1, approvedRuns: 1 });
    renderSection(ABC_ADMIN);
    openDialog();
    await within(dialog()).findByLabelText(/to confirm/);

    const text = dialog().textContent ?? "";
    expect(text).toContain("1 payroll run (1 approved)");
    expect(text).toContain("1 approved run will be deleted permanently.");
  });

  it("deletes a company that has approved runs once the name is typed", async () => {
    preview.mockResolvedValue(WITH_APPROVED);
    renderSection(ABC_ADMIN);
    openDialog();
    await within(dialog()).findByLabelText(/to confirm/);

    expect(deleteButton().disabled).toBe(true);
    type("ABC Co Ltd");
    fireEvent.click(deleteButton());

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(rpc).toHaveBeenCalledWith("delete_company", {
      p_company_id: ABC,
      p_confirm_name: "ABC Co Ltd",
    });
  });

  it("asks for the name even when the company has no runs at all", async () => {
    preview.mockResolvedValue({
      ...CLEAR,
      employees: 0,
      runs: 0,
      entries: 0,
      details: 0,
      links: 0,
    });
    renderSection(ABC_ADMIN);
    openDialog();
    await within(dialog()).findByLabelText(/to confirm/);

    expect(dialog().textContent).toContain("0 payroll runs");
    expect(dialog().textContent).not.toContain("approved");
    expect(deleteButton().disabled).toBe(true);
    type("ABC Co Ltd");
    expect(deleteButton().disabled).toBe(false);
  });

  it("keeps Delete disabled until the exact name is typed", async () => {
    renderSection(ABC_ADMIN);
    openDialog();
    await within(dialog()).findByLabelText(/to confirm/);

    expect(deleteButton().disabled).toBe(true);
    for (const attempt of [
      "ABC",
      "abc co ltd",
      "ABC CO LTD",
      "ABC Co Ltd.",
      "ABC Co Ltd x",
      "ABC  Co Ltd",
      "XYZ Trading Ltd",
      "   ",
    ]) {
      type(attempt);
      expect(deleteButton().disabled).toBe(true);
    }
    type("ABC Co Ltd");
    expect(deleteButton().disabled).toBe(false);
    // Only the spaces around the name are ignored.
    type("  ABC Co Ltd ");
    expect(deleteButton().disabled).toBe(false);
    type("ABC Co Lt");
    expect(deleteButton().disabled).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("cannot be submitted with Enter while the name doesn't match", async () => {
    renderSection(ABC_ADMIN);
    openDialog();
    await within(dialog()).findByLabelText(/to confirm/);
    type("abc co ltd");
    fireEvent.submit(nameBox().closest("form")!);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("submits with Enter once the name matches", async () => {
    renderSection(ABC_ADMIN);
    openDialog();
    await within(dialog()).findByLabelText(/to confirm/);
    type("ABC Co Ltd");
    fireEvent.submit(nameBox().closest("form")!);
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
  });

  it("shows a hint under the box only while the name doesn't match", async () => {
    renderSection(ABC_ADMIN);
    openDialog();
    await within(dialog()).findByLabelText(/to confirm/);

    expect(hint()).toBeTruthy();
    expect(nameBox().getAttribute("aria-describedby")).toBe(hint()!.id);
    type("abc co ltd");
    expect(hint()).toBeTruthy();
    type("ABC Co Ltd");
    expect(hint()).toBeNull();
    expect(nameBox().hasAttribute("aria-describedby")).toBe(false);
    type("ABC Co Ltd!");
    expect(hint()).toBeTruthy();
  });

  it("allows pasting the name", async () => {
    renderSection(ABC_ADMIN);
    openDialog();
    await within(dialog()).findByLabelText(/to confirm/);

    // fireEvent returns false when a handler cancelled the event.
    expect(fireEvent.paste(nameBox(), { clipboardData: { getData: () => "ABC Co Ltd" } })).toBe(
      true,
    );
    type("ABC Co Ltd");
    expect(deleteButton().disabled).toBe(false);
  });

  it("focuses Cancel by default, not the name box or Delete", async () => {
    renderSection(ABC_ADMIN);
    openDialog();
    await within(dialog()).findByLabelText(/to confirm/);
    expect(document.activeElement).toBe(cancelButton());
  });

  it("closes on Escape like Cancel, deleting nothing, and returns focus to the trigger", async () => {
    renderSection(ABC_ADMIN);
    openDialog();
    await within(dialog()).findByLabelText(/to confirm/);
    type("ABC Co Ltd");

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
    expect(rpc).not.toHaveBeenCalled();

    // Nothing typed is kept for the next time.
    openDialog();
    await within(dialog()).findByLabelText(/to confirm/);
    expect(nameBox().value).toBe("");
    expect(deleteButton().disabled).toBe(true);
  });

  it("closes on Cancel and returns focus to the trigger", async () => {
    renderSection(ABC_ADMIN);
    openDialog();
    await within(dialog()).findByLabelText(/to confirm/);

    fireEvent.click(cancelButton());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
    expect(rpc).not.toHaveBeenCalled();
  });

  it("shows the database's refusal when the name no longer matches there", async () => {
    // For example the company was renamed in another tab: the browser's check passes, the
    // database's does not.
    rpc.mockResolvedValue({ data: null, error: { code: "22023", message: "PH_NAME_MISMATCH" } });
    renderSection(ABC_ADMIN);
    openDialog();
    await within(dialog()).findByLabelText(/to confirm/);
    type("ABC Co Ltd");
    fireEvent.click(deleteButton());

    expect((await within(dialog()).findByRole("alert")).textContent).toContain(
      "That isn't the company's name",
    );
    expect(nameBox().getAttribute("aria-invalid")).toBe("true");
    expect(select).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("says the database needs migration 0007 if it still has the old approved-run rule", async () => {
    preview.mockResolvedValue(WITH_APPROVED);
    rpc.mockResolvedValue({
      data: null,
      error: { code: "P0001", message: "PH_HAS_APPROVED_RUNS" },
    });
    renderSection(ABC_ADMIN);
    openDialog();
    await within(dialog()).findByLabelText(/to confirm/);
    type("ABC Co Ltd");
    fireEvent.click(deleteButton());

    const alert = await within(dialog()).findByRole("alert");
    expect(alert.textContent).toContain("The database needs an update");
    expect(alert.textContent).toContain("0007_delete_company_any_runs.sql");
    expect(select).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe("after deleting", () => {
  beforeEach(() => grantUnlock(10));

  async function deleteIt(memberships: Membership[]) {
    queryClient.setQueryData(["memberships", USER], memberships);
    queryClient.setQueryData(["overview", ABC, USER], { latestRunNetPay: 18169.12 });
    queryClient.setQueryData(["run-entries", "run-1", USER], [{ national_id: "X0000000000001" }]);
    localStorage.setItem("payroll-hub:company", ABC);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    renderSection(ABC_ADMIN, memberships);
    openDialog();
    await within(dialog()).findByLabelText(/to confirm/);
    type("ABC Co Ltd");
    fireEvent.click(deleteButton());
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    return invalidate;
  }

  it("deletes through the function, switches to another company and refreshes the list", async () => {
    const invalidate = await deleteIt([ABC_ADMIN, XYZ_VIEWER]);

    expect(rpc).toHaveBeenCalledWith("delete_company", {
      p_company_id: ABC,
      p_confirm_name: "ABC Co Ltd",
    });
    expect(select).toHaveBeenCalledWith(XYZ);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["memberships"] });
    expect(
      queryClient.getQueryData<Membership[]>(["memberships", USER])!.map((m) => m.company.id),
    ).toEqual([XYZ]);
    expect(toast.success.mock.calls[0]![0]).toBe("ABC Co Ltd deleted");
    expect(toast.success.mock.calls[0]![1].description).toBe(
      "Removed 3 employees, 2 runs and 5 entries.",
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("clears the company's cached data and locks the gate again", async () => {
    await deleteIt([ABC_ADMIN, XYZ_VIEWER]);

    const keys = queryClient
      .getQueryCache()
      .getAll()
      .map((query) => JSON.stringify(query.queryKey));
    expect(keys.some((key) => key.includes(ABC))).toBe(false);
    expect(queryClient.getQueryCache().findAll({ queryKey: ["run-entries"] })).toHaveLength(0);
    expect(isUnlocked()).toBe(false);
  });

  it("leaves no selection behind when it was the user's only company", async () => {
    await deleteIt([ABC_ADMIN]);

    expect(select).not.toHaveBeenCalled();
    expect(localStorage.getItem("payroll-hub:company")).toBeNull();
    expect(queryClient.getQueryData<Membership[]>(["memberships", USER])).toEqual([]);
  });

  it("persists nothing about the company", async () => {
    await deleteIt([ABC_ADMIN, XYZ_VIEWER]);
    // The remembered selection pointed at the deleted company before; nothing does now.
    const stored = JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]);
    expect(stored).not.toContain("ABC Co Ltd");
    expect(stored).not.toContain(ABC);
  });
});
