import { formatDateTime, formatMoney } from "@/lib/format";
import { shortId, type DbColumn, type DbRow, type DbTable } from "@/lib/supabase/database";

/** Shown in place of a sensitive value until it is revealed. */
export const MASK = "••••••";

/** How a value is shown in a table cell. Display only: the stored value is never changed. */
export function cellText(column: DbColumn, value: unknown): string {
  if (value === null || value === undefined) return "null";
  switch (column.kind) {
    case "money":
      return typeof value === "number" ? formatMoney(value) : String(value);
    case "id":
      return shortId(String(value));
    case "timestamp":
      return formatDateTime(String(value));
    case "boolean":
      return value ? "true" : "false";
    case "json": {
      const json = JSON.stringify(value);
      return json.length > 48 ? `${json.slice(0, 47)}…` : json;
    }
    default:
      return String(value);
  }
}

/**
 * The row as JSON for the read-only panel: the table's own columns, in order, with sensitive
 * ones replaced by the mask unless `isRevealed` says otherwise. Internal fields are left out.
 */
export function rowJson(
  table: DbTable,
  row: DbRow,
  isRevealed: (column: string) => boolean,
): string {
  const shown: Record<string, unknown> = {};
  for (const column of table.columns) {
    shown[column.key] = column.sensitive && !isRevealed(column.key) ? MASK : row[column.key];
  }
  return JSON.stringify(shown, null, 2);
}

export function hasSensitiveColumns(table: DbTable): boolean {
  return table.columns.some((column) => column.sensitive);
}

/** Identifies one cell, for remembering which ones the user revealed. */
export const cellKey = (rowKey: string, column: string) => `${rowKey}|${column}`;
