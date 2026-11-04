import { makeZip } from "./zip";

// Writes a small Excel file (.xlsx) in memory: text cells only, no library. Enough for the
// companies template and the import report: column widths, a bold row, wrapped text, and
// columns formatted as Text ("@"), so what is typed into them later keeps its leading zeros.

export interface XlsxColumn {
  /** In Excel's own unit, about one character. */
  width: number;
  /** Formatted as Text: also the empty cells, for what is typed into them later. */
  text?: boolean;
  /** Long text wraps inside the cell. */
  wrap?: boolean;
}

export interface XlsxSheet {
  /** At most 31 characters, none of : \ / ? * [ ]. */
  name: string;
  columns: XlsxColumn[];
  /** Text cells; null or "" leaves a cell empty. */
  rows: (string | null)[][];
  /** Rows (from 0) written in bold. */
  boldRows?: number[];
  /** The first row stays in view when scrolling. */
  freezeFirstRow?: boolean;
}

// Cell styles, by position in cellXfs.
const PLAIN = 0;
const BOLD = 1;
const TEXT = 2;
const BOLD_TEXT = 3;
const WRAP = 4;
const BOLD_WRAP = 5;
/** Excel's own number format 49 is "@", Text. */
const TEXT_FORMAT = 49;

const escapeXml = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Control characters other than tab and line breaks cannot be written in XML at all.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

/** Column 0 -> "A", 26 -> "AA". */
export function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

function columnStyle(column: XlsxColumn | undefined, bold: boolean): number {
  if (column?.text) return bold ? BOLD_TEXT : TEXT;
  if (column?.wrap) return bold ? BOLD_WRAP : WRAP;
  return bold ? BOLD : PLAIN;
}

function sheetXml(sheet: XlsxSheet): string {
  const bold = new Set(sheet.boldRows ?? []);
  const cols = sheet.columns
    .map((column, index) => {
      const style = columnStyle(column, false);
      return `<col min="${index + 1}" max="${index + 1}" width="${column.width}" customWidth="1"${style === PLAIN ? "" : ` style="${style}"`}/>`;
    })
    .join("");
  const rows = sheet.rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) => {
          if (value === null || value === "") return "";
          const style = columnStyle(sheet.columns[columnIndex], bold.has(rowIndex));
          return `<c r="${columnName(columnIndex)}${rowIndex + 1}"${style === PLAIN ? "" : ` s="${style}"`} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
        })
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");
  const pane = sheet.freezeFirstRow
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    : "";
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `${pane}<sheetFormatPr defaultRowHeight="15"/>${cols ? `<cols>${cols}</cols>` : ""}<sheetData>${rows}</sheetData></worksheet>`
  );
}

const STYLES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
  `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
  `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="6">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
  `<xf numFmtId="${TEXT_FORMAT}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="${TEXT_FORMAT}" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
  `</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/** The .xlsx file of these sheets, in this order. */
export function writeXlsx(sheets: readonly XlsxSheet[], at: Date = new Date()): Uint8Array {
  const encode = (text: string) => new TextEncoder().encode(text);
  const head = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`;
  const sheetList = sheets
    .map(
      (sheet, i) =>
        `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
    )
    .join("");
  const sheetRelations = sheets
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    )
    .join("");
  const sheetTypes = sheets
    .map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join("");
  return makeZip(
    [
      {
        path: "[Content_Types].xml",
        bytes: encode(
          `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
            `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
            `<Default Extension="xml" ContentType="application/xml"/>` +
            `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
            `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
            `${sheetTypes}</Types>`,
        ),
      },
      {
        path: "_rels/.rels",
        bytes: encode(
          `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
            `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
            `</Relationships>`,
        ),
      },
      {
        path: "xl/workbook.xml",
        bytes: encode(
          `${head}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
            `<sheets>${sheetList}</sheets></workbook>`,
        ),
      },
      {
        path: "xl/_rels/workbook.xml.rels",
        bytes: encode(
          `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
            `${sheetRelations}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
            `</Relationships>`,
        ),
      },
      { path: "xl/styles.xml", bytes: encode(STYLES) },
      ...sheets.map((sheet, i) => ({
        path: `xl/worksheets/sheet${i + 1}.xml`,
        bytes: encode(sheetXml(sheet)),
      })),
    ],
    at,
  );
}

/** Offers a file made in memory as a download. */
export function downloadBytes(bytes: Uint8Array, fileName: string, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
