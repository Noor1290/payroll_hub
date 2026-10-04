import { z } from "zod";
import { NUMERIC_COLUMNS } from "@/config/payrollFields";
import { demoFetchTableCounts, demoFetchTablePage } from "@/lib/demo/demoData";
import { supabase } from "./client";
import { isMissingTable, NotConfiguredError } from "./errors";
import type { Viewer } from "./queries";
import { moneySchema } from "./schemas";

/**
 * Read-only access to the raw tables, for the admin "Database" page.
 *
 * Every read is scoped to one company, asks for one page at a time (so it works past the
 * API's 1,000-row limit without loading a whole table), and is validated before it is shown.
 * There is deliberately nothing here that writes, and nothing that takes free-form SQL.
 * Row-level security on the server still decides what the signed-in user may see.
 */

export const DB_TABLE_NAMES = [
  "companies",
  "employees",
  "payroll_runs",
  "payroll_entries",
  "company_members",
  "company_details",
  "company_links",
] as const;
export type DbTableName = (typeof DB_TABLE_NAMES)[number];

export type DbColumnKind =
  /** Plain text. */
  | "text"
  /** A row id (uuid). Shown shortened; the full value is in the JSON view. */
  | "id"
  /** A user's id. Only ever kept and shown in shortened form. */
  | "user"
  | "money"
  /** A whole number that is not money (a position in a list). */
  | "number"
  | "date"
  | "timestamp"
  | "boolean"
  | "json";

export interface DbColumn {
  key: string;
  kind: DbColumnKind;
  nullable?: boolean;
  /** Masked until revealed. */
  sensitive?: boolean;
}

export interface DbTable {
  name: DbTableName;
  columns: readonly DbColumn[];
  /** Columns the search box looks in (text columns of this table). */
  searchColumns: readonly string[];
  /** Whether rows can be soft-deleted (directly, or through their run). */
  canBeDeleted: boolean;
  defaultSort: { column: string; ascending: boolean };
  /** Columns that identify a row, used as a tiebreaker so pages never overlap. */
  keyColumns: readonly string[];
}

const id = (key: string, nullable = false): DbColumn => ({ key, kind: "id", nullable });
const text = (key: string, more: Partial<DbColumn> = {}): DbColumn => ({
  key,
  kind: "text",
  nullable: true,
  ...more,
});
const stamp = (key: string, nullable = false): DbColumn => ({ key, kind: "timestamp", nullable });

export const DB_TABLES: Record<DbTableName, DbTable> = {
  companies: {
    name: "companies",
    columns: [
      id("id"),
      text("name", { nullable: false }),
      text("address"),
      text("brn"),
      text("vat"),
      stamp("created_at"),
    ],
    searchColumns: ["name", "address", "brn", "vat"],
    canBeDeleted: false,
    defaultSort: { column: "name", ascending: true },
    keyColumns: ["id"],
  },
  employees: {
    name: "employees",
    columns: [
      id("id"),
      id("company_id"),
      text("national_id", { nullable: false, sensitive: true }),
      text("surname", { nullable: false }),
      text("other_names"),
      text("employment_type"),
      stamp("deleted_at", true),
      stamp("created_at"),
    ],
    searchColumns: ["surname", "other_names", "national_id", "employment_type"],
    canBeDeleted: true,
    defaultSort: { column: "surname", ascending: true },
    keyColumns: ["id"],
  },
  payroll_runs: {
    name: "payroll_runs",
    columns: [
      id("id"),
      id("company_id"),
      { key: "period", kind: "date" },
      text("status", { nullable: false }),
      { key: "created_by", kind: "user", nullable: true },
      stamp("created_at"),
      stamp("deleted_at", true),
    ],
    searchColumns: ["status"],
    canBeDeleted: true,
    defaultSort: { column: "period", ascending: false },
    keyColumns: ["id"],
  },
  payroll_entries: {
    name: "payroll_entries",
    columns: [
      id("id"),
      id("run_id"),
      id("employee_id"),
      ...NUMERIC_COLUMNS.slice(0, NUMERIC_COLUMNS.indexOf("gross_pay") + 1).map(
        (key): DbColumn => ({ key, kind: "money", sensitive: true }),
      ),
      { key: "age_60_plus", kind: "boolean" },
      ...NUMERIC_COLUMNS.slice(NUMERIC_COLUMNS.indexOf("gross_pay") + 1).map((key): DbColumn => ({
        key,
        kind: "money",
        sensitive: true,
      })),
      // Fields this dashboard has no column for. Unknown, so treated as sensitive.
      { key: "extra", kind: "json", sensitive: true },
      stamp("created_at"),
    ],
    // Entries hold no text of their own, so the search looks at the employee they belong to.
    searchColumns: [],
    canBeDeleted: true,
    defaultSort: { column: "created_at", ascending: false },
    keyColumns: ["id"],
  },
  company_members: {
    name: "company_members",
    columns: [
      id("company_id"),
      { key: "user_id", kind: "user" },
      text("role", { nullable: false }),
      stamp("created_at"),
    ],
    searchColumns: ["role"],
    canBeDeleted: false,
    defaultSort: { column: "created_at", ascending: true },
    keyColumns: ["company_id", "user_id"],
  },
  company_details: {
    name: "company_details",
    columns: [
      id("id"),
      id("company_id"),
      text("label", { nullable: false }),
      // Masked for every row, whether or not the detail is marked sensitive.
      text("value", { sensitive: true }),
      text("field_type", { nullable: false }),
      { key: "is_sensitive", kind: "boolean" },
      { key: "sort_order", kind: "number" },
      stamp("created_at"),
      stamp("updated_at"),
    ],
    // Never the value: a search must not be a way to test what a masked value contains.
    searchColumns: ["label", "field_type"],
    canBeDeleted: false,
    defaultSort: { column: "sort_order", ascending: true },
    keyColumns: ["id"],
  },
  company_links: {
    name: "company_links",
    columns: [
      id("id"),
      id("company_id"),
      text("title", { nullable: false }),
      text("url", { nullable: false }),
      text("description"),
      text("category"),
      text("icon"),
      text("accent"),
      { key: "is_pinned", kind: "boolean" },
      { key: "sort_order", kind: "number" },
      stamp("created_at"),
      stamp("updated_at"),
    ],
    searchColumns: ["title", "url", "description", "category"],
    canBeDeleted: false,
    defaultSort: { column: "sort_order", ascending: true },
    keyColumns: ["id"],
  },
};

