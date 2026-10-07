import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyContext, type CompanyContextValue } from "@/features/company/company-context";
import { ThemeContext, type ThemeContextValue } from "@/features/theme/theme-context";
import { importInbox } from "@/features/import/importInbox";
import { deleteTemplate, mappingTemplates, saveTemplate } from "@/features/transfer/templates";
import { beginTransfer, transferLog } from "@/features/transfer/transferLog";
import { heldBatch } from "@/features/transfer/transferSource";
import { incomingBatches } from "@/lib/bridge/bridge";
import {
  clampIdleMinutes,
  idleMinutes,
  refreshSeconds,
  setIdleMinutes,
  unlockMinutes,
} from "@/lib/preferences";
import { queryClient } from "@/lib/queryClient";
import { clearInMemoryData } from "@/lib/sessionCleanup";
import { grantUnlock, isUnlocked, lock } from "@/lib/unlock";
import { SettingsPage } from "./SettingsPage";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

const setTheme = vi.fn();
const theme: ThemeContextValue = { theme: "system", resolved: "dark", setTheme, toggle: () => {} };

const viewerOf = (role: "admin" | "viewer"): CompanyContextValue => {
  const current = {
    role,
    company: {
      id: "10000000-0000-4000-8000-000000000001",
      name: "ABC Co Ltd",
      address: null,
      brn: null,
      vat: null,
    },
  };
  return {
    status: "ready",
    failure: null,
    retry: () => {},
    memberships: [current],
    current,
    isAdmin: role === "admin",
    canAddCompany: role === "admin",
    select: () => {},
  };
};

const renderSettings = (role: "admin" | "viewer" = "viewer") =>
  render(
    <ThemeContext.Provider value={theme}>
      <CompanyContext.Provider value={viewerOf(role)}>
        <SettingsPage />
      </CompanyContext.Provider>
    </ThemeContext.Provider>,
  );

const PAYLOAD = {
  dataType: "payroll-result",
  rows: [{ ID: "X0000000000001", "Net Pay": 18169.12 }],
};

afterEach(() => {
  cleanup();
  for (const template of mappingTemplates.get()) deleteTemplate(template.id);
  clearInMemoryData();
  lock();
  setTheme.mockReset();
  localStorage.clear();
});

