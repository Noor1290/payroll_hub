import { z } from "zod";
import { demoCreateCompanyWithDetails } from "@/lib/demo/demoCompanyImport";
import { supabase } from "@/lib/supabase/client";
import { classifyDataError, isMissingTable, NotConfiguredError } from "@/lib/supabase/errors";
import {
  fetchMraTemplateAccess,
  fetchMraTemplateLinks,
  fetchMraTemplates,
} from "@/lib/supabase/mraReturns";
import {
  fetchCompanySetupLinks,
  fetchSharedSetup,
  fetchSharedSetupAccess,
} from "@/lib/supabase/payrollSetups";
import type { Viewer } from "@/lib/supabase/queries";
import type { Membership } from "@/lib/supabase/schemas";
import { NotAnExcelFile, readXlsxSheet, type XlsxCell } from "@/lib/xlsx/readXlsx";
import { writeXlsx, type XlsxSheet } from "@/lib/xlsx/writeXlsx";
import { createStore } from "@/lib/store";

// "Import companies from Excel": the template to download, reading a filled-in file, the
// preview (what each row will do), the choices for the new companies, creating them one at a
// time through `create_company_with_details` (migration 0023), and the report. No React here.

/** The file the owner runs to set this up; named when it has not been run. */
export const COMPANY_IMPORT_MIGRATION = "0023_create_company_with_details.sql";

export const COMPANIES_SHEET = "Companies";
export const READ_ME_SHEET = "Read me";
export const TEMPLATE_FILE_NAME = "Companies template.xlsx";
/** At most this many companies in one file, and this many detail columns. */
export const MAX_COMPANIES = 200;
export const MAX_DETAILS = 50;
const MAX_FILE_BYTES = 5_000_000;

/** The ready-made MRA templates, by name, as MRA Returns makes them (mra_returns/src/data/readyMade.ts). */
export const READY_MADE_MRA = ["MRA CSG (PACO)", "MRA PRGF"] as const;

type FieldId = "name" | "brn" | "address" | "vat" | "ern" | "telephone" | "mobile" | "declarant";

interface TemplateColumn {
  /** A field of the company, or a Company profile detail with this heading as its label. */
  field: FieldId | "detail";
  heading: string;
  required?: boolean;
  width: number;
  meaning: string;
  format: string;
  example: string;
}

/** The columns of the "Companies" sheet, in order. Every column is formatted as Text. */
export const TEMPLATE_COLUMNS: readonly TemplateColumn[] = [
  {
    field: "name",
    heading: "Company name",
    required: true,
    width: 32,
    meaning: "The company's name, as it should appear in the dashboard and on payslips.",
    format: "Text, at most 200 characters.",
    example: "Example Trading Ltd",
  },
  {
    field: "brn",
    heading: "BRN",
    required: true,
    width: 16,
    meaning:
      "The Business Registration Number. Payroll files are matched to a company by it, so it must be exactly the BRN in the company's payroll files.",
    format:
      "Text: one letter then 6 to 10 digits, e.g. C07012345. Saved in capitals with spaces removed. Two companies can never have the same BRN.",
    example: "C07012345",
  },
  {
    field: "address",
    heading: "Address",
    width: 40,
    meaning: "The company's address.",
    format: "Text, at most 500 characters.",
    example: "1 Example Street, Port Louis",
  },
  {
    field: "vat",
    heading: "VAT",
    width: 16,
    meaning: "The VAT registration number.",
    format: "Text, at most 50 characters. Leading zeros are kept.",
    example: "VAT20123456",
  },
  {
    field: "detail",
    heading: "TAN",
    width: 14,
    meaning: "The Tax Account Number. Kept as a detail on the Company profile, labelled TAN.",
    format: "Text, at most 2000 characters. Leading zeros are kept.",
    example: "00123456",
  },
  {
    field: "ern",
    heading: "ERN",
    width: 14,
    meaning:
      "The Employer Registration Number, for the MRA returns (MRA details on the Company profile).",
    format:
      "Text: letters and digits only, at most 20. Leading zeros are kept. A number typed in a cell not formatted as Text is refused, because Excel has already dropped its leading zeros.",
    example: "013341",
  },
  {
    field: "telephone",
    heading: "Telephone",
    width: 16,
    meaning: "The company's telephone number, for the MRA returns.",
    format: "Text: digits, spaces and + - ( ) only, at most 30.",
    example: "212 3456",
  },
  {
    field: "mobile",
    heading: "Mobile",
    width: 16,
    meaning: "The company's mobile number, for the MRA returns.",
    format: "Text: digits, spaces and + - ( ) only, at most 30.",
    example: "5 712 3456",
  },
  {
    field: "declarant",
    heading: "Name of declarant",
    width: 28,
    meaning: "The person who signs the MRA returns.",
    format: "Text, at most 120 characters.",
    example: "Jane Example",
  },
];

