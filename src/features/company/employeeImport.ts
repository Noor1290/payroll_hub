import type { XlsxCell } from "@/lib/xlsx/readXlsx";
import { cellValue, readDate } from "./employeeCells";
import {
  BRN_HEADING,
  COMPANY_NAME_HEADING,
  EMPLOYEES_SHEET,
  headingKey,
  MAX_EMPLOYEES,
  REFERENCE_HEADING,
  type SetupField,
  type SetupFields,
} from "./employeeSheet";

// The Employees sheet of an uploaded companies file (EMPLOYEES_IMPORT_PLAN.md, Stage 2): reading
// it, linking each row to its company by BRN, matching it to an employee of the month it goes
// into, and every check, for the preview. Nothing is saved here and no database is read: the
// caller gives what the dashboard holds (employeeImportData.ts).
//
// The rules (owner's decisions, 9 November 2026):
//  - Employees go into their company's newest saved month; a company with no saved month starts
//    in the month chosen in the preview. An approved month is never changed.
//  - A row is matched by its Reference, or without one by its ID. New: ticked. A change: shown,
//    and unticked. An empty cell changes nothing; nobody is ever deleted.
//  - A filled cell under a column the company does not have is a Problem.

const cellText = (cell: XlsxCell | null | undefined) => (cell ? cell.text.trim() : "");
const normaliseBrn = (brn: string) => brn.replace(/\s/g, "").toUpperCase();

