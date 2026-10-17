// The non-member check: every table, database function and storage bucket the dashboard uses,
// tried by someone who is signed in but belongs to no company, and by an anonymous visitor.
// Reads must return nothing or be refused; writes must be refused.
//
// Writes are aimed only at the two TEST companies given to the script, and each is shaped so
// that even a failed protection stores nothing that cannot be found again:
//  - inserts carry the marker "SAFETY CHECK" and an invalid value where the table allows one;
//  - updates set a column to the value it already has (company_id = company_id), so even if one
//    went through, nothing would change; the count of rows matched is what shows the hole;
//  - deletes are limited to one row;
//  - function calls carry one deliberately invalid argument, checked by the function only AFTER
//    its permission check, so a refusal for that argument means the permission check failed.
//
// A new table, function or bucket in a migration must be added here: nonmemberChecks.test.ts
// reads the migrations and fails until it is.

import {
  judgeRead,
  judgeReadCall,
  judgeStorageRead,
  judgeStorageRemove,
  judgeStorageWrite,
  judgeWrite,
  judgeWriteCall,
  type Action,
  type ApiResult,
  type Row,
  type Verdict,
  type Who,
} from "./outcome.ts";

/** Equality and membership filters, the only two the checks use. */
export type Filter = { column: string; op: "eq"; value: string } | { column: string; op: "in"; value: string[] };

/** What the checks need from a Supabase client. scripts/lib/supabaseApi.mjs adapts the real one;
 * the tests use a fake that records every request. */
export interface Api {
  read(table: string): Promise<ApiResult>;
  insert(table: string, row: Record<string, unknown>): Promise<ApiResult>;
  update(table: string, values: Record<string, unknown>, filters: Filter[]): Promise<ApiResult>;
  /** `limitOneBy`: delete at most one row, ordered by that column. */
  remove(table: string, filters: Filter[], limitOneBy: string | null): Promise<ApiResult>;
  rpc(name: string, args: Record<string, unknown>): Promise<ApiResult>;
  storageList(bucket: string, prefix: string): Promise<ApiResult>;
  storageDownload(bucket: string, path: string): Promise<ApiResult>;
  storageUpload(bucket: string, path: string, bytes: Uint8Array): Promise<ApiResult>;
  storageUpdate(bucket: string, path: string, bytes: Uint8Array): Promise<ApiResult>;
  storageRemove(bucket: string, paths: string[]): Promise<ApiResult>;
  listBuckets(): Promise<ApiResult>;
  getBucket(id: string): Promise<ApiResult>;
}

export const ZERO_ID = "00000000-0000-0000-0000-000000000000";
export const MARKER = "SAFETY CHECK";
/** The two TEST companies' names, from the dashboard. Used only in the no-change update of `companies`. */
export const TEST_COMPANY_NAMES = ["TEST Co Ltd", "TEST Co 2 Ltd"] as const;
/** The file name the storage write attempts use: <company id>/<this>.pdf. */
export const SAFETY_FILE_HASH = "5afe".repeat(16);
/** A minimal PDF, so the attempt is refused for who is asking, not for what it sends. */
export const SAFETY_PDF = new TextEncoder().encode("%PDF-1.4\n% SAFETY CHECK: must never be stored\n%%EOF\n");
export const BUCKET = "pdf-forms";

interface TableSpec {
  /** The column that names the company, if the table has one. */
  companyColumn: "id" | "company_id" | null;
  /** True where `authenticated` has a write grant and row-level security alone decides. */
  rlsWrites: boolean;
  /** A row to try to insert, for the TEST company `company`. */
  insert: (company: string, self: string | null) => Record<string, unknown>;
}

const fakePerson = (company: string) => ({
  company_id: company,
  national_id: "SAFETY-CHECK-0000",
  surname: MARKER,
  other_names: "NOT A PERSON",
});

