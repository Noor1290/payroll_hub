import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { AuthContext, type AuthContextValue } from "@/features/auth/auth-context";
import { queryClient } from "@/lib/queryClient";
import {
  fetchMraCompanyDetails,
  fetchMraSettings,
  saveMraCompanyDetails,
  saveMraSettings,
} from "@/lib/supabase/mraReturns";
import type { Membership } from "@/lib/supabase/schemas";
import { MraCard } from "./MraCard";

/** The MRA details on the Company profile (migration 0020). FAKE values only. */

vi.mock("@/lib/supabase/client", () => ({ supabase: null }));
vi.mock("@/lib/supabase/mraReturns", async (original) => ({
  ...(await original<typeof import("@/lib/supabase/mraReturns")>()),
  fetchMraCompanyDetails: vi.fn(),
  fetchMraSettings: vi.fn(),
  saveMraCompanyDetails: vi.fn(),
  saveMraSettings: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }));

const details = vi.mocked(fetchMraCompanyDetails);
const settings = vi.mocked(fetchMraSettings);
const saveDetails = vi.mocked(saveMraCompanyDetails);
const saveEmail = vi.mocked(saveMraSettings);

const ABC = "10000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-0000000000a1";
const SAVED = {
  company_id: ABC,
  ern: "001234",
  telephone: "",
  mobile: "5000 0000",
  declarant: "A. SAMPLE",
  revision: 2,
  updated_at: "t",
};

const auth: AuthContextValue = {
  status: "signed-in",
  user: { id: USER, email: "admin@example.com", isDemo: false },
  notice: null,
  signIn: async () => null,
  signInDemo: null,
  signOut: async () => {},
  clearNotice: () => {},
};
const membership = (role: Membership["role"]): Membership => ({
  role,
  company: { id: ABC, name: "ABC Co Ltd", address: "Mauritius", brn: "C1234567", vat: null },
});

function Card({ current }: { current: Membership }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>
        <MraCard current={current} />
      </AuthContext.Provider>
    </QueryClientProvider>
  );
}

const field = (dialog: HTMLElement, label: string) => within(dialog).getByLabelText(label, { exact: false });
const type = (dialog: HTMLElement, label: string, value: string) =>
  fireEvent.change(field(dialog, label), { target: { value } });
const openEditor = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Edit the MRA details" }));
  return screen.findByRole("dialog");
};

beforeEach(() => {
  details.mockReset().mockResolvedValue(SAVED);
  settings.mockReset().mockResolvedValue({ email: "returns@example.org", revision: 1, updated_at: "t" });
  saveDetails.mockReset().mockImplementation(async (_viewer, companyId, input) => ({
    ...SAVED,
    company_id: companyId,
    ...input,
    revision: input.expectedRevision + 1,
  }));
  saveEmail.mockReset().mockResolvedValue({ email: "x", revision: 2, updated_at: "t" });
  vi.mocked(toast.success).mockClear();
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe("the MRA card on the Company profile", () => {
  it("shows an admin the company's MRA details, the ERN with its leading zeros, and their own email", async () => {
    render(<Card current={membership("admin")} />);
    const card = await screen.findByTestId("mra-card");
    expect(within(card).getByText("001234")).toBeTruthy();
    expect(within(card).getByText("5000 0000")).toBeTruthy();
    expect(within(card).getByText("A. SAMPLE")).toBeTruthy();
    expect(within(card).getByText("returns@example.org")).toBeTruthy();
    // The telephone is empty.
    expect(within(card).getAllByText("Not set")).toHaveLength(1);
  });

  it("shows a member nothing, and reads nothing", async () => {
    const { container } = render(<Card current={membership("viewer")} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.textContent).toBe("");
    expect(details).not.toHaveBeenCalled();
    expect(settings).not.toHaveBeenCalled();
  });

  it("saves the details with the revision last seen, and the email only when it changed", async () => {
    render(<Card current={membership("admin")} />);
    const dialog = await openEditor();
    type(dialog, "Employer Registration Number", " 0012345 ");
    type(dialog, "Telephone number", "200 0000");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("MRA details of ABC Co Ltd saved"));
    expect(saveDetails).toHaveBeenCalledWith(expect.anything(), ABC, {
      ern: "0012345",
      telephone: "200 0000",
      mobile: "5000 0000",
      declarant: "A. SAMPLE",
      expectedRevision: 2,
    });
    expect(saveEmail).not.toHaveBeenCalled();
  });

  it("saves only the email when only the email changed, as a first save for a new user", async () => {
    settings.mockResolvedValue(null);
    render(<Card current={membership("admin")} />);
    const dialog = await openEditor();
    type(dialog, "Your email", "me@example.org");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(saveEmail).toHaveBeenCalledWith(expect.anything(), "me@example.org", 0));
    expect(saveDetails).not.toHaveBeenCalled();
  });

  it("refuses values the MRA file cannot hold before anything is sent", async () => {
    render(<Card current={membership("admin")} />);
    const dialog = await openEditor();
    type(dialog, "Employer Registration Number", "01 33");
    type(dialog, "Mobile number", "5000,0000");
    type(dialog, "Your email", "a,b@example.org");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(
      await within(dialog).findByText("Use letters and digits only, at most 20. Keep any leading zeros."),
    ).toBeTruthy();
    expect(within(dialog).getByText("Use digits, spaces and + - ( ) only, at most 30.")).toBeTruthy();
    expect(
      within(dialog).getByText(
        "Enter an email address such as name@example.com, without spaces or commas.",
      ),
    ).toBeTruthy();
    expect(saveDetails).not.toHaveBeenCalled();
    expect(saveEmail).not.toHaveBeenCalled();
  });

  it("says plainly when someone else saved first, and saves nothing over it", async () => {
    saveDetails.mockRejectedValue(Object.assign(new Error("PH_STALE"), { code: "P0001" }));
    render(<Card current={membership("admin")} />);
    const dialog = await openEditor();
    type(dialog, "Name of declarant", "B. SAMPLE");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(
      await within(dialog).findByText("Someone else saved these details since you opened them"),
    ).toBeTruthy();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("names migration 0020 when the database has not had it", async () => {
    details.mockRejectedValue({ code: "PGRST205", message: "Could not find the table" });
    render(<Card current={membership("admin")} />);
    expect(await screen.findByText("MRA details aren't set up in the database yet")).toBeTruthy();
    expect(screen.getByText(/0020_mra_returns\.sql/)).toBeTruthy();
  });
});
