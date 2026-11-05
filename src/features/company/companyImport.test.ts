// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Membership } from "@/lib/supabase/schemas";
import { crc32 } from "@/lib/xlsx/zip";
import { readXlsxSheet, type XlsxCell } from "@/lib/xlsx/readXlsx";
import { writeXlsx } from "@/lib/xlsx/writeXlsx";

vi.mock("@/lib/supabase/client", async () => ({
  supabase: (await import("@/test/fakeClient")).fake.client,
}));
const { fake } = await import("@/test/fakeClient");
const {
  buildReport,
  buildTemplate,
  importFailureReason,
  loadImportChoices,
  normaliseBrn,
  previewRows,
  readCompaniesFile,
  readCompaniesSheet,
  runImport,
  TEMPLATE_COLUMNS,
} = await import("./companyImport");

const VIEWER = { id: "00000000-0000-4000-8000-0000000000a1", isDemo: false };
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const membership = (
  n: number,
  name: string,
  brn: string | null,
  role: Membership["role"] = "admin",
): Membership => ({
  role,
  company: { id: id(n), name, address: null, brn, vat: null },
});
const asFile = (bytes: Uint8Array) => ({
  size: bytes.length,
  arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
});

/** A Companies sheet as the template makes it, filled in with these rows, as text cells. */
const HEADINGS = TEMPLATE_COLUMNS.map((column) =>
  column.required ? `${column.heading} *` : column.heading,
);
const text = (value: string): XlsxCell => ({ text: value, kind: "text" });
const sheetOf = (rows: (string | XlsxCell | null)[][], headings: string[] = HEADINGS) => [
  headings.map(text),
  ...rows.map((row) =>
    row.map((cell) => (typeof cell === "string" ? (cell === "" ? null : text(cell)) : cell)),
  ),
];
/** One row in the template's column order: name, BRN, address, VAT, TAN, ERN, telephone, mobile, declarant. */
const row = (
  name: string,
  brn: string,
  more: Partial<
    Record<"address" | "vat" | "tan" | "ern" | "telephone" | "mobile" | "declarant", string>
  > = {},
) => [
  name,
  brn,
  more.address ?? "",
  more.vat ?? "",
  more.tan ?? "",
  more.ern ?? "",
  more.telephone ?? "",
  more.mobile ?? "",
  more.declarant ?? "",
];
const read = (rows: (string | XlsxCell | null)[][], headings?: string[]) => {
  const result = readCompaniesSheet(sheetOf(rows, headings));
  if (!result.ok) throw new Error(result.why);
  return result.rows;
};

