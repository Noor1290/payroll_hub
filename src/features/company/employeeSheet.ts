import type { XlsxColumn, XlsxSheet } from "@/lib/xlsx/writeXlsx";

// The "Employees" sheet of the companies workbook (EMPLOYEES_IMPORT_PLAN.md): its columns, worked
// out from the companies' column setups in Payroll System, and, in the template with my
// companies, the employees of each company's newest saved month. No React and no database here.
//
// A company's columns are its setup's identity fields, then its Input columns (the Global
// columns and its own), as Payroll System's own "Import from Excel" offers them
// (Payroll_sys src/lib/excelImport.js getImportableSystemFields): an Input column whose name
// another Input column also has is headed with its category, "CSG (Employer Contribution)"
// (Payroll_sys src/lib/categories.js labelColumnsForHelper). Formula columns are never in it:
// Payroll System works them out.
//
// Sensitive, so never written in the file: the ID (the NIC) and every column after the identity
// fields. Each filled-in row carries a Reference instead, so it is still recognised on upload.

export const EMPLOYEES_SHEET = "Employees";
export const BRN_HEADING = "Company BRN";
export const COMPANY_NAME_HEADING = "Company name";
export const REFERENCE_HEADING = "Reference (leave as is)";
/** At most this many employees in one file. */
export const MAX_EMPLOYEES = 5000;

/** Payroll System's column categories, in its order (Payroll_sys src/lib/categories.js). */
export const CATEGORIES: readonly { id: string; label: string }[] = [
  { id: "general", label: "General" },
  { id: "employeeContribution", label: "Employee Contribution" },
  { id: "employerContribution", label: "Employer Contribution" },
  { id: "otherDeductions", label: "Other Deductions" },
];
const DEFAULT_CATEGORY = "general";
const categoryLabel = (id: string) => CATEGORIES.find((c) => c.id === id)?.label ?? id;

export type ValueType = "text" | "date" | "number" | "checkbox";

/** One identity field or Input column of a company's setup, under its heading in the sheet. */
export interface SetupField {
  key: string;
  heading: string;
  kind: "identity" | "input";
  valueType: ValueType;
  /** The identity field chosen as the ID in Payroll System (the NIC). */
  isId: boolean;
  /** An Input column's category label. */
  category: string | null;
}

export interface SetupFields {
  fields: SetupField[];
  /** The headings of its formula columns: never imported. */
  formulas: string[];
  /** The key of the identity field chosen as the ID; null when none is. */
  idKey: string | null;
}