/** Columns after the template's, also formatted as Text, for details added by heading. */
const SPARE_TEXT_COLUMNS = 16;

const fieldByHeading = new Map(
  TEMPLATE_COLUMNS.filter((column) => column.field !== "detail").map((column) => [
    normaliseHeading(column.heading),
    column.field as FieldId,
  ]),
);

/** A heading compared without capitals, the "*" of a required column, or extra spaces. */
function normaliseHeading(heading: string): string {
  return heading.replace(/\*/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** A BRN as it is saved and compared: capitals, no spaces at all. */
export function normaliseBrn(brn: string): string {
  return brn.replace(/\s/g, "").toUpperCase();
}

const headingText = (column: TemplateColumn) =>
  column.required ? `${column.heading} *` : column.heading;

// ---------- the template ----------

/** The companies template: a "Read me" sheet, then the "Companies" sheet with its headings only. */
export function buildTemplate(at: Date = new Date()): Uint8Array {
  const readMe: XlsxSheet = {
    name: READ_ME_SHEET,
    columns: [
      { width: 22 },
      { width: 12 },
      { width: 60, wrap: true },
      { width: 60, wrap: true },
      { width: 26, text: true },
    ],
    boldRows: [0, 3, 3 + TEMPLATE_COLUMNS.length + 2],
    rows: [
      ["Companies template"],
      [
        'Fill in the Companies sheet, one row per company, then upload this file in the dashboard with "Import companies from Excel". Nothing is saved before you confirm the preview.',
      ],
      [],
      ["Column", "Required", "What it is", "Format", "Example"],
      ...TEMPLATE_COLUMNS.map((column) => [
        headingText(column),
        column.required ? "Yes" : "No",
        column.meaning,
        column.format,
        column.example,
      ]),
      [],
      ["More details"],
      [
        "Any other heading you add on the Companies sheet becomes a detail of the Company profile, with that heading as its label (not sensitive; you can mark it sensitive later on the Company profile). Leave a cell empty to add nothing.",
      ],
      [],
      [
        "Every column of the Companies sheet is formatted as Text, so Excel keeps leading zeros. Keep it that way; do not rename or remove the sheet. Rows left empty are ignored.",
      ],
      [
        "A company whose BRN is already in the dashboard, with capitals and spaces ignored, is skipped. A BRN on two rows: the first row is created, the second skipped.",
      ],
    ],
  };
  const companies: XlsxSheet = {
    name: COMPANIES_SHEET,
    columns: [
      ...TEMPLATE_COLUMNS.map((column) => ({ width: column.width, text: true })),
      ...Array.from({ length: SPARE_TEXT_COLUMNS }, () => ({ width: 18, text: true })),
    ],
    boldRows: [0],
    freezeFirstRow: true,
    rows: [TEMPLATE_COLUMNS.map(headingText)],
  };
  return writeXlsx([readMe, companies], at);
}

// ---------- reading a filled-in file ----------

export interface MraFields {
  ern: string;
  telephone: string;
  mobile: string;
  declarant: string;
}

/** One company row of the file, read and checked. */
export interface FileRow {
  /** The row's number in Excel (the headings are row 1). */
  line: number;
  name: string;
  /** As typed, trimmed (shown in the preview). */
  brnTyped: string;
  /** As it would be saved: capitals, no spaces. */
  brn: string;
  address: string | null;
  vat: string | null;
  details: { label: string; value: string }[];
  mra: MraFields;
  /** Reasons it cannot be created. */
  problems: string[];
  /** Created only when ticked by hand. */
  warning: string | null;
}

export type ReadResult = { ok: true; rows: FileRow[] } | { ok: false; why: string };

const cellText = (cell: XlsxCell | null | undefined) => (cell ? cell.text.trim() : "");
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const PHONE = /^[0-9 +()-]{0,30}$/;

/** Reads the "Companies" sheet of a file. Nothing is saved. */
export async function readCompaniesFile(file: {
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}): Promise<ReadResult> {
  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, why: "The file is larger than 5 MB. Use the companies template." };
  }
  let sheet: (XlsxCell | null)[][] | null;
  try {
    sheet = await readXlsxSheet(new Uint8Array(await file.arrayBuffer()), COMPANIES_SHEET);
  } catch (error) {
    if (error instanceof NotAnExcelFile) return { ok: false, why: error.message };
    throw error;
  }
  if (!sheet) {
    return {
      ok: false,
      why: `The file has no sheet named "${COMPANIES_SHEET}". Use the companies template.`,
    };
  }
  return readCompaniesSheet(sheet);
}

