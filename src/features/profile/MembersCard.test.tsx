import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext, type AuthContextValue } from "@/features/auth/auth-context";
import { useUnlock } from "@/features/unlock/useUnlock";
import { queryClient } from "@/lib/queryClient";
import {
  addMember,
  fetchMemberChanges,
  fetchMembers,
  removeMember,
  setMemberRole,
} from "@/lib/supabase/members";
import type { Membership } from "@/lib/supabase/schemas";
import { MembersCard } from "./MembersCard";
import { changeText, classifyMemberError } from "./membersModel";

/** The Members card on the Company profile (migration 0021). FAKE values only. */

vi.mock("@/lib/supabase/client", () => ({ supabase: null }));
vi.mock("@/lib/supabase/members", async (original) => ({
  ...(await original<typeof import("@/lib/supabase/members")>()),
  addMember: vi.fn(),
  fetchMemberChanges: vi.fn(),
  fetchMembers: vi.fn(),
  removeMember: vi.fn(),
  setMemberRole: vi.fn(),
}));
vi.mock("@/features/unlock/useUnlock", () => ({ useUnlock: vi.fn() }));
vi.mock("@/features/unlock/PasswordGate", () => ({
  UnlockForm: () => <p>The password form</p>,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }));

const ABC = "10000000-0000-4000-8000-000000000001";
const ME = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";

const auth: AuthContextValue = {
  status: "signed-in",
  user: { id: ME, email: "me@example.com", isDemo: false },
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

const show = (role: Membership["role"] = "admin") =>
  render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>
        <MembersCard current={membership(role)} />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );

const unlocked = (open: boolean) =>
  vi.mocked(useUnlock).mockReturnValue({ unlocked: open } as ReturnType<typeof useUnlock>);

beforeEach(() => {
  queryClient.clear();
  vi.clearAllMocks();
  unlocked(true);
  vi.mocked(fetchMembers).mockResolvedValue([
    { user_id: ME, email: "me@example.com", role: "admin", added_at: "2026-01-05T09:00:00.000Z" },
    { user_id: OTHER, email: "v@example.com", role: "viewer", added_at: "2026-02-05T09:00:00.000Z" },
  ]);
  vi.mocked(fetchMemberChanges).mockResolvedValue([
    {
      id: 1,
      action: "added",
      member_email: "v@example.com",
      old_role: null,
      new_role: "viewer",
      changed_by_email: "me@example.com",
      changed_at: "2026-02-05T09:00:00.000Z",
    },
  ]);
  vi.mocked(addMember).mockResolvedValue();
  vi.mocked(removeMember).mockResolvedValue();
  vi.mocked(setMemberRole).mockResolvedValue();
});
afterEach(cleanup);

describe("the Members card", () => {
  it("is not shown to a viewer, and reads nothing for one", () => {
    const { container } = show("viewer");
    expect(container.innerHTML).toBe("");
    expect(fetchMembers).not.toHaveBeenCalled();
    expect(fetchMemberChanges).not.toHaveBeenCalled();
  });

  it("lists the members and every change", async () => {
    show();
    const list = await screen.findByRole("list", { name: "Members of this company" });
    expect(within(list).getByText("v@example.com")).toBeTruthy();
    expect(within(list).getByText("(you)")).toBeTruthy();
    expect(
      within(screen.getByRole("list", { name: "Changes to the members" })).getByText(
        /me@example.com added v@example.com as a viewer\./,
      ),
    ).toBeTruthy();
  });

  it("offers no way to remove or demote yourself", async () => {
    show();
    await screen.findByRole("list", { name: "Members of this company" });
    expect((screen.getByRole("combobox", { name: "Role of me@example.com" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Remove me@example.com" })).toBeNull();
  });

  it("adds an existing user by email, with the role chosen, in the selected company", async () => {
    show();
    fireEvent.change(await screen.findByLabelText("Add an existing user by email"), {
      target: { value: " new@example.com " },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Role of the new member" }), {
      target: { value: "admin" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(addMember).toHaveBeenCalledWith(
        expect.objectContaining({ id: ME }),
        ABC,
        "new@example.com",
        "admin",
      ),
    );
    await waitFor(() => expect((screen.getByLabelText("Add an existing user by email") as HTMLInputElement).value).toBe(""));
  });

  it("says when an email has no account, and keeps what was typed", async () => {
    vi.mocked(addMember).mockRejectedValue(new Error("PH_NO_ACCOUNT"));
    show();
    fireEvent.change(await screen.findByLabelText("Add an existing user by email"), {
      target: { value: "nobody@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("No account uses this email")).toBeTruthy();
    expect((screen.getByLabelText("Add an existing user by email") as HTMLInputElement).value).toBe("nobody@example.com");
  });

  it("refuses something that is not an email before asking the database", async () => {
    show();
    fireEvent.change(await screen.findByLabelText("Add an existing user by email"), {
      target: { value: "not an email" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText(/Enter an email address/)).toBeTruthy();
    expect(addMember).not.toHaveBeenCalled();
  });

  it("changes a role", async () => {
    show();
    fireEvent.change(await screen.findByRole("combobox", { name: "Role of v@example.com" }), {
      target: { value: "admin" },
    });
    await waitFor(() =>
      expect(setMemberRole).toHaveBeenCalledWith(expect.anything(), ABC, OTHER, "admin"),
    );
  });

  it("asks before removing someone", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Remove v@example.com" }));
    const dialog = await screen.findByRole("dialog");
    expect(removeMember).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(removeMember).toHaveBeenCalledWith(expect.anything(), ABC, OTHER));
  });

  it("with the gate locked: shows the members, changes nothing, and asks for the password", async () => {
    unlocked(false);
    show();
    await screen.findByRole("list", { name: "Members of this company" });
    expect(screen.getByText("The password form")).toBeTruthy();
    expect(screen.queryByLabelText("Add an existing user by email")).toBeNull();
    expect((screen.getByRole("combobox", { name: "Role of v@example.com" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Remove v@example.com" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says what to run while migration 0021 has not been run", async () => {
    vi.mocked(fetchMembers).mockRejectedValue({ code: "PGRST202", message: "not found" });
    show();
    expect(
      await screen.findByText("Members aren't set up in the database yet", undefined, { timeout: 10_000 }),
    ).toBeTruthy();
    expect(screen.getByText(/0021_company_members\.sql/)).toBeTruthy();
  }, 15_000);
});

describe("the words", () => {
  it.each([
    ["PH_NO_ACCOUNT", "No account uses this email"],
    ["PH_ALREADY_MEMBER", "This person is already a member"],
    ["PH_LAST_ADMIN", "A company must keep at least one admin"],
    ["PH_NOT_YOURSELF", "You can't remove yourself or make yourself a viewer"],
    ["PH_NOT_ADMIN", "Only an admin of this company can manage its members"],
  ])("%s", (code, title) => {
    expect(classifyMemberError(new Error(code)).title).toBe(title);
  });

  it("each kind of change", () => {
    const base = { id: 1, member_email: "b@x.mu", changed_by_email: "a@x.mu", changed_at: "t" };
    expect(changeText({ ...base, action: "added", old_role: null, new_role: "admin" })).toBe(
      "a@x.mu added b@x.mu as an admin.",
    );
    expect(changeText({ ...base, action: "role-changed", old_role: "viewer", new_role: "admin" })).toBe(
      "a@x.mu changed b@x.mu from a viewer to an admin.",
    );
    expect(changeText({ ...base, action: "removed", old_role: "viewer", new_role: null })).toBe(
      "a@x.mu removed b@x.mu, who was a viewer.",
    );
  });
});
