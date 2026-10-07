/**
 * Single source of truth for the payroll JSON format: which key in the payroll app's export maps
 * to which database column, how it is labelled, and whether it is sensitive.
 *
 * Used by the import (parsing and validation), the data grid (columns, labels, masking) and,
 * from Phase 4, the app registry's expected fields. Change the format here and nowhere else.
 *
 * A key that is NOT listed here is kept as-is in `payroll_entries.extra`, so a new field in the
 * payroll app never breaks an import.
 *
 * A field marked `inExtra` is known and checked like any other, but has no column of its own:
 * its value lives in `payroll_entries.extra` under its `column` name, and only when the file had
 * one. An absent value stays absent everywhere: it is never stored, shown or sent as "" or 0.
 */

export const NUMERIC_COLUMNS = [
  "basic_salary",
  "govt_increment",
  "new_basic_salary",
  "allowances",
  "emoluments",
  "travelling",
  "gross_pay",
  "csg",
  "nsf",
  "paye",
  "total_deductions",
  "net_pay",
  "levy",
  "prgf",
  "total_mra_contributions",
  "edf",
  "edf_monthly",
  "total",
] as const;
export type NumericColumn = (typeof NUMERIC_COLUMNS)[number];

export type EmployeeColumn = "national_id" | "surname" | "other_names" | "employment_type";
export type CompanyColumn = "name" | "address" | "brn" | "vat";
export type EntryColumn = NumericColumn | "age_60_plus";

export type PayrollFieldType = "string" | "number" | "boolean";

export interface PayrollField {
  /** Key exactly as the payroll app exports it. */
  jsonKey: string;
  /** Column name in the target table; for an `inExtra` field, its key inside `extra`. */
  column: string;
  /** Which table the value belongs to. */
  target: "company" | "employee" | "entry";
  label: string;
  type: PayrollFieldType;
  /** A row without it is rejected. */
  required: boolean;
  /** Masked in the grid until revealed; flagged when sent to another app. */
  sensitive: boolean;
  /** Stored in `payroll_entries.extra` under `column`, not in a column of its own. */
  inExtra?: true;
}

const money = (jsonKey: string, column: NumericColumn, label = jsonKey): PayrollField => ({
  jsonKey,
  column,
  target: "entry",
  label,
  type: "number",
  required: true,
  sensitive: true,
});

/** A money figure that older files and runs do not have. Kept in `extra`; never assumed to be 0. */
const optionalMoney = (jsonKey: string, column: string, label = jsonKey): PayrollField => ({
  jsonKey,
  column,
  target: "entry",
  label,
  type: "number",
  required: false,
  sensitive: true,
  inExtra: true,
});

/** In the order the payroll app exports them, which is also the grid's column order. */
export const PAYROLL_FIELDS: readonly PayrollField[] = [
  {
    jsonKey: "ID",
    column: "national_id",
    target: "employee",
    label: "National ID",
    type: "string",
    required: true,
    sensitive: true,
  },
  {
    jsonKey: "Surname",
    column: "surname",
    target: "employee",
    label: "Surname",
    type: "string",
    required: true,
    sensitive: false,
  },
  {
    jsonKey: "Other names",
    column: "other_names",
    target: "employee",
    label: "Other names",
    type: "string",
    required: false,
    sensitive: false,
  },
  money("Basic Salary", "basic_salary", "Basic salary"),
  money("Govt Increment", "govt_increment", "Govt increment"),
  money("New Basic Salary", "new_basic_salary", "New basic salary"),
  {
    jsonKey: "Full time / Part time",
    column: "employment_type",
    target: "employee",
    label: "Employment",
    type: "string",
    required: false,
    sensitive: false,
  },
  money("Allowances", "allowances"),
  money("Emoluments", "emoluments"),
  money("Travelling", "travelling"),
  money("Gross Pay", "gross_pay", "Gross pay"),
  {
    jsonKey: "Age 60+",
    column: "age_60_plus",
    target: "entry",
    label: "Age 60+",
    type: "boolean",
    required: true,
    sensitive: false,
  },
  money("CSG", "csg"),
  money("NSF", "nsf"),
  money("PAYE", "paye"),
  optionalMoney("Employee CSG", "employee_csg"),
  optionalMoney("Employee NSF", "employee_nsf"),
  money("Total deductions", "total_deductions"),
  money("Net Pay", "net_pay", "Net pay"),
  money("Levy", "levy"),
  money("PRGF", "prgf"),
  money("Total MRA contributions", "total_mra_contributions", "Total MRA contributions"),
  money("EDF", "edf"),
  money("EDF (monthly)", "edf_monthly"),
  money("Total", "total"),
  {
    jsonKey: "Company Name",
    column: "name",
    target: "company",
    label: "Company name",
    type: "string",
    required: true,
    sensitive: false,
  },
  {
    jsonKey: "Address",
    column: "address",
    target: "company",
    label: "Address",
    type: "string",
    required: false,
    sensitive: false,
  },
  {
    jsonKey: "BRN",
    column: "brn",
    target: "company",
    label: "BRN",
    type: "string",
    required: true,
    sensitive: false,
  },
  {
    jsonKey: "VAT",
    column: "vat",
    target: "company",
    label: "VAT",
    type: "string",
    required: false,
    sensitive: false,
  },
];