/** The rules of the "Companies" sheet, on its cells. */
export function readCompaniesSheet(sheet: (XlsxCell | null)[][]): ReadResult {
  const headings = (sheet[0] ?? []).map(cellText);
  const fields = new Map<FieldId, number>();
  const details: { label: string; column: number }[] = [];
  const seen = new Set<string>();
  const width = Math.max(headings.length, ...sheet.map((row) => row.length));

  for (let column = 0; column < width; column++) {
    const heading = headings[column] ?? "";
    if (heading === "") {
      if (sheet.slice(1).some((row) => cellText(row[column]) !== "")) {
        return {
          ok: false,
          why: `Column ${columnLetter(column)} has values but no heading in row 1.`,
        };
      }
      continue;
    }
    const key = normaliseHeading(heading);
    if (seen.has(key)) return { ok: false, why: `The heading "${heading}" is there twice.` };
    seen.add(key);
    const field = fieldByHeading.get(key);
    if (field) {
      fields.set(field, column);
      continue;
    }
    const label = heading.replace(/\s+/g, " ").trim();
    if (label.length > 80) {
      return {
        ok: false,
        why: `The heading "${label.slice(0, 40)}…" is longer than 80 characters.`,
      };
    }
    details.push({ label, column });
  }
  for (const required of TEMPLATE_COLUMNS.filter((column) => column.required)) {
    if (!fields.has(required.field as FieldId)) {
      return {
        ok: false,
        why: `The ${COMPANIES_SHEET} sheet has no "${required.heading}" column. Use the companies template.`,
      };
    }
  }
  if (details.length > MAX_DETAILS) {
    return {
      ok: false,
      why: `The ${COMPANIES_SHEET} sheet has more than ${MAX_DETAILS} detail columns.`,
    };
  }

  const rows: FileRow[] = [];
  for (let index = 1; index < sheet.length; index++) {
    const cells = sheet[index] ?? [];
    if (cells.every((cell) => cellText(cell) === "")) continue;
    rows.push(readRow(index + 1, cells, fields, details, headings));
  }
  if (rows.length === 0) {
    return { ok: false, why: `The ${COMPANIES_SHEET} sheet has no companies in it.` };
  }
  if (rows.length > MAX_COMPANIES) {
    return {
      ok: false,
      why: `The file has ${rows.length} companies. At most ${MAX_COMPANIES} can be imported at once.`,
    };
  }
  return { ok: true, rows };
}

