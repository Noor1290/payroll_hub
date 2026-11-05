import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext, type AuthContextValue } from "@/features/auth/auth-context";
import { runSessionCleanup } from "@/lib/sessionCleanup";

/**
 * Waking the database while a password is typed (speed fix F7, Payroll\SPEED_CHECK): one call
 * to keep_awake(), which reads no table; nothing else is asked; at most once every few minutes.
 * FAKE values only.
 */
vi.mock("@/lib/supabase/client", async () => ({
  supabase: (await import("@/test/fakeClient")).fake.client,
}));
const { fake } = await import("@/test/fakeClient");
const { forgetWakeDatabase, wakeDatabase } = await import("./wakeDatabase");
const { LoginPage } = await import("@/features/auth/LoginPage");
const { PasswordGate } = await import("@/features/unlock/PasswordGate");

const user = { id: "user-1", email: "admin@example.com", isDemo: false };
const auth = (status: "signed-in" | "signed-out"): AuthContextValue => ({
  status,
  user: status === "signed-in" ? user : null,
  notice: null,
  signIn: async () => null,
  signInDemo: null,
  signOut: async () => {},
  clearNotice: () => {},
});
const asked = () =>
  fake.state.queries.map((q) => q.map(([method, name]) => `${method} ${String(name)}`));

beforeEach(() => {
  fake.reset(() => ({ data: true, error: null }));
  forgetWakeDatabase();
});
afterEach(() => {
  cleanup();
  runSessionCleanup();
});

describe("wakeDatabase", () => {
  it("asks for keep_awake() only: no table, no company, nothing sent", () => {
    wakeDatabase(1_000_000);
    expect(asked()).toEqual([["rpc keep_awake"]]);
    expect(fake.arg(fake.state.queries[0]!, "rpc", 1)).toBeUndefined();
  });

  it("asks at most once every 5 minutes", () => {
    wakeDatabase(1_000_000);
    wakeDatabase(1_000_000 + 4 * 60_000);
    expect(asked()).toHaveLength(1);
    wakeDatabase(1_000_000 + 5 * 60_000);
    expect(asked()).toHaveLength(2);
  });

  it("changes nothing when the database does not answer", async () => {
    fake.reset(() => {
      throw new Error("offline");
    });
    expect(() => wakeDatabase(1_000_000)).not.toThrow();
    await Promise.resolve();
  });
});

describe("the password screens wake it as they appear", () => {
  it("the sign-in page", () => {
    render(
      <AuthContext.Provider value={auth("signed-out")}>
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>
      </AuthContext.Provider>,
    );
    expect(asked()).toEqual([["rpc keep_awake"]]);
  });

  it("the dashboard's password gate", () => {
    render(
      <AuthContext.Provider value={auth("signed-in")}>
        <PasswordGate what="The data explorer">
          <p>locked content</p>
        </PasswordGate>
      </AuthContext.Provider>,
    );
    expect(asked()).toEqual([["rpc keep_awake"]]);
  });
});