/**
 * "Date of Employment" is not part of the payroll app's export. It is typed into the dashboard
 * (employees.date_of_employment, migration 0008) and added to the rows of a saved run when an
 * employee has one, as "YYYY-MM-DD". An employee without one gets no key at all.
 */
export const DATE_OF_EMPLOYMENT = "Date of Employment";

/** True for a real calendar date written "YYYY-MM-DD", within what the database accepts. */
export function isEmploymentDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value &&
    value >= "1900-01-01" &&
    value <= "2100-12-31"
  );
}

/** Keys are compared ignoring case and stray whitespace, so "net pay " still finds "Net Pay". */
export function normaliseKey(key: string): string {
  return key.trim().replace(/\s+/g, " ").toLowerCase();
}

const FIELD_BY_KEY = new Map(PAYROLL_FIELDS.map((field) => [normaliseKey(field.jsonKey), field]));
const FIELD_BY_COLUMN = new Map(
  PAYROLL_FIELDS.filter((f) => f.target !== "company").map((field) => [field.column, field]),
);

/**
 * Keys the dashboard adds to exported rows itself. An import leaves them out (they are not the
 * payroll app's to set), so a file made from a dashboard export never stores them in `extra`.
 */
export function isHubOwnedKey(key: string): boolean {
  return normaliseKey(key) === normaliseKey(DATE_OF_EMPLOYMENT);
}

export function fieldForJsonKey(key: string): PayrollField | undefined {
  return FIELD_BY_KEY.get(normaliseKey(key));
}

/** Employee and entry columns only (company columns reuse names like "name"). */
export function fieldForColumn(column: string): PayrollField | undefined {
  return FIELD_BY_COLUMN.get(column);
}

/** Keys inside `extra` that belong to a known field, so no unknown field may use them. */
export const RESERVED_EXTRA_KEYS: ReadonlySet<string> = new Set(
  PAYROLL_FIELDS.filter((field) => field.inExtra).map((field) => field.column),
);

/**
 * The value of an `inExtra` field, or undefined when the row has none. Anything that is not a
 * real number counts as absent: it is never turned into 0 or "".
 */
export function extraNumber(
  row: Pick<PayrollRow, "extra">,
  field: PayrollField,
): number | undefined {
  const value = row.extra[field.column];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The per-employee fields, in export order: what a grid row shows. */
export const ROW_FIELDS: readonly PayrollField[] = PAYROLL_FIELDS.filter(
  (field) => field.target !== "company",
);

/** One employee's line in a run: the shape shared by the import preview and the data explorer. */
export type PayrollRow = {
  /** Entry id for saved rows; the row number for rows still being imported. */
  id: string;
  national_id: string;
  surname: string;
  other_names: string | null;
  employment_type: string | null;
  age_60_plus: boolean;
  /** The employee's own id. Saved rows only. */
  employee_id?: string;
  /**
   * Saved rows only: "YYYY-MM-DD", or null when not set. Undefined when it is not known: a row
   * still being imported, or a database that has not had migration 0008.
   */
  date_of_employment?: string | null;
  /**
   * Fields this version of the dashboard does not know about, kept verbatim, plus the known
   * `inExtra` fields under their column names (see RESERVED_EXTRA_KEYS).
   */
  extra: Record<string, unknown>;
} & Record<NumericColumn, number>;

/**
 * Turns a row back into the payroll app's own export shape (its keys, "Yes"/"No", company
 * details on every row). This is what apps that consume payroll results expect to receive.
 * An `inExtra` field the row has no value for is left out, so the app can tell it is missing.
 */
export function toExportRow(
  row: PayrollRow,
  company: Record<CompanyColumn, string | null>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of PAYROLL_FIELDS) {
    if (field.inExtra) {
      const value = extraNumber(row, field);
      if (value !== undefined) out[field.jsonKey] = value;
    } else if (field.target === "company") {
      out[field.jsonKey] = company[field.column as CompanyColumn] ?? "";
    } else if (field.type === "boolean") {
      out[field.jsonKey] = row.age_60_plus ? "Yes" : "No";
    } else {
      out[field.jsonKey] = row[field.column as keyof PayrollRow] ?? "";
    }
  }
  if (isEmploymentDate(row.date_of_employment)) out[DATE_OF_EMPLOYMENT] = row.date_of_employment;
  // Unknown fields travel along untouched, but never override a known one.
  for (const [key, value] of Object.entries(row.extra)) {
    if (!(key in out) && !RESERVED_EXTRA_KEYS.has(key) && !isHubOwnedKey(key)) out[key] = value;
  }
  return out;
}