function columnLetter(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

// ---------- reading the sheet ----------

/** One row of the Employees sheet, as read. */
export interface EmployeeFileRow {
  /** The row's number in Excel (the headings are row 1). */
  line: number;
  brnTyped: string;
  brn: string;
  reference: string;
  /** The filled cells under the other headings, by heading (as written in row 1). */
  cells: { heading: string; cell: XlsxCell }[];
}

export type EmployeesRead =
  | {
      ok: true;
      rows: EmployeeFileRow[];
      /** The headings other than Company BRN, Company name and Reference, as written. */
      headings: string[];
    }
  | { ok: false; why: string };

const REFERENCE_KEYS = new Set([headingKey(REFERENCE_HEADING), "reference"]);

/** Reads the "Employees" sheet; a file without one, or with no employees in it, has none. */
export function readEmployeesSheet(sheet: (XlsxCell | null)[][] | null): EmployeesRead {
  if (!sheet) return { ok: true, rows: [], headings: [] };
  const headings = (sheet[0] ?? []).map(cellText);
  const width = Math.max(headings.length, ...sheet.map((row) => row.length));
  const hasRows = sheet.slice(1).some((row) => row.some((cell) => cellText(cell) !== ""));
  if (!hasRows) return { ok: true, rows: [], headings: [] };

  let brnColumn = -1;
  let referenceColumn = -1;
  const others: { heading: string; column: number }[] = [];
  const seen = new Set<string>();
  for (let column = 0; column < width; column++) {
    const heading = headings[column] ?? "";
    if (heading === "") {
      if (sheet.slice(1).some((row) => cellText(row[column]) !== "")) {
        return {
          ok: false,
          why: `Column ${columnLetter(column)} of the ${EMPLOYEES_SHEET} sheet has values but no heading in row 1.`,
        };
      }
      continue;
    }
    const key = headingKey(heading);
    if (seen.has(key)) {
      return {
        ok: false,
        why: `The heading "${heading}" is there twice on the ${EMPLOYEES_SHEET} sheet.`,
      };
    }
    seen.add(key);
    if (key === headingKey(BRN_HEADING)) brnColumn = column;
    else if (REFERENCE_KEYS.has(key)) referenceColumn = column;
    else if (key !== headingKey(COMPANY_NAME_HEADING)) others.push({ heading, column });
  }
  if (brnColumn < 0) {
    return {
      ok: false,
      why: `The ${EMPLOYEES_SHEET} sheet has no "${BRN_HEADING}" column. Use the companies template.`,
    };
  }

  const rows: EmployeeFileRow[] = [];
  for (let index = 1; index < sheet.length; index++) {
    const cells = sheet[index] ?? [];
    if (cells.every((cell) => cellText(cell) === "")) continue;
    const brnTyped = cellText(cells[brnColumn]);
    rows.push({
      line: index + 1,
      brnTyped,
      brn: normaliseBrn(brnTyped),
      reference: referenceColumn < 0 ? "" : cellText(cells[referenceColumn]),
      cells: others.flatMap(({ heading, column }) => {
        const cell = cells[column];
        return cell && cellText(cell) !== "" ? [{ heading, cell }] : [];
      }),
    });
  }
  if (rows.length > MAX_EMPLOYEES) {
    return {
      ok: false,
      why: `The ${EMPLOYEES_SHEET} sheet has more than ${MAX_EMPLOYEES} employees. Split it into two files.`,
    };
  }
  return { ok: true, rows, headings: others.map((other) => other.heading) };
}

// ---------- what the dashboard holds ----------

type Employee = Record<string, unknown>;

/** A saved month: its employees, as Payroll System saved them. */
export interface SavedMonthContent {
  period: string;
  revision: number;
  sharedRevision: number;
  companyRevision: number;
  employees: readonly Employee[];
}

/** A company the user is admin of, as the dashboard holds it now. */
export interface ExistingCompany {
  id: string;
  name: string;
  brn: string;
  /** Null when it has no column setup in Payroll System yet. */
  fields: SetupFields | null;
  /** Its newest saved month; null when none is saved. */
  newest: SavedMonthContent | null;
  /** Whether the saved run of its newest month is approved. */
  approved: boolean;
  /** Older months a Reference of the file points to, by period. */
  referenced: ReadonlyMap<string, readonly Employee[]>;
}

/** A company of the Companies sheet that is not in the dashboard yet. */
export interface NewCompany {
  name: string;
  /** Ticked to be created, with no problem. */
  created: boolean;
}

export interface EmployeeContext {
  /** The user's admin companies the file names, by BRN (capitals, no spaces). */
  existing: ReadonlyMap<string, ExistingCompany>;
  /** Companies in the dashboard the user is only a member of, by BRN: their names. */
  notAdmin: ReadonlyMap<string, string>;
  /** The Companies sheet's new companies, by BRN. */
  newCompanies: ReadonlyMap<string, NewCompany>;
  /** The column setup chosen for the new companies; null for "None yet". */
  newSetup: SetupFields | null;
  /** The month a company with no saved month starts in, "YYYY-MM-01". */
  startPeriod: string;
}

// ---------- the preview ----------

export type EmployeeStatus = "new" | "update" | "same" | "problem";

export interface EmployeeChange {
  heading: string;
  before: string;
  after: string;
}

export interface EmployeePreview {
  row: EmployeeFileRow;
  status: EmployeeStatus;
  /** New: ticked unless there is a warning. Update: never ticked when the preview opens. */
  ticked: boolean;
  /** How the employee is named in the preview: Surname and Other names, or the ID. */
  label: string;
  problems: string[];
  warning: string | null;
  /** Update: what changes. New: what the employee is given. */
  changes: EmployeeChange[];
  /** New: the employee as saved. Update: the values that change, by key. */
  values: Record<string, unknown>;
  /** Update and No changes: the employee's id in the month. */
  employeeId: string | null;
}

export interface CompanyEmployees {
  brn: string;
  name: string;
  /** The month the employees go into, "YYYY-MM-01"; null when they can't go anywhere. */
  period: string | null;
  /** True when the month is not saved yet. */
  newMonth: boolean;
  /** Why none of its employees can be added, when that is so. */
  problem: string | null;
  rows: EmployeePreview[];
  /** Employees of the month not in the file: they stay as they are. */
  notInFile: number;
  companyId: string | null;
}

export interface EmployeesPreview {
  /** In the order the companies are first met in the file; rows with no BRN last. */
  companies: CompanyEmployees[];
  /** Said once above the list; they stop nothing. */
  notices: string[];
}

/** "October 2026". */
export const monthName = (period: string) =>
  new Date(`${period.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

const textOf = (value: unknown) =>
  value === undefined || value === null ? "" : typeof value === "string" ? value : String(value);

/** A value as the preview shows it. */
function shown(field: SetupField, value: unknown): string {
  if (field.valueType === "checkbox") return value === true ? "Yes" : "No";
  if (field.valueType === "date") {
    const read = readDate(value);
    if ("value" in read) {
      const [y, m, d] = read.value.split("-");
      return `${d}/${m}/${y}`;
    }
  }
  if (field.valueType === "number" && typeof value === "number") {
    return value.toLocaleString("en-GB", { maximumFractionDigits: 10 });
  }
  const text = textOf(value);
  return text === "" ? "(empty)" : text;
}

/** Whether a saved value and a value from the file are the same. */
function same(field: SetupField, saved: unknown, next: unknown): boolean {
  switch (field.valueType) {
    case "checkbox":
      return (saved === true) === next;
    case "number":
      return saved !== "" && saved !== null && saved !== undefined && Number(saved) === next;
    case "date": {
      const read = readDate(saved);
      return ("value" in read ? read.value : textOf(saved)) === next;
    }
    default:
      return textOf(saved) === next;
  }
}

const valuesOf = (employee: Employee) => (employee.values ?? {}) as Record<string, unknown>;

/**
 * What each employee row will do, company by company. Pure: the same file and context always give
 * the same preview, so it is worked out again whenever a company is ticked or a choice changes.
 */
export function previewEmployees(
  rows: readonly EmployeeFileRow[],
  headings: readonly string[],
  context: EmployeeContext,
  makeId: () => string = () => crypto.randomUUID(),
): EmployeesPreview {
  const groups = new Map<string, EmployeeFileRow[]>();
  for (const row of rows) groups.set(row.brn, [...(groups.get(row.brn) ?? []), row]);

  const companies: CompanyEmployees[] = [];
  const known = new Set<string>();
  const formulas = new Set<string>();
  const formulaHeadings = new Map<string, string>();
  for (const [brn, group] of groups) {
    const result = companyPreview(brn, group, context, makeId);
    companies.push(result.company);
    if (result.fields) {
      for (const field of result.fields.fields) known.add(headingKey(field.heading));
      for (const formula of result.fields.formulas) {
        known.add(headingKey(formula));
        formulas.add(headingKey(formula));
      }
    }
  }
  // Rows with no BRN last.
  companies.sort((a, b) => Number(a.brn === "") - Number(b.brn === ""));

  // The headings no company of the file has, and the formula columns filled in: never imported.
  const notices: string[] = [];
  const filled = new Set(rows.flatMap((row) => row.cells.map((c) => headingKey(c.heading))));
  for (const heading of headings) {
    const key = headingKey(heading);
    if (formulas.has(key) && filled.has(key) && !formulaHeadings.has(key)) {
      formulaHeadings.set(key, heading);
    }
  }
  for (const heading of formulaHeadings.values()) {
    notices.push(
      `${heading} is worked out by Payroll System, so its values in the file are not imported.`,
    );
  }
  const unknown = headings.filter((heading) => !known.has(headingKey(heading)));
  if (unknown.length > 0 && companies.some((company) => company.problem === null)) {
    notices.push(
      `These headings are not a column of any company in the file, so they are not imported: ${unknown.join(", ")}.`,
    );
  }
  return { companies, notices };
}

interface Target {
  name: string;
  companyId: string | null;
  fields: SetupFields | null;
  month: SavedMonthContent | null;
  period: string | null;
  problem: string | null;
  referenced: ReadonlyMap<string, readonly Employee[]>;
}

/** Where the employees of one BRN go, or why they can't go anywhere. */
function targetOf(brn: string, typed: string, context: EmployeeContext): Target {
  const none = (name: string, problem: string): Target => ({
    name,
    companyId: null,
    fields: null,
    month: null,
    period: null,
    problem,
    referenced: new Map(),
  });
  if (brn === "") return none("", "No Company BRN. Each employee needs the BRN of their company.");

  const existing = context.existing.get(brn);
  if (existing) {
    const who = `${existing.brn} ${existing.name}`;
    const base = {
      name: existing.name,
      companyId: existing.id,
      fields: existing.fields,
      referenced: existing.referenced,
    };
    if (!existing.fields) {
      return {
        ...base,
        month: null,
        period: null,
        problem: `${who} has no column setup in Payroll System yet, so employees can't be added to it.`,
      };
    }
    if (existing.fields.idKey === null) {
      return {
        ...base,
        month: null,
        period: null,
        problem: `The column setup of ${existing.brn} has no identity field chosen as the ID, so employees can't be matched. Choose one in Payroll System.`,
      };
    }
    if (existing.newest && existing.approved) {
      return {
        ...base,
        month: existing.newest,
        period: existing.newest.period,
        problem: `${monthName(existing.newest.period)} of ${existing.brn} is approved and can't be changed. Start ${monthName(nextPeriod(existing.newest.period))} in Payroll System first, then upload again.`,
      };
    }
    return {
      ...base,
      month: existing.newest,
      period: existing.newest?.period ?? context.startPeriod,
      problem: null,
    };
  }

  const notAdmin = context.notAdmin.get(brn);
  if (notAdmin !== undefined) {
    return none(
      notAdmin,
      `You are not an admin of ${brn} ${notAdmin}, so its employees can't be changed here.`,
    );
  }

  const created = context.newCompanies.get(brn);
  if (created) {
    if (!created.created) {
      return none(
        created.name,
        `Its company, ${brn}, is not being created, so its employees can't be added.`,
      );
    }
    if (!context.newSetup) {
      return none(
        created.name,
        "Choose a column setup for the new companies above to add their employees.",
      );
    }
    if (context.newSetup.idKey === null) {
      return none(
        created.name,
        `The column setup of ${brn} has no identity field chosen as the ID, so employees can't be matched. Choose one in Payroll System.`,
      );
    }
    return {
      name: created.name,
      companyId: null,
      fields: context.newSetup,
      month: null,
      period: context.startPeriod,
      problem: null,
      referenced: new Map(),
    };
  }

  return none(
    "",
    `BRN ${typed} is not on the Companies sheet and is not one of your companies in the dashboard.`,
  );
}