/** Deflated as Excel does it, with the runtime's own CompressionStream. */
async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A zip as Excel saves one: every part deflated. */
async function deflatedZip(files: Record<string, string>): Promise<Uint8Array> {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const names = Object.keys(files);
  for (const name of names) {
    const raw = new TextEncoder().encode(files[name]);
    const packed = await deflateRaw(raw);
    const nameBytes = new TextEncoder().encode(name);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(8, 8, true);
    head.setUint32(14, crc32(raw), true);
    head.setUint32(18, packed.length, true);
    head.setUint32(22, raw.length, true);
    head.setUint16(26, nameBytes.length, true);
    local.push(new Uint8Array(head.buffer), nameBytes, packed);
    const record = new DataView(new ArrayBuffer(46));
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(10, 8, true);
    record.setUint32(16, crc32(raw), true);
    record.setUint32(20, packed.length, true);
    record.setUint32(24, raw.length, true);
    record.setUint16(28, nameBytes.length, true);
    record.setUint32(42, offset, true);
    central.push(new Uint8Array(record.buffer), nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const size = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, names.length, true);
  end.setUint16(10, names.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  const parts = [...local, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The parts of a file made here, as text. */
function partsOf(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts = new Map<string, string>();
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLength));
    parts.set(
      name,
      new TextDecoder().decode(bytes.subarray(at + 30 + nameLength, at + 30 + nameLength + size)),
    );
    at += 30 + nameLength + size;
  }
  return parts;
}

beforeEach(() => fake.reset());

describe("the companies template", () => {
  const template = buildTemplate(new Date(2026, 10, 4, 9, 30));

  it("has a Read me sheet, then a Companies sheet with one heading per company detail, required ones marked", async () => {
    const workbook = partsOf(template).get("xl/workbook.xml")!;
    expect([...workbook.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1])).toEqual([
      "Read me",
      "Companies",
    ]);
    const companies = await readXlsxSheet(template, "Companies");
    expect(companies!.map((cells) => cells.map((cell) => cell?.text ?? ""))).toEqual([
      [
        "Company name *",
        "BRN *",
        "Address",
        "VAT",
        "TAN",
        "ERN",
        "Telephone",
        "Mobile",
        "Name of declarant",
      ],
    ]);
  });

  it("formats every column of the Companies sheet as Text (number format 49), so leading zeros are kept", () => {
    const parts = partsOf(template);
    const styles = parts.get("xl/styles.xml")!;
    const xfs = [...styles.split("<cellXfs")[1]!.matchAll(/<xf numFmtId="(\d+)"/g)].map((m) =>
      Number(m[1]),
    );
    const sheet = parts.get("xl/worksheets/sheet2.xml")!;
    const cols = [...sheet.matchAll(/<col min="(\d+)"[^>]*?(?: style="(\d+)")?\/>/g)];
    expect(cols.length).toBeGreaterThanOrEqual(TEMPLATE_COLUMNS.length + 10);
    for (const [, , style] of cols) expect(xfs[Number(style)]).toBe(49);
    // BRN, VAT, TAN, ERN, Telephone and Mobile among them, by name.
    for (const heading of ["BRN", "VAT", "TAN", "ERN", "Telephone", "Mobile"]) {
      const column = TEMPLATE_COLUMNS.findIndex((c) => c.heading === heading) + 1;
      const style = cols.find(([, min]) => Number(min) === column)?.[2];
      expect(xfs[Number(style)], heading).toBe(49);
    }
  });

  it("explains every column in the Read me sheet, with whether it is required, its format and an example", async () => {
    const readMe = (await readXlsxSheet(template, "Read me"))!.map((cells) =>
      cells.map((cell) => cell?.text ?? ""),
    );
    for (const column of TEMPLATE_COLUMNS) {
      const line = readMe.find((cells) => (cells[0] ?? "").replace(" *", "") === column.heading);
      expect(line, column.heading).toEqual([
        column.required ? `${column.heading} *` : column.heading,
        column.required ? "Yes" : "No",
        column.meaning,
        column.format,
        column.example,
      ]);
    }
    expect(readMe.find((cells) => cells[0] === "ERN")![3]).toMatch(
      /^Text: .*Leading zeros are kept/,
    );
    expect(readMe.flat().join(" ")).toContain("Any other heading you add");
  });

  it("is read back as it is, the template's example values with their leading zeros", async () => {
    const filled = writeXlsx([
      { name: "Read me", columns: [], rows: [] },
      {
        name: "Companies",
        columns: [],
        rows: [HEADINGS, TEMPLATE_COLUMNS.map((column) => column.example)],
      },
    ]);
    const result = await readCompaniesFile(asFile(filled));
    expect(result.ok && result.rows[0]).toMatchObject({
      name: "Example Trading Ltd",
      brn: "C07012345",
      vat: "VAT20123456",
      details: [{ label: "TAN", value: "00123456" }],
      mra: {
        ern: "013341",
        telephone: "212 3456",
        mobile: "5 712 3456",
        declarant: "Jane Example",
      },
      problems: [],
      warning: null,
    });
  });
});