/** Every table in supabase/migrations. Tables whose writes go only through functions have no
 * insert, update or delete grant, so `revision: 0` (refused by their checks) is a second guard. */
export const TABLES: Record<string, TableSpec> = {
  companies: { companyColumn: "id", rlsWrites: false, insert: () => ({ name: MARKER, brn: null }) },
  company_members: {
    companyColumn: "company_id",
    rlsWrites: false,
    // The attack that matters most: making oneself an admin.
    insert: (company, self) => ({ company_id: company, user_id: self ?? ZERO_ID, role: "admin" }),
  },
  employees: { companyColumn: "company_id", rlsWrites: true, insert: fakePerson },
  payroll_runs: {
    companyColumn: "company_id",
    rlsWrites: true,
    insert: (company) => ({ company_id: company, period: "2000-01-01", status: "draft" }),
  },
  payroll_entries: {
    companyColumn: null,
    rlsWrites: true,
    insert: () => ({ run_id: ZERO_ID, employee_id: ZERO_ID, extra: { marker: MARKER } }),
  },
  company_details: {
    companyColumn: "company_id",
    rlsWrites: true,
    insert: (company) => ({ company_id: company, label: MARKER, value: "must never be stored" }),
  },
  company_links: {
    companyColumn: "company_id",
    rlsWrites: true,
    insert: (company) => ({ company_id: company, title: MARKER, url: "https://example.com/safety-check" }),
  },
  statutory_rates: {
    companyColumn: "company_id",
    rlsWrites: false,
    insert: (company) => ({ company_id: company, effective_from: "2000-01-01", revision: 0, source_note: MARKER }),
  },
  payslip_templates: {
    companyColumn: "company_id",
    rlsWrites: false,
    insert: (company) => ({ company_id: company, name: MARKER, draft_body: {}, draft_revision: 0 }),
  },
  payslip_template_versions: {
    companyColumn: "company_id",
    rlsWrites: false,
    insert: (company) => ({ company_id: company, template_id: ZERO_ID, version: 0, name: MARKER, body: {} }),
  },
  issued_payslips: {
    companyColumn: "company_id",
    rlsWrites: false,
    insert: (company) => ({ company_id: company, employee_id: ZERO_ID, period: "2000-01-01", revision: 0 }),
  },
  pdf_templates: {
    companyColumn: "company_id",
    rlsWrites: false,
    insert: (company) => ({ company_id: company, name: MARKER, body: {}, revision: 0 }),
  },
  pdf_template_history: {
    companyColumn: "company_id",
    rlsWrites: false,
    insert: (company) => ({ company_id: company, template_id: ZERO_ID, revision: 0, name: MARKER }),
  },
  payroll_shared_setups: {
    companyColumn: null,
    rlsWrites: false,
    insert: () => ({ id: ZERO_ID, name: MARKER, body: {}, revision: 0 }),
  },
  payroll_shared_setup_history: {
    companyColumn: null,
    rlsWrites: false,
    insert: () => ({ shared_setup_id: ZERO_ID, revision: 0, name: MARKER, body: {} }),
  },
  payroll_company_setups: {
    companyColumn: "company_id",
    rlsWrites: false,
    insert: (company) => ({ company_id: company, shared_setup_id: ZERO_ID, body: {}, revision: 0 }),
  },
  payroll_company_setup_history: {
    companyColumn: "company_id",
    rlsWrites: false,
    insert: (company) => ({ company_id: company, shared_setup_id: ZERO_ID, body: {}, revision: 0 }),
  },
  payroll_months: {
    companyColumn: "company_id",
    rlsWrites: false,
    insert: (company) => ({ company_id: company, period: "2000-01-01", revision: 0, employees: [] }),
  },
  payroll_month_history: {
    companyColumn: "company_id",
    rlsWrites: false,
    insert: (company) => ({ company_id: company, period: "2000-01-01", revision: 0 }),
  },
};

