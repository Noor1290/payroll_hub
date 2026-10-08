import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { navItemsFor } from "@/app/nav";
import { AuthContext, type AuthContextValue } from "@/features/auth/auth-context";
import { CompanyContext, type CompanyContextValue } from "@/features/company/company-context";
import { setRefreshSeconds } from "@/lib/preferences";
import { queryClient } from "@/lib/queryClient";
import { runSessionCleanup } from "@/lib/sessionCleanup";
import {
  DB_TABLES,
  fetchTableCounts,
  fetchTablePage,
  parseRow,
  type DbTableName,
  type TableQuery,
} from "@/lib/supabase/database";
import type { Membership } from "@/lib/supabase/schemas";
import { grantUnlock, lock } from "@/lib/unlock";
import { DatabasePage, DatabaseViewer } from "./DatabasePage";

vi.mock("@/lib/supabase/database", async (original) => ({
  ...(await original<typeof import("@/lib/supabase/database")>()),
  fetchTablePage: vi.fn(),
  fetchTableCounts: vi.fn(),
}));
const fetchPage = vi.mocked(fetchTablePage);
const fetchCounts = vi.mocked(fetchTableCounts);

// FAKE values, chosen to be easy to search for.
const NATIONAL_ID = "X0000000000001";
const SECOND_ID = "X0000000000002";
const ABC = "10000000-0000-4000-8000-000000000001";
const XYZ = "10000000-0000-4000-8000-000000000002";
const NOW = "2026-09-28T10:15:00+00:00";

const employee = (n: number, nationalId: string, surname: string, deleted = false) =>
  parseRow(DB_TABLES.employees, {
    id: `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    company_id: ABC,
    national_id: nationalId,
    surname,
    other_names: "JANE",
    employment_type: "Full Time",
    deleted_at: deleted ? NOW : null,
    created_at: NOW,
  });

const company = (id: string, name: string) =>
  parseRow(DB_TABLES.companies, {
    id,
    name,
    address: "Mauritius",
    brn: "C1234567",
    vat: "12%",
    created_at: NOW,
  });

const ME = "00000000-0000-4000-8000-0000000000a1";
const OTHER_ADMIN = "0b0b0b0b-0000-4000-8000-0000000000b2";
const TEMPLATE = "50000000-0000-4000-8000-000000000001";
const BODY = {
  title: "Payslip",
  lines: [
    { label: "Basic salary", column: "Basic Salary" },
    { label: "Net pay", column: "Net Pay" },
  ],
};

const rates = () =>
  parseRow(
    DB_TABLES.statutory_rates,
    {
      id: "60000000-0000-4000-8000-000000000001",
      company_id: ABC,
      effective_from: "2025-07-01",
      revision: 1,
      nsf_employee_rate: 1.0625,
      nsf_ceiling: 28570,
      nsf_exempt_at_60: true,
      csg_employee_rate_low: 1.5,
      csg_employee_rate_high: 3,
      csg_threshold: 50000,
      source_note: "Sample figures, not the real ones",
      created_by: ME,
      created_at: NOW,
    },
    ME,
  );

const template = () =>
  parseRow(
    DB_TABLES.payslip_templates,
    {
      id: TEMPLATE,
      company_id: ABC,
      name: "Monthly payslip",
      draft_body: BODY,
      draft_revision: 3,
      created_by: OTHER_ADMIN,
      created_at: NOW,
      updated_by: ME,
      updated_at: NOW,
    },
    ME,
  );

const templateVersion = () =>
  parseRow(
    DB_TABLES.payslip_template_versions,
    {
      id: "70000000-0000-4000-8000-000000000001",
      template_id: TEMPLATE,
      company_id: ABC,
      version: 2,
      name: "Monthly payslip",
      body: BODY,
      published_by: OTHER_ADMIN,
      published_at: NOW,
    },
    ME,
  );

const issued = (n: number, issuedBy: string | null) =>
  parseRow(
    DB_TABLES.issued_payslips,
    {
      id: `80000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      company_id: ABC,
      employee_id: "30000000-0000-4000-8000-000000000001",
      period: "2026-09-01",
      revision: n,
      template_id: TEMPLATE,
      template_version: 2,
      rates_snapshot: { nsf_ceiling: 28570 },
      // The payslip app decides what a line holds: it may well carry the national ID.
      lines: [{ label: "Basic salary", amount: 31415, national_id: NATIONAL_ID }],
      accepted_differences: [{ field: "PAYE", reason: "Rounded by the payroll app" }],
      issued_by: issuedBy,
      issued_at: NOW,
    },
    ME,
  );