/** A heading compared without capitals, a "*", or extra spaces. */
export function headingKey(heading: string): string {
  return heading.replace(/\*/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

type Item = Record<string, unknown>;
const itemsOf = (list: unknown): Item[] =>
  Array.isArray(list)
    ? (list as unknown[]).filter(
        (item): item is Item =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as Item).key === "string" &&
          (item as Item).key !== "" &&
          typeof (item as Item).name === "string" &&
          ((item as Item).name as string).trim() !== "",
      )
    : [];

const inputType = (column: Item): ValueType =>
  column.valueType === "text" || column.valueType === "date" || column.valueType === "checkbox"
    ? column.valueType
    : "number";

/**
 * A company's identity fields and Input columns, from its setup as Payroll System saves it: the
 * shared setup's body and the company's own (null for a company with no own setup body yet).
 */
export function setupFields(shared: Item, company: Item | null): SetupFields {
  const idKey = typeof shared.idFieldKey === "string" ? shared.idFieldKey : null;
  const identity: SetupField[] = itemsOf(shared.identityFields).map((field) => ({
    key: field.key as string,
    heading: (field.name as string).trim(),
    kind: "identity",
    valueType: field.valueType === "date" ? "date" : "text",
    isId: field.key === idKey,
    category: null,
  }));

  const columns = [...itemsOf(shared.globalColumns), ...itemsOf(company?.columns)];
  const inputs = columns.filter((column) => column.type === "input");
  const uses = new Map<string, number>();
  for (const column of inputs) {
    const name = column.name as string;
    uses.set(name, (uses.get(name) ?? 0) + 1);
  }
  const categoryOf = (column: Item) =>
    typeof column.category === "string" ? column.category : DEFAULT_CATEGORY;
  const order = (column: Item) => {
    const at = CATEGORIES.findIndex((c) => c.id === categoryOf(column));
    return at < 0 ? CATEGORIES.length : at;
  };
  const ordered = inputs
    .map((column, at) => ({ column, at }))
    .sort((a, b) => order(a.column) - order(b.column) || a.at - b.at)
    .map(({ column }) => column);

  const inputFields: SetupField[] = ordered.map((column) => {
    const name = (column.name as string).trim();
    const label = categoryLabel(categoryOf(column));
    return {
      key: column.key as string,
      heading: (uses.get(column.name as string) ?? 0) > 1 ? `${name} (${label})` : name,
      kind: "input",
      valueType: inputType(column),
      isId: false,
      category: label,
    };
  });

  return {
    fields: [...identity, ...inputFields],
    formulas: columns
      .filter((column) => column.type === "formula")
      .map((column) => (column.name as string).trim()),
    idKey,
  };
}

/** True for the field the file never holds a value of in the template: the ID (the NIC). */
export const isIdField = (field: Pick<SetupField, "isId" | "heading">) =>
  field.isId || headingKey(field.heading) === "id";

// ---------- the sheet's columns ----------

/** One column of the Employees sheet, after Company BRN and Company name. */
export interface SheetColumn {
  heading: string;
  kind: "identity" | "input";
  valueType: ValueType;
  isId: boolean;
  category: string | null;
  /** The companies of the file that have it, when not all of those with a setup do. */
  onlyFor: string[] | null;
}

/** The identity fields of a saved run, for when no column setup is known (mraFields.ts). */
const FALLBACK: SetupFields = {
  fields: [
    { key: "id", heading: "ID", kind: "identity", valueType: "text", isId: true, category: null },
    {
      key: "surname",
      heading: "Surname",
      kind: "identity",
      valueType: "text",
      isId: false,
      category: null,
    },
    {
      key: "other_names",
      heading: "Other names",
      kind: "identity",
      valueType: "text",
      isId: false,
      category: null,
    },
  ],
  formulas: [],
  idKey: "id",
};

/**
 * The columns of the sheet for these setups (each with the name of its company, or null for the
 * blank template's one setup): every identity field, then every Input column, in the order first
 * met, one column per heading (capitals and spaces ignored). With no setup at all, ID, Surname
 * and Other names.
 */
export function sheetColumns(
  setups: readonly { company: string | null; fields: SetupFields }[],
): SheetColumn[] {
  const list = setups.length > 0 ? setups : [{ company: null, fields: FALLBACK }];
  const found = new Map<string, SheetColumn & { companies: Set<string> }>();
  for (const kind of ["identity", "input"] as const) {
    for (const { company, fields } of list) {
      for (const field of fields.fields) {
        if (field.kind !== kind) continue;
        const key = headingKey(field.heading);
        const column = found.get(key) ?? {
          heading: field.heading,
          kind: field.kind,
          valueType: field.valueType,
          isId: false,
          category: field.category,
          onlyFor: null,
          companies: new Set<string>(),
        };
        // Text where any company keeps text there: a Text cell is read for every kind.
        if (column.valueType !== field.valueType) {
          const textish = (type: ValueType) => type === "text" || type === "date";
          column.valueType =
            textish(column.valueType) || textish(field.valueType) ? "text" : "number";
        }
        column.isId ||= isIdField(field);
        if (company !== null) column.companies.add(company);
        found.set(key, column);
      }
    }
  }
  const named = list.filter((setup) => setup.company !== null).length;
  return [...found.values()].map(({ companies, ...column }) => ({
    ...column,
    onlyFor: companies.size > 0 && companies.size < named ? [...companies] : null,
  }));
}

// ---------- the template's rows ----------

/** One company of the template with my companies, with its setup and its newest saved month. */
export interface TemplateCompany {
  name: string;
  brn: string;
  /** Null when it has no column setup in Payroll System yet. */
  fields: SetupFields | null;
  /** The newest saved month, "YYYY-MM-01"; null when none is saved. */
  period: string | null;
  /** That month's employees, exactly as Payroll System saved them. */
  employees: readonly Item[];
}

/** "2026-10/<the employee's id in that month>": which employee a row of the template is. */
export const referenceOf = (period: string, employeeId: string) =>
  `${period.slice(0, 7)}/${employeeId}`;

/** A value of an identity field as the template shows it: a date DD/MM/YYYY, the rest as saved. */
function shown(value: unknown, field: SetupField): string | null {
  if (value === undefined || value === null) return null;
  const text = typeof value === "string" ? value : String(value);
  if (text.trim() === "") return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  return field.valueType === "date" && iso ? `${iso[3]}/${iso[2]}/${iso[1]}` : text;
}

/** How many employees the filled-in template holds, from how many companies. */
export function employeeCounts(companies: readonly TemplateCompany[]) {
  const withEmployees = companies.filter((company) => company.employees.length > 0);
  return {
    employees: withEmployees.reduce((sum, company) => sum + company.employees.length, 0),
    companies: withEmployees.length,
  };
}

// ---------- the sheet and its part of the Read me ----------

const DATE_FORMAT = "A date: DD/MM/YYYY, for example 05/03/2024.";

function example(column: SheetColumn): string {
  if (column.isId) return "A0101801234567";
  if (column.valueType === "date") return "05/03/2024";
  if (column.valueType === "checkbox") return "Yes";
  if (column.kind === "input") return column.valueType === "number" ? "18115.00" : "";
  const key = headingKey(column.heading);
  if (key === "surname") return "Example";
  if (key === "other names" || key === "name") return "Jane";
  return "";
}

function meaning(column: SheetColumn): string {
  const base = column.isId
    ? "The employee's ID (their NIC). An employee is recognised by it."
    : column.kind === "identity"
      ? "An identity field of the column setup in Payroll System."
      : `An Input column of the column setup (${column.category ?? "General"}): ${column.valueType === "number" ? "a figure" : "a value"} for the month.`;
  return column.onlyFor ? `${base} Only for: ${column.onlyFor.join(", ")}.` : base;
}

function format(column: SheetColumn): string {
  if (column.isId) return "Text. Leading zeros are kept.";
  switch (column.valueType) {
    case "date":
      return DATE_FORMAT;
    case "checkbox":
      return "Yes or No. Y, X and 1 also tick it.";
    case "number":
      return "A number, for example 18115.00 or 18,115.00.";
    default:
      return "Text.";
  }
}

const required = (column: SheetColumn) =>
  column.isId || headingKey(column.heading) === "surname" ? "For a new employee" : "No";

export type EmployeesPart =
  | {
      kind: "blank";
      /** The column setup the columns come from; null when the user has none. */
      setupName: string | null;
      fields: SetupFields | null;
    }
  | { kind: "filled"; companies: readonly TemplateCompany[] };

/**
 * The Employees sheet, and the rows its section adds at the end of the Read me sheet (with which
 * of them, counted from the first, are bold). Column widths fit the Read me's five columns.
 */
export function employeesSheet(part: EmployeesPart): {
  sheet: XlsxSheet;
  readMe: (string | null)[][];
  readMeBold: number[];
} {
  const filled = part.kind === "filled";
  const columns = sheetColumns(
    part.kind === "blank"
      ? part.fields
        ? [{ company: null, fields: part.fields }]
        : []
      : part.companies.flatMap((company) =>
          company.fields ? [{ company: company.name, fields: company.fields }] : [],
        ),
  );

  const xlsxColumns: XlsxColumn[] = [
    { width: 16, text: true },
    { width: 28, text: true },
    ...columns.map((column) => ({
      width: column.kind === "identity" ? 20 : 16,
      // Figures and ticks stay numbers; everything else is Text, dates too: typed as DD/MM/YYYY
      // they are kept exactly as typed, whatever Excel's own date settings.
      text: column.valueType === "text" || column.valueType === "date",
    })),
    ...(filled ? [{ width: 46, text: true }] : []),
  ];

  const rows: (string | null)[][] = [
    [
      `${BRN_HEADING} *`,
      COMPANY_NAME_HEADING,
      ...columns.map((column) => column.heading),
      ...(filled ? [REFERENCE_HEADING] : []),
    ],
  ];
  if (part.kind === "filled") {
    for (const company of part.companies) {
      if (!company.fields || !company.period) continue;
      const byHeading = new Map(company.fields.fields.map((f) => [headingKey(f.heading), f]));
      for (const employee of company.employees) {
        const values = (employee.values ?? {}) as Item;
        rows.push([
          company.brn,
          company.name,
          ...columns.map((column) => {
            const field = byHeading.get(headingKey(column.heading));
            // Never the ID, never a figure: sensitive.
            if (!field || field.kind !== "identity" || isIdField(field)) return null;
            return shown(values[field.key], field);
          }),
          referenceOf(company.period, String(employee.id)),
        ]);
      }
    }
  }

  const readMe: (string | null)[][] = [
    [],
    ["Employees sheet"],
    [
      "Optional. One row per employee, linked to their company by its BRN: a company on the Companies sheet or one already in the dashboard. Leave it empty to import companies only.",
    ],
  ];
  if (part.kind === "blank") {
    readMe.push([
      part.setupName
        ? `Its columns are those of your column setup "${part.setupName}" in Payroll System: the identity fields, then the Input columns. For a company with other columns, add their headings.`
        : "Its columns are the identity fields ID, Surname and Other names. For a company with a column setup in Payroll System, add the headings of its identity fields and Input columns.",
    ]);
  } else {
    readMe.push([
      "Filled in with the employees of each company's newest saved month. ID and the columns after the identity fields are left empty because they are sensitive: an empty cell changes nothing.",
    ]);
  }
  const headingAt = readMe.length;
  readMe.push(
    ["Column", "Required", "What it is", "Format", "Example"],
    [
      `${BRN_HEADING} *`,
      "Yes",
      "The BRN of the employee's company, as on the Companies sheet or in the dashboard.",
      "Text. Capitals and spaces don't matter.",
      "C07012345",
    ],
    [
      COMPANY_NAME_HEADING,
      "No",
      "Only to help you read the file: it is not read. The BRN links the employee to their company.",
      "Text.",
      "Example Trading Ltd",
    ],
    ...columns.map((column) => [
      column.heading,
      required(column),
      meaning(column),
      format(column),
      example(column),
    ]),
  );
  if (filled) {
    readMe.push([
      REFERENCE_HEADING,
      "No",
      "Which employee of the dashboard the row is. Leave it as it is. For a new employee, leave it empty.",
      "Filled in by the dashboard.",
      "",
    ]);
  }
  readMe.push(
    [],
    [
      "Employees are added to their company's newest saved month in Payroll System. A company with no saved month starts in the month you choose in the preview.",
    ],
    [
      "A row is matched to an employee of that month by its Reference or, without one, by its ID. A new employee is added. For an employee already there, the preview shows the changes, and they are made only if you tick them.",
    ],
    [
      "An empty cell changes nothing; nobody is ever deleted. Employees of the month who are not in the file stay as they are.",
    ],
    [
      "Formula columns are not in this sheet: Payroll System works them out. A column of a company's setup can be added by its heading; capitals and spaces don't matter.",
    ],
  );

  return {
    sheet: {
      name: EMPLOYEES_SHEET,
      columns: xlsxColumns,
      rows,
      boldRows: [0],
      freezeFirstRow: true,
    },
    readMe,
    readMeBold: [1, headingAt],
  };
}
