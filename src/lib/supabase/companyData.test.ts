import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { grantUnlock, lock } from "@/lib/unlock";

type Call = [method: string, ...args: unknown[]];

/** A stand-in for the Supabase client that records calls and answers each query by its own calls. */
const db = vi.hoisted(() => {
  const state = {
    calls: [] as Call[],
    queries: [] as Call[][],
    answer: (() => ({ data: [], error: null })) as (calls: Call[]) => unknown,
  };
  const builder = (own: Call[]): Record<string, unknown> =>
    new Proxy(
      {},
      {
        get(_target, property: string) {
          if (property === "then") {
            return (resolve: (value: unknown) => void) => resolve(state.answer(own));
          }
          return (...args: unknown[]) => {
            own.push([property, ...args]);
            state.calls.push([property, ...args]);
            return builder(own);
          };
        },
      },
    );
  return {
    state,
    client: {
      from: (name: string) => {
        const own: Call[] = [["from", name]];
        state.calls.push(["from", name]);
        state.queries.push(own);
        return builder(own);
      },
    },
  };
});
vi.mock("./client", () => ({ supabase: db.client }));

const {
  classifyCompanyDataError,
  createLinks,
  deleteLink,
  fetchDetails,
  fetchLinks,
  fetchSensitiveValues,
  saveOrder,
  updateCompanyCore,
  updateDetail,
} = await import("./companyData");

const VIEWER = { id: "00000000-0000-4000-8000-0000000000a1", isDemo: false };
const ABC = "10000000-0000-4000-8000-000000000001";
const D1 = "50000000-0000-4000-8000-000000000001";
const D2 = "50000000-0000-4000-8000-000000000002";
const L1 = "60000000-0000-4000-8000-000000000001";
const NOW = "2026-09-28T10:15:00+00:00";
const SECRET = "FAKE-IBAN-0000-0000";

const has = (own: Call[], method: string, ...args: unknown[]) =>
  own.some((call) => JSON.stringify(call) === JSON.stringify([method, ...args]));
const selects = () => db.state.calls.filter(([m]) => m === "select").map((c) => String(c[1]));

const detailRow = (id: string, more: Record<string, unknown>) => ({
  id,
  company_id: ABC,
  label: "Label",
  field_type: "text",
  is_sensitive: false,
  sort_order: 0,
  updated_at: NOW,
  ...more,
});
const linkRow = (more: Record<string, unknown> = {}) => ({
  id: L1,
  company_id: ABC,
  title: "Tax portal",
  url: "https://example.org/tax",
  description: null,
  category: "Government",
  icon: "landmark",
  accent: "teal",
  is_pinned: true,
  sort_order: 0,
  updated_at: NOW,
  ...more,
});

/** What the add/edit form sends for a link. */
const linkFields = () => ({
  title: "Tax portal",
  url: "https://example.org/tax",
  description: null,
  category: "Government",
  icon: "landmark",
  accent: "teal",
  is_pinned: true,
});

beforeEach(() => {
  db.state.calls = [];
  db.state.queries = [];
  db.state.answer = () => ({ data: [], error: null });
});
afterEach(() => lock());

describe("fetchDetails", () => {
  beforeEach(() => {
    db.state.answer = (own) =>
      has(own, "eq", "is_sensitive", true)
        ? {
            data: [detailRow(D2, { label: "Bank reference", is_sensitive: true, sort_order: 0 })],
            error: null,
          }
        : {
            data: [detailRow(D1, { label: "Contact", value: "a@example.com", sort_order: 1 })],
            error: null,
          };
  });

  it("never asks for the value of a sensitive detail", async () => {
    const details = await fetchDetails(VIEWER, ABC);

    const sensitiveQuery = db.state.queries.find((own) => has(own, "eq", "is_sensitive", true))!;
    const columns = String(sensitiveQuery.find(([m]) => m === "select")![1]);
    expect(columns.split(",").map((c) => c.trim())).not.toContain("value");

    expect(details.map((d) => [d.label, d.value, d.valueLoaded])).toEqual([
      ["Bank reference", null, false],
      ["Contact", "a@example.com", true],
    ]);
  });

  it("only reads, and only the selected company", async () => {
    await fetchDetails(VIEWER, ABC);
    for (const own of db.state.queries) expect(has(own, "eq", "company_id", ABC)).toBe(true);
    const used = new Set(db.state.calls.map(([m]) => m));
    for (const write of ["insert", "update", "delete", "upsert"])
      expect(used.has(write)).toBe(false);
  });

  it("refuses rows that are not what it expects", async () => {
    db.state.answer = () => ({ data: [detailRow(D1, { field_type: "password" })], error: null });
    await expect(fetchDetails(VIEWER, ABC)).rejects.toBeInstanceOf(ZodError);
  });

  it("passes a missing table on, to be explained as a migration that was not run", async () => {
    db.state.answer = () => ({ data: null, error: { code: "PGRST205", message: "not found" } });
    const error = await fetchDetails(VIEWER, ABC).catch((e: unknown) => e);
    const failure = classifyCompanyDataError(error, "details");
    expect(failure.kind).toBe("not-set-up");
    expect(failure.message).toContain("0005_company_details.sql");
  });
});

