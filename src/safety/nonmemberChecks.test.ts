import { describe, expect, it } from "vitest";
import {
  BUCKET,
  EXTRA_CALLS,
  FUNCTIONS,
  preflight,
  runChecks,
  SAFETY_SETUP_ID,
  SKIPPED,
  TABLES,
  ZERO_ID,
  type Api,
  type Filter,
} from "./nonmemberChecks.ts";
import type { ApiResult } from "./outcome.ts";

const files = import.meta.glob<string>("../../supabase/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const sql = Object.entries(files)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, text]) => text.replace(/\r\n/g, "\n").replace(/--.*$/gm, ""))
  .join("\n");

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SELF = "5e1f5e1f-5e1f-45e1-85e1-5e1f5e1f5e1f";

describe("what the check covers", () => {
  it("tries every table the migrations create, and no table that does not exist", () => {
    const created = [...sql.matchAll(/create table (?:if not exists )?public\.(\w+)/g)].map((match) => match[1]!);
    expect(Object.keys(TABLES).sort()).toEqual([...new Set(created)].sort());
  });

  it("tries every database function the migrations create, and none that does not exist", () => {
    const created = [...sql.matchAll(/create or replace function public\.(\w+)\s*\(/g)].map((match) => match[1]!);
    expect(Object.keys(FUNCTIONS).sort()).toEqual([...new Set(created)].sort());
  });

  it("tries every storage bucket the migrations create", () => {
    const buckets = [...sql.matchAll(/insert into storage\.buckets[^;]*?values\s*\(\s*'([^']+)'/g)].map((match) => match[1]);
    expect(buckets).toEqual([BUCKET]);
  });

  it("would be told about a view: there are none today, and a new one must be added to the check", () => {
    expect(sql).not.toMatch(/create (?:or replace )?(?:materialized )?view/i);
  });

  it("calls each function with its real parameter names (newest definition), and gives every required one", () => {
    const calls = [...Object.entries(FUNCTIONS), ...EXTRA_CALLS.map((call) => [call.fn, call.spec] as const)];
    for (const [name, spec] of calls) {
      const definitions = [...sql.matchAll(new RegExp(`create or replace function public\\.${name}\\s*\\(([^)]*)\\)`, "g"))];
      const signature = definitions.at(-1)![1]!;
      const params = signature
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => ({ name: part.split(/\s+/)[0]!, required: !/\bdefault\b/i.test(part) }));
      const args = Object.keys(spec.args({ a: A, b: B }));
      expect(args.filter((arg) => !params.some((param) => param.name === arg)), name).toEqual([]);
      expect(params.filter((param) => param.required && !args.includes(param.name)).map((param) => param.name), name).toEqual([]);
    }
  });
});

interface Recorded {
  kind: string;
  target: string;
  payload?: unknown;
  filters?: Filter[];
}

/** A fake client that refuses every write and returns nothing, and records what was asked. */
function fakeApi(override: Partial<Record<keyof Api, (...args: never[]) => ApiResult>> = {}) {
  const calls: Recorded[] = [];
  const refused: ApiResult = { error: { code: "42501", message: "permission denied" } };
  const answer = (kind: keyof Api, fallback: ApiResult, record: Recorded, args: unknown[]) => {
    calls.push(record);
    const custom = override[kind] as ((...input: unknown[]) => ApiResult) | undefined;
    return Promise.resolve(custom ? custom(...args) : fallback);
  };
  const api: Api = {
    read: (table) => answer("read", { data: [], count: 0 }, { kind: "read", target: table }, [table]),
    insert: (table, row) => answer("insert", refused, { kind: "insert", target: table, payload: row }, [table, row]),
    update: (table, values, filters) =>
      answer("update", { count: 0 }, { kind: "update", target: table, payload: values, filters }, [table, values, filters]),
    remove: (table, filters, limit) =>
      answer("remove", { count: 0 }, { kind: "remove", target: table, filters, payload: limit }, [table, filters, limit]),
    rpc: (name, args) => {
      const spec = FUNCTIONS[name];
      const fallback: ApiResult =
        name === "pdf_form_company"
          ? { data: A }
          : name === "keep_awake"
            ? { data: true }
          : name === "payroll_shared_setup_access"
            ? { data: { can_change: false, companies: 0, admin_of: 0 } }
            : name === "issued_payslips_for_month"
              ? { data: [] }
              : spec?.expect.kind === "read" && ["set_updated_at", "payroll_month_employee_count", "payroll_month_value_keys", "payroll_month_rename_key", "payroll_run_columns"].includes(name)
                ? refused
                : spec?.expect.kind === "read"
                  ? { data: false }
                  : {
                      error: {
                        code: "42501",
                        message: name === "save_payroll_shared_setup" && args.p_expected_revision !== 0 ? "PH_NOT_FOUND" : "PH_NOT_ADMIN",
                      },
                    };
      return answer("rpc", fallback, { kind: "rpc", target: name, payload: args }, [name, args]);
    },
    storageList: (bucket, prefix) => answer("storageList", { data: [] }, { kind: "storageList", target: `${bucket}/${prefix}` }, []),
    storageDownload: (bucket, path) =>
      answer("storageDownload", { error: { message: "Object not found" } }, { kind: "storageDownload", target: `${bucket}/${path}` }, []),
    storageUpload: (bucket, path) =>
      answer("storageUpload", { error: { message: "new row violates row-level security policy" } }, { kind: "storageUpload", target: `${bucket}/${path}` }, []),
    storageUpdate: (bucket, path) =>
      answer("storageUpdate", { error: { message: "new row violates row-level security policy" } }, { kind: "storageUpdate", target: `${bucket}/${path}` }, []),
    storageRemove: (bucket, paths) => answer("storageRemove", { data: [] }, { kind: "storageRemove", target: `${bucket}/${paths.join(",")}` }, []),
    listBuckets: () => answer("listBuckets", { data: [] }, { kind: "listBuckets", target: "" }, []),
    getBucket: (id) => answer("getBucket", { error: { message: "Bucket not found" } }, { kind: "getBucket", target: id }, []),
  };
  return { api, calls };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

describe("the attempts", () => {
  it("passes everything against a database that refuses what it should", async () => {
    const { api } = fakeApi();
    const rows = await runChecks({ api, who: "non-member", test: { a: A, b: B }, self: SELF });
    const notPassed = rows.filter((row) => row.status !== "PASS" && row.status !== "SKIP");
    expect(notPassed).toEqual([]);
    expect(rows.filter((row) => row.status === "SKIP")).toHaveLength(SKIPPED.length);
    expect(rows.filter((row) => row.action === "read" && row.object in TABLES)).toHaveLength(Object.keys(TABLES).length);
  });

  it("aims every write at the two TEST companies only (or at an id that cannot exist)", async () => {
    const { api, calls } = fakeApi();
    await runChecks({ api, who: "non-member", test: { a: A, b: B }, self: SELF });
    const allowed = new Set([A, B, ZERO_ID, SELF, SAFETY_SETUP_ID]);
    const writes = calls.filter((call) => call.kind !== "read");
    expect(writes.length).toBeGreaterThan(60);
    for (const call of writes) {
      const ids = JSON.stringify([call.target, call.payload ?? null, call.filters ?? null]).match(UUID) ?? [];
      expect(ids.filter((id) => !allowed.has(id)), `${call.kind} ${call.target}`).toEqual([]);
    }
  });

  it("asks for a new shared setup only with an empty name, so nothing can be stored even without 0016", async () => {
    const { api, calls } = fakeApi();
    await runChecks({ api, who: "anon", test: { a: A, b: B }, self: null });
    const saves = calls.filter((call) => call.kind === "rpc" && call.target === "save_payroll_shared_setup");
    expect(saves.map((call) => call.payload)).toEqual([
      expect.objectContaining({ p_expected_revision: 1 }),
      expect.objectContaining({ p_setup_id: SAFETY_SETUP_ID, p_expected_revision: 0, p_name: "" }),
    ]);
  });

  it("goes on with later writes after a FAIL that stored nothing (only the empty name stopped it)", async () => {
    const { api } = fakeApi({
      rpc: (name: string, args: Record<string, unknown>) =>
        name === "save_payroll_shared_setup" && args.p_expected_revision === 0
          ? { error: { code: "22023", message: "PH_INVALID_INPUT: the setup name must be 1 to 80 characters" } }
          : { error: { code: "42501", message: "PH_NOT_ADMIN" } },
    });
    const rows = await runChecks({ api, who: "non-member", test: { a: A, b: B }, self: SELF });
    const creation = rows.find((row) => row.object === "save_payroll_shared_setup() new setup")!;
    expect(creation.status).toBe("FAIL");
    expect(creation.cleanup).toMatch(/Nothing was stored/);
    expect(rows.filter((row) => row.result.startsWith("not attempted: an earlier write"))).toEqual([]);
  });

  it("accepts the shared-setup access answer whatever order the database puts its keys in", async () => {
    const { api } = fakeApi({
      rpc: (name: string) =>
        name === "payroll_shared_setup_access"
          ? { data: { admin_of: 0, companies: 0, can_change: false } }
          : { error: { code: "42501", message: "PH_NOT_ADMIN" } },
    });
    const rows = await runChecks({ api, who: "non-member", test: { a: A, b: B }, self: SELF });
    expect(rows.find((row) => row.object === "payroll_shared_setup_access()")?.status).toBe("PASS");
  });

  it("only ever updates a column to the value it already has", async () => {
    const { api, calls } = fakeApi();
    await runChecks({ api, who: "non-member", test: { a: A, b: B }, self: SELF });
    for (const call of calls.filter((entry) => entry.kind === "update")) {
      for (const [column, value] of Object.entries(call.payload as Record<string, unknown>)) {
        const same = call.filters!.some((filter) => filter.column === column && filter.op === "eq" && filter.value === value);
        expect(same, `${call.target}.${column}`).toBe(true);
      }
    }
  });

  it("deletes at most one row where the row-level rules alone decide", async () => {
    const { api, calls } = fakeApi();
    await runChecks({ api, who: "non-member", test: { a: A, b: B }, self: SELF });
    for (const call of calls.filter((entry) => entry.kind === "remove")) {
      expect(call.payload, call.target).toBe(TABLES[call.target]!.rlsWrites ? "id" : null);
    }
  });

  it("fails a write that goes through, gives its cleanup, and attempts no further write", async () => {
    const { api, calls } = fakeApi({ insert: () => ({ data: null, error: null }) });
    const rows = await runChecks({ api, who: "non-member", test: { a: A, b: B }, self: SELF });
    const failed = rows.filter((row) => row.status === "FAIL");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ object: "companies", action: "insert" });
    expect(failed[0]!.cleanup).toMatch(/select \* from public\.companies where name = 'SAFETY CHECK'/);
    expect(calls.filter((call) => call.kind === "insert")).toHaveLength(1);
    expect(rows.filter((row) => row.result.startsWith("not attempted: an earlier write")).length).toBeGreaterThan(50);
    // Reads go on: a slipped write must not hide what can be read.
    expect(calls.filter((call) => call.kind === "read")).toHaveLength(Object.keys(TABLES).length);
  });

  it("fails a read that returns a row", async () => {
    const { api } = fakeApi({ read: () => ({ data: [{ id: 1 }], count: 1 }) });
    const rows = await runChecks({ api, who: "anon", test: { a: A, b: B }, self: null });
    expect(rows.filter((row) => row.action === "read" && row.status === "FAIL")).toHaveLength(Object.keys(TABLES).length);
  });

  it("fails a write function stopped only by its deliberately invalid argument", async () => {
    const { api } = fakeApi({ rpc: () => ({ error: { code: "22023", message: "PH_INVALID_INPUT: the BRN is required" } }) });
    const rows = await runChecks({ api, who: "non-member", test: { a: A, b: B }, self: SELF });
    expect(rows.find((row) => row.object === "import_payroll_run()")?.status).toBe("FAIL");
  });
});

describe("preflight", () => {
  it("allows the run for an account that belongs to no company", async () => {
    expect(await preflight(fakeApi().api, { a: A, b: B })).toBeNull();
  });

  it("stops before any write when the account can see memberships", async () => {
    const { api } = fakeApi({ read: () => ({ data: [{ company_id: A }], count: 1 }) });
    expect(await preflight(api, { a: A, b: B })).toMatch(/member of a company/);
  });

  it("stops before any write when the account is a member of a TEST company", async () => {
    const { api } = fakeApi({ rpc: () => ({ data: true }) });
    expect(await preflight(api, { a: A, b: B })).toMatch(new RegExp(`member of ${A}`));
  });
});