const membership = (id: string, name: string, role: Membership["role"]): Membership => ({
  role,
  company: { id, name, address: "Mauritius", brn: "C1234567", vat: "12%" },
});

const auth: AuthContextValue = {
  status: "signed-in",
  user: { id: ME, email: "admin@example.com", isDemo: false },
  notice: null,
  signIn: async () => null,
  signInDemo: null,
  signOut: async () => {},
  clearNotice: () => {},
};

function companyValue(current: Membership): CompanyContextValue {
  return {
    status: "ready",
    failure: null,
    retry: () => {},
    memberships: [current],
    current,
    isAdmin: current.role === "admin",
    canAddCompany: current.role === "admin",
    select: () => {},
  };
}

function Page({ current }: { current: Membership }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>
        <CompanyContext.Provider value={companyValue(current)}>
          <DatabasePage />
        </CompanyContext.Provider>
      </AuthContext.Provider>
    </QueryClientProvider>
  );
}

/** The tabs on their own, as someone who is not an admin would get them. */
function Tabs({ isAdmin }: { isAdmin: boolean }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>
        <DatabaseViewer company={ADMIN.company} isAdmin={isAdmin} />
      </AuthContext.Provider>
    </QueryClientProvider>
  );
}

const ADMIN = membership(ABC, "ABC Co Ltd", "admin");
const VIEWER = membership(ABC, "ABC Co Ltd", "viewer");

let total = 2;

beforeEach(() => {
  vi.useFakeTimers();
  total = 2;
  fetchCounts.mockReset().mockResolvedValue({
    companies: 1,
    employees: 2500,
    payroll_runs: 9,
    payroll_entries: 2500,
    company_members: 2,
    company_details: 3,
    // Its migration has not been run yet.
    company_links: null,
    statutory_rates: 1,
    payslip_templates: 1,
    payslip_template_versions: 1,
    issued_payslips: 3,
  });
  fetchPage
    .mockReset()
    .mockImplementation(async (_viewer, table: DbTableName, companyId: string) => {
      switch (table) {
        case "employees":
          return {
            rows: [employee(1, NATIONAL_ID, "DOE"), employee(2, SECOND_ID, "ROE", true)],
            total,
          };
        case "statutory_rates":
          return { rows: [rates()], total: 1 };
        case "payslip_templates":
          return { rows: [template()], total: 1 };
        case "payslip_template_versions":
          return { rows: [templateVersion()], total: 1 };
        case "issued_payslips":
          return { rows: [issued(1, ME), issued(2, OTHER_ADMIN), issued(3, null)], total: 3 };
        default:
          return {
            rows: [company(companyId, companyId === ABC ? "ABC Co Ltd" : "XYZ Trading Ltd")],
            total: 1,
          };
      }
    });
});

