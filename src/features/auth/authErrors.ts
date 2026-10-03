export type AuthFailureKind =
  "invalid-credentials" | "unreachable" | "rate-limited" | "not-configured" | "unknown";

export interface AuthFailure {
  kind: AuthFailureKind;
  title: string;
  message: string;
}

const FAILURES: Record<AuthFailureKind, AuthFailure> = {
  "invalid-credentials": {
    kind: "invalid-credentials",
    title: "Email or password is incorrect",
    message: "Check both and try again. Accounts are created by invitation only.",
  },
  unreachable: {
    kind: "unreachable",
    title: "Can't reach the database",
    message:
      "The Supabase project may be paused after a period of inactivity, or you may be offline. " +
      "Check your connection; if it persists, the project owner needs to resume it from the Supabase dashboard.",
  },
  "rate-limited": {
    kind: "rate-limited",
    title: "Too many attempts",
    message: "Wait a minute before trying again.",
  },
  "not-configured": {
    kind: "not-configured",
    title: "The dashboard isn't connected to a database",
    message:
      "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set (see .env.example), then restart or redeploy.",
  },
  unknown: {
    kind: "unknown",
    title: "Sign-in failed",
    message: "Something unexpected went wrong. Try again in a moment.",
  },
};

export function authFailure(kind: AuthFailureKind): AuthFailure {
  return FAILURES[kind];
}

interface ErrorLike {
  name?: unknown;
  status?: unknown;
  code?: unknown;
  message?: unknown;
}

/**
 * Turns whatever Supabase Auth (or fetch) threw into a message a person can act on.
 * A paused or deleted project looks like a network failure or a gateway error from the
 * browser, so "unreachable" is a best-effort guess, not a certainty.
 */
export function classifyAuthError(error: unknown): AuthFailure {
  if (typeof error !== "object" || error === null) return FAILURES.unknown;

  const { name, status, code, message } = error as ErrorLike;
  const text = typeof message === "string" ? message.toLowerCase() : "";

  if (
    code === "invalid_credentials" ||
    code === "user_not_found" ||
    text.includes("invalid login credentials")
  ) {
    return FAILURES["invalid-credentials"];
  }

  if (status === 429 || code === "over_request_rate_limit") return FAILURES["rate-limited"];

  const networkFailure =
    name === "AuthRetryableFetchError" ||
    name === "TypeError" ||
    status === 0 ||
    text.includes("failed to fetch") ||
    text.includes("networkerror") ||
    text.includes("load failed");
  const serverFailure = typeof status === "number" && status >= 500;
  if (networkFailure || serverFailure) return FAILURES.unreachable;

  if (status === 400 || status === 401) return FAILURES["invalid-credentials"];

  return FAILURES.unknown;
}
