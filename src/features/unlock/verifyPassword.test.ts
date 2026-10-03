import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isUnlocked, lock } from "@/lib/unlock";
import { attemptUnlock } from "./useUnlock";
import { verifyPassword } from "./verifyPassword";

// A made-up password, used to prove it never ends up anywhere it shouldn't.
const PASSWORD = "correct-horse-battery-staple-9431";
const USER = {
  id: "00000000-0000-4000-8000-0000000000a1",
  email: "admin@example.com",
  isDemo: false,
};

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  signInWithPassword: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));
vi.mock("@/config/env", () => ({
  env: {
    supabase: { url: "https://example-project.supabase.co", anonKey: "fake-public-anon-key" },
    idleTimeoutMinutes: 15,
    problems: [],
  },
  DEMO_MODE: false,
}));

let setItem: ReturnType<typeof vi.spyOn>;
let logs: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  mocks.createClient.mockReset().mockReturnValue({
    auth: { signInWithPassword: mocks.signInWithPassword, signOut: mocks.signOut },
  });
  mocks.signInWithPassword.mockReset().mockResolvedValue({
    data: { user: { id: USER.id }, session: { access_token: "t" } },
    error: null,
  });
  mocks.signOut.mockReset().mockResolvedValue({ error: null });
  setItem = vi.spyOn(Storage.prototype, "setItem");
  logs = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => {}),
  );
});

afterEach(() => {
  lock();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

/** Everything this page could have persisted or printed. */
function everythingStoredOrLogged(): string {
  return JSON.stringify({
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
    writes: setItem.mock.calls,
    logs: logs.flatMap((spy) => spy.mock.calls),
    url: window.location.href,
  });
}

describe("verifyPassword", () => {
  it("checks the password on a separate client that keeps nothing", async () => {
    await expect(verifyPassword(USER, PASSWORD)).resolves.toBeNull();

    expect(mocks.createClient).toHaveBeenCalledTimes(1);
    const options = mocks.createClient.mock.calls[0]![2] as {
      auth: Record<string, unknown> & { storage: Storage; storageKey: string };
    };
    expect(options.auth).toMatchObject({
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    });
    // Its own in-memory storage and its own key: it cannot read or overwrite the main session.
    expect(options.auth.storage).not.toBe(localStorage);
    expect(options.auth.storage).not.toBe(sessionStorage);
    expect(options.auth.storageKey).not.toBe("payroll-hub:auth");

    expect(mocks.signInWithPassword).toHaveBeenCalledWith({
      email: USER.email,
      password: PASSWORD,
    });
  });

  it('signs the throwaway session out with scope "local", never the default that ends every session', async () => {
    await verifyPassword(USER, PASSWORD);
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("uses a fresh client for every check", async () => {
    await verifyPassword(USER, PASSWORD);
    await verifyPassword(USER, PASSWORD);
    const keys = mocks.createClient.mock.calls.map(
      (call) => (call[2] as { auth: { storageKey: string } }).auth.storageKey,
    );
    expect(new Set(keys).size).toBe(2);
  });

  it("explains a wrong password without ending the session", async () => {
    mocks.signInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: { status: 400, code: "invalid_credentials", message: "Invalid login credentials" },
    });
    const failure = await verifyPassword(USER, "wrong");
    expect(failure).toMatchObject({
      kind: "invalid-credentials",
      title: "That password isn't right",
    });
    expect(failure?.message).toMatch(/still signed in/);
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it("explains rate limiting", async () => {
    mocks.signInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: { status: 429, code: "over_request_rate_limit", message: "Too many requests" },
    });
    expect(await verifyPassword(USER, PASSWORD)).toMatchObject({
      kind: "rate-limited",
      title: "Too many attempts",
    });
  });

  it("explains an unreachable or paused database", async () => {
    mocks.signInWithPassword.mockRejectedValue(new TypeError("Failed to fetch"));
    const failure = await verifyPassword(USER, PASSWORD);
    expect(failure?.kind).toBe("unreachable");
    expect(failure?.message).toMatch(/paused/i);
  });

  it("refuses if the password belongs to a different account", async () => {
    mocks.signInWithPassword.mockResolvedValue({
      data: { user: { id: "someone-else" }, session: {} },
      error: null,
    });
    expect(await verifyPassword(USER, PASSWORD)).not.toBeNull();
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("still counts as verified if signing the throwaway session out fails", async () => {
    mocks.signOut.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(verifyPassword(USER, PASSWORD)).resolves.toBeNull();
  });

  it("rejects an empty password without asking the server", async () => {
    expect(await verifyPassword(USER, "")).not.toBeNull();
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("does not accept the demo word outside demo mode", async () => {
    mocks.signInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: { status: 400, code: "invalid_credentials", message: "Invalid login credentials" },
    });
    expect(await verifyPassword(USER, "demo")).not.toBeNull();
    expect(mocks.signInWithPassword).toHaveBeenCalled();
  });
});

describe("attemptUnlock", () => {
  it("opens the gate when the password is right", async () => {
    expect(await attemptUnlock(USER, PASSWORD)).toBeNull();
    expect(isUnlocked()).toBe(true);
  });

  it("stays locked when the password is wrong", async () => {
    mocks.signInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: { status: 400, code: "invalid_credentials", message: "Invalid login credentials" },
    });
    expect(await attemptUnlock(USER, "wrong")).not.toBeNull();
    expect(isUnlocked()).toBe(false);
  });

  it("stays locked when the check cannot be completed", async () => {
    mocks.signInWithPassword.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await attemptUnlock(USER, PASSWORD)).not.toBeNull();
    expect(isUnlocked()).toBe(false);

    expect(await attemptUnlock(null, PASSWORD)).not.toBeNull();
    expect(isUnlocked()).toBe(false);
  });
});

describe("the password never ends up in storage or logs", () => {
  it("after a successful unlock", async () => {
    await attemptUnlock(USER, PASSWORD);
    expect(isUnlocked()).toBe(true);
    expect(everythingStoredOrLogged()).not.toContain(PASSWORD);
    expect(setItem).not.toHaveBeenCalled();
  });

  it("after a wrong password, a rate limit and a network failure", async () => {
    mocks.signInWithPassword
      .mockResolvedValueOnce({
        data: { user: null, session: null },
        error: { status: 400, code: "invalid_credentials", message: "Invalid login credentials" },
      })
      .mockResolvedValueOnce({ data: { user: null, session: null }, error: { status: 429 } })
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));

    for (let i = 0; i < 3; i++) await attemptUnlock(USER, PASSWORD);

    expect(isUnlocked()).toBe(false);
    expect(everythingStoredOrLogged()).not.toContain(PASSWORD);
    expect(setItem).not.toHaveBeenCalled();
  });
});