afterEach(() => {
  cleanup();
  lock();
  queryClient.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

/** Lets pending reads resolve and the screen settle. */
const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const unlock = () => act(() => grantUnlock(10));

async function open(table: DbTableName) {
  await unlock();
  await settle();
  fireEvent.click(screen.getByRole("tab", { name: new RegExp(`^${table}`) }));
  await settle();
}
const openEmployees = () => open("employees");

const pageCalls = (table: DbTableName) => fetchPage.mock.calls.filter((call) => call[1] === table);
const lastQuery = (table: DbTableName) => pageCalls(table).at(-1)![3] as TableQuery;

describe("who can open it", () => {
  it("leaves the Database item out of the navigation for viewers", () => {
    expect(navItemsFor(true).map((item) => item.label)).toContain("Database");
    expect(navItemsFor(false).map((item) => item.label)).not.toContain("Database");
  });

  it("places it between History and Settings", () => {
    const labels = navItemsFor(true).map((item) => item.label);
    expect(labels.slice(labels.indexOf("History"), labels.indexOf("Settings") + 1)).toEqual([
      "History",
      "Database",
      "Settings",
    ]);
  });

  it("blocks the route for a viewer with a clear message, and reads nothing", async () => {
    await unlock(); // even with the gate open
    render(<Page current={VIEWER} />);
    await settle();

    expect(screen.getByText("The Database page is for admins only")).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByText("Confirm your password to continue")).toBeNull();
    expect(fetchPage).not.toHaveBeenCalled();
    expect(fetchCounts).not.toHaveBeenCalled();
  });

  it("asks an admin for their password first, and reads nothing until then", async () => {
    render(<Page current={ADMIN} />);
    await settle();
    expect(screen.getByText("Confirm your password to continue")).toBeTruthy();
    expect(fetchPage).not.toHaveBeenCalled();
    expect(fetchCounts).not.toHaveBeenCalled();
  });
});

describe("what it shows", () => {
  it("has a tab per table with its row count", async () => {
    render(<Page current={ADMIN} />);
    await unlock();
    await settle();

    const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabs).toEqual([
      "companies1",
      "employees2,500",
      "payroll_runs9",
      "payroll_entries2,500",
      "company_members2",
      "company_details3",
      "company_links–",
      "statutory_rates1",
      "payslip_templates1",
      "payslip_template_versions1",
      "issued_payslips3",
    ]);
  });

  it("reads only the selected company, and offers no way to change anything", async () => {
    render(<Page current={ADMIN} />);
    await openEmployees();

    for (const call of fetchPage.mock.calls) expect(call[2]).toBe(ABC);
    expect(fetchCounts.mock.calls.every((call) => call[1] === ABC)).toBe(true);

    const names = screen.getAllByRole("button").map((button) => button.textContent ?? "");
    // No button whose name starts with a write action (column headers like "deleted_at" are fine).
    expect(
      names.some((name) =>
        /^(edit|delete|remove|insert|save|add|update|new|run)\b/i.test(name.trim()),
      ),
    ).toBe(false);
    expect(document.querySelector("textarea, [contenteditable]")).toBeNull();
  });

  it("badges soft-deleted rows and hides them unless asked", async () => {
    render(<Page current={ADMIN} />);
    await openEmployees();

    expect(lastQuery("employees").showDeleted).toBe(false);
    expect(screen.getByText("deleted")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Show deleted"));
    await settle();
    expect(lastQuery("employees").showDeleted).toBe(true);
  });
});

describe("masking", () => {
  it("masks national IDs by default", async () => {
    const { container } = render(<Page current={ADMIN} />);
    await openEmployees();

    expect(screen.getByText("DOE")).toBeTruthy();
    expect(container.textContent).not.toContain(NATIONAL_ID);
    expect(screen.getAllByRole("button", { name: /national_id is hidden/ })).toHaveLength(2);
  });

  it("reveals one cell at a time on click", async () => {
    const { container } = render(<Page current={ADMIN} />);
    await openEmployees();

    fireEvent.click(screen.getAllByRole("button", { name: /national_id is hidden/ })[0]!);
    expect(container.textContent).toContain(NATIONAL_ID);
    expect(container.textContent).not.toContain(SECOND_ID);
  });

  it("reveals and hides everything with the toggle", async () => {
    const { container } = render(<Page current={ADMIN} />);
    await openEmployees();

    fireEvent.click(screen.getByRole("button", { name: "Reveal all" }));
    expect(container.textContent).toContain(NATIONAL_ID);
    expect(container.textContent).toContain(SECOND_ID);

    fireEvent.click(screen.getByRole("button", { name: "Hide all" }));
    expect(container.textContent).not.toContain(NATIONAL_ID);
    expect(container.textContent).not.toContain(SECOND_ID);
  });

  it("masks the JSON view too, until revealed", async () => {
    render(<Page current={ADMIN} />);
    await openEmployees();

    fireEvent.click(screen.getAllByRole("button", { name: /View JSON/ })[0]!);
    const panel = screen.getByRole("dialog");
    const json = () => within(panel).getByLabelText("employees row as JSON").textContent ?? "";

    expect(json()).toContain('"surname": "DOE"');
    expect(json()).toContain('"national_id": "••••••"');
    expect(json()).not.toContain(NATIONAL_ID);

    fireEvent.click(within(panel).getByRole("button", { name: "Reveal sensitive" }));
    expect(json()).toContain(`"national_id": "${NATIONAL_ID}"`);
  });

  it("copies the JSON exactly as shown", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<Page current={ADMIN} />);
    await openEmployees();

    fireEvent.click(screen.getAllByRole("button", { name: /View JSON/ })[0]!);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Copy" }));
    await settle();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]![0]).toContain("••••••");
    expect(writeText.mock.calls[0]![0]).not.toContain(NATIONAL_ID);
  });

  it("masks everything again after the page locks", async () => {
    const { container } = render(<Page current={ADMIN} />);
    await openEmployees();
    fireEvent.click(screen.getByRole("button", { name: "Reveal all" }));
    expect(container.textContent).toContain(NATIONAL_ID);

    await act(() => lock());
    expect(container.textContent).not.toContain(NATIONAL_ID);
    expect(container.textContent).not.toContain("DOE");
    expect(screen.getByText("Confirm your password to continue")).toBeTruthy();

    await openEmployees();
    expect(screen.getByText("DOE")).toBeTruthy();
    expect(container.textContent).not.toContain(NATIONAL_ID);
    expect(screen.getByRole("button", { name: "Reveal all" })).toBeTruthy();
  });

  it("masks everything again when the company changes", async () => {
    const { container, rerender } = render(<Page current={ADMIN} />);
    await openEmployees();
    fireEvent.click(screen.getByRole("button", { name: "Reveal all" }));
    expect(container.textContent).toContain(NATIONAL_ID);

    rerender(<Page current={membership(XYZ, "XYZ Trading Ltd", "admin")} />);
    await settle();
    fireEvent.click(screen.getByRole("tab", { name: /employees/ }));
    await settle();

    expect(container.textContent).not.toContain(NATIONAL_ID);
    expect(screen.getByRole("button", { name: "Reveal all" })).toBeTruthy();
    expect(lastQuery("employees")).toBeDefined();
    expect(pageCalls("employees").at(-1)![2]).toBe(XYZ);
  });
});