/** For a table with no company column: a filter that names one row that does not exist. */
const NO_COMPANY_FILTER: Record<string, Filter> = {
  payroll_entries: { column: "run_id", op: "eq", value: ZERO_ID },
  payroll_shared_setups: { column: "id", op: "eq", value: ZERO_ID },
  payroll_shared_setup_history: { column: "shared_setup_id", op: "eq", value: ZERO_ID },
};

/** Why some table checks prove less than the others. */
export const LIMITS: Record<string, string> = {
  payroll_entries:
    "rows have no company column and a non-member cannot find a TEST run id, so update and delete are aimed at a run that does not exist (0 rows either way)",
};

type Refusal =
  | { kind: "write"; refusals: readonly string[] }
  | { kind: "read"; ok: (data: unknown) => boolean; expected: string };

interface FunctionSpec {
  args: (t: { a: string; b: string }) => Record<string, unknown>;
  expect: Refusal;
}

const NOT_ADMIN = { kind: "write", refusals: ["PH_NOT_ADMIN", "PH_NOT_SIGNED_IN"] } as const satisfies Refusal;
const isFalse = (data: unknown) => data === false;

/** Compares JSON by content: the database returns an object's keys in its own order. */
function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => sameJson(item, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    return (
      sameJson(keysA, keysB) &&
      keysA.every((key) => sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
    );
  }
  return a === b;
}

/** The id of the shared setup the creation attempt names. Not a company. */
export const SAFETY_SETUP_ID = "5afe5afe-5afe-45af-85af-5afe5afe5afe";

/**
 * Every function `authenticated` may run (and the helpers it may not), with arguments aimed at
 * the TEST companies. The comment on each write says which argument is the second guard.
 */
