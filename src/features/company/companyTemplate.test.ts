// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Membership } from "@/lib/supabase/schemas";
import { readXlsxSheet } from "@/lib/xlsx/readXlsx";

vi.mock("@/lib/supabase/client", async () => ({
  supabase: (await import("@/test/fakeClient")).fake.client,
}));
const { fake } = await import("@/test/fakeClient");
const {
  buildFilledTemplate,
  buildReport,
  buildTemplate,
  companiesForTemplate,
  filledTemplateFileName,
  previewRows,
  readCompaniesFile,
  runImport,
  updateLine,
} = await import("./companyImport");
const { compareRow, fetchAdminCompanies } = await import("./companyUpdate");
type CurrentCompany = import("./companyUpdate").CurrentCompany;
type FileRow = import("./companyImport").FileRow;

// The template filled in with the companies the user is admin of, and what uploading it again
// does. TEST companies only.

const VIEWER = { id: "00000000-0000-4000-8000-0000000000a1", isDemo: false };
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const detailId = (n: number) => `50000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const AT = new Date(2026, 10, 5, 10, 15);
const NO_CHOICES = { sharedSetupId: null, mraTemplateIds: [] };

const membership = (
  n: number,
  name: string,
  brn: string | null,
  role: Membership["role"] = "admin",
): Membership => ({ role, company: { id: id(n), name, address: null, brn, vat: null } });

const asFile = (bytes: Uint8Array) => ({
  size: bytes.length,
  arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
});
const cellsOf = async (bytes: Uint8Array, sheet: string) =>
  (await readXlsxSheet(bytes, sheet))!.map((row) => row.map((cell) => cell?.text ?? ""));

/** TEST Alpha: everything filled in, a multi-line address, leading zeros, a sensitive detail. */
const ALPHA: CurrentCompany = {
  id: id(1),
  name: "TEST Alpha Ltd",
  brn: "C0000101",
  address: "1 Test Street\nTestville",
  vat: "0012345",
  details: [
    { id: detailId(1), label: "TAN", value: "00123", sensitive: false, sortOrder: 0 },
    { id: detailId(2), label: "Tax office", value: "Port Louis", sensitive: false, sortOrder: 1 },
    { id: detailId(3), label: "Bank account", value: null, sensitive: true, sortOrder: 2 },
  ],
  mra: { ern: "013341", telephone: "212 3456", mobile: "", declarant: "Jane Test", revision: 3 },
};
/** TEST Beta: few details, no MRA details, a detail Alpha does not have. */
const BETA: CurrentCompany = {
  id: id(2),
  name: "TEST Beta Ltd",
  brn: "C0000102",
  address: null,
  vat: null,
  details: [
    { id: detailId(4), label: "Year end", value: "30 June", sensitive: false, sortOrder: 0 },
  ],
  mra: null,
};
/** TEST Gamma: no BRN, so it cannot be in the file. */
const GAMMA: CurrentCompany = {
  ...BETA,
  id: id(3),
  name: "TEST Gamma Ltd",
  brn: null,
  details: [],
};

async function previewOf(bytes: Uint8Array, memberships: Membership[], admin: CurrentCompany[]) {
  const result = await readCompaniesFile(asFile(bytes));
  if (!result.ok) throw new Error(result.why);
  return previewRows(result.rows, memberships, admin);
}

beforeEach(() => fake.reset());

describe("reading the companies you are admin of", () => {
  it("asks only for the companies you are admin of, never a sensitive value", async () => {
    fake.reset((calls) => {
      const from = fake.arg(calls, "from");
      const sensitive = calls.some(([m, col, v]) => m === "eq" && col === "is_sensitive" && v);
      if (from === "companies")
        return {
          data: [{ id: id(1), name: "TEST Alpha Ltd", address: null, brn: "C0000101", vat: null }],
        };
      if (from === "company_details" && sensitive)
        return {
          data: [{ id: detailId(3), company_id: id(1), label: "Bank account", sort_order: 2 }],
        };
      if (from === "company_details")
        return {
          data: [
            { id: detailId(1), company_id: id(1), label: "TAN", value: "00123", sort_order: 0 },
          ],
        };
      if (from === "mra_company_details") {
        return {
          data: [
            {
              company_id: id(1),
              ern: "013341",
              telephone: "",
              mobile: "",
              declarant: "",
              revision: 2,
            },
          ],
        };
      }
      return { data: [] };
    });
    const companies = await fetchAdminCompanies(VIEWER, [
      membership(1, "TEST Alpha Ltd", "C0000101"),
      membership(2, "TEST Viewer Ltd", "C0000202", "viewer"),
    ]);

    // Every read is for company 1 only.
    for (const query of fake.state.queries) {
      const inCall = query.find(([method]) => method === "in")!;
      expect(inCall[2], JSON.stringify(query)).toEqual([id(1)]);
    }
    // The read of sensitive details asks for their labels, not their values.
    const sensitiveRead = fake.state.queries.find((q) =>
      q.some(([m, col, v]) => m === "eq" && col === "is_sensitive" && v === true),
    )!;
    expect(fake.arg(sensitiveRead, "select")).not.toMatch(/value/);
    expect(companies).toEqual([
      {
        id: id(1),
        name: "TEST Alpha Ltd",
        brn: "C0000101",
        address: null,
        vat: null,
        details: [
          { id: detailId(1), label: "TAN", value: "00123", sensitive: false, sortOrder: 0 },
          { id: detailId(3), label: "Bank account", value: null, sensitive: true, sortOrder: 2 },
        ],
        mra: { ern: "013341", telephone: "", mobile: "", declarant: "", revision: 2 },
      },
    ]);
  });

  it("asks for nothing when you are admin of none", async () => {
    expect(
      await fetchAdminCompanies(VIEWER, [membership(2, "TEST Viewer Ltd", "C0000202", "viewer")]),
    ).toEqual([]);
    expect(fake.state.queries).toHaveLength(0);
  });
});

describe("the template with my companies", () => {
  it("has one row per company with a BRN, by name, with its details; never a sensitive one", async () => {
    const bytes = buildFilledTemplate([BETA, GAMMA, ALPHA], AT);
    expect(await cellsOf(bytes, "Companies")).toEqual([
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
        "Tax office",
        "Year end",
      ],
      [
        "TEST Alpha Ltd",
        "C0000101",
        "1 Test Street\nTestville",
        "0012345",
        "00123",
        "013341",
        "212 3456",
        "",
        "Jane Test",
        "Port Louis",
      ],
      ["TEST Beta Ltd", "C0000102", "", "", "", "", "", "", "", "", "30 June"],
    ]);
    const all =
      JSON.stringify(await cellsOf(bytes, "Read me")) +
      JSON.stringify(await cellsOf(bytes, "Companies"));
    expect(all).not.toContain("Bank account");
    expect(all).not.toContain("TEST Gamma");
  });

  it("says in its Read me when it was filled in, with how many companies", async () => {
    const readMe = await cellsOf(buildFilledTemplate([ALPHA, BETA], AT), "Read me");
    expect(readMe[0]).toEqual(["Companies template with my companies"]);
    expect(readMe[2]).toEqual([
      "Filled in on 5 November 2026 with the 2 companies you are admin of. Sensitive details are not included.",
    ]);
    expect(readMe.flat()).toContain(
      "A row whose BRN is a company you are admin of shows its changes in the preview and is updated only if you tick it. An empty cell leaves the value as it is.",
    );
  });

  it("leaves the blank template with no company, and the same columns", async () => {
    const blank = buildTemplate(AT);
    expect(await cellsOf(blank, "Companies")).toHaveLength(1);
    expect((await cellsOf(blank, "Read me"))[0]).toEqual(["Companies template"]);
  });

  it("leaves out companies with no BRN, and those after the first 200 by name", () => {
    const many = Array.from({ length: 203 }, (_, n) => ({
      ...BETA,
      id: id(100 + n),
      name: `TEST ${String(n).padStart(3, "0")} Ltd`,
      brn: `C${String(9000000 + n)}`,
    }));
    const { inFile, noBrn, overLimit } = companiesForTemplate([...many, GAMMA]);
    expect([inFile.length, noBrn, overLimit]).toEqual([200, 1, 3]);
    expect(inFile.at(-1)!.name).toBe("TEST 199 Ltd");
  });

  it("leaves out, and names, a detail whose label is a column of the template", async () => {
    const clash: CurrentCompany = {
      ...BETA,
      details: [{ id: detailId(9), label: "vat", value: "x", sensitive: false, sortOrder: 0 }],
    };
    const bytes = buildFilledTemplate([clash], AT);
    expect((await cellsOf(bytes, "Companies"))[0]).toHaveLength(9);
    expect((await cellsOf(bytes, "Read me"))[3]).toEqual([
      "Not in this file: the details labelled vat, because a column of the template already has that heading.",
    ]);
  });

  it("is named after the day", () => {
    expect(filledTemplateFileName(AT)).toBe("My companies 2026-11-05.xlsx");
  });
});

describe("uploading it again", () => {
  const memberships = [
    membership(1, "TEST Alpha Ltd", "C0000101"),
    membership(2, "TEST Beta Ltd", "C0000102"),
  ];

  it("changes nothing when uploaded untouched: every row is No changes", async () => {
    const preview = await previewOf(buildFilledTemplate([ALPHA, BETA], AT), memberships, [
      ALPHA,
      BETA,
    ]);
    expect(preview.map((item) => [item.row.name, item.status, item.ticked])).toEqual([
      ["TEST Alpha Ltd", "same", false],
      ["TEST Beta Ltd", "same", false],
    ]);
    expect(preview[0]!.comparison).toEqual({ changes: [], leftAsIs: [], sensitive: [] });
  });

  it("ignores Windows line breaks and spaces at the ends when comparing", () => {
    const company = { ...ALPHA, address: "1 Test Street\r\nTestville " };
    const row = rowOf({ address: "1 Test Street\nTestville" });
    expect(compareRow(row, company).changes).toEqual([]);
  });

  it("shows each change as before and after, and leaves the row unticked", async () => {
    const row = rowOf({
      name: "TEST Alpha Trading Ltd",
      address: "2 New Street",
      details: [
        { label: "TAN", value: "00124" },
        { label: "tax office", value: "Port Louis" },
        { label: "Website", value: "test.example" },
      ],
      mra: { ern: "013341", telephone: "", mobile: "5 700 0000", declarant: "Jane Test" },
    });
    const [item] = previewRows([row], memberships, [ALPHA]);
    expect(item!.status).toBe("update");
    expect(item!.ticked).toBe(false);
    expect(item!.comparison!.changes).toEqual([
      {
        kind: "core",
        field: "name",
        label: "Name",
        before: "TEST Alpha Ltd",
        after: "TEST Alpha Trading Ltd",
      },
      {
        kind: "core",
        field: "address",
        label: "Address",
        before: "1 Test Street\nTestville",
        after: "2 New Street",
      },
      { kind: "detail", id: detailId(1), label: "TAN", before: "00123", after: "00124" },
      { kind: "detail", id: null, label: "Website", before: null, after: "test.example" },
      { kind: "mra", field: "mobile", label: "Mobile", before: "", after: "5 700 0000" },
    ]);
    // The telephone is empty in the file: left as it is.
    expect(item!.comparison!.leftAsIs).toEqual(["Telephone"]);
  });

  it("never changes a sensitive detail, and says so", () => {
    const row = rowOf({ details: [{ label: "Bank account", value: "123" }] });
    const comparison = compareRow(row, ALPHA);
    expect(comparison.changes).toEqual([]);
    expect(comparison.sensitive).toEqual(["Bank account"]);
  });

  it("leaves a value as it is when its cell is empty", () => {
    const row = rowOf({
      address: null,
      vat: null,
      details: [],
      emptyDetails: ["TAN", "Tax office"],
      mra: { ern: "", telephone: "", mobile: "", declarant: "" },
    });
    const comparison = compareRow(row, ALPHA);
    expect(comparison.changes).toEqual([]);
    expect(comparison.leftAsIs).toEqual([
      "Address",
      "VAT",
      "TAN",
      "Tax office",
      "ERN",
      "Telephone",
      "Name of declarant",
    ]);
  });

  it("skips a company you are only a member of, and a second row of a company you update", () => {
    const rows = [
      rowOf({ line: 2, name: "TEST Alpha new name" }),
      rowOf({ line: 3, name: "TEST Alpha again" }),
      rowOf({ line: 4, name: "TEST Viewer Ltd", brn: "C0000202" }),
    ];
    const preview = previewRows(
      rows,
      [...memberships, membership(5, "TEST Viewer Ltd", "C0000202", "viewer")],
      [ALPHA],
    );
    expect(preview.map((item) => [item.status, item.sameAs, item.existingName])).toEqual([
      ["update", [3], undefined],
      ["twice", [2], undefined],
      ["existing", undefined, "TEST Viewer Ltd"],
    ]);
  });
});

describe("updating", () => {
  const memberships = [membership(1, "TEST Alpha Ltd", "C0000101")];
  const changed = rowOf({
    address: "2 New Street",
    details: [
      { label: "TAN", value: "00124" },
      { label: "Website", value: "test.example" },
    ],
    mra: { ern: "013342", telephone: "212 3456", mobile: "", declarant: "Jane Test" },
  });
  const ticked = () => {
    const preview = previewRows([changed], memberships, [ALPHA]);
    preview[0]!.ticked = true;
    return preview;
  };

  it("writes nothing for a row that is not ticked", async () => {
    const lines = await runImport(VIEWER, previewRows([changed], memberships, [ALPHA]), NO_CHOICES);
    expect(fake.state.queries).toHaveLength(0);
    expect(lines[0]).toMatchObject({ result: "Skipped", why: "Not ticked." });
  });

  it("writes each step only if it is still what the preview showed, and reports before and after", async () => {
    fake.reset((calls) => {
      if (fake.arg(calls, "rpc") === "save_mra_company_details") {
        return {
          data: {
            company_id: id(1),
            ern: "013342",
            telephone: "212 3456",
            mobile: "",
            declarant: "Jane Test",
            revision: 4,
            updated_at: "2026-11-05T10:00:00Z",
          },
        };
      }
      return { data: [{ id: id(1) }] };
    });
    const progress: unknown[] = [];
    const lines = await runImport(VIEWER, ticked(), NO_CHOICES, (...args) => progress.push(args));
    const [core, tan, website, mra] = fake.state.queries;

    // Name, address and VAT: one statement, only if all three are still as they were.
    expect(fake.arg(core!, "from")).toBe("companies");
    expect(fake.arg(core!, "update")).toEqual({
      name: "TEST Alpha Ltd",
      address: "2 New Street",
      vat: "0012345",
    });
    expect(core!.filter(([m]) => m === "eq" || m === "is")).toEqual([
      ["eq", "id", id(1)],
      ["eq", "name", "TEST Alpha Ltd"],
      ["eq", "address", "1 Test Street\nTestville"],
      ["eq", "vat", "0012345"],
    ]);
    // A detail: only if its value is still the old one, and it is not sensitive.
    expect(fake.arg(tan!, "update")).toEqual({ value: "00124" });
    expect(tan!.filter(([m]) => m === "eq")).toEqual([
      ["eq", "id", detailId(1)],
      ["eq", "is_sensitive", false],
      ["eq", "value", "00123"],
    ]);
    // A new detail: added after the others, not sensitive.
    expect(fake.arg(website!, "insert")).toEqual({
      label: "Website",
      value: "test.example",
      field_type: "text",
      is_sensitive: false,
      company_id: id(1),
      sort_order: 3,
    });
    // The MRA details: all four, over the revision the preview read.
    expect(fake.arg(mra!, "rpc", 1)).toEqual({
      p_company_id: id(1),
      p_ern: "013342",
      p_telephone: "212 3456",
      p_mobile: "",
      p_declarant: "Jane Test",
      p_expected_revision: 3,
    });
    expect(lines[0]).toEqual({
      line: 2,
      name: "TEST Alpha Ltd",
      brn: "C0000101",
      result: "Updated",
      why: "Changes: Address: 1 Test Street, Testville → 2 New Street; TAN: 00123 → 00124; Website: (empty) → test.example; ERN: 013341 → 013342.",
      before: "Address: 1 Test Street\nTestville\nTAN: 00123\nWebsite: (empty)\nERN: 013341",
      after: "Address: 2 New Street\nTAN: 00124\nWebsite: test.example\nERN: 013342",
    });
    expect(progress).toEqual([
      [0, 1, "update"],
      [1, 1, null],
    ]);
  });

  it("does not overwrite a company changed after the preview", async () => {
    fake.reset(() => ({ data: [] })); // the old values are no longer there: no row changed
    const lines = await runImport(VIEWER, ticked(), NO_CHOICES);
    expect(fake.state.queries).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      result: "Problem",
      why: "Not updated: it was changed in the dashboard after the preview. Upload the file again.",
    });
    expect(lines[0]!.before).toBeUndefined();
  });

  it("says exactly what was saved when a later step is refused", async () => {
    fake.reset((calls) => {
      if (fake.arg(calls, "rpc") === "save_mra_company_details")
        return { error: { code: "P0001", message: "PH_STALE" } };
      if (fake.arg(calls, "insert")) return { error: { code: "23505", message: "duplicate key" } };
      return { data: [{ id: id(1) }] };
    });
    const lines = await runImport(VIEWER, ticked(), NO_CHOICES);
    // It stops at the refused detail: the MRA details are not even tried.
    expect(fake.state.queries.map((q) => fake.arg(q, "from") ?? fake.arg(q, "rpc"))).toEqual([
      "companies",
      "company_details",
      "company_details",
    ]);
    expect(lines[0]).toMatchObject({
      result: "Problem",
      why: "Updated: address, TAN. Not updated: Website, ERN (it was changed in the dashboard after the preview).",
      before: "Address: 1 Test Street\nTestville\nTAN: 00123",
      after: "Address: 2 New Street\nTAN: 00124",
    });
  });

  it("writes Before and After in the report file", async () => {
    const report = buildReport([
      updateLine(
        { line: 2, name: "TEST Alpha Ltd", brn: "C0000101" },
        {
          saved: [{ kind: "core", field: "vat", label: "VAT", before: null, after: "V1" }],
          notSaved: [],
          why: null,
          stale: false,
        },
      ),
    ]);
    expect(await cellsOf(report, "Report")).toEqual([
      ["Row", "Company name", "BRN", "Result", "Why", "Before", "After"],
      [
        "2",
        "TEST Alpha Ltd",
        "C0000101",
        "Updated",
        "Changes: VAT: (empty) → V1.",
        "VAT: (empty)",
        "VAT: V1",
      ],
    ]);
  });
});

/** A row of the file, as read, for TEST Alpha unless said otherwise. */
function rowOf(more: Partial<FileRow>): FileRow {
  return {
    line: 2,
    name: "TEST Alpha Ltd",
    brnTyped: "C0000101",
    brn: more.brn ?? "C0000101",
    address: "1 Test Street\nTestville",
    vat: "0012345",
    details: [
      { label: "TAN", value: "00123" },
      { label: "Tax office", value: "Port Louis" },
    ],
    emptyDetails: [],
    mra: { ern: "013341", telephone: "212 3456", mobile: "", declarant: "Jane Test" },
    problems: [],
    warning: null,
    notices: [],
    ...more,
  };
}
