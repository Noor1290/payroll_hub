import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { CompanyContext, type CompanyContextValue } from "@/features/company/company-context";
import type { Membership } from "@/lib/supabase/schemas";
import { openCompanyProfile, profileOpenerReady } from "./openProfile";
import { ProfileOpener } from "./ProfileOpener";

/**
 * The shell's side of `open-profile` (MRA Returns, Stage 2): the selected company's profile is
 * shown at once; another company is selected first, the usual way (the question about unsaved
 * changes included), and its profile shown only once it is. FAKE companies.
 */

const ABC = "10000000-0000-4000-8000-000000000001";
const DEF = "10000000-0000-4000-8000-000000000003";
const membership: Membership = {
  role: "admin",
  company: { id: ABC, name: "ABC Co Ltd", address: null, brn: "C1234567", vat: null },
};

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function mount(select: CompanyContextValue["select"]) {
  const companies: CompanyContextValue = {
    status: "ready",
    failure: null,
    retry: () => {},
    memberships: [membership],
    current: membership,
    isAdmin: true,
    canAddCompany: true,
    select,
  };
  return render(
    <MemoryRouter initialEntries={["/workspace"]}>
      <CompanyContext.Provider value={companies}>
        <ProfileOpener />
        <Routes>
          <Route path="*" element={<Where />} />
        </Routes>
      </CompanyContext.Provider>
    </MemoryRouter>,
  );
}

afterEach(() => cleanup());

describe("ProfileOpener", () => {
  it("shows the selected company's profile without selecting anything", () => {
    const select = vi.fn();
    const view = mount(select);
    act(() => void openCompanyProfile(ABC));
    expect(view.getByTestId("where").textContent).toBe("/profile");
    expect(select).not.toHaveBeenCalled();
  });

  it("selects another company first, and shows its profile only once it is selected", () => {
    let afterwards: (() => void) | undefined;
    const select = vi.fn((_id: string, options?: { afterwards?: () => void }) => {
      afterwards = options?.afterwards;
    });
    const view = mount(select);
    act(() => void openCompanyProfile(DEF));
    expect(select).toHaveBeenCalledWith(
      DEF,
      expect.objectContaining({ afterwards: expect.any(Function) }),
    );
    // The user may still be asked about unsaved changes: nothing moves yet.
    expect(view.getByTestId("where").textContent).toBe("/workspace");
    act(() => afterwards!());
    expect(view.getByTestId("where").textContent).toBe("/profile");
  });

  it("is there only while the shell is", () => {
    const view = mount(vi.fn());
    expect(profileOpenerReady()).toBe(true);
    view.unmount();
    expect(profileOpenerReady()).toBe(false);
  });
});
