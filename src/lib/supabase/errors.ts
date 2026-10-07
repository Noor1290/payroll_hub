import { ZodError } from "zod";

export type DataFailureKind =
  | "unreachable"
  | "session"
  | "forbidden"
  | "unexpected-shape"
  | "not-configured"
  /** A table or function the dashboard needs is not in the database: a migration was not run. */
  | "not-set-up"
  | "unknown";

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
  "not-set-up": {
    kind: "not-set-up",
    title: "This isn't set up in the database yet",
    message:
      "A table this screen needs doesn't exist. The owner needs to run the latest files in supabase/migrations in the Supabase SQL editor.",
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
/**
 * True when the database says a table does not exist: PGRST205 from the Data API ("not in the
 * schema cache"), or Postgres's own 42P01.
 */
export function isMissingTable(error: unknown): boolean {
  const code = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown };
  return code.code === "PGRST205" || code.code === "42P01";
}

/**
 * True when the database says a column does not exist: Postgres's 42703, or PGRST204 from the
 * Data API ("not in the schema cache"). A migration that adds the column was not run.
 */
export function isMissingColumn(error: unknown): boolean {
  const code = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown };
  return code.code === "42703" || code.code === "PGRST204";
}

/** True when the database has no such function: PGRST202 from the Data API, or Postgres's 42883. */
export function isMissingFunction(error: unknown): boolean {
  const code = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown };
  return code.code === "PGRST202" || code.code === "42883";
}

export function classifyDataError(error: unknown): DataFailure {
  if (error instanceof NotConfiguredError) return FAILURES["not-configured"];
  if (error instanceof ZodError) return FAILURES["unexpected-shape"];
  if (typeof error !== "object" || error === null) return FAILURES.unknown;

  const { name, code, status, message } = error as ErrorLike;
  const text = typeof message === "string" ? message.toLowerCase() : "";

  if (isMissingTable(error)) return FAILURES["not-set-up"];

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