export const FUNCTIONS: Record<string, FunctionSpec> = {
  // ---------- reads and helpers ----------
  is_company_member: { args: (t) => ({ cid: t.a }), expect: { kind: "read", ok: isFalse, expected: "false or refused" } },
  is_company_admin: { args: (t) => ({ cid: t.a }), expect: { kind: "read", ok: isFalse, expected: "false or refused" } },
  can_read_payroll_shared_setup: {
    args: () => ({ p_setup_id: ZERO_ID }),
    expect: { kind: "read", ok: isFalse, expected: "false or refused" },
  },
  can_change_payroll_shared_setup: {
    args: () => ({ p_setup_id: ZERO_ID }),
    expect: { kind: "read", ok: isFalse, expected: "false or refused" },
  },
  payroll_shared_setup_access: {
    args: () => ({ p_setup_id: ZERO_ID }),
    expect: {
      kind: "read",
      ok: (data) => sameJson(data, { can_change: false, companies: 0, admin_of: 0 }),
      expected: "no access, 0 companies, or refused",
    },
  },
  issued_payslips_for_month: {
    args: (t) => ({ p_company_id: t.a, p_period: "2026-09-01" }),
    expect: { kind: "read", ok: (data) => Array.isArray(data) && data.length === 0, expected: "[] or refused" },
  },
  pdf_form_company: {
    // Pure: it reads the company id out of the file name it is given, and touches no table.
    args: (t) => ({ object_name: `${t.a}/${SAFETY_FILE_HASH}.pdf` }),
    expect: { kind: "read", ok: () => true, expected: "only the id it was given, or refused" },
  },
  // The keep-awake job's function (0015): open to anon on purpose, reads nothing, answers true.
  keep_awake: { args: () => ({}), expect: { kind: "read", ok: (data) => data === true, expected: "true, or refused" } },
  set_updated_at: {
    args: () => ({}),
    expect: { kind: "read", ok: () => false, expected: "refused (trigger only)" },
  },
  payroll_month_employee_count: {
    args: () => ({ p_employees: [] }),
    expect: { kind: "read", ok: () => false, expected: "refused (internal)" },
  },
  payroll_month_value_keys: {
    args: () => ({ p_employees: [] }),
    expect: { kind: "read", ok: () => false, expected: "refused (internal)" },
  },
  payroll_month_rename_key: {
    args: () => ({ p_employees: [], p_old: "safetyCheckOld", p_new: "safetyCheckNew" }),
    expect: { kind: "read", ok: () => false, expected: "refused (internal)" },
  },

  // ---------- writes ----------
  // Guard: no rows.
  import_payroll_run: { args: (t) => ({ p_company_id: t.a, p_period: "2026-09-01", p_rows: [], p_replace: false }), expect: NOT_ADMIN },
  // Guard: no name and no BRN. (It adds a company, so it cannot be aimed at a TEST company.)
  create_company: { args: () => ({ p_name: "", p_address: null, p_brn: "", p_vat: null }), expect: NOT_ADMIN },
  // Guard: the typed name is not the company's.
  delete_company: { args: (t) => ({ p_company_id: t.a, p_confirm_name: `${MARKER}: not the company name` }), expect: NOT_ADMIN },
  // Guard: the 15th is not the first day of a month.
  save_statutory_rates: {
    args: (t) => ({
      p_company_id: t.a,
      p_effective_from: "2026-09-15",
      p_expected_revision: 0,
      p_nsf_employee_rate: 1,
      p_nsf_ceiling: 29710,
      p_nsf_exempt_at_60: true,
      p_csg_employee_rate_low: 1.5,
      p_csg_employee_rate_high: 3,
      p_csg_threshold: 50000,
      p_source_note: MARKER,
    }),
    expect: NOT_ADMIN,
  },
  // Guard: no name.
  save_payslip_template_draft: {
    args: (t) => ({ p_company_id: t.a, p_template_id: null, p_name: "", p_body: {}, p_expected_revision: 0 }),
    expect: NOT_ADMIN,
  },
  // Guard: no template.
  publish_payslip_template: {
    args: (t) => ({ p_company_id: t.a, p_template_id: null, p_expected_revision: null }),
    expect: NOT_ADMIN,
  },
  // Guard: the 15th is not the first day of a month.
  issue_payslips: { args: (t) => ({ p_company_id: t.a, p_period: "2026-09-15", p_payslips: [] }), expect: NOT_ADMIN },
  // Guard: no template id.
  save_pdf_template: {
    args: (t) => ({
      p_company_id: t.a,
      p_template_id: null,
      p_name: "",
      p_body: {},
      p_expected_revision: 0,
      p_pdf_sha256: "",
      p_pdf_file_name: "",
      p_pdf_bytes: 0,
      p_pdf_pages: 0,
    }),
    expect: NOT_ADMIN,
  },
  // Guard: no template.
  restore_pdf_template: {
    args: (t) => ({ p_company_id: t.a, p_template_id: null, p_revision: null, p_expected_revision: null }),
    expect: NOT_ADMIN,
  },
  // Guard: no template. From one TEST company to the other.
  copy_pdf_template: {
    args: (t) => ({ p_from_company_id: t.b, p_template_id: null, p_to_company_id: t.a, p_new_template_id: null, p_name: "" }),
    expect: NOT_ADMIN,
  },
  // Guard: no template.
  delete_pdf_template: { args: (t) => ({ p_company_id: t.a, p_template_id: null, p_expected_revision: null }), expect: NOT_ADMIN },
  // A change of an existing setup (expected revision 1); the attempt to CREATE one is in
  // EXTRA_CALLS. A setup that does not exist is "not found".
  save_payroll_shared_setup: {
    args: () => ({ p_setup_id: ZERO_ID, p_name: MARKER, p_body: {}, p_expected_revision: 1, p_companies: [] }),
    expect: { kind: "write", refusals: ["PH_NOT_FOUND", "PH_NOT_ADMIN", "PH_NOT_SIGNED_IN"] },
  },
  // Guard: the body is a list, not an object.
  save_payroll_company_setup: { args: (t) => ({ p_company_id: t.a, p_body: [], p_expected_revision: 1 }), expect: NOT_ADMIN },
  // Guard: no shared setup.
  attach_payroll_company: { args: (t) => ({ p_company_id: t.a, p_shared_setup_id: null, p_body: {} }), expect: NOT_ADMIN },
  // Guard: the 15th is not the first day of a month.
  save_payroll_month: {
    args: (t) => ({
      p_company_id: t.a,
      p_period: "2026-09-15",
      p_employees: [],
      p_expected_revision: 0,
      p_shared_revision: 1,
      p_company_revision: 1,
    }),
    expect: NOT_ADMIN,
  },
  // Its company setup save checks the admin first. Guard: that body is a list, not an object.
  save_payroll_key_change: {
    args: (t) => ({
      p_moves: [{ company_id: t.a, old_key: "safetyCheckOld", new_key: "safetyCheckNew" }],
      p_shared: null,
      p_company: { company_id: t.a, body: [], expected_revision: 1 },
    }),
    expect: NOT_ADMIN,
  },
};