describe("the payslip tables", () => {
  it("reads each of them for the selected company only, behind the gate", async () => {
    render(<Page current={ADMIN} />);
    await settle();
    expect(fetchPage).not.toHaveBeenCalled();

    for (const table of [
      "statutory_rates",
      "payslip_templates",
      "payslip_template_versions",
      "issued_payslips",
    ] as const) {
      await open(table);
      expect(pageCalls(table).length).toBeGreaterThan(0);
      expect(pageCalls(table).every((call) => call[2] === ABC)).toBe(true);
      expect(screen.getByRole("table")).toBeTruthy();
    }
  });

  it("shows the statutory figures as they are: company-wide, so nothing is masked", async () => {
    const { container } = render(<Page current={ADMIN} />);
    await open("statutory_rates");

    // A rate is shown as stored, a ceiling or threshold as money.
    expect(container.textContent).toContain("1.0625");
    expect(container.textContent).toContain("28,570");
    expect(container.textContent).toContain("50,000");
    expect(screen.queryByRole("button", { name: /is hidden/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reveal all" })).toBeNull();
  });

  it("shows a template body masked, then collapsed, and in full only in the JSON view", async () => {
    const { container } = render(<Page current={ADMIN} />);
    await open("payslip_templates");

    expect(screen.getByText("Monthly payslip")).toBeTruthy();
    expect(container.textContent).not.toContain('"title"');

    // Revealed in the table it is one short line, not the whole body.
    fireEvent.click(screen.getByRole("button", { name: /draft_body is hidden/ }));
    expect(container.textContent).toContain('{"title":"Payslip"');
    expect(container.textContent).not.toContain("Net pay");

    fireEvent.click(screen.getByRole("button", { name: /View JSON/ }));
    const panel = screen.getByRole("dialog");
    const json = () =>
      within(panel).getByLabelText("payslip_templates row as JSON").textContent ?? "";
    expect(json()).toContain('"draft_body": "••••••"');
    expect(json()).not.toContain("Net pay");

    fireEvent.click(within(panel).getByRole("button", { name: "Reveal sensitive" }));
    expect(json()).toContain('"label": "Net pay"');
  });

  it("does the same for a published version's body", async () => {
    const { container } = render(<Page current={ADMIN} />);
    await open("payslip_template_versions");

    expect(container.textContent).not.toContain('"title"');
    fireEvent.click(screen.getByRole("button", { name: /View JSON/ }));
    const json = () =>
      within(screen.getByRole("dialog")).getByLabelText("payslip_template_versions row as JSON")
        .textContent ?? "";
    expect(json()).toContain('"body": "••••••"');
    fireEvent.click(screen.getByRole("button", { name: "Reveal sensitive" }));
    expect(json()).toContain('"label": "Net pay"');
  });

  it("masks issued lines, rates and accepted differences: no amount or national ID until revealed", async () => {
    const { container } = render(<Page current={ADMIN} />);
    await open("issued_payslips");

    expect(screen.getAllByRole("button", { name: /lines is hidden/ })).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: /rates_snapshot is hidden/ })).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: /accepted_differences is hidden/ })).toHaveLength(
      3,
    );
    for (const value of [NATIONAL_ID, "31415", "28570", "Basic salary", "Rounded by"]) {
      expect(container.textContent).not.toContain(value);
    }

    // Revealed in the table the lines are one short line: the national ID is past the cut.
    fireEvent.click(screen.getAllByRole("button", { name: /lines is hidden/ })[0]!);
    expect(container.textContent).toContain('[{"label":"Basic salary"');
    expect(container.textContent).not.toContain(NATIONAL_ID);

    fireEvent.click(screen.getAllByRole("button", { name: /View JSON/ })[1]!);
    const panel = screen.getByRole("dialog");
    const json = () =>
      within(panel).getByLabelText("issued_payslips row as JSON").textContent ?? "";
    expect(json()).toContain('"lines": "••••••"');
    expect(json()).toContain('"rates_snapshot": "••••••"');
    expect(json()).toContain('"accepted_differences": "••••••"');
    expect(json()).not.toContain(NATIONAL_ID);

    fireEvent.click(within(panel).getByRole("button", { name: "Reveal sensitive" }));
    expect(json()).toContain(`"national_id": "${NATIONAL_ID}"`);
    expect(json()).toContain('"amount": 31415');
  });

  it("says You or Another admin, and never shows a user id", async () => {
    const { container } = render(<Page current={ADMIN} />);
    await open("issued_payslips");
    fireEvent.click(screen.getByRole("button", { name: "Reveal all" }));

    const cells = (text: string) =>
      screen.getAllByRole("cell").filter((c) => c.textContent === text);
    expect(cells("You")).toHaveLength(1);
    expect(cells("Another admin")).toHaveLength(1);
    // The account that issued the third one was removed.
    expect(cells("null")).toHaveLength(1);

    // Who did it is not something to sort by either.
    expect(screen.queryByRole("button", { name: "issued_by" })).toBeNull();
    expect(screen.getByRole("button", { name: "issued_at" })).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: /View JSON/ })[1]!);
    expect(screen.getByRole("dialog").textContent).toContain('"issued_by": "Another admin"');

    for (const shown of [container.textContent, document.body.textContent]) {
      expect(shown).not.toContain(ME);
      expect(shown).not.toContain(OTHER_ADMIN);
      expect(shown).not.toContain("0b0b0b0b");
    }
  });

  it("tells someone who is not an admin that issued payslips are for admins only, and reads nothing", async () => {
    await unlock();
    render(<Tabs isAdmin={false} />);
    await settle();

    // Not even a count is asked for.
    expect(fetchCounts.mock.calls.every((call) => call[3] === false)).toBe(true);
    const tab = screen.getByRole("tab", { name: /^issued_payslips/ });
    expect(within(tab).getByLabelText("admins only")).toBeTruthy();

    fireEvent.click(tab);
    await advance(2_000);

    expect(screen.getByText("issued_payslips is for admins only")).toBeTruthy();
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
      "db-tab-issued_payslips",
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button", { name: /Try again/ })).toBeNull();
    expect(pageCalls("issued_payslips")).toHaveLength(0);

    // The tables a member may read still open.
    fireEvent.click(screen.getByRole("tab", { name: /^statutory_rates/ }));
    await settle();
    expect(screen.getByRole("table")).toBeTruthy();
  });

  it("shows an admin the rows, with no such message", async () => {
    await unlock();
    render(<Tabs isAdmin />);
    await settle();
    expect(fetchCounts.mock.calls.every((call) => call[3] === true)).toBe(true);

    fireEvent.click(screen.getByRole("tab", { name: /^issued_payslips/ }));
    await settle();
    expect(screen.queryByText("issued_payslips is for admins only")).toBeNull();
    expect(pageCalls("issued_payslips").length).toBeGreaterThan(0);
  });

  it("names the migration when a table is not in the database yet", async () => {
    fetchPage.mockRejectedValue({ code: "PGRST205", message: "not in the schema cache" });
    render(<Page current={ADMIN} />);
    await open("issued_payslips");
    await advance(2_000);

    expect(screen.getByText("issued_payslips isn't in the database yet")).toBeTruthy();
    expect(screen.getByText(/0011_issued_payslips\.sql/)).toBeTruthy();
  });

  it("drops the rows when it locks, and writes nothing to browser storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { container } = render(<Page current={ADMIN} />);
    await open("issued_payslips");
    fireEvent.click(screen.getByRole("button", { name: "Reveal all" }));
    fireEvent.click(screen.getAllByRole("button", { name: /View JSON/ })[0]!);
    await advance(20_000);

    expect(setItem).not.toHaveBeenCalled();
    const stored = JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]);
    for (const value of [NATIONAL_ID, "31415", "Basic salary", "28570"]) {
      expect(stored).not.toContain(value);
    }
    expect(
      queryClient.getQueryCache().findAll({ queryKey: ["db", "rows", "issued_payslips"] }).length,
    ).toBeGreaterThan(0);

    await act(() => lock());
    expect(queryClient.getQueryCache().findAll({ queryKey: ["db"] })).toHaveLength(0);
    expect(container.textContent).not.toContain("Basic salary");
    expect(screen.getByText("Confirm your password to continue")).toBeTruthy();
  });
});

