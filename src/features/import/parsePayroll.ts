import { z } from "zod";
import {
  fieldForJsonKey,
  PAYROLL_FIELDS,
  type CompanyColumn,
  type NumericColumn,
  type PayrollRow,
} from "@/config/payrollFields";

/** A problem with one row of a file. `row` is 1-based, matching what the user sees in the file. */
export interface RowError {
  row: number;
  field: string;
  message: string;
}

export type FileCompany = Record<CompanyColumn, string | null>;

export interface ParsedFile {
  /** Rows that passed validation. Only complete when `errors` is empty and `fatal` is null. */
  rows: PayrollRow[];
  errors: RowError[];
  /** A problem with the file as a whole; nothing can be imported from it. */
  fatal: string | null;
  /** Company details taken from the file (same on every row), or null if unusable. */
  company: FileCompany | null;
  /** Total objects found in the file, valid or not. */
  rowCount: number;
}

/** Largest absolute value a numeric(12,2) column can hold. */
const MAX_MONEY = 9_999_999_999.99;
/** Differences smaller than this from a 2-decimal value are floating-point noise, not data. */
const NOISE = 0.0001;

function trimDeep(value: unknown): unknown {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(trimDeep);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k.trim(), trimDeep(v)]));
  }
  return value;
}

/**
 * Checks a money value without changing it, apart from removing floating-point noise
 * (18169.120000000003 -> 18169.12). Anything with real precision beyond 2 decimals is refused,
 * because the database would otherwise round it silently.
 */
export function checkMoney(
  value: unknown,
): { ok: true; value: number } | { ok: false; why: string } {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, why: "must be a number" };
  }
  const rounded = Math.round(value * 100) / 100;
  if (Math.abs(value - rounded) >= NOISE) {
    return { ok: false, why: "has more than 2 decimal places" };
  }
  if (Math.abs(rounded) > MAX_MONEY) return { ok: false, why: "is too large to store" };
  // Avoid storing -0.
  return { ok: true, value: rounded === 0 ? 0 : rounded };
}

function checkYesNo(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const text = value.toLowerCase();
  if (text === "yes") return true;
  if (text === "no") return false;
  return null;
}

const isBlank = (value: unknown) => value === null || value === undefined || value === "";

const moneySchema = z.unknown().transform((value, ctx): number => {
  if (isBlank(value)) {
    ctx.addIssue({ code: "custom", message: "is missing" });
    return z.NEVER;
  }
  const checked = checkMoney(value);
  if (!checked.ok) {
    ctx.addIssue({ code: "custom", message: checked.why });
    return z.NEVER;
  }
  return checked.value;
});

const yesNoSchema = z.unknown().transform((value, ctx): boolean => {
  const parsed = isBlank(value) ? null : checkYesNo(value);
  if (parsed === null) {
    ctx.addIssue({
      code: "custom",
      message: isBlank(value) ? "is missing" : 'must be "Yes" or "No"',
    });
    return z.NEVER;
  }
  return parsed;
});

/** Text. Numbers are accepted (an all-digit ID, a numeric VAT) and kept as text. */
const textSchema = (required: boolean) =>
  z.unknown().transform((value, ctx): string | null => {
    if (isBlank(value)) {
      if (!required) return null;
      ctx.addIssue({ code: "custom", message: "is missing" });
      return z.NEVER;
    }
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    ctx.addIssue({ code: "custom", message: "must be text" });
    return z.NEVER;
  });

/** One row of the export, keyed by the payroll app's own field names. Built from PAYROLL_FIELDS. */
const rowSchema = z.object(
  Object.fromEntries(
    PAYROLL_FIELDS.map((field) => [
      field.jsonKey,
      field.type === "number"
        ? moneySchema
        : field.type === "boolean"
          ? yesNoSchema
          : textSchema(field.required),
    ]),
  ),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Turns the text of a payroll export into validated rows.
 * Never throws and never drops a row silently: every problem is reported with its row and field.
 * Strings are trimmed; numbers are stored exactly as exported (see checkMoney).
 */
export function parsePayrollFile(text: string): ParsedFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return failed("This file isn't valid JSON. Export it again from the payroll app.");
  }
  return parsePayrollRows(data);
}

const failed = (fatal: string, rowCount = 0): ParsedFile => ({
  rows: [],
  errors: [],
  fatal,
  company: null,
  rowCount,
});

