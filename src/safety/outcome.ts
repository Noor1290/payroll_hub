// Safety checks against the live project: how one answer from the database is judged, and how
// the results are printed. Pure functions, no network. The scripts in scripts/ do the requests.
//
// This folder is not part of the dashboard. It lives under src/ so that it is typechecked,
// linted and tested with everything else; nothing in the app imports it.

/** PASS: refused or nothing returned. FAIL: data came back or a write went through.
 * UNCLEAR: refused, but not in a way that proves the protection (look at the script).
 * SKIP: not attempted, with the reason. */
export type Status = "PASS" | "FAIL" | "UNCLEAR" | "SKIP";

export type Who = "anon" | "non-member";

export type Action = "read" | "insert" | "update" | "delete" | "call";

export interface Row {
  who: Who;
  object: string;
  action: Action;
  expected: string;
  result: string;
  status: Status;
  /** For a FAIL: how to find and undo what the attempt may have stored. */
  cleanup?: string;
}

/** The parts of an error the checks look at (PostgREST, Auth and Storage errors all fit). */
export interface ApiError {
  code?: string;
  message?: string;
  status?: number;
}

export interface ApiResult {
  data?: unknown;
  error?: ApiError | null;
  /** Rows matched, when the request asked for a count. */
  count?: number | null;
}

/** Postgres "insufficient privilege": a missing grant, a row-level security refusal, or a
 * function that raised PH_NOT_ADMIN / PH_NOT_SIGNED_IN (they use the same code). */
export const PERMISSION_CODE = "42501";

export interface Verdict {
  status: Status;
  result: string;
  /** A FAIL that certainly stored nothing (a later check refused it): later writes may go on. */
  nothingStored?: boolean;
}

