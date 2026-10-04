import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext, type AuthContextValue } from "@/features/auth/auth-context";
import { CompanyContext, type CompanyContextValue } from "@/features/company/company-context";
import { GATED_QUERY_KEYS, queryClient } from "@/lib/queryClient";
import {
  fetchDetails,
  fetchSensitiveValues,
  updateCompanyCore,
  type CompanyDetail,
} from "@/lib/supabase/companyData";
import type { Membership } from "@/lib/supabase/schemas";
import { runSessionCleanup } from "@/lib/sessionCleanup";
import { grantUnlock, isUnlocked, lock } from "@/lib/unlock";
import { ProfilePage } from "./ProfilePage";

vi.mock("@/lib/supabase/client", () => ({ supabase: null }));
vi.mock("@/lib/supabase/companyData", async (original) => ({
  ...(await original<typeof import("@/lib/supabase/companyData")>()),
  fetchDetails: vi.fn(),
  fetchSensitiveValues: vi.fn(),
  updateCompanyCore: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }));
const verify = vi.hoisted(() => vi.fn());
vi.mock("@/features/unlock/verifyPassword", () => ({ verifyPassword: verify }));

const details = vi.mocked(fetchDetails);
const sensitiveValues = vi.mocked(fetchSensitiveValues);
const updateCore = vi.mocked(updateCompanyCore);

const ABC = "10000000-0000-4000-8000-000000000001";
const XYZ = "10000000-0000-4000-8000-000000000002";
const USER = "00000000-0000-4000-8000-0000000000a1";
const NOW = "2026-09-28T10:15:00+00:00";
const CONTACT = "50000000-0000-4000-8000-000000000001";
const BANK = "50000000-0000-4000-8000-000000000002";
// FAKE values, chosen to be easy to search for.
const SECRET = "FAKE-IBAN-0000-0000";
const MASK = "••••••";

const detail = (id: string, more: Partial<CompanyDetail>): CompanyDetail => ({
  id,
  company_id: ABC,
  label: "Label",
  value: null,
  field_type: "text",
  is_sensitive: false,
  sort_order: 0,
  updated_at: NOW,
  valueLoaded: true,
  ...more,
});
const OPEN = detail(CONTACT, {
  label: "Payroll contact",
  value: "payroll@example.com",
  field_type: "email",
});
// As the real read returns it: the label, but not the value.
const HIDDEN = detail(BANK, {
  label: "Bank reference",
  is_sensitive: true,
  sort_order: 1,
  valueLoaded: false,
});

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
  company: { id, name, address: "Mauritius", brn: "C1234567", vat: "12%" },
});

function Page({ current }: { current: Membership }) {
  const company: CompanyContextValue = {
    status: "ready",
    failure: null,
    retry: () => {},
    memberships: [current],
    current,
    isAdmin: current.role === "admin",
    canAddCompany: current.role === "admin",
    select: () => {},
  };
  return (
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>
        <CompanyContext.Provider value={company}>
          <ProfilePage />
        </CompanyContext.Provider>
      </AuthContext.Provider>
    </QueryClientProvider>
  );
}

const ADMIN = membership(ABC, "ABC Co Ltd", "admin");
const VIEWER = membership(ABC, "ABC Co Ltd", "viewer");

const reveal = () => screen.getByRole("button", { name: "Reveal Bank reference" });
const submitPassword = (dialog: HTMLElement) => {
  fireEvent.change(within(dialog).getByLabelText("Password"), { target: { value: "pw" } });
  fireEvent.submit(within(dialog).getByLabelText("Password").closest("form")!);
};

beforeEach(() => {
  // An admin is sent both rows; a viewer is sent only what the database lets them read.
  details.mockReset().mockResolvedValue([OPEN, HIDDEN]);
  sensitiveValues.mockReset().mockResolvedValue({ [BANK]: SECRET });
  updateCore.mockReset();
  verify.mockReset().mockResolvedValue(null);
});
afterEach(() => {
  cleanup();
  lock();
  queryClient.clear();
  localStorage.clear();
  sessionStorage.clear();
});

