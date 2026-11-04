// Reads one sheet of an Excel file (.xlsx) as cells. An .xlsx file is a zip of XML files: the
// zip is read here and each part is unpacked with the browser's own DecompressionStream
// ("deflate-raw"), so no library is needed. Copied from the MRA Returns app
// (mra_returns/src/lib/xlsx.ts), which reads text only; here each cell also says what kind of
// value Excel stored, because a number has lost its leading zeros already and text has not.

export class NotAnExcelFile extends Error {
  constructor() {
    super("This is not an Excel (.xlsx) file the dashboard can read.");
    this.name = "NotAnExcelFile";
  }
}

/** The most an unpacked part may be. */
const MAX_PART_BYTES = 20_000_000;

/**
 * One cell: its text as stored (before any number format), and what Excel stored it as.
 * "error" is a cell such as #N/A or #VALUE!.
 */
export interface XlsxCell {
  text: string;
  kind: "text" | "number" | "boolean" | "error";
}

interface Entry {
  name: string;
  method: number;
  compressedSize: number;
  offset: number;
}

const u16 = (view: DataView, at: number) => view.getUint16(at, true);
const u32 = (view: DataView, at: number) => view.getUint32(at, true);

/** The files in a zip, from its central directory. */
function zipEntries(bytes: Uint8Array): Map<string, Entry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end of central directory record: within the last 64 KB + 22 bytes.
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65_557); at--) {
    if (u32(view, at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new NotAnExcelFile();
  const count = u16(view, end + 10);
  let at = u32(view, end + 16);
  const entries = new Map<string, Entry>();
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || u32(view, at) !== 0x02014b50) throw new NotAnExcelFile();
    const nameLength = u16(view, at + 28);
    const extraLength = u16(view, at + 30);
    const commentLength = u16(view, at + 32);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    entries.set(name, {
      name,
      method: u16(view, at + 10),
      compressedSize: u32(view, at + 20),
      offset: u32(view, at + 42),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function unpack(bytes: Uint8Array, entry: Entry): Promise<string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const local = entry.offset;
  if (local + 30 > bytes.length || u32(view, local) !== 0x04034b50) throw new NotAnExcelFile();
  const start = local + 30 + u16(view, local + 26) + u16(view, local + 28);
  const packed = bytes.slice(start, start + entry.compressedSize);
  if (entry.method === 0) return new TextDecoder().decode(packed);
  if (entry.method !== 8) throw new NotAnExcelFile();
  const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_PART_BYTES) throw new NotAnExcelFile();
      parts.push(value);
    }
  } catch {
    throw new NotAnExcelFile();
  }
  const whole = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    whole.set(part, offset);
    offset += part.length;
  }
  return new TextDecoder().decode(whole);
}

/** XML text with its five entities and numeric character references turned back into text. */
function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, code: string) => {
    if (code === "amp") return "&";
    if (code === "lt") return "<";
    if (code === "gt") return ">";
    if (code === "quot") return '"';
    if (code === "apos") return "'";
    return String.fromCodePoint(
      code[1] === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10),
    );
  });
}

/** The text of every <t> inside a piece of XML, joined (rich text has several runs). */
function textOf(xml: string): string {
  let out = "";
  for (const match of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)) {
    out += unescapeXml(match[1] ?? "");
  }
  return out;
}

/** "C12" -> column 2 (from 0). */
function columnOf(reference: string): number {
  const letters = /^[A-Z]+/.exec(reference)?.[0] ?? "A";
  let column = 0;
  for (const letter of letters) column = column * 26 + (letter.charCodeAt(0) - 64);
  return column - 1;
}

/**
 * The sheet of the workbook with this name (capitals and surrounding spaces ignored), as rows of
 * cells; an empty cell is null. Null when the workbook has no such sheet.
 */
export async function readXlsxSheet(
  bytes: Uint8Array,
  sheetName: string,
): Promise<(XlsxCell | null)[][] | null> {
  const entries = zipEntries(bytes);
  const part = async (name: string) => {
    const entry = entries.get(name);
    return entry ? unpack(bytes, entry) : null;
  };
  const workbook = await part("xl/workbook.xml");
  const relations = await part("xl/_rels/workbook.xml.rels");
  if (!workbook || !relations) throw new NotAnExcelFile();

  const wanted = sheetName.trim().toLowerCase();
  const chosen = [...workbook.matchAll(/<sheet\b[^>]*>/g)]
    .map((match) => match[0])
    .find(
      (tag) =>
        unescapeXml(/\bname="([^"]*)"/.exec(tag)?.[1] ?? "")
          .trim()
          .toLowerCase() === wanted,
    );
  if (!chosen) return null;
  const id = /\br:id="([^"]+)"/.exec(chosen)?.[1];
  const target = [...relations.matchAll(/<Relationship\b[^>]*>/g)]
    .map((match) => match[0])
    .find((tag) => tag.includes(`Id="${id}"`))
    ?.match(/Target="([^"]+)"/)?.[1];
  if (!target) throw new NotAnExcelFile();
  const sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  const sheet = await part(sheetPath);
  if (!sheet) throw new NotAnExcelFile();

  const shared: string[] = [];
  const strings = await part("xl/sharedStrings.xml");
  if (strings) {
    for (const match of strings.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textOf(match[1]!));
  }

  const rows: (XlsxCell | null)[][] = [];
  for (const rowMatch of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
    const attributes = rowMatch[1] ?? rowMatch[3] ?? "";
    const number = Number(/\br="(\d+)"/.exec(attributes)?.[1] ?? rows.length + 1);
    const cells: (XlsxCell | null)[] = [];
    for (const cellMatch of (rowMatch[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const cellAttributes = cellMatch[1]!;
      const inner = cellMatch[2] ?? "";
      const reference = /\br="([A-Z]+\d+)"/.exec(cellAttributes)?.[1];
      const column = reference ? columnOf(reference) : cells.length;
      const type = /\bt="([a-zA-Z]+)"/.exec(cellAttributes)?.[1] ?? "n";
      const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let cell: XlsxCell | null = null;
      if (type === "s") cell = { text: shared[Number(raw)] ?? "", kind: "text" };
      else if (type === "inlineStr") cell = { text: textOf(inner), kind: "text" };
      else if (raw !== undefined) {
        const text = unescapeXml(raw);
        if (type === "str" || type === "d") cell = { text, kind: "text" };
        else if (type === "b") cell = { text: text === "1" ? "TRUE" : "FALSE", kind: "boolean" };
        else if (type === "e") cell = { text, kind: "error" };
        else cell = { text, kind: "number" };
      }
      while (cells.length < column) cells.push(null);
      cells[column] = cell;
    }
    while (rows.length < number - 1) rows.push([]);
    rows[number - 1] = cells;
  }
  return rows;
}