function columnLetter(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

function readRow(
  line: number,
  cells: (XlsxCell | null)[],
  fields: Map<FieldId, number>,
  details: { label: string; column: number }[],
  headings: string[],
): FileRow {
  const problems: string[] = [];
  const cellOf = (field: FieldId) => {
    const column = fields.get(field);
    return column === undefined ? null : (cells[column] ?? null);
  };
  const text = (field: FieldId) => cellText(cellOf(field));

  cells.forEach((cell, column) => {
    if (cell?.kind === "error") {
      problems.push(
        `The value in "${headings[column] ?? columnLetter(column)}" can't be read (${cell.text}).`,
      );
    }
  });

  const name = text("name");
  if (name === "") problems.push("The company name is missing.");
  else if (name.length > 200) problems.push("The company name is longer than 200 characters.");

  const brnTyped = text("brn");
  const brn = normaliseBrn(brnTyped);
  let warning: string | null = null;
  if (brn === "") problems.push("The BRN is missing.");
  else if (!/^[A-Z0-9]+$/.test(brn))
    problems.push("The BRN has characters other than letters and digits.");
  else if (brn.length > 50) problems.push("The BRN is longer than 50 characters.");
  else if (!/^[A-Z]\d{6,10}$/.test(brn)) {
    warning =
      "This BRN doesn't look like one (one letter then 6 to 10 digits). Tick it if it is right.";
  }

  const address = text("address");
  if (address.length > 500) problems.push("The address is longer than 500 characters.");
  const vat = text("vat");
  if (vat.length > 50) problems.push("The VAT is longer than 50 characters.");

  const mra: MraFields = {
    ern: text("ern"),
    telephone: text("telephone"),
    mobile: text("mobile"),
    declarant: text("declarant"),
  };
  if (cellOf("ern")?.kind === "number") {
    problems.push(
      "The ERN is stored as a number, so a leading zero may have been lost. Format the ERN column as Text, type the ERN again and upload the file again.",
    );
  } else if (!/^[0-9A-Za-z]{0,20}$/.test(mra.ern)) {
    problems.push("The ERN must be letters and digits only, at most 20.");
  }
  if (!PHONE.test(mra.telephone))
    problems.push("The telephone must be digits, spaces and + - ( ) only, at most 30.");
  if (!PHONE.test(mra.mobile))
    problems.push("The mobile must be digits, spaces and + - ( ) only, at most 30.");
  if (mra.declarant.length > 120 || CONTROL.test(mra.declarant)) {
    problems.push("The name of the declarant must be at most 120 characters.");
  }

  const rowDetails: FileRow["details"] = [];
  for (const { label, column } of details) {
    const value = cellText(cells[column]);
    if (value === "") continue;
    if (value.length > 2000) problems.push(`"${label}" is longer than 2000 characters.`);
    rowDetails.push({ label, value });
  }

  return {
    line,
    name,
    brnTyped,
    brn,
    address: address === "" ? null : address,
    vat: vat === "" ? null : vat,
    details: rowDetails,
    mra,
    problems: [...new Set(problems)],
    warning,
  };
}

// ---------- the preview ----------

export type RowStatus = "new" | "existing" | "twice" | "problem";

export interface PreviewRow {
  row: FileRow;
  status: RowStatus;
  /** "new" only: ticked when the preview opens (not when the BRN only looks unusual). */
  ticked: boolean;
  /** "existing": the name of the company in the dashboard with this BRN. */
  existingName?: string;
  /** "twice": the row created instead. "new": the later rows with the same BRN, skipped. */
  sameAs?: number[];
}

/**
 * What each row will do. A row with a problem is not created. Of the others, one whose BRN is
 * already in the dashboard (capitals and spaces ignored) is skipped; of rows with the same BRN,
 * the first is created and the later ones skipped.
 */
export function previewRows(
  rows: readonly FileRow[],
  memberships: readonly Membership[],
): PreviewRow[] {
  const inDashboard = new Map<string, string>();
  for (const { company } of memberships) {
    if (company.brn) inDashboard.set(normaliseBrn(company.brn), company.name);
  }
  const firstLine = new Map<string, number>();
  const preview: PreviewRow[] = rows.map((row) => {
    if (row.problems.length > 0) return { row, status: "problem", ticked: false };
    const existingName = inDashboard.get(row.brn);
    if (existingName !== undefined) return { row, status: "existing", ticked: false, existingName };
    const first = firstLine.get(row.brn);
    if (first !== undefined) return { row, status: "twice", ticked: false, sameAs: [first] };
    firstLine.set(row.brn, row.line);
    return { row, status: "new", ticked: row.warning === null };
  });
  for (const item of preview) {
    if (item.status !== "new") continue;
    const later = preview
      .filter((other) => other.status === "twice" && other.sameAs?.[0] === item.row.line)
      .map((other) => other.row.line);
    if (later.length > 0) item.sameAs = later;
  }
  return preview;
}

// ---------- the choices for the new companies ----------

export interface SetupChoice {
  id: string;
  name: string;
  /** How many of the user's admin companies use it. */
  companies: number;
  /** The user may attach a company to it (an admin of every company using it). */
  canUse: boolean;
}

export interface ImportChoices {
  /** Most used first. */
  setups: SetupChoice[];
  /** The one most of the user's companies use, among those they may use; null for none. */
  defaultSetupId: string | null;
  /** The ready-made MRA templates to share with the new companies; empty when there are none. */
  templates: { id: string; name: string }[];
}

/** Reads what the new companies can be given: the shared column setups and the ready-made MRA templates. */
export async function loadImportChoices(
  viewer: Viewer,
  memberships: readonly Membership[],
): Promise<ImportChoices> {
  const adminIds = memberships.filter((m) => m.role === "admin").map((m) => m.company.id);

  const links = await fetchCompanySetupLinks(viewer, adminIds);
  const counts = new Map<string, number>();
  for (const link of links)
    counts.set(link.shared_setup_id, (counts.get(link.shared_setup_id) ?? 0) + 1);
  const setups: SetupChoice[] = [];
  for (const [id, companies] of counts) {
    const [setup, access] = await Promise.all([
      fetchSharedSetup(viewer, id),
      fetchSharedSetupAccess(viewer, id),
    ]);
    if (setup) setups.push({ id, name: setup.name, companies, canUse: access.can_change });
  }
  setups.sort((a, b) => b.companies - a.companies || a.name.localeCompare(b.name));

  return {
    setups,
    defaultSetupId: setups.find((setup) => setup.canUse)?.id ?? null,
    templates: await readyMadeTemplates(viewer, adminIds),
  };
}

/**
 * The ready-made MRA templates the user already shares: for each name, the one used by most of
 * their admin companies that they may also use in another company. None when MRA Returns is not
 * set up in the database.
 */
async function readyMadeTemplates(viewer: Viewer, adminIds: string[]) {
  let links;
  try {
    links = await fetchMraTemplateLinks(viewer, adminIds);
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  const uses = new Map<string, number>();
  for (const link of links) uses.set(link.template_id, (uses.get(link.template_id) ?? 0) + 1);
  const templates = await fetchMraTemplates(viewer, [...uses.keys()]);
  const chosen: { id: string; name: string }[] = [];
  for (const name of READY_MADE_MRA) {
    const candidates = templates
      .filter((template) => template.name.trim().toLowerCase() === name.toLowerCase())
      .sort((a, b) => (uses.get(b.id) ?? 0) - (uses.get(a.id) ?? 0));
    for (const candidate of candidates) {
      if ((await fetchMraTemplateAccess(viewer, candidate.id)).can_change) {
        chosen.push({ id: candidate.id, name: candidate.name });
        break;
      }
    }
  }
  return chosen;
}

// ---------- creating ----------

export interface NewCompanyInput {
  name: string;
  brn: string;
  address: string | null;
  vat: string | null;
  details: { label: string; value: string }[];
  mra: MraFields;
  sharedSetupId: string | null;
  mraTemplateIds: string[];
}

const createdSchema = z.object({ id: z.uuid(), name: z.string(), brn: z.string() });
export type CreatedCompany = z.infer<typeof createdSchema>;

/**
 * Creates one company with everything it is given, all of it or nothing, through
 * `create_company_with_details` (migration 0023). The caller becomes its admin.
 */
export async function createCompanyWithDetails(
  viewer: Viewer,
  input: NewCompanyInput,
): Promise<CreatedCompany> {
  if (import.meta.env.DEV && viewer.isDemo) return demoCreateCompanyWithDetails(input);
  if (!supabase) throw new NotConfiguredError();
  const { data, error } = await supabase.rpc("create_company_with_details", {
    p_name: input.name,
    p_brn: input.brn,
    p_address: input.address,
    p_vat: input.vat,
    p_details: input.details,
    p_mra: input.mra,
    p_shared_setup_id: input.sharedSetupId,
    p_mra_template_ids: input.mraTemplateIds,
  });
  if (error) throw error;
  return createdSchema.parse(data);
}

/** Why a company was not created, in one sentence. Nothing of it was created in every case. */
export function importFailureReason(error: unknown): string {
  const { code, message } = (typeof error === "object" && error !== null ? error : {}) as {
    code?: unknown;
    message?: unknown;
  };
  const text = typeof message === "string" ? message : "";
  if (code === "PGRST202" || code === "42883") {
    return `Creating companies from a file isn't set up in the database yet: the owner needs to run supabase/migrations/${COMPANY_IMPORT_MIGRATION}.`;
  }
  if (text.includes("PH_DUPLICATE_BRN") || (code === "23505" && !text.includes("PH_"))) {
    return "A company with this BRN already exists (one you are not a member of, or one added since the preview).";
  }
  if (text.includes("PH_NOT_ADMIN") || text.includes("PH_NOT_SIGNED_IN")) {
    return "Not allowed: you must be an admin of a company, and of every company using the chosen column setup and MRA templates.";
  }
  if (text.includes("PH_NOT_FOUND")) {
    return "The chosen column setup or MRA templates can no longer be found.";
  }
  if (text.includes("PH_INVALID_INPUT")) {
    const detail = text.replace(/^.*PH_INVALID_INPUT:?\s*/, "").slice(0, 200);
    return `The database refused a value${detail ? `: ${detail}` : ""}.`;
  }
  if (
    text.includes("PH_DUPLICATE_NAME") ||
    text.includes("PH_ALREADY_ATTACHED") ||
    text.includes("PH_LIMIT")
  ) {
    return "The MRA templates could not be added to it.";
  }
  return classifyDataError(error).title;
}

// ---------- the report ----------

export type ReportResult = "Created" | "Skipped" | "Problem";

export interface ReportLine {
  line: number;
  name: string;
  brn: string;
  result: ReportResult;
  why: string;
}

/** What the preview says of a row that is not created. */
export function skippedLine(item: PreviewRow): ReportLine {
  const base = { line: item.row.line, name: item.row.name, brn: item.row.brn };
  switch (item.status) {
    case "problem":
      return { ...base, result: "Problem", why: item.row.problems.join(" ") };
    case "existing":
      return {
        ...base,
        result: "Skipped",
        why: `Already in the dashboard as ${item.existingName}.`,
      };
    case "twice":
      return {
        ...base,
        result: "Skipped",
        why: `Same BRN as row ${item.sameAs?.[0]}, which is created instead.`,
      };
    case "new":
      return { ...base, result: "Skipped", why: "Not ticked." };
  }
}

/** The input for a ticked row, with the choices made in the preview. */
export function inputOf(
  row: FileRow,
  choices: { sharedSetupId: string | null; mraTemplateIds: string[] },
): NewCompanyInput {
  return {
    name: row.name,
    brn: row.brn,
    address: row.address,
    vat: row.vat,
    details: row.details,
    mra: row.mra,
    sharedSetupId: choices.sharedSetupId,
    mraTemplateIds: choices.mraTemplateIds,
  };
}

/**
 * Creates the ticked rows one at a time; one failing does not stop the others. Returns a line
 * for every row of the file, in the file's order.
 */
export async function runImport(
  viewer: Viewer,
  preview: readonly PreviewRow[],
  choices: { sharedSetupId: string | null; mraTemplateIds: string[] },
  onProgress: (done: number, total: number) => void = () => {},
): Promise<ReportLine[]> {
  const ticked = preview.filter((item) => item.status === "new" && item.ticked);
  const results = new Map<PreviewRow, ReportLine>();
  let done = 0;
  onProgress(done, ticked.length);
  for (const item of ticked) {
    const base = { line: item.row.line, name: item.row.name, brn: item.row.brn };
    try {
      const created = await createCompanyWithDetails(viewer, inputOf(item.row, choices));
      results.set(item, {
        ...base,
        name: created.name,
        brn: created.brn,
        result: "Created",
        why: "",
      });
    } catch (error) {
      results.set(item, {
        ...base,
        result: "Problem",
        why: `${importFailureReason(error)} Nothing of this company was created.`,
      });
    }
    onProgress(++done, ticked.length);
  }
  return preview.map((item) => results.get(item) ?? skippedLine(item));
}

/** The report as an Excel file. */
export function buildReport(lines: readonly ReportLine[], at: Date = new Date()): Uint8Array {
  return writeXlsx(
    [
      {
        name: "Report",
        columns: [
          { width: 8 },
          { width: 32 },
          { width: 16, text: true },
          { width: 12 },
          { width: 80, wrap: true },
        ],
        boldRows: [0],
        freezeFirstRow: true,
        rows: [
          ["Row", "Company name", "BRN", "Result", "Why"],
          ...lines.map((line) => [String(line.line), line.name, line.brn, line.result, line.why]),
        ],
      },
    ],
    at,
  );
}

const pad = (n: number) => String(n).padStart(2, "0");
export function reportFileName(at: Date = new Date()): string {
  return `Companies import report ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}${pad(at.getMinutes())}.xlsx`;
}

/** Whether the "Import companies from Excel" dialog is open. Opened from the company switcher and the command palette. */
export const importCompaniesOpen = createStore(false);
