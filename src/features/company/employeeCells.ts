import type { XlsxCell } from "@/lib/xlsx/readXlsx";

// How one cell of the Employees sheet is read, for each kind of column. A COPY of Payroll System's
// own Excel import rules, so a file reads the same in both places:
//
//   parseNumberCell, parseCheckboxValue   Payroll_sys src/lib/excelImport.js
//   readDate, excelSerialToIso,
//   readExcelDateCell                     Payroll_sys src/lib/dates.js
//
// Copied on 9 November 2026. Both copies must change together: see docs/KNOWN_ISSUES.md here and
// docs/KNOWN_ISSUES.md in Payroll_sys. employeeCells.test.ts pins every rule with examples.
//
// One difference, on purpose: a cell is read as the dashboard's xlsx reader gives it, its text
// trimmed (an Excel number as the number, an Excel date as its serial number).

/** A Number cell: a number, or not one (text such as "n/a"). A blank cell is 0. */
export function parseNumberCell(raw: unknown): { ok: true; value: number } | { ok: false } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: 0 };
  if (typeof raw === "number")
    return Number.isFinite(raw) ? { ok: true, value: raw } : { ok: false };
  if (typeof raw !== "string") return { ok: false };

  // Ordinary and non-breaking spaces are only ever separators in a figure.
  let text = raw.replace(/[\s\u00a0\u202f]+/g, " ").trim();
  if (text === "") return { ok: true, value: 0 };

  // Accounting style: (1,200.00) is minus 1,200.00.
  let negative = false;
  const bracketed = text.match(/^\((.*)\)$/);
  if (bracketed) {
    negative = true;
    text = bracketed[1]!.trim();
  }

  // A currency label before or after the figure: "Rs", "Rs.", "MUR", "$".
  text = text
    .replace(/^(?:[A-Za-z]{1,4}\.?|[$€£₨])\s*(?=[-+.\d])/, "")
    .replace(/(?<=\d)\s*(?:[A-Za-z]{1,4}\.?|[$€£₨])$/, "");
  text = text.replace(/ /g, "");

  if (/^[-+]/.test(text)) {
    if (text[0] === "-") negative = !negative;
    text = text.slice(1);
  }

  const grouped = /^\d{1,3}(,\d{3})+(\.\d*)?$/.test(text);
  const plain = /^(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text);
  if (!grouped && !plain) return { ok: false };

  const value = Number(grouped ? text.replace(/,/g, "") : text);
  if (!Number.isFinite(value)) return { ok: false };
  return { ok: true, value: negative ? -value : value };
}

/** A Yes/No cell: Yes, Y, True, 1 and X tick it; anything else leaves it unticked. */
export function parseCheckboxValue(raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === "") return false;
  const s = String(raw).trim().toLowerCase();
  return s === "yes" || s === "y" || s === "true" || s === "1" || s === "x";
}

const FIRST_YEAR = 1900;
const LAST_YEAR = 2100;
const pad = (n: number) => String(n).padStart(2, "0");

function isoDate(year: number, month: number, day: number): string | null {
  if (year < FIRST_YEAR || year > LAST_YEAR || month < 1 || month > 12 || day < 1) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day)
    return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** One typed date: "YYYY-MM-DD", or day first with "/", "-" or "." between. */
export function readDate(
  raw: unknown,
): { value: string } | { empty: true } | { unreadable: true; wellFormed: boolean } {
  if (raw === undefined || raw === null || String(raw).trim() === "") return { empty: true };
  const text = String(raw).trim();
  let m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const value = isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
    return value ? { value } : { unreadable: true, wellFormed: true };
  }
  m = text.match(/^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})$/);
  if (m) {
    const value = isoDate(Number(m[4]), Number(m[3]), Number(m[1]));
    return value ? { value } : { unreadable: true, wellFormed: true };
  }
  return { unreadable: true, wellFormed: false };
}

// Excel keeps a date as the number of days since 30 December 1899, except that it counts a
// 29 February 1900 that never was (day 60): days 1 to 59 are one day earlier.
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const DAY = 24 * 60 * 60 * 1000;
const MARCH_1900 = 61;

/** An Excel date cell's serial number as "YYYY-MM-DD", or null. A time of day is dropped. */
export function excelSerialToIso(serial: unknown): string | null {
  if (typeof serial !== "number" || !Number.isFinite(serial)) return null;
  const days = Math.floor(serial);
  if (days < 1 || days === 60) return null;
  const d = new Date(EXCEL_EPOCH + (days < MARCH_1900 ? days + 1 : days) * DAY);
  return isoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** A Date cell: an Excel date (a number), "DD/MM/YYYY" or "YYYY-MM-DD" text. */
export function readExcelDateCell(raw: unknown): { value: string } | { unreadable: true } {
  if (typeof raw === "number") {
    const value = excelSerialToIso(raw);
    return value ? { value } : { unreadable: true };
  }
  const read = readDate(raw);
  if ("value" in read) return { value: read.value };
  if ("empty" in read) return { value: "" };
  return { unreadable: true };
}

// ---------- a cell of the sheet, for a field ----------

export type CellKind = "text" | "date" | "number" | "checkbox";

/** What Payroll System's import is given for a cell: the number for a number cell, else the text. */
export function rawOf(cell: XlsxCell | null | undefined): unknown {
  if (!cell) return "";
  if (cell.kind === "number") {
    const n = Number(cell.text);
    return Number.isFinite(n) ? n : cell.text.trim();
  }
  return cell.text.trim();
}

/**
 * The value a filled cell gives a field, as Payroll System saves it (convertImportValue): text
 * as it is, a date "YYYY-MM-DD", a tick true or false, a figure a number. Null when it can't be
 * read (a figure or a date only).
 */
export function cellValue(kind: CellKind, cell: XlsxCell): string | number | boolean | null {
  const raw = rawOf(cell);
  switch (kind) {
    case "date": {
      const read = readExcelDateCell(raw);
      return "value" in read ? read.value : null;
    }
    case "checkbox":
      return parseCheckboxValue(raw);
    case "number": {
      const parsed = parseNumberCell(raw);
      return parsed.ok ? parsed.value : null;
    }
    default:
      return typeof raw === "number" ? cell.text.trim() : String(raw);
  }
}
