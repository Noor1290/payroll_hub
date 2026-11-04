import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext, type AuthContextValue } from "@/features/auth/auth-context";
import { queryClient } from "@/lib/queryClient";
import type { Membership } from "@/lib/supabase/schemas";
import { writeXlsx } from "@/lib/xlsx/writeXlsx";
import { CompanyContext, type CompanyContextValue } from "./company-context";
import { CompanySwitcher } from "./CompanySwitcher";

vi.mock("@/lib/supabase/client", async () => ({
  supabase: (await import("@/test/fakeClient")).fake.client,
}));
const { fake } = await import("@/test/fakeClient");
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const { ImportCompaniesDialog } = await import("./ImportCompaniesDialog");
const { importCompaniesOpen } = await import("./companyImport");

const auth: AuthContextValue = {
  status: "signed-in",
  user: { id: "00000000-0000-4000-8000-0000000000a1", email: "admin@example.com", isDemo: false },
  notice: null,
  signIn: async () => null,
  signInDemo: null,
  signOut: async () => {},
  clearNotice: () => {},
};
const SETUP = "20000000-0000-4000-8000-000000000001";
const ABC: Membership = {
  role: "admin",
  company: {
    id: "10000000-0000-4000-8000-000000000001",
    name: "ABC Co Ltd",
    address: null,
    brn: "C1234567",
    vat: null,
  },
};