/** Same checks as parsePayrollFile, for data that is already parsed (e.g. received from the payroll app). */
export function parsePayrollRows(data: unknown): ParsedFile {
  if (!Array.isArray(data)) {
    return failed(
      "Expected a list of employees (a JSON array), but the file contains something else.",
    );
  }
  if (data.length === 0) return failed("The file contains no employees.");

  const rows: PayrollRow[] = [];
  const errors: RowError[] = [];
  const companies: FileCompany[] = [];
  const firstRowById = new Map<string, number>();

  data.forEach((raw, index) => {
    const rowNumber = index + 1;
    const fail = (field: string, message: string) =>
      errors.push({ row: rowNumber, field, message });

    if (!isRecord(raw)) {
      fail("(row)", "is not an object");
      return;
    }
    const before = errors.length;
    const source = trimDeep(raw) as Record<string, unknown>;

    const known: Record<string, unknown> = {};
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
      const field = fieldForJsonKey(key);
      if (field) known[field.jsonKey] = value;
      else extra[key] = value;
    }

    // Absent keys are checked like empty ones, so a missing field is always reported.
    for (const field of PAYROLL_FIELDS) known[field.jsonKey] ??= null;

    const result = rowSchema.safeParse(known);
    if (!result.success) {
      for (const issue of result.error.issues)
        fail(String(issue.path[0] ?? "(row)"), issue.message);
    }
    const parsed: Record<string, unknown> = result.success ? result.data : {};

    const company: FileCompany = { name: null, address: null, brn: null, vat: null };
    const employee: Record<string, string | null> = {};
    const numbers: Partial<Record<NumericColumn, number>> = {};
    let age60Plus = false;

    for (const field of PAYROLL_FIELDS) {
      const value = parsed[field.jsonKey];
      if (value === undefined) continue;
      if (field.type === "number") numbers[field.column as NumericColumn] = value as number;
      else if (field.type === "boolean") age60Plus = value as boolean;
      else if (field.target === "company")
        company[field.column as CompanyColumn] = value as string | null;
      else employee[field.column] = value as string | null;
    }

    // Company details are needed even when the row has other problems (to detect mixed BRNs).
    if (!result.success) {
      for (const field of PAYROLL_FIELDS) {
        if (field.target !== "company") continue;
        const loose = textSchema(false).safeParse(known[field.jsonKey]);
        if (loose.success) company[field.column as CompanyColumn] = loose.data;
      }
    }

    companies.push(company);

    const nationalId = employee.national_id;
    if (nationalId) {
      const first = firstRowById.get(nationalId);
      // The ID itself is sensitive, so point at the other row instead of printing it.
      if (first !== undefined) fail("ID", `is the same as row ${first}`);
      else firstRowById.set(nationalId, rowNumber);
    }

    if (errors.length > before) return;

    rows.push({
      id: String(rowNumber),
      national_id: nationalId!,
      surname: employee.surname!,
      other_names: employee.other_names ?? null,
      employment_type: employee.employment_type ?? null,
      age_60_plus: age60Plus,
      extra,
      ...(numbers as Record<NumericColumn, number>),
    });
  });

  const brns = [...new Set(companies.map((c) => c.brn).filter((brn): brn is string => !!brn))];
  if (brns.length > 1) {
    return failed(
      `This file mixes more than one company (BRNs: ${brns.join(", ")}). Each file must contain one company only.`,
      data.length,
    );
  }

  const company = companies.find((c) => c.brn) ?? null;
  return { rows, errors, fatal: null, company, rowCount: data.length };
}

/**
 * "ABC Co Ltd-pdf-fill-2026-09.json" -> "2026-09-01".
 * Uses the last YYYY-MM in the name; null when there is none or the month is impossible.
 */
export function periodFromFileName(fileName: string): string | null {
  const matches = [...fileName.matchAll(/(?<!\d)(\d{4})-(\d{2})(?!\d)/g)];
  const last = matches.at(-1);
  if (!last) return null;
  const month = Number(last[2]);
  if (month < 1 || month > 12) return null;
  return `${last[1]}-${last[2]}-01`;
}

/** "2026-09" (what <input type="month"> gives) -> "2026-09-01"; null if not a real month. */
export function periodFromMonthInput(value: string): string | null {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return null;
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? `${value}-01` : null;
}