describe("reading a file saved by Excel", () => {
  const files = (sheet: string) =>
    deflatedZip({
      "xl/workbook.xml": `<workbook><sheets><sheet name="Read me" sheetId="1" r:id="rId1"/><sheet name="Companies" sheetId="2" r:id="rId2"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`,
      "xl/sharedStrings.xml": `<sst><si><t>Company name *</t></si><si><t>BRN *</t></si><si><t>ERN</t></si><si><t>ABC &amp; Sons Ltd</t></si><si><t>c 0701 2345</t></si><si><t>013341</t></si></sst>`,
      "xl/worksheets/sheet1.xml": "<worksheet><sheetData/></worksheet>",
      "xl/worksheets/sheet2.xml": sheet,
    });

  it("keeps a text ERN's leading zero and reads shared strings", async () => {
    const result = await readCompaniesFile(
      asFile(
        await files(
          `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" t="s"><v>4</v></c><c r="C2" t="s"><v>5</v></c></row></sheetData></worksheet>`,
        ),
      ),
    );
    expect(result.ok && result.rows[0]).toMatchObject({
      line: 2,
      name: "ABC & Sons Ltd",
      brnTyped: "c 0701 2345",
      brn: "C07012345",
      mra: { ern: "013341" },
      problems: [],
    });
  });

  it("refuses an ERN stored as a number: its leading zero is already gone", async () => {
    const result = await readCompaniesFile(
      asFile(
        await files(
          `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" t="s"><v>4</v></c><c r="C2"><v>13341</v></c></row></sheetData></worksheet>`,
        ),
      ),
    );
    expect(result.ok && result.rows[0]!.problems).toEqual([
      "The ERN is stored as a number, so a leading zero may have been lost. Format the ERN column as Text, type the ERN again and upload the file again.",
    ]);
  });

  it("says why a file can't be imported at all", async () => {
    expect(await readCompaniesFile(asFile(new TextEncoder().encode("name,brn\nA,C1")))).toEqual({
      ok: false,
      why: "This is not an Excel (.xlsx) file the dashboard can read.",
    });
    const noSheet = writeXlsx([{ name: "Sheet1", columns: [], rows: [["Company name", "BRN"]] }]);
    expect(await readCompaniesFile(asFile(noSheet))).toEqual({
      ok: false,
      why: 'The file has no sheet named "Companies". Use the companies template.',
    });
    expect(readCompaniesSheet(sheetOf([], ["Company name", "Address"]))).toEqual({
      ok: false,
      why: 'The Companies sheet has no "BRN" column. Use the companies template.',
    });
    expect(readCompaniesSheet(sheetOf([]))).toEqual({
      ok: false,
      why: "The Companies sheet has no companies in it.",
    });
    expect(
      readCompaniesSheet(sheetOf([["A", "C1234567"]], ["Company name", "BRN", "brn "])),
    ).toEqual({
      ok: false,
      why: 'The heading "brn" is there twice.',
    });
    expect(
      readCompaniesSheet(sheetOf([["A", "C1234567", "", "x"]], ["Company name", "BRN"])),
    ).toEqual({
      ok: false,
      why: "Column D has values but no heading in row 1.",
    });
  });
});

describe("the rows of the file", () => {
  it("ignores empty rows and gives each row its Excel row number", () => {
    const rows = read([row("A Ltd", "C1234567"), row("", ""), row("B Ltd", "C2345678")]);
    expect(rows.map((r) => [r.line, r.name])).toEqual([
      [2, "A Ltd"],
      [4, "B Ltd"],
    ]);
  });

  it("is a Problem with a missing name or BRN, or a BRN with odd characters", () => {
    const rows = read([
      row("", "C1234567"),
      row("A Ltd", "  "),
      row("B Ltd", "C123-4567"),
      row("", ""),
    ]);
    expect(rows.map((r) => r.problems)).toEqual([
      ["The company name is missing."],
      ["The BRN is missing."],
      ["The BRN has characters other than letters and digits."],
    ]);
  });

  it("only warns about a BRN that does not look like one (a letter, then 6 to 10 digits)", () => {
    const rows = read([
      row("A Ltd", "C123456"),
      row("B Ltd", "C12345678901"),
      row("C Ltd", "12345678"),
      row("D Ltd", "CC123456"),
    ]);
    expect(rows.map((r) => [r.problems, r.warning !== null])).toEqual([
      [[], false],
      [[], true],
      [[], true],
      [[], true],
    ]);
  });

  it("saves the BRN in capitals with every space removed", () => {
    expect(normaliseBrn(" c 070 12345 ")).toBe("C07012345");
    expect(read([row("A Ltd", " c 070 12345 ")])[0]).toMatchObject({
      brnTyped: "c 070 12345",
      brn: "C07012345",
    });
  });

  it("is a Problem with an unreadable value, or MRA details the database would refuse", () => {
    const [first, second] = read(
      [
        [...row("A Ltd", "C1234567"), { text: "#N/A", kind: "error" }],
        row("B Ltd", "C2345678", {
          ern: "01-33",
          telephone: "212/3456",
          mobile: "abc",
          declarant: "x".repeat(121),
        }),
      ],
      [...HEADINGS, "Contact"],
    );
    expect(first!.problems).toEqual(['The value in "Contact" can\'t be read (#N/A).']);
    expect(second!.problems).toEqual([
      "The ERN must be letters and digits only, at most 20.",
      "The telephone must be digits, spaces and + - ( ) only, at most 30.",
      "The mobile must be digits, spaces and + - ( ) only, at most 30.",
      "The name of the declarant must be at most 120 characters.",
    ]);
  });

  it("only notes a TAN or VAT typed as a number: the row stays ticked; an ERN stays a Problem", () => {
    const number = (value: string): XlsxCell => ({ text: value, kind: "number" });
    const rows = read([
      ["A Ltd", "C1234567", "", number("20123456"), number("123456")],
      ["B Ltd", "C2345678", "", "VAT20123456", "00123456", number("13341")],
    ]);
    expect(rows[0]!.problems).toEqual([]);
    expect(rows[0]!.notices).toEqual([
      "VAT was typed as a number, so leading zeros may be lost; check it.",
      "TAN was typed as a number, so leading zeros may be lost; check it.",
    ]);
    expect(rows[1]!.notices).toEqual([]);
    expect(rows[1]!.problems[0]).toMatch(/^The ERN is stored as a number/);
    expect(previewRows(rows, []).map((p) => [p.status, p.ticked])).toEqual([
      ["new", true],
      ["problem", false],
    ]);
  });

  it("makes every other heading a detail with that label, empty cells leaving it out", () => {
    const [first, second] = read(
      [
        [...row("A Ltd", "C1234567", { tan: "00123456" }), "Mrs Example", ""],
        [...row("B Ltd", "C2345678"), "", "Port Louis office"],
      ],
      [...HEADINGS, " Contact  person ", "Tax office"],
    );
    expect(first!.details).toEqual([
      { label: "TAN", value: "00123456" },
      { label: "Contact person", value: "Mrs Example" },
    ]);
    expect(second!.details).toEqual([{ label: "Tax office", value: "Port Louis office" }]);
  });
});