describe("sensitive details", () => {
  it("are masked by default, and their values are not even fetched", async () => {
    render(<Page current={ADMIN} />);
    await screen.findByText("Bank reference");

    expect(screen.getByText(MASK)).toBeTruthy();
    expect(reveal()).toBeTruthy();
    expect(screen.queryByText(SECRET)).toBeNull();
    expect(sensitiveValues).not.toHaveBeenCalled();
    // The ordinary detail is shown as it is.
    expect(screen.getByText("payroll@example.com")).toBeTruthy();
  });

  it("stay masked even while the gate is open, until one is asked for", async () => {
    grantUnlock(10);
    render(<Page current={ADMIN} />);
    await screen.findByText("Bank reference");
    expect(screen.queryByText(SECRET)).toBeNull();
    expect(sensitiveValues).not.toHaveBeenCalled();
  });

  it("need the password before they are revealed", async () => {
    render(<Page current={ADMIN} />);
    await screen.findByText("Bank reference");
    fireEvent.click(reveal());

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Confirm your password")).toBeTruthy();
    expect(sensitiveValues).not.toHaveBeenCalled();
    expect(screen.queryByText(SECRET)).toBeNull();

    submitPassword(dialog);
    expect(await screen.findByText(SECRET)).toBeTruthy();
    expect(verify).toHaveBeenCalledWith(auth.user, "pw");
    expect(isUnlocked()).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stay hidden when the password is wrong", async () => {
    verify.mockResolvedValue({
      kind: "invalid-credentials",
      title: "Wrong",
      message: "Try again.",
    });
    render(<Page current={ADMIN} />);
    await screen.findByText("Bank reference");
    fireEvent.click(reveal());
    submitPassword(screen.getByRole("dialog"));

    expect((await within(screen.getByRole("dialog")).findByRole("alert")).textContent).toContain(
      "Wrong",
    );
    expect(sensitiveValues).not.toHaveBeenCalled();
    expect(screen.queryByText(SECRET)).toBeNull();
  });

  it("re-mask when the gate locks, and the value leaves memory", async () => {
    grantUnlock(10);
    render(<Page current={ADMIN} />);
    await screen.findByText("Bank reference");
    fireEvent.click(reveal());
    expect(await screen.findByText(SECRET)).toBeTruthy();
    expect(GATED_QUERY_KEYS.some((key) => key[0] === "company-details-sensitive")).toBe(true);

    act(() => lock("timeout"));

    expect(screen.queryByText(SECRET)).toBeNull();
    expect(queryClient.getQueryData(["company-details-sensitive", ABC, USER])).toBeUndefined();
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain(SECRET);

    // Unlocking again does not bring back what was revealed before.
    act(() => grantUnlock(10));
    expect(screen.queryByText(SECRET)).toBeNull();
    expect(reveal()).toBeTruthy();
  });

  it("can be hidden again by hand", async () => {
    grantUnlock(10);
    render(<Page current={ADMIN} />);
    await screen.findByText("Bank reference");
    fireEvent.click(reveal());
    await screen.findByText(SECRET);

    fireEvent.click(screen.getByRole("button", { name: "Hide Bank reference" }));
    expect(screen.queryByText(SECRET)).toBeNull();
    expect(screen.getByText(MASK)).toBeTruthy();
  });

  it("re-mask when the company changes", async () => {
    grantUnlock(10);
    const { rerender } = render(<Page current={ADMIN} />);
    await screen.findByText("Bank reference");
    fireEvent.click(reveal());
    await screen.findByText(SECRET);

    details.mockResolvedValue([{ ...HIDDEN, company_id: XYZ }]);
    rerender(<Page current={membership(XYZ, "XYZ Trading Ltd", "admin")} />);
    await waitFor(() => expect(details).toHaveBeenCalledWith({ id: USER, isDemo: false }, XYZ));
    await screen.findByText("Bank reference");

    expect(screen.queryByText(SECRET)).toBeNull();
    expect(screen.getByText(MASK)).toBeTruthy();
  });

  it("leave memory when the session ends", async () => {
    grantUnlock(10);
    render(<Page current={ADMIN} />);
    await screen.findByText("Bank reference");
    fireEvent.click(reveal());
    await screen.findByText(SECRET);

    act(() => runSessionCleanup());

    expect(isUnlocked()).toBe(false);
    expect(screen.queryByText(SECRET)).toBeNull();
    expect(queryClient.getQueryData(["company-details-sensitive", ABC, USER])).toBeUndefined();
  });

  it("never reach browser storage", async () => {
    grantUnlock(10);
    render(<Page current={ADMIN} />);
    await screen.findByText("Bank reference");
    fireEvent.click(reveal());
    await screen.findByText(SECRET);

    const stored = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    for (const text of [SECRET, "Bank reference", "payroll@example.com", "C1234567"]) {
      expect(stored).not.toContain(text);
    }
  });
});