function nextPeriod(period: string): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
}
const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-10/<id>" → its period ("2026-10-01") and the employee's id in that month. */
function parseReference(reference: string): { period: string; id: string } | null {
  const m = /^(\d{4}-(0[1-9]|1[0-2]))\/(.+)$/.exec(reference);
  return m ? { period: `${m[1]}-01`, id: m[3]! } : null;
}

function companyPreview(
  brn: string,
  group: readonly EmployeeFileRow[],
  context: EmployeeContext,
  makeId: () => string,
): { company: CompanyEmployees; fields: SetupFields | null } {
  const target = targetOf(brn, group[0]?.brnTyped ?? brn, context);
  const company: CompanyEmployees = {
    brn,
    name: target.name,
    period: target.problem ? null : target.period,
    newMonth: target.problem === null && target.month === null,
    problem: target.problem,
    rows: [],
    notInFile: 0,
    companyId: target.companyId,
  };
  if (target.problem || !target.fields || !target.period) {
    // The reason is said once, on the company's line.
    company.rows = group.map((row) => problemRow(row, []));
    return { company, fields: target.fields };
  }

  const fields = target.fields;
  const byHeading = new Map(fields.fields.map((field) => [headingKey(field.heading), field]));
  const formulaKeys = new Set(fields.formulas.map(headingKey));
  const idField = fields.fields.find((field) => field.key === fields.idKey)!;
  const surnameField = fields.fields.find((f) => headingKey(f.heading) === "surname") ?? null;
  const otherNamesField =
    fields.fields.find((f) => headingKey(f.heading) === "other names") ?? null;
  const monthEmployees = target.month?.employees ?? [];
  const month = monthName(target.period);
  const idOf = (employee: Employee) => textOf(valuesOf(employee)[idField.key]).trim();
  const byId = new Map<string, Employee[]>();
  for (const employee of monthEmployees) {
    const id = idOf(employee);
    if (id) byId.set(id, [...(byId.get(id) ?? []), employee]);
  }
  const labelOf = (values: Record<string, unknown>) =>
    [surnameField, otherNamesField]
      .flatMap((field) => (field ? [textOf(values[field.key]).trim()] : []))
      .filter((text) => text !== "")
      .join(" ") || textOf(values[idField.key]);

  // First pass: each row's values, and who it is.
  interface Worked {
    row: EmployeeFileRow;
    problems: string[];
    warning: string | null;
    values: Record<string, unknown>;
    filled: SetupField[];
    match: Employee | null;
    /** The ID the employee will have: typed, or theirs. */
    id: string;
  }
  const worked: Worked[] = group.map((row) => {
    const problems: string[] = [];
    let warning: string | null = null;
    const values: Record<string, unknown> = {};
    const filled: SetupField[] = [];
    for (const { heading, cell } of row.cells) {
      const key = headingKey(heading);
      if (cell.kind === "error") {
        problems.push(`The value in "${heading}" can't be read (${cell.text}).`);
        continue;
      }
      const field = byHeading.get(key);
      if (!field) {
        if (formulaKeys.has(key)) continue;
        if (!knownElsewhere(key, context)) continue;
        problems.push(
          `${heading}: ${brn} has no column called ${heading}. Leave it empty, or add the column in Payroll System first.`,
        );
        continue;
      }
      const value = cellValue(field.valueType, cell);
      if (value === null) {
        problems.push(
          field.valueType === "date"
            ? `${field.heading}: "${cell.text.trim()}" is not a date. Type it as DD/MM/YYYY, for example 05/03/2024.`
            : `${field.heading}: "${cell.text.trim()}" is not a number.`,
        );
        continue;
      }
      if (field.key === idField.key && cell.kind === "number") {
        warning =
          "The ID was typed as a number, so Excel may have dropped leading zeros. Check it before ticking.";
      }
      values[field.key] = value;
      filled.push(field);
    }

    const typedId = textOf(values[idField.key]).trim();
    let match: Employee | null = null;
    if (row.reference !== "") {
      const ref = parseReference(row.reference);
      const fromMonth =
        ref && target.month
          ? ref.period === target.month.period
            ? monthEmployees
            : (target.referenced.get(ref.period) ?? [])
          : [];
      const found = ref ? fromMonth.find((employee) => String(employee.id) === ref.id) : undefined;
      if (found && ref!.period === target.month?.period) match = found;
      else if (found) {
        // Downloaded from an older month: the same person, by their ID, in the newest one.
        const inNewest = byId.get(idOf(found)) ?? [];
        if (inNewest.length === 1) match = inNewest[0]!;
      }
      if (!match) {
        problems.push(
          `This row's Reference does not match an employee of ${brn}. For a new employee, empty its Reference cell.`,
        );
      }
    } else if (typedId === "") {
      problems.push("No ID. Each employee needs an ID.");
    } else {
      const found = byId.get(typedId) ?? [];
      if (found.length > 1) {
        problems.push(
          `ID ${typedId} is in ${month} twice already. Correct it in Payroll System first.`,
        );
      } else if (found.length === 1) match = found[0]!;
    }
    // A new employee: an ID the month does not have at all.
    if (!match && row.reference === "" && typedId !== "" && !byId.has(typedId) && surnameField) {
      if (textOf(values[surnameField.key]).trim() === "") {
        problems.push("No Surname. A new employee needs a Surname.");
      }
    }
    return {
      row,
      problems,
      warning,
      values,
      filled,
      match,
      id: typedId !== "" ? typedId : match ? idOf(match) : "",
    };
  });

  // The same Reference, or the same employee, twice in the file: neither row is used.
  const twice = (keyOf: (w: Worked) => string, problem: (w: Worked, lines: string) => string) => {
    const lines = new Map<string, number[]>();
    for (const w of worked) {
      const key = keyOf(w);
      if (key) lines.set(key, [...(lines.get(key) ?? []), w.row.line]);
    }
    for (const w of worked) {
      const at = lines.get(keyOf(w));
      if (keyOf(w) && at && at.length > 1) {
        const list =
          at.length === 2
            ? `${at[0]} and ${at[1]}`
            : `${at.slice(0, -1).join(", ")} and ${at.at(-1)}`;
        w.problems.push(problem(w, list));
      }
    }
  };
  twice(
    (w) => w.row.reference,
    (_w, lines) =>
      `Rows ${lines} have the same Reference: one was probably copied. For a new employee, empty its Reference cell.`,
  );
  twice(
    (w) => (w.row.reference !== "" && w.problems.length > 0 ? "" : w.id),
    (w, lines) =>
      `ID ${w.id} is used twice for ${brn} (rows ${lines}). Each employee needs their own ID.`,
  );

  // Second pass: what each row does.
  const matched = new Set<Employee>();
  company.rows = worked.map((w) => {
    const problems = [...new Set(w.problems)];
    if (problems.length > 0) return problemRow(w.row, problems, labelOf(w.values));
    if (!w.match) {
      const employee = { id: makeId(), values: w.values };
      return {
        row: w.row,
        status: "new",
        ticked: w.warning === null,
        label: labelOf(w.values),
        problems: [],
        warning: w.warning,
        changes: w.filled.map((field) => ({
          heading: field.heading,
          before: "",
          after: shown(field, w.values[field.key]),
        })),
        values: employee,
        employeeId: employee.id,
      };
    }
    matched.add(w.match);
    const saved = valuesOf(w.match);
    const changes: EmployeeChange[] = [];
    const patch: Record<string, unknown> = {};
    for (const field of w.filled) {
      const next = w.values[field.key];
      if (same(field, saved[field.key], next)) continue;
      changes.push({
        heading: field.heading,
        before: shown(field, saved[field.key]),
        after: shown(field, next),
      });
      patch[field.key] = next;
    }
    return {
      row: w.row,
      status: changes.length > 0 ? "update" : "same",
      ticked: false,
      label: labelOf(saved),
      problems: [],
      warning: changes.length > 0 ? w.warning : null,
      changes,
      values: patch,
      employeeId: String(w.match.id),
    };
  });
  company.notInFile = monthEmployees.filter((employee) => !matched.has(employee)).length;
  return { company, fields };
}