/** Further calls of a function already in FUNCTIONS, for a second rule it must keep. */
export const EXTRA_CALLS: { label: string; fn: keyof typeof FUNCTIONS; spec: FunctionSpec }[] = [
  {
    // Since 0016 a new shared setup needs an admin of at least one company, checked before
    // the input. Guard: the name is empty, which the function refuses before it stores
    // anything, so even a database without 0016 stores nothing (and this row then FAILs).
    label: "save_payroll_shared_setup() new setup",
    fn: "save_payroll_shared_setup",
    spec: {
      args: () => ({ p_setup_id: SAFETY_SETUP_ID, p_name: "", p_body: {}, p_expected_revision: 0, p_companies: [] }),
      expect: NOT_ADMIN,
    },
  },
];

/** Not attempted, on purpose. Printed as SKIP rows so the gap stays visible. */
export const SKIPPED: { object: string; action: Action; reason: string }[] = [
  {
    object: "storage: create a bucket",
    action: "insert",
    reason: "a new bucket would not belong to a TEST company",
  },
];

interface Context {
  api: Api;
  who: Who;
  /** The two TEST companies. Every write is aimed at these and nothing else. */
  test: { a: string; b: string };
  /** The signed-in user's id (null for anon). */
  self: string | null;
}

interface Check {
  object: string;
  action: Action;
  expected: string;
  write: boolean;
  run: () => Promise<Verdict>;
  cleanup?: string;
}

function companyFilter(table: string, company: string): Filter {
  const column = TABLES[table]!.companyColumn;
  return column ? { column, op: "eq", value: company } : NO_COMPANY_FILTER[table]!;
}

function tableChecks({ api, test, self }: Context): Check[] {
  const checks: Check[] = [];
  for (const [table, spec] of Object.entries(TABLES)) {
    const filter = companyFilter(table, test.a);
    const limit = LIMITS[table] ? ` (limited: ${LIMITS[table]})` : "";
    const row = spec.insert(test.a, self);
    checks.push({
      object: table,
      action: "read",
      expected: "nothing or refused",
      write: false,
      run: async () => judgeRead(await api.read(table)),
    });
    checks.push({
      object: table,
      action: "insert",
      expected: "refused",
      write: true,
      run: async () => judgeWrite("insert", await api.insert(table, row)),
      cleanup: insertCleanup(table, row),
    });
    if (table === "companies") {
      // Only name, address and VAT may be updated at all (migration 0005). Set a TEST company's
      // name to the name it already has: nothing can change, and the count shows the hole.
      for (const name of TEST_COMPANY_NAMES) {
        checks.push({
          object: table,
          action: "update",
          expected: "0 rows or refused",
          write: true,
          run: async () =>
            judgeWrite(
              "update",
              await api.update(table, { name }, [
                { column: "id", op: "in", value: [test.a, test.b] },
                { column: "name", op: "eq", value: name },
              ]),
            ),
          cleanup: "Nothing to undo: the update set the name to the value it already had.",
        });
      }
    } else {
      const sameValue = { [filter.column]: filter.value };
      checks.push({
        object: table,
        action: "update",
        expected: "0 rows or refused",
        write: true,
        run: async () => judgeWrite("update", await api.update(table, sameValue, [filter])),
        cleanup: `Nothing to undo: the update set ${filter.column} to the value it already had.${limit}`,
      });
    }
    checks.push({
      object: table,
      action: "delete",
      expected: "0 rows or refused",
      write: true,
      run: async () => judgeWrite("delete", await api.remove(table, [filter], spec.rlsWrites ? "id" : null)),
      cleanup: `A row of ${table} (TEST company ${test.a}) was deleted. It cannot be restored by SQL; restore it from a backup if it mattered.`,
    });
  }
  return checks;
}