describe("viewers", () => {
  beforeEach(() => details.mockResolvedValue([OPEN]));

  it("cannot edit anything: no add, edit, delete, reorder or reveal", async () => {
    grantUnlock(10); // even with the gate open
    render(<Page current={VIEWER} />);
    await screen.findByText("Payroll contact");

    expect(screen.queryAllByRole("button", { name: /Add|Edit|Delete|Move|Drag|Reveal/ })).toEqual(
      [],
    );
    expect(screen.queryByText("Don't store passwords here.")).toBeNull();
  });

  it("are shown no trace of sensitive details: no label, no mask, no placeholder", async () => {
    grantUnlock(10);
    render(<Page current={VIEWER} />);
    await screen.findByText("Payroll contact");

    expect(screen.queryByText("Bank reference")).toBeNull();
    expect(screen.queryByText(MASK)).toBeNull();
    expect(screen.queryByText("Sensitive")).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(sensitiveValues).not.toHaveBeenCalled();
  });

  it("see the core fields", async () => {
    render(<Page current={VIEWER} />);
    await screen.findByText("Payroll contact");
    expect(screen.getByText("C1234567")).toBeTruthy();
    expect(screen.getByText("ABC Co Ltd")).toBeTruthy();
  });
});

describe("admins", () => {
  it("are told not to store passwords, and get the editing controls", async () => {
    render(<Page current={ADMIN} />);
    await screen.findByText("Payroll contact");

    expect(screen.getByText("Don't store passwords here.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add detail" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit Payroll contact" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete Payroll contact" })).toBeTruthy();
    // Reordering works from the keyboard without dragging.
    const up = screen.getByRole("button", { name: "Move Payroll contact up" }) as HTMLButtonElement;
    const down = screen.getByRole("button", { name: "Move Payroll contact down" });
    expect(up.disabled).toBe(true);
    expect((down as HTMLButtonElement).disabled).toBe(false);
  });

  it("can change the name, address and VAT, but not the BRN", async () => {
    updateCore.mockResolvedValue({ ...ADMIN.company, name: "ABC Holdings Ltd" });
    render(<Page current={ADMIN} />);
    await screen.findByText("Payroll contact");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog");

    const brn = within(dialog).getByLabelText("BRN") as HTMLInputElement;
    expect(brn.disabled).toBe(true);
    expect(brn.value).toBe("C1234567");
    expect(dialog.textContent).toContain("must match the BRN in the payroll JSON exports");
    expect(dialog.textContent).toContain("can only be changed in the Supabase SQL editor");

    fireEvent.change(within(dialog).getByLabelText("Company name"), {
      target: { value: " ABC Holdings Ltd " },
    });
    fireEvent.submit(within(dialog).getByLabelText("Company name").closest("form")!);

    await waitFor(() => expect(updateCore).toHaveBeenCalledTimes(1));
    expect(updateCore.mock.calls[0]).toEqual([
      { id: USER, isDemo: false },
      ABC,
      { name: "ABC Holdings Ltd", address: "Mauritius", vat: "12%" },
    ]);
  });

  it("must give the company a name", async () => {
    render(<Page current={ADMIN} />);
    await screen.findByText("Payroll contact");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Company name"), { target: { value: "  " } });
    fireEvent.submit(within(dialog).getByLabelText("Company name").closest("form")!);

    expect(within(dialog).getByText("Enter the company's name.")).toBeTruthy();
    expect(updateCore).not.toHaveBeenCalled();
  });
});

describe("when something is wrong", () => {
  it("says which migration to run when the table is missing, and still shows the company", async () => {
    details.mockRejectedValue({ code: "PGRST205", message: "not in the schema cache" });
    render(<Page current={ADMIN} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Company details aren't set up in the database yet");
    expect(alert.textContent).toContain("0005_company_details.sql");
    expect(screen.getByText("C1234567")).toBeTruthy();
  });

  it("has an empty state", async () => {
    details.mockResolvedValue([]);
    render(<Page current={VIEWER} />);
    expect(await screen.findByText("No other details yet")).toBeTruthy();
  });
});
