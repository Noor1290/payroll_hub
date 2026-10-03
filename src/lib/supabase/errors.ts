import { ZodError } from "zod";

export type DataFailureKind =
  "unreachable" | "session" | "forbidden" | "unexpected-shape" | "not-configured" | "unknown";

export interface DataFailure {
  kind: DataFailureKind;
  title: string;
  message: string;
  /** Whether trying the same request again could plausibly work. */
  retryable: boolean;
}

const FAILURES: Record<DataFailureKind, DataFailure> = {
  unreachable: {
    kind: "unreachable",
    title: "Can't reach the database",
    message:
      "The Supabase project may be paused after a period of inactivity, or you may be offline. " +
      "If your connection is fine, the project owner needs to resume it from the Supabase dashboard.",
    retryable: true,
  },
  session: {
    kind: "session",
    title: "Your session has ended",
    message: "Sign out and sign in again to continue.",
    retryable: false,
  },
  forbidden: {
    kind: "forbidden",
    title: "You don't have access to this",
    message:
      "Your account isn't allowed to read or change this data. Ask the owner to check your role.",
    retryable: false,
  },
  "unexpected-shape": {
    kind: "unexpected-shape",
    title: "The database returned something unexpected",
    message:
      "The data didn't match what this version of the dashboard expects, so nothing was shown rather than risk showing wrong figures. The database schema may have changed.",
    retryable: false,
  },
  "not-configured": {
    kind: "not-configured",
    title: "The dashboard isn't connected to a database",
    message: "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set (see .env.example).",
    retryable: false,
  },
  unknown: {
    kind: "unknown",
    title: "Something went wrong loading this",
    message: "Try again in a moment.",
    retryable: true,
  },
};

export function dataFailure(kind: DataFailureKind): DataFailure {
  return FAILURES[kind];
}

/** Thrown by query functions when there is no Supabase client to talk to. */
export class NotConfiguredError extends Error {
  constructor() {
    super("Supabase is not configured.");
    this.name = "NotConfiguredError";
  }
}

interface ErrorLike {
  name?: unknown;
  code?: unknown;
  status?: unknown;
  message?: unknown;
}

/**
 * Turns a failed read/write into something a person can act on.
 * "unreachable" is a heuristic: a paused project and a dropped connection look alike from the browser.
 */
export function classifyDataError(error: unknown): DataFailure {
  if (error instanceof NotConfiguredError) return FAILURES["not-configured"];
  if (error instanceof ZodError) return FAILURES["unexpected-shape"];
  if (typeof error !== "object" || error === null) return FAILURES.unknown;

  const { name, code, status, message } = error as ErrorLike;
  const text = typeof message === "string" ? message.toLowerCase() : "";

  // PGRST301/PGRST303: JWT expired or invalid.
  if (code === "PGRST301" || code === "PGRST303" || status === 401 || text.includes("jwt")) {
    return FAILURES.session;
  }
  // 42501: insufficient privilege (grant or RLS). PGRST116-style "no rows" is not an error here.
  if (code === "42501" || status === 403) return FAILURES.forbidden;

  const network =
    name === "TypeError" ||
    text.includes("failed to fetch") ||
    text.includes("networkerror") ||
    text.includes("load failed");
  const server = typeof status === "number" && status >= 500;
  if (network || server) return FAILURES.unreachable;

  return FAILURES.unknown;
}