const short = (text: string | undefined, max = 90): string => {
  const one = (text ?? "").replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

export function describeError(error: ApiError): string {
  const parts = [error.code, short(error.message)].filter(Boolean);
  return parts.join(": ") || `status ${error.status ?? "?"}`;
}

const isPermission = (error: ApiError): boolean =>
  error.code === PERMISSION_CODE || /row-level security|permission denied/i.test(error.message ?? "");

/** A read: refused, or nothing came back. */
export function judgeRead(result: ApiResult): Verdict {
  if (result.error) {
    if (isPermission(result.error)) return { status: "PASS", result: `refused (${describeError(result.error)})` };
    return { status: "UNCLEAR", result: `error, not a permission refusal (${describeError(result.error)})` };
  }
  const rows = Array.isArray(result.data) ? result.data.length : result.data == null ? 0 : 1;
  if (rows > 0 || (result.count ?? 0) > 0) {
    return { status: "FAIL", result: `${Math.max(rows, result.count ?? 0)} row(s) returned` };
  }
  return { status: "PASS", result: "nothing returned" };
}

/** An insert, update or delete on a table. Updates and deletes ask for a count of rows changed. */
export function judgeWrite(action: "insert" | "update" | "delete", result: ApiResult): Verdict {
  if (result.error) {
    if (isPermission(result.error)) return { status: "PASS", result: `refused (${describeError(result.error)})` };
    return {
      status: "UNCLEAR",
      result: `refused, but not by a permission check (${describeError(result.error)})`,
    };
  }
  if (action === "insert") return { status: "FAIL", result: "STORED: the row was accepted" };
  if (result.count === 0) return { status: "PASS", result: "0 rows changed" };
  if (result.count == null) return { status: "UNCLEAR", result: "accepted, and the number of rows changed is unknown" };
  return { status: "FAIL", result: `${result.count} row(s) ${action === "update" ? "UPDATED" : "DELETED"}` };
}

/**
 * A database function that writes. `refusals` are the tokens of the expected refusal (the
 * permission check). Every attempt also carries a deliberately invalid value, so that if the
 * permission check ever let it through, a later check refuses it before anything is stored:
 * any other PH_ token therefore means the permission check did NOT stop it.
 */
export function judgeWriteCall(result: ApiResult, refusals: readonly string[]): Verdict {
  const error = result.error;
  if (!error) return { status: "FAIL", result: "ACCEPTED: the function ran to the end" };
  const text = `${error.code ?? ""} ${error.message ?? ""}`;
  if (refusals.some((token) => text.includes(token))) return { status: "PASS", result: `refused (${describeError(error)})` };
  if (/PH_[A-Z_]+/.test(text)) {
    return {
      status: "FAIL",
      result: `the permission check did not stop it; only a later check did, so nothing was stored (${describeError(error)})`,
      nothingStored: true,
    };
  }
  if (error.code === PERMISSION_CODE) return { status: "PASS", result: `refused (${describeError(error)})` };
  return { status: "UNCLEAR", result: `error, not the expected refusal (${describeError(error)})` };
}

/** A database function that reads: refused, or it answers what `ok` accepts (nothing revealing). */
export function judgeReadCall(result: ApiResult, ok: (data: unknown) => boolean): Verdict {
  if (result.error) {
    if (isPermission(result.error) || result.error.code === "PGRST202") {
      return { status: "PASS", result: `refused (${describeError(result.error)})` };
    }
    return { status: "UNCLEAR", result: `error, not a permission refusal (${describeError(result.error)})` };
  }
  const shown = short(JSON.stringify(result.data) ?? "undefined", 60);
  return ok(result.data)
    ? { status: "PASS", result: `answered ${shown}` }
    : { status: "FAIL", result: `answered ${shown}` };
}

/** Storage: a write that came back with any error stored nothing. */
export function judgeStorageWrite(result: ApiResult): Verdict {
  if (result.error) return { status: "PASS", result: `refused (${describeError(result.error)})` };
  return { status: "FAIL", result: "STORED: the file was accepted" };
}

/** Storage remove: answers the files it removed. */
export function judgeStorageRemove(result: ApiResult): Verdict {
  if (result.error) return { status: "PASS", result: `refused (${describeError(result.error)})` };
  const removed = Array.isArray(result.data) ? result.data.length : 0;
  return removed === 0
    ? { status: "PASS", result: "nothing removed" }
    : { status: "FAIL", result: `${removed} file(s) REMOVED` };
}

/** Storage reads: a refusal or "not found" reveals nothing; an empty list neither. */
export function judgeStorageRead(result: ApiResult): Verdict {
  if (result.error) return { status: "PASS", result: `refused (${describeError(result.error)})` };
  const items = Array.isArray(result.data) ? result.data.length : result.data == null ? 0 : 1;
  return items === 0
    ? { status: "PASS", result: "nothing returned" }
    : { status: "FAIL", result: `${items} item(s) returned` };
}

const COLUMNS = ["who", "object", "action", "expected", "result", "status"] as const;

/** A plain-text table, one line per row, columns padded to the widest value. */
export function formatTable(rows: readonly Row[]): string {
  const cells = rows.map((row) => COLUMNS.map((column) => String(row[column])));
  const header = COLUMNS.map((column) => column.toUpperCase());
  const widths = COLUMNS.map((_, index) =>
    Math.max(header[index]!.length, ...cells.map((line) => line[index]!.length)),
  );
  const line = (values: readonly string[]) =>
    values.map((value, index) => value.padEnd(widths[index]!)).join("  ").trimEnd();
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...cells.map(line)].join("\n");
}

export interface Tally {
  PASS: number;
  FAIL: number;
  UNCLEAR: number;
  SKIP: number;
}

export function tally(rows: readonly Row[]): Tally {
  const counts: Tally = { PASS: 0, FAIL: 0, UNCLEAR: 0, SKIP: 0 };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

/** 0 when everything passed (or was skipped on purpose), 1 on any FAIL, 2 on UNCLEAR only. */
export function exitCode(rows: readonly Row[]): number {
  const counts = tally(rows);
  if (counts.FAIL > 0) return 1;
  if (counts.UNCLEAR > 0) return 2;
  return 0;
}
