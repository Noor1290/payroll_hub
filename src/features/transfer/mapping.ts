import type { ExpectedField } from "@/config/apps.config";
import {
  fieldForJsonKey,
  PAYROLL_FIELDS,
  toExportRow,
  type CompanyColumn,
  type PayrollRow,
} from "@/config/payrollFields";

/**
 * The logic behind the transfer wizard, kept free of React so it can be tested on its own:
 * turning a source into a table, matching its columns to what a destination expects, checking
 * the result row by row, and building exactly what will be sent.
 */

export interface SourceColumn {
  key: string;
  label: string;
  type: "string" | "number" | "boolean";
  sensitive: boolean;
  /** A payroll money figure, shown as rupees. */
  money: boolean;
}

export interface SourceRow {
  id: string;
  /** 1-based position in the source, used when reporting a problem with a row. */
  number: number;
  values: Record<string, unknown>;
}

export interface SourceTable {
  columns: SourceColumn[];
  rows: SourceRow[];
}

/** Destination field key -> source column key. A missing or empty entry means "not mapped". */
export type Mapping = Record<string, string>;

function columnFor(key: string, sample: unknown): SourceColumn {
  const field = fieldForJsonKey(key);
  if (field) {
    return {
      key,
      label: field.label,
      type: field.type,
      sensitive: field.sensitive,
      money: field.type === "number",
    };
  }
  // A field this dashboard doesn't know: treat it as sensitive until someone decides otherwise.
  const type =
    typeof sample === "number" ? "number" : typeof sample === "boolean" ? "boolean" : "string";
  return { key, label: key, type, sensitive: true, money: false };
}

/** A saved run as a table, in the payroll app's own export shape (its keys, company on every row). */
export function tableFromRun(
  rows: readonly PayrollRow[],
  company: Record<CompanyColumn, string | null>,
): SourceTable {
  const extraKeys = [...new Set(rows.flatMap((row) => Object.keys(row.extra)))].sort();
  const known = new Set(PAYROLL_FIELDS.map((field) => field.jsonKey));
  const tableRows = rows.map((row, index) => ({
    id: row.id,
    number: index + 1,
    values: toExportRow(row, company),
  }));
  return {
    columns: [
      ...PAYROLL_FIELDS.map((field) => columnFor(field.jsonKey, undefined)),
      ...extraKeys
        .filter((key) => !known.has(key))
        .map((key) => columnFor(key, rows.find((row) => key in row.extra)?.extra[key])),
    ],
    rows: tableRows,
  };
}

/** Rows an app sent to the dashboard, as a table. Strings are trimmed, as everywhere else. */
export function tableFromReceived(rows: readonly Record<string, unknown>[]): SourceTable {
  const columns = new Map<string, SourceColumn>();
  const tableRows = rows.map((raw, index) => {
    const values: Record<string, unknown> = {};
    for (const [rawKey, rawValue] of Object.entries(raw)) {
      const key = rawKey.trim();
      const value = typeof rawValue === "string" ? rawValue.trim() : rawValue;
      values[key] = value;
      const existing = columns.get(key);
      if (!existing) columns.set(key, columnFor(key, value));
    }
    return { id: String(index + 1), number: index + 1, values };
  });
  return { columns: [...columns.values()], rows: tableRows };
}

/** "Net Pay", "net_pay" and "net pay " all compare equal. */
export function normaliseName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Suggests a mapping by name: each destination field takes the first unused source column whose
 * key or label matches its key or label. Anything without a match is left for the user.
 */
export function autoMap(
  columns: readonly SourceColumn[],
  fields: readonly ExpectedField[],
): Mapping {
  const mapping: Mapping = {};
  const used = new Set<string>();
  for (const field of fields) {
    const wanted = new Set([normaliseName(field.key), normaliseName(field.label)]);
    const match = columns.find(
      (column) =>
        !used.has(column.key) &&
        (wanted.has(normaliseName(column.key)) || wanted.has(normaliseName(column.label))),
    );
    if (match) {
      mapping[field.key] = match.key;
      used.add(match.key);
    }
  }
  return mapping;
}

/** The mapping that actually applies: entries pointing at a deselected or unknown column are dropped. */
export function effectiveMapping(
  mapping: Mapping,
  selectedColumns: ReadonlySet<string>,
  fields: readonly ExpectedField[],
): Mapping {
  const result: Mapping = {};
  for (const field of fields) {
    const source = mapping[field.key];
    if (source && selectedColumns.has(source)) result[field.key] = source;
  }
  return result;
}

/** Required destination fields that have no source: the transfer must not go ahead. */
export function missingRequired(
  mapping: Mapping,
  selectedColumns: ReadonlySet<string>,
  fields: readonly ExpectedField[],
): ExpectedField[] {
  const effective = effectiveMapping(mapping, selectedColumns, fields);
  return fields.filter((field) => field.required && !effective[field.key]);
}

export interface RowIssue {
  /** The row's position in the source. */
  row: number;
  /** The destination field's label. */
  field: string;
  message: string;
}

const isEmpty = (value: unknown) => value === null || value === undefined || value === "";

function typeProblem(value: unknown, type: ExpectedField["type"]): string | null {
  switch (type) {
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : "must be a number";
    case "boolean":
      return typeof value === "boolean" ||
        (typeof value === "string" && /^(yes|no)$/i.test(value.trim()))
        ? null
        : 'must be "Yes" or "No"';
    case "date":
      return typeof value === "string" &&
        /^\d{4}-\d{2}(-\d{2})?/.test(value) &&
        !Number.isNaN(Date.parse(value))
        ? null
        : "must be a date";
    case "string":
      return typeof value === "string" || typeof value === "number" ? null : "must be text";
  }
}

/** Checks every selected row against the destination's field types. Values are never changed. */
export function validateRows(
  rows: readonly SourceRow[],
  mapping: Mapping,
  fields: readonly ExpectedField[],
): RowIssue[] {
  const issues: RowIssue[] = [];
  for (const row of rows) {
    for (const field of fields) {
      const source = mapping[field.key];
      if (!source) continue;
      const value = row.values[source];
      if (isEmpty(value)) {
        if (field.required)
          issues.push({ row: row.number, field: field.label, message: "is empty" });
        continue;
      }
      const problem = typeProblem(value, field.type);
      if (problem) issues.push({ row: row.number, field: field.label, message: problem });
    }
  }
  return issues;
}

/**
 * Exactly what the destination will receive: one object per selected row, holding only the
 * mapped destination fields, in the destination's own field order. Nothing else leaves.
 */
export function buildOutput(
  rows: readonly SourceRow[],
  mapping: Mapping,
  fields: readonly ExpectedField[],
): Record<string, unknown>[] {
  const mapped = fields.filter((field) => mapping[field.key]);
  return rows.map((row) =>
    Object.fromEntries(mapped.map((field) => [field.key, row.values[mapping[field.key]!] ?? ""])),
  );
}

/** Sensitive source columns that the mapping sends to the destination. */
export function sensitiveColumnsSent(
  mapping: Mapping,
  columns: readonly SourceColumn[],
): SourceColumn[] {
  const sent = new Set(Object.values(mapping));
  return columns.filter((column) => column.sensitive && sent.has(column.key));
}
