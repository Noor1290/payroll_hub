import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { navItemsFor } from "@/app/nav";
import { AuthContext, type AuthContextValue } from "@/features/auth/auth-context";
import { CompanyContext, type CompanyContextValue } from "@/features/company/company-context";
import { queryClient } from "@/lib/queryClient";
import {
  createLinks,
  deleteLink,
  fetchLinks,
  saveOrder,
  updateLink,
  type CompanyLink,
} from "@/lib/supabase/companyData";
import type { Membership } from "@/lib/supabase/schemas";
import { LinksPage } from "./LinksPage";

vi.mock("@/lib/supabase/client", () => ({ supabase: null }));
vi.mock("@/lib/supabase/companyData", async (original) => ({
  ...(await original<typeof import("@/lib/supabase/companyData")>()),
  fetchLinks: vi.fn(),
  createLinks: vi.fn(),
  updateLink: vi.fn(),
  deleteLink: vi.fn(),
  saveOrder: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const fetch = vi.mocked(fetchLinks);
const create = vi.mocked(createLinks);

const ABC = "10000000-0000-4000-8000-000000000001";
const XYZ = "10000000-0000-4000-8000-000000000002";
const USER = "00000000-0000-4000-8000-0000000000a1";
const NOW = "2026-09-28T10:15:00+00:00";

// FAKE links.
const link = (
  n: number,
  companyId: string,
  title: string,
  url: string,
  more: Partial<CompanyLink> = {},
): CompanyLink => ({
  id: `60000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  company_id: companyId,
  title,
  url,
  description: null,
  category: null,
  icon: "link",
  accent: "teal",
  is_pinned: false,
  sort_order: n,
  updated_at: NOW,
  ...more,
});

const ABC_LINKS = [
  link(1, ABC, "Tax portal", "https://example.org/tax", {
    category: "Government",
    is_pinned: true,
  }),
  link(2, ABC, "Online banking", "https://example.com/bank", { category: "Banking" }),
];
const XYZ_LINKS = [
  // The same site as ABC's tax portal, typed slightly differently.
  link(11, XYZ, "Tax (XYZ)", "https://EXAMPLE.org/tax/"),
  link(12, XYZ, "Pension scheme", "https://example.org/pension"),
  link(13, XYZ, "Supplier portal", "https://example.com/suppliers"),
];

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

function renderPage(role: Membership["role"]) {
  const current = membership(ABC, "ABC Co Ltd", role);
  const company: CompanyContextValue = {
    status: "ready",
    failure: null,
    retry: () => {},
    memberships: [current, membership(XYZ, "XYZ Trading Ltd", "viewer")],
    current,
    isAdmin: role === "admin",
    canAddCompany: role === "admin",
    select: () => {},
  };
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>
        <CompanyContext.Provider value={company}>
          <LinksPage />
        </CompanyContext.Provider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

const network = vi.fn();

beforeEach(() => {
  fetch
    .mockReset()
    .mockImplementation(async (_viewer, companyId) => (companyId === ABC ? ABC_LINKS : XYZ_LINKS));
  create.mockReset().mockImplementation(async (_viewer, _company, inputs) => inputs.length);
  vi.mocked(updateLink).mockReset().mockResolvedValue();
  vi.mocked(deleteLink).mockReset().mockResolvedValue();
  vi.mocked(saveOrder).mockReset().mockResolvedValue();
  toast.success.mockReset();
  toast.error.mockReset();
  network.mockReset();
  vi.stubGlobal("fetch", network);
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe("what everyone sees", () => {
  it("is in the navigation for viewers and admins alike", () => {
    for (const admin of [true, false]) {
      const labels = navItemsFor(admin).map((item) => item.label);
      expect(labels).toContain("Links");
      expect(labels).toContain("Company profile");
    }
  });

  it("shows each link as a card that opens in a new tab, safely", async () => {
    renderPage("viewer");
    const card = (await screen.findByText("Tax portal")).closest("a")!;

    expect(card.getAttribute("href")).toBe("https://example.org/tax");
    expect(card.getAttribute("target")).toBe("_blank");
    expect(card.getAttribute("rel")).toBe("noopener noreferrer");
    for (const anchor of screen.getAllByRole("link")) {
      expect(anchor.getAttribute("href")).toMatch(/^https?:\/\//);
      expect(anchor.getAttribute("rel")).toBe("noopener noreferrer");
    }
  });

  it("groups by category with pinned links first, and narrows with the search", async () => {
    renderPage("viewer");
    await screen.findByText("Tax portal");
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "Pinned1",
      "Banking1",
    ]);

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "bank" } });
    expect(screen.queryByText("Tax portal")).toBeNull();
    expect(screen.getByText("Online banking")).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz" } });
    expect(screen.getByText("No links match")).toBeTruthy();
  });

  it("fetches nothing from outside for the cards: no images, no requests", async () => {
    const { container } = renderPage("viewer");
    await screen.findByText("Tax portal");
    expect(container.querySelectorAll("img, iframe, link, script")).toHaveLength(0);
    expect(network).not.toHaveBeenCalled();
  });

  it("keeps nothing about the links in browser storage", async () => {
    renderPage("admin");
    await screen.findByText("Tax portal");
    const stored = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    for (const text of ["Tax portal", "example.org", "Online banking", "Government"]) {
      expect(stored).not.toContain(text);
    }
  });

  it("has an empty state", async () => {
    fetch.mockResolvedValue([]);
    renderPage("viewer");
    expect(await screen.findByText("No links yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Add/ })).toBeNull();
  });

  it("says which migration to run when the table is missing", async () => {
    fetch.mockRejectedValue({ code: "PGRST205", message: "not in the schema cache" });
    renderPage("admin");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Links aren't set up in the database yet");
    expect(alert.textContent).toContain("0006_company_links.sql");
  });
});

describe("viewers cannot edit", () => {
  it("offers a viewer nothing but the cards and the search", async () => {
    renderPage("viewer");
    await screen.findByText("Tax portal");
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.queryByText(/Copy from another company/)).toBeNull();
  });

  it("offers an admin add, copy, reorder and per-card actions", async () => {
    renderPage("admin");
    await screen.findByText("Tax portal");
    expect(screen.getByRole("button", { name: "Add link" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy from another company" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Actions for Tax portal" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Drag Tax portal to reorder" })).toBeTruthy();
  });
});

describe("adding a link", () => {
  const open = async () => {
    renderPage("admin");
    await screen.findByText("Tax portal");
    fireEvent.click(screen.getByRole("button", { name: "Add link" }));
    return screen.getByRole("dialog");
  };
  const fill = (dialog: HTMLElement, title: string, url: string) => {
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: title } });
    fireEvent.change(within(dialog).getByLabelText("Web address"), { target: { value: url } });
    fireEvent.submit(within(dialog).getByLabelText("Title").closest("form")!);
  };

  it("refuses javascript: and data: addresses without calling the database", async () => {
    const dialog = await open();
    for (const bad of ["javascript:alert(1)", "data:text/html,hi"]) {
      fill(dialog, "Bad", bad);
      expect(within(dialog).getByText(/must start with https:\/\/ or http:\/\//)).toBeTruthy();
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("saves the tidied address and refreshes the list", async () => {
    const dialog = await open();
    fill(dialog, " Pension ", " https://EXAMPLE.org/pension/ ");

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const [viewer, companyId, inputs, sortOrder] = create.mock.calls[0]!;
    expect(viewer).toEqual({ id: USER, isDemo: false });
    expect(companyId).toBe(ABC);
    expect(inputs).toMatchObject([{ title: "Pension", url: "https://example.org/pension" }]);
    expect(sortOrder).toBe(3);
    // Read again straight after the change.
    await waitFor(() => expect(fetch.mock.calls.filter((c) => c[1] === ABC).length).toBe(2));
  });

  it("explains a duplicate address in plain words", async () => {
    create.mockRejectedValue({ code: "23505", message: "duplicate key value" });
    const dialog = await open();
    fill(dialog, "Tax again", "https://example.org/tax/");

    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "This company already has a link to that address",
    );
    expect(within(dialog).getByLabelText("Web address").getAttribute("aria-invalid")).toBe("true");
  });
});

describe("copying from another company", () => {
  it("copies only the addresses this company doesn't have, and reports how many were skipped", async () => {
    renderPage("admin");
    await screen.findByText("Tax portal");
    fireEvent.click(screen.getByRole("button", { name: "Copy from another company" }));
    const dialog = screen.getByRole("dialog");

    expect(await within(dialog).findByText("2 links will be copied")).toBeTruthy();
    expect(within(dialog).getByText(/1 link will be skipped/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy 2 links" }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const [, companyId, inputs] = create.mock.calls[0]!;
    expect(companyId).toBe(ABC);
    expect(inputs.map((input) => input.url)).toEqual([
      "https://example.org/pension",
      "https://example.com/suppliers",
    ]);
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(toast.success.mock.calls[0]![0]).toBe("Copied 2 links to ABC Co Ltd");
    expect(toast.success.mock.calls[0]![1].description).toBe(
      "Skipped 1 link that ABC Co Ltd already has.",
    );
  });

  it("offers nothing to copy when every address is already here", async () => {
    fetch.mockImplementation(async () => ABC_LINKS);
    renderPage("admin");
    await screen.findByText("Tax portal");
    fireEvent.click(screen.getByRole("button", { name: "Copy from another company" }));
    const dialog = screen.getByRole("dialog");

    expect(await within(dialog).findByText(/Nothing to copy/)).toBeTruthy();
    expect(
      (within(dialog).getByRole("button", { name: "Copy" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });
});