describe("the preview", () => {
  const memberships = [
    membership(1, "ABC Co Ltd", "C1234567"),
    membership(2, "XYZ Trading Ltd", "c 765 4321", "viewer"),
  ];

  it("skips a BRN already in the dashboard, capitals and spaces ignored, naming that company", () => {
    const preview = previewRows(
      read([
        row("ABC again", "c1234567"),
        row("XYZ again", "C 7654321"),
        row("New Ltd", "C1111111"),
      ]),
      memberships,
    );
    expect(preview.map((p) => [p.status, p.ticked, p.existingName])).toEqual([
      ["existing", false, "ABC Co Ltd"],
      ["existing", false, "XYZ Trading Ltd"],
      ["new", true, undefined],
    ]);
  });

  it("marks both rows of a BRN twice in the file: the first is created, the second skipped", () => {
    const preview = previewRows(
      read([
        row("First Ltd", "C2222222"),
        row("Other Ltd", "C3333333"),
        row("Second Ltd", "c 222 2222"),
      ]),
      memberships,
    );
    expect(preview.map((p) => [p.row.line, p.status, p.ticked, p.sameAs])).toEqual([
      [2, "new", true, [4]],
      [3, "new", true, undefined],
      [4, "twice", false, [2]],
    ]);
  });

  it("does not create a Problem row, and does not tick a BRN that only looks unusual", () => {
    const preview = previewRows(
      read([row("", "C2222222"), row("Odd Ltd", "2222222")]),
      memberships,
    );
    expect(preview.map((p) => [p.status, p.ticked])).toEqual([
      ["problem", false],
      ["new", false],
    ]);
  });
});