describe("leaving nothing behind", () => {
  it("drops the rows from memory when it locks and when the session ends", async () => {
    render(<Page current={ADMIN} />);
    await openEmployees();
    expect(queryClient.getQueryCache().findAll({ queryKey: ["db"] }).length).toBeGreaterThan(0);

    await act(() => lock());
    expect(queryClient.getQueryCache().findAll({ queryKey: ["db"] })).toHaveLength(0);

    await openEmployees();
    await act(() => runSessionCleanup());
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it("writes no row values to browser storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    render(<Page current={ADMIN} />);
    await openEmployees();
    fireEvent.click(screen.getByRole("button", { name: "Reveal all" }));
    fireEvent.click(screen.getAllByRole("button", { name: /View JSON/ })[0]!);
    await advance(20_000);

    const stored = JSON.stringify([
      Object.entries(localStorage),
      Object.entries(sessionStorage),
      setItem.mock.calls,
    ]);
    for (const value of [NATIONAL_ID, SECOND_ID, "DOE", "ROE", "ABC Co Ltd"]) {
      expect(stored).not.toContain(value);
    }
    expect(setItem).not.toHaveBeenCalled();
  });
});

describe("refreshing", () => {
  it("re-reads every 15 seconds by default", async () => {
    render(<Page current={ADMIN} />);
    await openEmployees();
    const before = pageCalls("employees").length;

    await advance(14_000);
    expect(pageCalls("employees")).toHaveLength(before);
    await advance(1_000);
    expect(pageCalls("employees")).toHaveLength(before + 1);
    await advance(15_000);
    expect(pageCalls("employees")).toHaveLength(before + 2);
  });

  it("follows the interval set in Settings", async () => {
    setRefreshSeconds(60);
    render(<Page current={ADMIN} />);
    await openEmployees();
    const before = pageCalls("employees").length;

    await advance(45_000);
    expect(pageCalls("employees")).toHaveLength(before);
    await advance(15_000);
    expect(pageCalls("employees")).toHaveLength(before + 1);
    setRefreshSeconds(15);
  });

  it("pauses while the browser tab is hidden, and resumes when it is back", async () => {
    render(<Page current={ADMIN} />);
    await openEmployees();
    const before = fetchPage.mock.calls.length + fetchCounts.mock.calls.length;

    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(() => void window.dispatchEvent(new Event("visibilitychange")));
    await advance(90_000);
    expect(fetchPage.mock.calls.length + fetchCounts.mock.calls.length).toBe(before);

    visibility.mockReturnValue("visible");
    await act(() => void window.dispatchEvent(new Event("visibilitychange")));
    await advance(15_000);
    expect(fetchPage.mock.calls.length + fetchCounts.mock.calls.length).toBeGreaterThan(before);
  });

  it("stops while the page is locked", async () => {
    render(<Page current={ADMIN} />);
    await openEmployees();
    await act(() => lock());
    const before = fetchPage.mock.calls.length + fetchCounts.mock.calls.length;

    await advance(120_000);
    expect(fetchPage.mock.calls.length + fetchCounts.mock.calls.length).toBe(before);
  });

  it("keeps the page, sort and search across a refresh", async () => {
    total = 2500;
    render(<Page current={ADMIN} />);
    await openEmployees();

    fireEvent.click(screen.getByRole("button", { name: "surname" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "doe" } });
    await advance(400);
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await settle();
    const chosen = lastQuery("employees");
    expect(chosen).toMatchObject({
      page: 1,
      search: "doe",
      sort: { column: "surname", ascending: false },
    });

    await advance(15_000);
    expect(lastQuery("employees")).toEqual(chosen);
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("doe");
    expect(screen.getByText(/Page 2 of 50/)).toBeTruthy();
  });

  it("has a manual Refresh and shows when it was last updated", async () => {
    render(<Page current={ADMIN} />);
    await openEmployees();
    const before = pageCalls("employees").length;

    expect(screen.getByText(/Updated/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await settle();
    expect(pageCalls("employees")).toHaveLength(before + 1);
  });
});

describe("paging past 1,000 rows", () => {
  it("walks to the last page of 2,500 rows, asking for one page at a time", async () => {
    total = 2500;
    render(<Page current={ADMIN} />);
    await openEmployees();

    expect(screen.getByText(/Page 1 of 50/)).toBeTruthy();
    expect(lastQuery("employees")).toMatchObject({ page: 0, pageSize: 50 });

    fireEvent.click(screen.getByRole("button", { name: "Last page" }));
    await settle();

    expect(lastQuery("employees")).toMatchObject({ page: 49, pageSize: 50 });
    expect(screen.getByText(/Page 50 of 50/)).toBeTruthy();
    expect(screen.getByText("2,451–2,500")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe("when something is wrong", () => {
  it("shows the paused-or-unreachable message with a retry", async () => {
    fetchPage.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<Page current={ADMIN} />);
    await unlock();
    await advance(2_000);

    expect(screen.getByText("Can't reach the database")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Try again/ })).toBeTruthy();
  });

  it("shows an error instead of data when the response doesn't match", async () => {
    fetchPage.mockImplementation(async () => ({
      rows: [parseRow(DB_TABLES.companies, { id: "nope" })],
      total: 1,
    }));
    render(<Page current={ADMIN} />);
    await unlock();
    await advance(2_000);

    expect(screen.getByText("The database returned something unexpected")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows an empty state for a table with no rows", async () => {
    fetchPage.mockResolvedValue({ rows: [], total: 0 });
    render(<Page current={ADMIN} />);
    await unlock();
    await settle();
    expect(screen.getByText("No rows in companies")).toBeTruthy();
  });
});