/** Tables added by a later migration (0005, 0006). The page still works before they exist. */
export const OPTIONAL_TABLES: Partial<Record<DbTableName, string>> = {
  company_details: "0005_company_details.sql",
  company_links: "0006_company_links.sql",
};

/** A row as the page holds it: validated values plus two derived fields. */
export type DbRow = Record<string, unknown> & {
  /** Stable identity of the row within its table. */
  __key: string;
  /** Soft-deleted (or, for an entry, belonging to a soft-deleted run). */
  __deleted: boolean;
};

export interface TableQuery {
  /** 0-based. */
  page: number;
  pageSize: number;
  sort: { column: string; ascending: boolean };
  search: string;
  showDeleted: boolean;
}

export interface TablePage {
  rows: DbRow[];
  /** Rows matching the query across all pages. */
  total: number;
}

/** Rows per table. Null means the table is not in the database yet (its migration was not run). */
export type TableCounts = Record<DbTableName, number | null>;

export const PAGE_SIZES = [25, 50, 100] as const;

/** "a1b2c3d4-…" -> "a1b2c3d4…". Users are identified by this short form only; nothing reads auth.users. */
export function shortId(value: string): string {
  return value.length > 8 ? `${value.slice(0, 8)}…` : value;
}

/** A short, stable, one-way fingerprint of a string (FNV-1a). Used for row keys, not security. */
function digest(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const kindSchema: Record<DbColumnKind, z.ZodType> = {
  text: z.string(),
  id: z.uuid(),
  // Shortened as it is read, so a full user id is never held by the page.
  user: z.uuid().transform(shortId),
  money: moneySchema,
  number: z.number().int(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timestamp: z.string().min(1),
  boolean: z.boolean(),
  json: z.record(z.string(), z.unknown()),
};

function rowSchema(table: DbTable) {
  return z.object(
    Object.fromEntries(
      table.columns.map((column) => [
        column.key,
        column.nullable ? kindSchema[column.kind].nullable() : kindSchema[column.kind],
      ]),
    ),
  );
}

const ROW_SCHEMAS = Object.fromEntries(
  DB_TABLE_NAMES.map((name) => [name, rowSchema(DB_TABLES[name])]),
) as Record<DbTableName, ReturnType<typeof rowSchema>>;

/** What a payroll entry is joined to, only to scope and search it. Never shown as columns. */
const entryJoinSchema = z.object({
  payroll_runs: z.object({ company_id: z.uuid(), deleted_at: z.string().nullable() }),
});

/** Validates one row from the API and adds its key and deleted flag. Throws on any mismatch. */
export function parseRow(table: DbTable, raw: unknown): DbRow {
  const values = ROW_SCHEMAS[table.name].parse(raw) as Record<string, unknown>;
  const deleted =
    table.name === "payroll_entries"
      ? entryJoinSchema.parse(raw).payroll_runs.deleted_at !== null
      : "deleted_at" in values && values.deleted_at !== null;
  // Built from the values as received: a shortened user id is not unique enough to be a key.
  // A user id goes in as a digest, so the full id still isn't kept.
  const source = raw as Record<string, unknown>;
  const keyOf = (key: string) =>
    table.columns.find((column) => column.key === key)?.kind === "user"
      ? digest(String(source[key]))
      : String(values[key]);
  return {
    ...values,
    __key: table.keyColumns.map(keyOf).join(":"),
    __deleted: deleted,
  };
}

function client() {
  if (!supabase) throw new NotConfiguredError();
  return supabase;
}

/**
 * Makes user-typed text safe inside a PostgREST `or=(…)` filter: LIKE wildcards are escaped so
 * they match literally, and the whole pattern is double-quoted so commas, dots and brackets
 * cannot be read as filter syntax.
 */
export function likeFilter(columns: readonly string[], search: string): string {
  const literal = search.trim().replace(/[\\%_]/g, (character) => `\\${character}`);
  const quoted = `"*${literal.replace(/[\\"]/g, (character) => `\\${character}`)}*"`;
  return columns.map((column) => `${column}.ilike.${quoted}`).join(",");
}

const ENTRY_EMPLOYEE_SEARCH = ["surname", "other_names", "national_id"] as const;

function selectFor(table: DbTable): string {
  const columns = table.columns.map((column) => column.key).join(", ");
  return table.name === "payroll_entries"
    ? // Inner joins: the run scopes the entry to a company; the employee is only for searching.
      `${columns}, payroll_runs!inner(company_id, deleted_at), employees!inner(surname, other_names, national_id)`
    : columns;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the query builder's type depends on the table; these helpers are table-agnostic
type Builder = any;

/** Limits a query to one company (and, unless asked, to rows that are not soft-deleted). */
function scope(query: Builder, table: DbTable, companyId: string, showDeleted: boolean): Builder {
  switch (table.name) {
    case "companies":
      return query.eq("id", companyId);
    case "company_members":
    case "company_details":
    case "company_links":
      return query.eq("company_id", companyId);
    case "employees":
    case "payroll_runs": {
      const scoped = query.eq("company_id", companyId);
      return showDeleted ? scoped : scoped.is("deleted_at", null);
    }
    case "payroll_entries": {
      const scoped = query.eq("payroll_runs.company_id", companyId);
      return showDeleted ? scoped : scoped.is("payroll_runs.deleted_at", null);
    }
  }
}

function applySearch(query: Builder, table: DbTable, search: string): Builder {
  const term = search.trim();
  if (!term) return query;

  if (table.name === "payroll_entries") {
    return query.or(likeFilter(ENTRY_EMPLOYEE_SEARCH, term), { referencedTable: "employees" });
  }
  // A month like "2026-09" finds that period's run (the period column is a date, not text).
  if (table.name === "payroll_runs" && /^\d{4}-(0[1-9]|1[0-2])$/.test(term)) {
    return query.eq("period", `${term}-01`);
  }
  return table.searchColumns.length > 0 ? query.or(likeFilter(table.searchColumns, term)) : query;
}

/** The sort to use: the requested column if this table has it, otherwise the table's default. */
export function safeSort(table: DbTable, sort: TableQuery["sort"]): TableQuery["sort"] {
  return table.columns.some((column) => column.key === sort.column && column.kind !== "json")
    ? sort
    : table.defaultSort;
}

/** Reads one page of one table for one company. */
export async function fetchTablePage(
  viewer: Viewer,
  tableName: DbTableName,
  companyId: string,
  query: TableQuery,
): Promise<TablePage> {
  const table = DB_TABLES[tableName];
  const sort = safeSort(table, query.sort);
  const pageSize = Math.min(Math.max(1, Math.trunc(query.pageSize)), 100);
  const from = Math.max(0, Math.trunc(query.page)) * pageSize;

  if (import.meta.env.DEV && viewer.isDemo) {
    return demoFetchTablePage(table, companyId, { ...query, sort, pageSize }, parseRow);
  }

  let request: Builder = client().from(table.name).select(selectFor(table), { count: "exact" });
  request = scope(request, table, companyId, query.showDeleted);
  request = applySearch(request, table, query.search);
  request = request.order(sort.column, { ascending: sort.ascending });
  for (const key of table.keyColumns) {
    if (key !== sort.column) request = request.order(key, { ascending: true });
  }

  const { data, count, error } = await request.range(from, from + pageSize - 1);
  if (error) {
    // PGRST103: the page asked for is past the end (rows were removed since the last read).
    if (error.code === "PGRST103") return { rows: [], total: 0 };
    throw error;
  }
  return {
    rows: z
      .array(z.unknown())
      .parse(data)
      .map((raw) => parseRow(table, raw)),
    total: z.number().int().nonnegative().parse(count),
  };
}

/** How many rows each table has for the company (without a search), for the tab labels. */
export async function fetchTableCounts(
  viewer: Viewer,
  companyId: string,
  showDeleted: boolean,
): Promise<TableCounts> {
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchTableCounts(companyId, showDeleted);

  const counts = await Promise.all(
    DB_TABLE_NAMES.map(async (name) => {
      const table = DB_TABLES[name];
      const columns =
        name === "payroll_entries"
          ? "id, payroll_runs!inner(company_id, deleted_at)"
          : table.keyColumns[0]!;
      const request = scope(
        client().from(name).select(columns, { count: "exact", head: true }),
        table,
        companyId,
        showDeleted,
      );
      const { count, error } = await request;
      if (error) {
        if (name in OPTIONAL_TABLES && isMissingTable(error)) return [name, null] as const;
        throw error;
      }
      return [name, z.number().int().nonnegative().parse(count)] as const;
    }),
  );
  return Object.fromEntries(counts) as TableCounts;
}