function functionChecks({ api, test }: Context): Check[] {
  const calls = [
    ...Object.entries(FUNCTIONS).map(([name, spec]) => ({ label: `${name}()`, name, spec })),
    ...EXTRA_CALLS.map(({ label, fn, spec }) => ({ label, name: fn, spec })),
  ];
  return calls.map(({ label, name, spec }) => {
    const args = spec.args(test);
    if (spec.expect.kind === "read") {
      const { ok, expected } = spec.expect;
      return {
        object: label,
        action: "call",
        expected,
        write: false,
        run: async () => judgeReadCall(await api.rpc(name, args), ok),
      };
    }
    const { refusals } = spec.expect;
    return {
      object: label,
      action: "call",
      expected: `refused (${refusals[0]})`,
      write: true,
      run: async () => judgeWriteCall(await api.rpc(name, args), refusals),
      cleanup: `${name} was not refused by its permission check. Look in the tables it writes for rows of the TEST companies saved just now (marker "${MARKER}" where it takes text), and send the output of this check to Claude before deleting anything.`,
    };
  });
}

function storageChecks({ api, test }: Context): Check[] {
  const path = `${test.a}/${SAFETY_FILE_HASH}.pdf`;
  const found = `select name, created_at from storage.objects where bucket_id = '${BUCKET}' and name = '${path}';`;
  return [
    { object: "storage: buckets", action: "read", expected: "nothing or refused", write: false, run: async () => judgeStorageRead(await api.listBuckets()) },
    { object: `storage: ${BUCKET} bucket`, action: "read", expected: "nothing or refused", write: false, run: async () => judgeStorageRead(await api.getBucket(BUCKET)) },
    { object: `storage: ${BUCKET}/`, action: "read", expected: "nothing or refused", write: false, run: async () => judgeStorageRead(await api.storageList(BUCKET, "")) },
    { object: `storage: ${BUCKET}/<TEST>/`, action: "read", expected: "nothing or refused", write: false, run: async () => judgeStorageRead(await api.storageList(BUCKET, test.a)) },
    { object: `storage: ${BUCKET}/<TEST>/file`, action: "read", expected: "nothing or refused", write: false, run: async () => judgeStorageRead(await api.storageDownload(BUCKET, `${test.a}/${"0".repeat(64)}.pdf`)) },
    {
      object: `storage: ${BUCKET}/<TEST>/file`,
      action: "insert",
      expected: "refused",
      write: true,
      run: async () => judgeStorageWrite(await api.storageUpload(BUCKET, path, SAFETY_PDF)),
      cleanup: `A file was stored at ${BUCKET}/${path}. Preview: ${found} Then delete that one file in Supabase > Storage > ${BUCKET} (not with SQL).`,
    },
    {
      object: `storage: ${BUCKET}/<TEST>/file`,
      action: "update",
      expected: "refused",
      write: true,
      run: async () => judgeStorageWrite(await api.storageUpdate(BUCKET, path, SAFETY_PDF)),
      cleanup: `A file was written at ${BUCKET}/${path}. Preview: ${found} Then delete that one file in Supabase > Storage > ${BUCKET} (not with SQL).`,
    },
    {
      object: `storage: ${BUCKET}/<TEST>/file`,
      action: "delete",
      expected: "nothing removed or refused",
      write: true,
      run: async () => judgeStorageRemove(await api.storageRemove(BUCKET, [path])),
      cleanup: `The file ${BUCKET}/${path} could be removed: storage deletes are not protected for this user.`,
    },
  ];
}

