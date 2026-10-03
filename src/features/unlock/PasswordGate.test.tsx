import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext, type AuthContextValue } from "@/features/auth/auth-context";
import { runSessionCleanup } from "@/lib/sessionCleanup";
import { grantUnlock, lock } from "@/lib/unlock";
import { PasswordGate, UnlockStatus } from "./PasswordGate";
import { verifyPassword } from "./verifyPassword";

vi.mock("./verifyPassword", () => ({ verifyPassword: vi.fn() }));
const verify = vi.mocked(verifyPassword);

const PASSWORD = "correct-horse-battery-staple-9431";
const SECRET = "X0000000000001 earns Rs 18,169.12";

const auth: AuthContextValue = {
  status: "signed-in",
  user: { id: "user-1", email: "admin@example.com", isDemo: false },
  notice: null,
  signIn: async () => null,
  signInDemo: null,
  signOut: async () => {},
  clearNotice: () => {},
};

function renderGate() {
  return render(
    <AuthContext.Provider value={auth}>
      <UnlockStatus />
      <PasswordGate what="The data explorer">
        <p>{SECRET}</p>
      </PasswordGate>
    </AuthContext.Provider>,
  );
}

const field = () => screen.getByLabelText("Password") as HTMLInputElement;
const submit = (value: string) => {
  fireEvent.change(field(), { target: { value } });
  fireEvent.submit(field().closest("form")!);
};

beforeEach(() => verify.mockReset());

afterEach(() => {
  cleanup();
  lock();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("<PasswordGate>", () => {
  it("asks for the password and shows nothing behind it while locked", () => {
    renderGate();
    expect(screen.getByText("Confirm your password to continue")).toBeTruthy();
    expect(screen.getByText(/stays open for 10 minutes/)).toBeTruthy();
    expect(screen.queryByText(SECRET)).toBeNull();
  });

  it("opens with the right password, checked against the signed-in user", async () => {
    verify.mockResolvedValue(null);
    renderGate();
    submit(PASSWORD);

    expect(await screen.findByText(SECRET)).toBeTruthy();
    expect(verify).toHaveBeenCalledWith(auth.user, PASSWORD);
    expect(screen.getByText(/Unlocked until/)).toBeTruthy();
  });

  it("stays locked on a wrong password and says why", async () => {
    verify.mockResolvedValue({
      kind: "invalid-credentials",
      title: "That password isn't right",
      message: "Try again.",
    });
    renderGate();
    submit("wrong");

    expect((await screen.findByRole("alert")).textContent).toContain("That password isn't right");
    expect(screen.queryByText(SECRET)).toBeNull();
  });

  it("shows the rate-limit and unreachable messages", async () => {
    verify.mockResolvedValueOnce({
      kind: "rate-limited",
      title: "Too many attempts",
      message: "Wait a minute before trying again.",
    });
    renderGate();
    submit(PASSWORD);
    expect((await screen.findByRole("alert")).textContent).toContain("Too many attempts");

    verify.mockResolvedValueOnce({
      kind: "unreachable",
      title: "Can't reach the database",
      message: "The Supabase project may be paused.",
    });
    submit(PASSWORD);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Can't reach the database"),
    );
    expect(screen.queryByText(SECRET)).toBeNull();
  });

  it("clears the password from the field the moment it is submitted", async () => {
    let finish!: (value: null) => void;
    verify.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { container } = renderGate();
    submit(PASSWORD);

    // The check is still running, and the page no longer holds the password anywhere.
    expect(field().value).toBe("");
    expect(container.innerHTML).not.toContain(PASSWORD);

    await act(async () => finish(null));
  });

  it("never writes the password to browser storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    verify
      .mockResolvedValueOnce({ kind: "invalid-credentials", title: "No", message: "No" })
      .mockResolvedValueOnce(null);
    renderGate();
    submit(PASSWORD);
    await screen.findByRole("alert");
    submit(PASSWORD);
    await screen.findByText(SECRET);

    const stored = JSON.stringify([
      Object.entries(localStorage),
      Object.entries(sessionStorage),
      setItem.mock.calls,
    ]);
    expect(stored).not.toContain(PASSWORD);
  });

  it("hides the content again when the time is up, and says why", () => {
    vi.useFakeTimers();
    renderGate();
    act(() => grantUnlock(10));
    expect(screen.getByText(SECRET)).toBeTruthy();

    act(() => void vi.advanceTimersByTime(10 * 60_000));

    expect(screen.queryByText(SECRET)).toBeNull();
    expect(screen.getByText("Confirm your password to continue")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/time was up/);
  });

  it("hides the content on sign-out", () => {
    renderGate();
    act(() => grantUnlock(10));
    expect(screen.getByText(SECRET)).toBeTruthy();

    act(() => runSessionCleanup());
    expect(screen.queryByText(SECRET)).toBeNull();
  });

  it("can be locked by hand with Lock now", () => {
    renderGate();
    act(() => grantUnlock(10));
    fireEvent.click(screen.getByRole("button", { name: /Lock now/ }));
    expect(screen.queryByText(SECRET)).toBeNull();
    expect(screen.queryByText(/Unlocked until/)).toBeNull();
  });
});