describe("Settings", () => {
  it("has every section the brief asks for", () => {
    renderSettings();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "Appearance",
      "Security",
      "Database page",
      "Saved mappings",
      "Apps",
      "Memory",
      "About",
    ]);
  });

  it("adds the danger zone last, for an admin of the selected company only", () => {
    renderSettings("admin");
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings.at(-1)).toBe("Danger zone");
    expect(screen.getByRole("button", { name: /Delete ABC Co Ltd/ })).toBeTruthy();
  });

  it("switches theme", () => {
    renderSettings();
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(setTheme).toHaveBeenCalledWith("light");
    expect(screen.getByRole("radio", { name: "Match system" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("saves the three timings as you type, within their ranges", () => {
    renderSettings();
    fireEvent.change(screen.getByLabelText("Keep sensitive areas unlocked for"), {
      target: { value: "20" },
    });
    fireEvent.change(screen.getByLabelText("Sign me out after no activity for"), {
      target: { value: "30" },
    });
    fireEvent.change(screen.getByLabelText("Refresh the Database page every"), {
      target: { value: "60" },
    });
    expect([unlockMinutes.get(), idleMinutes.get(), refreshSeconds.get()]).toEqual([20, 30, 60]);

    // Out of range: not saved, flagged, and snapped back on leaving the field.
    const unlockField = screen.getByLabelText(
      "Keep sensitive areas unlocked for",
    ) as HTMLInputElement;
    fireEvent.change(unlockField, { target: { value: "99" } });
    expect(unlockMinutes.get()).toBe(20);
    expect(unlockField.getAttribute("aria-invalid")).toBe("true");
    fireEvent.blur(unlockField);
    expect(unlockField.value).toBe("30");
    expect(unlockMinutes.get()).toBe(30);

    fireEvent.change(unlockField, { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Sign me out after no activity for"), {
      target: { value: "15" },
    });
    fireEvent.change(screen.getByLabelText("Refresh the Database page every"), {
      target: { value: "15" },
    });
  });

  it("keeps the idle sign-out between 1 and 120 minutes, defaulting to 15", () => {
    expect(clampIdleMinutes(undefined)).toBe(15);
    expect(clampIdleMinutes(0)).toBe(1);
    expect(clampIdleMinutes(500)).toBe(120);
    expect(setIdleMinutes("45")).toBe(45);
    expect(localStorage.getItem("payroll-hub:idle-minutes")).toBe("45");
    setIdleMinutes(15);
  });

  it("lists saved mappings and deletes one", () => {
    saveTemplate({
      name: "Payroll to PDF",
      destinationId: "pdf-editor",
      dataType: "payroll-result",
      mapping: { ID: "ID", Surname: "Surname" },
    });
    renderSettings();

    expect(screen.getByText("Payroll to PDF")).toBeTruthy();
    expect(screen.getByText(/For PDF Form Filler, 2 fields/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: 'Delete the mapping "Payroll to PDF"' }));
    expect(screen.queryByText("Payroll to PDF")).toBeNull();
    expect(mappingTemplates.get()).toEqual([]);
  });

  it("shows the app registry, read only", () => {
    renderSettings();
    const table = screen.getByRole("table", { name: /Registered apps/ });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("rowheader")[0]!.textContent)).toEqual([
      "Payroll Systempayroll",
      "PDF Form Fillerpdf-editor",
      "Payslip Automationpayslip",
    ]);
    expect(within(table).getByText("https://noor1290.github.io/payroll_sys/")).toBeTruthy();
    expect(within(table).getByText("https://noor1290.github.io/payslip/")).toBeTruthy();
    expect(within(table).queryByText("Coming soon")).toBeNull();
    expect(within(table).queryByRole("button")).toBeNull();
    expect(within(table).queryByRole("textbox")).toBeNull();
  });

  it("shows the version and protocol", () => {
    renderSettings();
    expect(screen.getByText(/^\d+\.\d+\.\d+/)).toBeTruthy();
    expect(screen.getByText("version 1")).toBeTruthy();
  });
});

describe("Clear all in-memory data", () => {
  it("wipes everything held in memory, and nothing that is a saved preference", () => {
    // Fill every place that holds data.
    queryClient.setQueryData(["run-entries", "run-1", "u"], [{ national_id: "X0000000000001" }]);
    queryClient.setQueryData(["overview", "c", "u"], { latestRunNetPay: 18169.12 });
    queryClient.setQueryData(["db", "rows", "employees"], { rows: [], total: 0 });
    beginTransfer("transfer-00001", "pdf-editor", "PDF Form Filler", PAYLOAD, {
      label: "Payroll System",
      gated: false,
    });
    const batch = { id: "batch-1", appId: "payroll", receivedAt: 1, payload: PAYLOAD };
    incomingBatches.set([batch]);
    heldBatch.set(batch);
    importInbox.set([
      {
        label: "From Payroll System",
        parsed: { rows: [], errors: [], fatal: null, company: null, rowCount: 1 },
      },
    ]);
    grantUnlock(10);
    saveTemplate({
      name: "Keep me",
      destinationId: "pdf-editor",
      dataType: "payroll-result",
      mapping: { ID: "ID" },
    });

    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: /Clear all in-memory data/ }));

    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(transferLog.get()).toEqual([]);
    expect(incomingBatches.get()).toEqual([]);
    expect(heldBatch.get()).toBeNull();
    expect(importInbox.get()).toEqual([]);
    expect(isUnlocked()).toBe(false);
    // Preferences are not "data": the saved mapping stays.
    expect(mappingTemplates.get().map((t) => t.name)).toEqual(["Keep me"]);
  });
});