describe("the choices for the new companies", () => {
  const S1 = "20000000-0000-4000-8000-000000000001";
  const S2 = "20000000-0000-4000-8000-000000000002";
  const S3 = "20000000-0000-4000-8000-000000000003";
  const T1 = "30000000-0000-4000-8000-000000000001";
  const T2 = "30000000-0000-4000-8000-000000000002";
  const T3 = "30000000-0000-4000-8000-000000000003";
  const memberships = [1, 2, 3, 4]
    .map((n) => membership(n, `Co ${n}`, `C100000${n}`))
    .concat(membership(5, "Viewer Co", "C1000005", "viewer"));
  const setup = (sid: string, name: string) => ({
    id: sid,
    name,
    body: {},
    revision: 1,
    updated_by: null,
    updated_at: "2026-11-01T00:00:00Z",
  });
  const template = (tid: string, name: string) => ({
    id: tid,
    name,
    body: {},
    revision: 1,
    updated_by: null,
    updated_at: "2026-11-01T00:00:00Z",
  });
  const link = (tid: string, company: number) => ({
    template_id: tid,
    company_id: id(company),
    own_values: {},
    revision: 1,
    updated_by: null,
    updated_at: "2026-11-01T00:00:00Z",
  });

  function answer(options: { mraMissing?: boolean; t2Locked?: boolean } = {}) {
    fake.reset((calls) => {
      const from = fake.arg(calls, "from");
      const rpc = fake.arg(calls, "rpc");
      const args = fake.arg(calls, "rpc", 1) as Record<string, string> | undefined;
      if (from === "payroll_company_setups") {
        return {
          data: [
            { company_id: id(1), shared_setup_id: S2 },
            { company_id: id(2), shared_setup_id: S1 },
            { company_id: id(3), shared_setup_id: S1 },
            { company_id: id(4), shared_setup_id: S3 },
          ],
        };
      }
      if (from === "payroll_shared_setups") {
        const wanted = fake.arg(calls, "eq", 1);
        return {
          data: {
            [S1]: setup(S1, "Main setup"),
            [S2]: setup(S2, "Another setup"),
            [S3]: setup(S3, "Shared with others"),
          }[wanted as string],
        };
      }
      if (rpc === "payroll_shared_setup_access") {
        return { data: { can_change: args!.p_setup_id !== S3, companies: 1, admin_of: 1 } };
      }
      if (from === "mra_template_companies") {
        if (options.mraMissing) return { error: { code: "PGRST205", message: "no table" } };
        return { data: [link(T1, 1), link(T2, 1), link(T2, 2), link(T3, 2)] };
      }
      if (from === "mra_templates") {
        return {
          data: [
            template(T1, "MRA CSG (PACO)"),
            template(T2, "mra csg (paco) "),
            template(T3, "MRA PRGF"),
          ],
        };
      }
      if (rpc === "mra_template_access") {
        return {
          data: {
            can_change: !(options.t2Locked && args!.p_template_id === T2),
            companies: 1,
            admin_of: 1,
          },
        };
      }
      return { data: [] };
    });
  }

  it("offers the shared setups most used first, the default being the most used one you may use", async () => {
    answer();
    const choices = await loadImportChoices(VIEWER, memberships);
    expect(choices.setups.map((s) => [s.name, s.companies, s.canUse])).toEqual([
      ["Main setup", 2, true],
      ["Another setup", 1, true],
      ["Shared with others", 1, false],
    ]);
    expect(choices.defaultSetupId).toBe(S1);
    // Only the admin companies are asked about.
    const asked = fake.state.queries.find((q) => fake.arg(q, "from") === "payroll_company_setups")!;
    expect(fake.arg(asked, "in", 1)).toEqual([id(1), id(2), id(3), id(4)]);
  });

  it("offers the ready-made MRA templates you share: for each name the one most of your companies use", async () => {
    answer();
    const choices = await loadImportChoices(VIEWER, memberships);
    expect(choices.templates).toEqual([
      { id: T2, name: "mra csg (paco) " },
      { id: T3, name: "MRA PRGF" },
    ]);
  });

  it("passes over a template you may not use in another company, for the next most used", async () => {
    answer({ t2Locked: true });
    expect((await loadImportChoices(VIEWER, memberships)).templates).toEqual([
      { id: T1, name: "MRA CSG (PACO)" },
      { id: T3, name: "MRA PRGF" },
    ]);
  });

  it("offers none when MRA Returns is not set up in the database, and no setup when none is used", async () => {
    answer({ mraMissing: true });
    expect((await loadImportChoices(VIEWER, memberships)).templates).toEqual([]);
    fake.reset(() => ({ data: [] }));
    expect(await loadImportChoices(VIEWER, memberships)).toEqual({
      setups: [],
      defaultSetupId: null,
      templates: [],
    });
  });
});