function renderAll(role: Membership["role"] = "admin") {
  const current = { ...ABC, role };
  const company: CompanyContextValue = {
    status: "ready",
    failure: null,
    retry: () => {},
    memberships: [current],
    current,
    isAdmin: role === "admin",
    canAddCompany: role === "admin",
    select: vi.fn(),
  };
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>
        <CompanyContext.Provider value={company}>
          <CompanySwitcher />
          <ImportCompaniesDialog />
        </CompanyContext.Provider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

const FILE_ROWS = [
  [
    "Company name *",
    "BRN *",
    "Address",
    "VAT",
    "TAN",
    "ERN",
    "Telephone",
    "Mobile",
    "Name of declarant",
  ],
  ["First Ltd", "C1111111", "", "", "00123", "013341", "", "", ""],
  ["ABC again", "c 123 4567"],
  ["Second Ltd", "C2222222"],
  ["", "C3333333"],
];
const upload = (rows = FILE_ROWS) => {
  const bytes = writeXlsx([{ name: "Companies", columns: [], rows }]);
  const file = new File([bytes as BlobPart], "companies.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(input, { target: { files: [file] } });
};
const creates = () =>
  fake.state.queries.filter((q) => fake.arg(q, "rpc") === "create_company_with_details");

beforeEach(() => {
  toast.success.mockReset();
  fake.reset((calls) => {
    const from = fake.arg(calls, "from");
    const rpc = fake.arg(calls, "rpc");
    if (from === "payroll_company_setups")
      return { data: [{ company_id: ABC.company.id, shared_setup_id: SETUP }] };
    if (from === "payroll_shared_setups") {
      return {
        data: {
          id: SETUP,
          name: "Main setup",
          body: {},
          revision: 1,
          updated_by: null,
          updated_at: "2026-11-01T00:00:00Z",
        },
      };
    }
    if (rpc === "payroll_shared_setup_access")
      return { data: { can_change: true, companies: 1, admin_of: 1 } };
    if (rpc === "create_company_with_details") {
      const args = fake.arg(calls, "rpc", 1) as { p_name: string; p_brn: string };
      if (args.p_name === "Second Ltd")
        return { error: { code: "23505", message: "PH_DUPLICATE_BRN" } };
      return {
        data: { id: "10000000-0000-4000-8000-000000000009", name: args.p_name, brn: args.p_brn },
      };
    }
    return { data: [] };
  });
});
afterEach(() => {
  cleanup();
  importCompaniesOpen.set(false);
  queryClient.clear();
});

describe("<ImportCompaniesDialog>", () => {
  it("is offered to an admin next to Add company", async () => {
    renderAll("admin");
    fireEvent.pointerDown(screen.getByRole("button", { name: /Switch company/ }), {
      button: 0,
      ctrlKey: false,
    });
    const item = await screen.findByRole("menuitem", { name: "Import companies from Excel" });
    expect(screen.getByRole("menuitem", { name: "Add company" })).toBeTruthy();
    fireEvent.click(item);
    expect(await screen.findByRole("dialog", { name: "Import companies from Excel" })).toBeTruthy();
  });

  it("is not there at all for a viewer, even when asked to open", async () => {
    renderAll("viewer");
    fireEvent.pointerDown(screen.getByRole("button", { name: /Switch company/ }), {
      button: 0,
      ctrlKey: false,
    });
    await screen.findByRole("menu");
    expect(screen.queryByRole("menuitem", { name: "Import companies from Excel" })).toBeNull();
    act(() => importCompaniesOpen.set(true));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the preview, saves nothing before Create, then creates the ticked rows and reports every row", async () => {
    renderAll();
    act(() => importCompaniesOpen.set(true));
    await screen.findByRole("button", { name: "Download the companies template" });
    upload();

    const table = await screen.findByRole("table");
    expect(
      within(table)
        .getAllByRole("row")
        .map((r) => r.textContent),
    ).toEqual([
      "CreateRowCompanyBRNWhat happens",
      expect.stringMatching(/^2First Ltd.*TAN 00123 · ERN 013341C1111111New$/),
      "3ABC againC1234567Already in the dashboardSkipped: ABC Co Ltd already has this BRN.",
      "4Second LtdC2222222New",
      "5(no name)C3333333ProblemNot created: The company name is missing.",
    ]);
    expect(
      await screen.findByRole("combobox", { name: "Column setup of the new companies" }),
    ).toHaveProperty("value", SETUP);
    const templates = screen.getByRole("checkbox", { name: /Use the ready-made MRA templates/ });
    expect(templates).toHaveProperty("disabled", true);
    expect(screen.getByText(/None of your companies uses them yet/)).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Create row 3, ABC again" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(creates()).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Create 2 companies" }));
    expect(await screen.findByText(/1 company created, 1 skipped, 2 problems\./)).toBeTruthy();
    expect(creates().map((q) => (fake.arg(q, "rpc", 1) as { p_name: string }).p_name)).toEqual([
      "First Ltd",
      "Second Ltd",
    ]);
    expect(
      (fake.arg(creates()[0]!, "rpc", 1) as { p_shared_setup_id: string }).p_shared_setup_id,
    ).toBe(SETUP);
    expect(screen.getByText(/A company with this BRN already exists/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download the report" })).toBeTruthy();
    expect(toast.success).toHaveBeenCalledWith("1 company created", expect.anything());
  });

  it("creates only what stays ticked, and none when the setup is set to None yet", async () => {
    renderAll();
    act(() => importCompaniesOpen.set(true));
    upload();
    await screen.findByRole("table");
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Column setup of the new companies" }),
      ).toHaveProperty("value", SETUP),
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Column setup of the new companies" }), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Create row 4, Second Ltd" }));
    fireEvent.click(screen.getByRole("button", { name: "Create 1 company" }));
    await screen.findByText(/1 company created/);
    expect(creates()).toHaveLength(1);
    expect(fake.arg(creates()[0]!, "rpc", 1)).toMatchObject({
      p_name: "First Ltd",
      p_shared_setup_id: null,
      p_mra_template_ids: [],
    });
  });

  it("says why a file can't be imported", async () => {
    renderAll();
    act(() => importCompaniesOpen.set(true));
    upload([
      ["Name", "Address"],
      ["A Ltd", "x"],
    ]);
    expect(
      await screen.findByText(
        'The Companies sheet has no "Company name" column. Use the companies template.',
      ),
    ).toBeTruthy();
    expect(creates()).toHaveLength(0);
  });
});
