import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext, type AuthContextValue } from "@/features/auth/auth-context";
import { queryClient } from "@/lib/queryClient";
import type { Membership } from "@/lib/supabase/schemas";
import { readXlsxSheet } from "@/lib/xlsx/readXlsx";
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

function renderAll(role: Membership["role"] = "admin", others: Membership[] = []) {
  const current = { ...ABC, role };
  const company: CompanyContextValue = {
    status: "ready",
    failure: null,
    retry: () => {},
    memberships: [current, ...others],
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
  toast.error.mockReset();
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
    // The companies you are admin of, read afresh: TEST ABC only.
    if (from === "companies" && fake.arg(calls, "update"))
      return { data: [{ id: ABC.company.id }] };
    if (from === "companies") {
      const ids = fake.arg(calls, "in", 1) as string[];
      return { data: ids.includes(ABC.company.id) ? [{ ...ABC.company }] : [] };
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
    await screen.findByRole("button", { name: "Download the blank template" });
    upload();

    const table = await screen.findByRole("table");
    expect(
      within(table)
        .getAllByRole("row")
        .map((r) => r.textContent),
    ).toEqual([
      "CreateRowCompanyBRNWhat happens",
      expect.stringMatching(/^2First Ltd.*TAN 00123 · ERN 013341C1111111New$/),
      "3ABC againC1234567UpdateChanges: Name: ABC Co Ltd → ABC again.",
      "4Second LtdC2222222New",
      "5(no name)C3333333ProblemNot created: The company name is missing.",
    ]);
    expect(
      await screen.findByRole("combobox", { name: "Column setup of the new companies" }),
    ).toHaveProperty("value", SETUP);
    const templates = screen.getByRole("checkbox", { name: /Use the ready-made MRA templates/ });
    expect(templates).toHaveProperty("disabled", true);
    expect(screen.getByText(/None of your companies uses them yet/)).toBeTruthy();
    const update = screen.getByRole("checkbox", { name: "Update row 3, ABC again" });
    expect([update.hasAttribute("disabled"), (update as HTMLInputElement).checked]).toEqual([
      false,
      false,
    ]);
    expect(
      screen.getByText(
        "4 rows: 2 new, 1 to update, 0 with no changes, 0 already in the dashboard, 0 twice in the file, 1 problem.",
      ),
    ).toBeTruthy();
    expect(creates()).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Create 2 companies" }));
    expect(
      await screen.findByText(/1 company created, 0 updated, 1 skipped, 2 problems\./),
    ).toBeTruthy();
    // The unticked update wrote nothing.
    expect(fake.state.queries.some((q) => fake.arg(q, "update"))).toBe(false);
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

  it("says so, and why, when no company was created", async () => {
    renderAll();
    act(() => importCompaniesOpen.set(true));
    upload([FILE_ROWS[0]!, ["Second Ltd", "C2222222"], ["", "C3333333"]]);
    await screen.findByRole("table");
    fireEvent.click(await screen.findByRole("button", { name: "Create 1 company" }));
    expect(
      await screen.findByText("No company was created. Every row had a problem."),
    ).toBeTruthy();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("No company was created", {
      description: "Every row had a problem.",
    });
  });

  it("offers both templates, saying how many companies the filled-in one holds and which are left out", async () => {
    const noBrn: Membership = {
      role: "admin",
      company: {
        id: "10000000-0000-4000-8000-000000000003",
        name: "TEST No BRN Ltd",
        address: null,
        brn: null,
        vat: null,
      },
    };
    const viewerOf: Membership = {
      role: "viewer",
      company: {
        id: "10000000-0000-4000-8000-000000000004",
        name: "TEST Viewer Ltd",
        address: null,
        brn: "C0000404",
        vat: null,
      },
    };
    renderAll("admin", [noBrn, viewerOf]);
    act(() => importCompaniesOpen.set(true));
    expect(await screen.findByRole("button", { name: "Download the blank template" })).toBeTruthy();
    expect(screen.getByText("No companies in it, for adding new ones.")).toBeTruthy();
    expect(
      screen.getByText(
        "Filled in with the 1 company you are admin of, to change their details or add new companies below them. 1 of your companies has no BRN, so it is not in it: a row is matched to its company by BRN.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "The filled-in template holds your companies' details. Keep it on your computer.",
      ),
    ).toBeTruthy();

    const saved: Blob[] = [];
    const created = vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      saved.push(blob as Blob);
      return "blob:test";
    });
    const revoked = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    try {
      fireEvent.click(
        screen.getByRole("button", { name: "Download the template with my companies" }),
      );
      await waitFor(() => expect(saved).toHaveLength(1));
    } finally {
      created.mockRestore();
      revoked.mockRestore();
    }
    // Only the companies you are admin of are asked for; the viewer company never is.
    for (const query of fake.state.queries.filter((q) => fake.arg(q, "in"))) {
      expect(fake.arg(query, "in", 1)).toEqual([ABC.company.id, noBrn.company.id]);
    }
    const bytes = new Uint8Array(await saved[0]!.arrayBuffer());
    const rows = (await readXlsxSheet(bytes, "Companies"))!.map((r) => r.map((c) => c?.text ?? ""));
    expect(rows.slice(1)).toEqual([["ABC Co Ltd", "C1234567"]]);
  });

  it("updates a company only when its row is ticked and the button pressed", async () => {
    renderAll();
    act(() => importCompaniesOpen.set(true));
    upload([FILE_ROWS[0]!, ["ABC Co Ltd", "C1234567", "1 TEST Street"]]);
    const box = await screen.findByRole("checkbox", { name: "Update row 2, ABC Co Ltd" });
    expect(screen.getByText("Changes: Address: (empty) → 1 TEST Street.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create 0 companies" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(fake.state.queries.some((q) => fake.arg(q, "update"))).toBe(false);

    fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: "Update 1 company" }));
    expect(
      await screen.findByText(/0 companies created, 1 updated, 0 skipped, 0 problems\./),
    ).toBeTruthy();
    const update = fake.state.queries.find((q) => fake.arg(q, "update"))!;
    expect(fake.arg(update, "update")).toEqual({
      name: "ABC Co Ltd",
      address: "1 TEST Street",
      vat: null,
    });
    expect(creates()).toHaveLength(0);
    expect(toast.success).toHaveBeenCalledWith("1 company updated", expect.anything());
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