function insertCleanup(table: string, row: Record<string, unknown>): string {
  const where = Object.entries(row)
    .filter(([, value]) => typeof value === "string" || typeof value === "number")
    .map(([column, value]) => `${column} = ${typeof value === "string" ? `'${value.replace(/'/g, "''")}'` : value}`)
    .join(" and ");
  return [
    `A row was stored in ${table}. Preview first, and run the delete only if the preview shows exactly that one row:`,
    `  select * from public.${table} where ${where};`,
    `  delete from public.${table} where ${where};`,
  ].join("\n");
}

export interface RunOptions {
  /** Called after each check, for progress output. */
  onRow?: (row: Row) => void;
}

/**
 * Runs every check for one kind of visitor. After the first write that goes through, no further
 * write is attempted (reads still are), so a broken rule cannot be used more than once. A FAIL
 * that certainly stored nothing (only the invalid argument stopped it) does not stop the run.
 */
export async function runChecks(context: Context, options: RunOptions = {}): Promise<Row[]> {
  const rows: Row[] = [];
  let writeFailed = false;
  const checks = [...tableChecks(context), ...functionChecks(context), ...storageChecks(context)];
  for (const check of checks) {
    let row: Row;
    if (check.write && writeFailed) {
      row = { who: context.who, object: check.object, action: check.action, expected: check.expected, result: "not attempted: an earlier write went through", status: "SKIP" };
    } else {
      let verdict: Verdict;
      try {
        verdict = await check.run();
      } catch (error) {
        verdict = { status: "UNCLEAR", result: `the request failed: ${error instanceof Error ? error.message : String(error)}` };
      }
      const { status, result } = verdict;
      row = { who: context.who, object: check.object, action: check.action, expected: check.expected, status, result };
      if (verdict.status === "FAIL" && check.write) {
        if (verdict.nothingStored) {
          row.cleanup = "Nothing was stored: only the deliberately invalid argument stopped it. The permission check needs a migration.";
        } else {
          writeFailed = true;
          row.cleanup = check.cleanup;
        }
      }
    }
    rows.push(row);
    options.onRow?.(row);
  }
  for (const skip of SKIPPED) {
    const row: Row = { who: context.who, object: skip.object, action: skip.action, expected: "-", result: `not attempted: ${skip.reason}`, status: "SKIP" };
    rows.push(row);
    options.onRow?.(row);
  }
  return rows;
}

/**
 * Before any write: the signed-in account must really belong to no company, or its writes
 * would be allowed and would change real data. Returns the problem, or null when it is safe.
 */
export async function preflight(api: Api, test: { a: string; b: string }): Promise<string | null> {
  const members = await api.read("company_members");
  if (members.error) return `Could not check the account's memberships (${members.error.message ?? members.error.code}).`;
  if (Array.isArray(members.data) && members.data.length > 0) {
    return "This account can see company memberships, so it is a member of a company. It must belong to NO company. Nothing was written.";
  }
  for (const company of [test.a, test.b]) {
    for (const fn of ["is_company_member", "is_company_admin"]) {
      const answer = await api.rpc(fn, { cid: company });
      if (answer.error) return `Could not check membership of ${company} (${answer.error.message ?? answer.error.code}). Nothing was written.`;
      if (answer.data !== false) return `This account is a member of ${company}. It must belong to NO company. Nothing was written.`;
    }
  }
  return null;
}