describe("fetchSensitiveValues", () => {
  it("is refused while the password gate is locked: the database is never asked", async () => {
    await expect(fetchSensitiveValues(VIEWER, ABC)).rejects.toThrow(/locked/);
    expect(db.state.calls).toEqual([]);
  });

  it("returns the values by id once the gate is open", async () => {
    grantUnlock(10);
    db.state.answer = () => ({ data: [{ id: D2, value: SECRET }], error: null });
    await expect(fetchSensitiveValues(VIEWER, ABC)).resolves.toEqual({ [D2]: SECRET });
    expect(has(db.state.queries[0]!, "eq", "is_sensitive", true)).toBe(true);
    expect(has(db.state.queries[0]!, "eq", "company_id", ABC)).toBe(true);
  });
});

describe("links", () => {
  it("treats a stored address that is not http(s) as unexpected data, never as a link", async () => {
    for (const url of ["javascript:alert(1)", "data:text/html,hi", "ftp://example.org"]) {
      db.state.answer = () => ({ data: [linkRow({ url })], error: null });
      await expect(fetchLinks(VIEWER, ABC)).rejects.toBeInstanceOf(ZodError);
    }
    db.state.answer = () => ({ data: [linkRow()], error: null });
    await expect(fetchLinks(VIEWER, ABC)).resolves.toHaveLength(1);
  });

  it("adds several links in one statement, so a refusal adds none of them", async () => {
    db.state.answer = () => ({ data: [{ id: L1 }, { id: D1 }], error: null });
    const fields = linkFields();
    const added = await createLinks(
      VIEWER,
      ABC,
      [fields, { ...fields, url: "https://example.org/pension" }],
      5,
    );

    expect(added).toBe(2);
    const inserts = db.state.calls.filter(([m]) => m === "insert");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![1]).toMatchObject([
      { company_id: ABC, url: "https://example.org/tax", sort_order: 5 },
      { company_id: ABC, url: "https://example.org/pension", sort_order: 6 },
    ]);
  });

  it("explains a missing table and a duplicate address", () => {
    const missing = classifyCompanyDataError({ code: "42P01", message: "no relation" }, "links");
    expect(missing.kind).toBe("not-set-up");
    expect(missing.message).toContain("0006_company_links.sql");

    const duplicate = classifyCompanyDataError(
      { code: "23505", message: "duplicate key" },
      "links",
    );
    expect(duplicate.title).toBe("This company already has a link to that address");
    expect(duplicate.field).toBe("url");

    const label = classifyCompanyDataError({ code: "23505", message: "duplicate key" }, "details");
    expect(label.field).toBe("label");
  });
});

describe("a viewer cannot change anything", () => {
  // Row-level security filters the rows a viewer may not touch, so a write changes nothing.
  beforeEach(() => {
    db.state.answer = () => ({ data: [], error: null });
  });

  it("reports every write that changed nothing as not allowed", async () => {
    const detail = { label: "x", value: "y", field_type: "text" as const, is_sensitive: false };
    for (const attempt of [
      () => updateDetail(VIEWER, D1, detail),
      () => deleteLink(VIEWER, L1),
      () => saveOrder(VIEWER, "company_links", [{ id: L1, sort_order: 3 }]),
      () => updateCompanyCore(VIEWER, ABC, { name: "Renamed", address: null, vat: null }),
    ]) {
      const error = await attempt().catch((e: unknown) => e);
      expect(classifyCompanyDataError(error, "links").kind).toBe("forbidden");
    }
  });

  it("passes on the database's refusal of an insert", async () => {
    db.state.answer = () => ({
      data: null,
      error: { code: "42501", message: "new row violates row-level security policy" },
    });
    const fields = linkFields();
    const error = await createLinks(VIEWER, ABC, [fields], 0).catch((e: unknown) => e);
    expect(classifyCompanyDataError(error, "links").kind).toBe("forbidden");
  });
});

describe("updateCompanyCore", () => {
  it("sends the name, address and VAT, and never the BRN", async () => {
    db.state.answer = () => ({
      data: [{ id: ABC, name: "Renamed", address: null, brn: "C1234567", vat: "15%" }],
      error: null,
    });
    const input = { name: "Renamed", address: null, vat: "15%", brn: "C9999999" };
    const saved = await updateCompanyCore(VIEWER, ABC, input);

    const updates = db.state.calls.filter(([m]) => m === "update");
    expect(updates).toEqual([["update", { name: "Renamed", address: null, vat: "15%" }]]);
    expect(saved.brn).toBe("C1234567");
    expect(selects()).toEqual(["id, name, address, brn, vat"]);
  });
});