describe("creating the companies", () => {
  const memberships = [membership(1, "ABC Co Ltd", "C1234567")];
  const choices = {
    sharedSetupId: "20000000-0000-4000-8000-000000000001",
    mraTemplateIds: ["30000000-0000-4000-8000-000000000001"],
  };

  it("creates the ticked rows one at a time; one failing does not stop the others", async () => {
    let call = 0;
    fake.reset((calls) => {
      const args = fake.arg(calls, "rpc", 1) as { p_name: string; p_brn: string };
      call += 1;
      if (call === 2) return { error: { code: "42501", message: "PH_NOT_ADMIN" } };
      return { data: { id: id(10 + call), name: args.p_name, brn: args.p_brn } };
    });
    const preview = previewRows(
      read([
        row("First Ltd", "c 111 1111", {
          tan: "00123",
          ern: "013341",
          telephone: "212 3456",
          declarant: "Jane",
        }),
        row("Second Ltd", "C2222222"),
        row("ABC again", "C1234567"),
        row("Third Ltd", "C3333333"),
        row("", "C4444444"),
        row("Unticked Ltd", "C5555555"),
      ]),
      memberships,
    );
    preview[5]!.ticked = false;
    const progress: [number, number][] = [];
    const lines = await runImport(VIEWER, preview, choices, (done, total) =>
      progress.push([done, total]),
    );

    expect(fake.state.queries.map((q) => fake.arg(q, "rpc"))).toEqual(
      Array(3).fill("create_company_with_details"),
    );
    expect(fake.arg(fake.state.queries[0]!, "rpc", 1)).toEqual({
      p_name: "First Ltd",
      p_brn: "C1111111",
      p_address: null,
      p_vat: null,
      p_details: [{ label: "TAN", value: "00123" }],
      p_mra: { ern: "013341", telephone: "212 3456", mobile: "", declarant: "Jane" },
      p_shared_setup_id: choices.sharedSetupId,
      p_mra_template_ids: choices.mraTemplateIds,
    });
    expect(progress).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(lines.map((l) => [l.line, l.name, l.result])).toEqual([
      [2, "First Ltd", "Created"],
      [3, "Second Ltd", "Problem"],
      [4, "ABC again", "Skipped"],
      [5, "Third Ltd", "Created"],
      [6, "", "Problem"],
      [7, "Unticked Ltd", "Skipped"],
    ]);
    expect(lines[1]!.why).toBe(
      "Not allowed: you must be an admin of a company, and of every company using the chosen column setup and MRA templates. Nothing of this company was created.",
    );
    expect(lines[2]!.why).toBe("Already in the dashboard as ABC Co Ltd.");
    expect(lines[4]!.why).toBe("The company name is missing.");
    expect(lines[5]!.why).toBe("Not ticked.");
  });

  it("explains each refusal of the database in words", () => {
    expect(
      importFailureReason({ code: "PGRST202", message: "Could not find the function" }),
    ).toContain("the owner needs to run supabase/migrations/0023_create_company_with_details.sql");
    expect(importFailureReason({ code: "23505", message: "PH_DUPLICATE_BRN" })).toBe(
      "A company with this BRN already exists (one you are not a member of, or one added since the preview).",
    );
    expect(importFailureReason({ code: "P0002", message: "PH_NOT_FOUND" })).toBe(
      "The chosen column setup or MRA templates can no longer be found.",
    );
    expect(
      importFailureReason({
        code: "22023",
        message: "PH_INVALID_INPUT: the BRN must be letters and digits only",
      }),
    ).toBe("The database refused a value: the BRN must be letters and digits only.");
  });

  it("writes the report as an Excel file with a line per row", async () => {
    const report = buildReport([
      { line: 2, name: "First Ltd", brn: "C0111111", result: "Created", why: "" },
      {
        line: 3,
        name: "ABC again",
        brn: "C1234567",
        result: "Skipped",
        why: "Already in the dashboard as ABC Co Ltd.",
      },
    ]);
    const cells = (await readXlsxSheet(report, "Report"))!.map((r) => r.map((c) => c?.text ?? ""));
    expect(cells).toEqual([
      ["Row", "Company name", "BRN", "Result", "Why", "Before", "After"],
      ["2", "First Ltd", "C0111111", "Created"],
      ["3", "ABC again", "C1234567", "Skipped", "Already in the dashboard as ABC Co Ltd."],
    ]);
  });
});