/** Whether some company of the dashboard or the file knows this heading (so a company lacking it is told). */
function knownElsewhere(key: string, context: EmployeeContext): boolean {
  const has = (fields: SetupFields | null) =>
    !!fields &&
    (fields.fields.some((f) => headingKey(f.heading) === key) ||
      fields.formulas.some((f) => headingKey(f) === key));
  if (has(context.newSetup)) return true;
  for (const company of context.existing.values()) if (has(company.fields)) return true;
  return false;
}

function problemRow(row: EmployeeFileRow, problems: string[], label = ""): EmployeePreview {
  return {
    row,
    status: "problem",
    ticked: false,
    label,
    problems: problems.filter((p) => p !== ""),
    warning: null,
    changes: [],
    values: {},
    employeeId: null,
  };
}

/** Whether a row can be ticked: a new employee, or one with changes. */
export const isEmployeeTickable = (item: EmployeePreview) =>
  item.status === "new" || item.status === "update";

/** "C07012345 Example Ltd: into October 2026: 3 new, 2 to update, 40 no changes, 1 problem". */
export function companyLine(company: CompanyEmployees): string {
  const who = [company.brn, company.name].filter(Boolean).join(" ");
  if (company.problem || !company.period) {
    // A BRN with no company to name (unknown, or none): the message alone, which says the BRN.
    return company.name ? `${who}: ${company.problem ?? ""}` : (company.problem ?? "");
  }
  const count = (status: EmployeeStatus) =>
    company.rows.filter((row) => row.status === status).length;
  const problems = count("problem");
  return `${who}: into ${monthName(company.period)}: ${count("new")} new, ${count("update")} to update, ${count("same")} no changes, ${problems} ${problems === 1 ? "problem" : "problems"}`;
}

/** "40 employees of October 2026 are not in the file: they stay as they are." */
export function notInFileLine(company: CompanyEmployees): string | null {
  if (company.notInFile === 0 || !company.period) return null;
  return `${company.notInFile === 1 ? "1 employee" : `${company.notInFile} employees`} of ${monthName(company.period)} ${company.notInFile === 1 ? "is" : "are"} not in the file: ${company.notInFile === 1 ? "it stays" : "they stay"} as ${company.notInFile === 1 ? "it is" : "they are"}.`;
}
