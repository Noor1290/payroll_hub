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
import { DatabasePage } from "./DatabasePage";

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

const membership = (id: string, name: string, role: Membership["role"]): Membership => ({
  role,
  company: { id, name, address: "Mauritius", brn: "C1234567", vat: "12%" },
});

const auth: AuthContextValue = {
  status: "signed-in",
  user: { id: "00000000-0000-4000-8000-0000000000a1", email: "admin@example.com", isDemo: false },
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
  });
  fetchPage
    .mockReset()
    .mockImplementation(async (_viewer, table: DbTableName, companyId: string) => ({
      rows:
        table === "employees"
          ? [employee(1, NATIONAL_ID, "DOE"), employee(2, SECOND_ID, "ROE", true)]
          : [company(companyId, companyId === ABC ? "ABC Co Ltd" : "XYZ Trading Ltd")],
      total: table === "employees" ? total : 1,
    }));
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

async function openEmployees() {
  await unlock();
  await settle();
  fireEvent.click(screen.getByRole("tab", { name: /employees/ }));
  await settle();
}

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
