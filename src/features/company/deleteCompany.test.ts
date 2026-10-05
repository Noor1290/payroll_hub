import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { queryClient } from "@/lib/queryClient";
import type { Membership } from "@/lib/supabase/schemas";
import { grantUnlock, isUnlocked, lock, unlockState } from "@/lib/unlock";

type Call = [method: string, ...args: unknown[]];

/** A stand-in for the Supabase client that records calls and answers each query by its table and filters. */
const db = vi.hoisted(() => {
  const state = {
    calls: [] as Call[],
    answer: (() => ({ data: null, count: 0, error: null })) as (calls: Call[]) => unknown,
    rpc: (() => ({ data: null, error: null })) as (name: string, args: unknown) => unknown,
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
        state.calls.push(["from", name]);
        return builder([["from", name]]);
      },
      rpc: (name: string, args: unknown) => {
        state.calls.push(["rpc", name, args]);
        return Promise.resolve(state.rpc(name, args));
      },
    },
  };
});
vi.mock("@/lib/supabase/client", () => ({ supabase: db.client }));

const {
  classifyDeleteCompanyError,
  deleteCompany,
  fetchDeletePreview,
  forgetCompany,
  LockedError,
  NameMismatchError,
  nameMatches,
} = await import("./deleteCompany");

const VIEWER = { id: "00000000-0000-4000-8000-0000000000a1", isDemo: false };
const ABC = "10000000-0000-4000-8000-000000000001";
const XYZ = "10000000-0000-4000-8000-000000000002";
const COMPANY = { id: ABC, name: "ABC Co Ltd" };
const RESULT = { company_id: ABC, entries: 5, runs: 2, employees: 3, members: 2 };

const rpcCalls = () => db.state.calls.filter(([method]) => method === "rpc");

beforeEach(() => {
  db.state.calls = [];
  db.state.rpc = () => ({ data: RESULT, error: null });
  db.state.answer = () => ({ data: [], count: 0, error: null });
});
afterEach(() => {
  lock();
  queryClient.clear();
  localStorage.clear();
});

describe("nameMatches", () => {
  it("needs the exact name, capitals included", () => {
    expect(nameMatches("ABC Co Ltd", "ABC Co Ltd")).toBe(true);
    expect(nameMatches("abc co ltd", "ABC Co Ltd")).toBe(false);
    expect(nameMatches("ABC Co", "ABC Co Ltd")).toBe(false);
    expect(nameMatches("ABC Co Ltd.", "ABC Co Ltd")).toBe(false);
    expect(nameMatches("ABC  Co Ltd", "ABC Co Ltd")).toBe(false);
  });

  it("ignores only the spaces around it, and never matches an empty box", () => {
    expect(nameMatches("  ABC Co Ltd ", "ABC Co Ltd")).toBe(true);
    expect(nameMatches("", "ABC Co Ltd")).toBe(false);
    expect(nameMatches("   ", "   ")).toBe(false);
  });
});

describe("deleteCompany", () => {
  it("requires the password gate: locked means the database is never called", async () => {
    expect(isUnlocked()).toBe(false);
    await expect(deleteCompany(VIEWER, COMPANY, "ABC Co Ltd")).rejects.toBeInstanceOf(LockedError);
    expect(rpcCalls()).toEqual([]);
  });

  it("requires the exact name, even with the gate open", async () => {
    grantUnlock(10);
    await expect(deleteCompany(VIEWER, COMPANY, "abc co ltd")).rejects.toBeInstanceOf(
      NameMismatchError,
    );
    await expect(deleteCompany(VIEWER, COMPANY, "")).rejects.toBeInstanceOf(NameMismatchError);
    expect(rpcCalls()).toEqual([]);
  });

  it("calls delete_company with the id and the typed name, and returns the counts", async () => {
    grantUnlock(10);
    const result = await deleteCompany(VIEWER, COMPANY, " ABC Co Ltd ");

    expect(rpcCalls()).toEqual([
      ["rpc", "delete_company", { p_company_id: ABC, p_confirm_name: "ABC Co Ltd" }],
    ]);
    expect(result).toEqual(RESULT);
    // The function is the only thing it touches: no direct deletes on any table.
    expect(db.state.calls.some(([method]) => method === "delete" || method === "from")).toBe(false);
  });

  it("passes the database's refusal on (a viewer calling it is refused there)", async () => {
    grantUnlock(10);
    db.state.rpc = () => ({ data: null, error: { code: "42501", message: "PH_NOT_ADMIN" } });
    await expect(deleteCompany(VIEWER, COMPANY, "ABC Co Ltd")).rejects.toMatchObject({
      message: "PH_NOT_ADMIN",
    });
  });

  it("passes on the database's own refusal of the name (it compares with the current name)", async () => {
    grantUnlock(10);
    db.state.rpc = () => ({ data: null, error: { code: "22023", message: "PH_NAME_MISMATCH" } });
    await expect(deleteCompany(VIEWER, COMPANY, "ABC Co Ltd")).rejects.toMatchObject({
      message: "PH_NAME_MISMATCH",
    });
  });

  it("accepts the counts migration 0007 adds for details and links", async () => {
    grantUnlock(10);
    db.state.rpc = () => ({ data: { ...RESULT, details: 2, links: 4 }, error: null });
    await expect(deleteCompany(VIEWER, COMPANY, "ABC Co Ltd")).resolves.toMatchObject(RESULT);
  });

  it("refuses a response that isn't the expected counts", async () => {
    grantUnlock(10);
    db.state.rpc = () => ({ data: { company_id: ABC }, error: null });
    await expect(deleteCompany(VIEWER, COMPANY, "ABC Co Ltd")).rejects.toBeInstanceOf(ZodError);
  });
});

describe("fetchDeletePreview", () => {
  const has = (own: Call[], method: string, ...args: unknown[]) =>
    own.some((call) => JSON.stringify(call) === JSON.stringify([method, ...args]));

  it("counts employees, runs and entries INCLUDING soft-deleted ones, and how many runs are approved", async () => {
    db.state.answer = (own) => {
      const table = own[0]![1];
      if (table === "employees") return { data: null, count: 13, error: null };
      if (table === "payroll_entries") return { data: null, count: 67, error: null };
      if (table === "company_members") return { data: null, count: 3, error: null };
      if (table === "company_details") return { data: null, count: 4, error: null };
      if (table === "company_links") return { data: null, count: 6, error: null };
      if (has(own, "eq", "status", "approved")) return { data: null, count: 3, error: null };
      return { data: null, count: 7, error: null };
    };

    const preview = await fetchDeletePreview(VIEWER, ABC);

    expect(preview).toEqual({
      employees: 13,
      runs: 7,
      entries: 67,
      otherMembers: 2,
      details: 4,
      links: 6,
      approvedRuns: 3,
    });
    // Nothing is filtered on deleted_at: soft-deleted rows, approved runs among them, are counted.
    expect(
      db.state.calls.some(([method, column]) => method === "is" && column === "deleted_at"),
    ).toBe(false);
    expect(JSON.stringify(db.state.calls)).not.toContain('deleted_at",null');
  });

  it("only reads, and only this company", async () => {
    await fetchDeletePreview(VIEWER, ABC);
    const used = new Set(db.state.calls.map(([method]) => method));
    for (const write of ["insert", "update", "delete", "upsert", "rpc"])
      expect(used.has(write)).toBe(false);
    const scoped = db.state.calls.filter(([method, , value]) => method === "eq" && value === ABC);
    expect(scoped).toHaveLength(7);
  });

  it("still works before migrations 0005 and 0006 are run: missing tables count as nothing", async () => {
    db.state.answer = (own) => {
      const table = own[0]![1];
      if (table === "company_details") {
        return { data: null, count: null, error: { code: "PGRST205", message: "not found" } };
      }
      if (table === "company_links") {
        return { data: null, count: null, error: { code: "42P01", message: "no relation" } };
      }
      return { data: [], count: 2, error: null };
    };
    const preview = await fetchDeletePreview(VIEWER, ABC);
    expect(preview.details).toBe(0);
    expect(preview.links).toBe(0);
    expect(preview.employees).toBe(2);
  });

  it("does not hide any other failure reading details or links", async () => {
    db.state.answer = (own) =>
      own[0]![1] === "company_links"
        ? { data: null, count: null, error: { code: "42501", message: "denied" } }
        : { data: [], count: 2, error: null };
    await expect(fetchDeletePreview(VIEWER, ABC)).rejects.toMatchObject({ code: "42501" });
  });

  it("fails rather than show wrong numbers", async () => {
    db.state.answer = () => ({ data: null, count: null, error: null });
    await expect(fetchDeletePreview(VIEWER, ABC)).rejects.toBeInstanceOf(ZodError);

    db.state.answer = () => ({
      data: null,
      count: null,
      error: { code: "42501", message: "denied" },
    });
    await expect(fetchDeletePreview(VIEWER, ABC)).rejects.toMatchObject({ code: "42501" });
  });
});

describe("forgetCompany", () => {
  const membership = (id: string, name: string): Membership => ({
    role: "admin",
    company: { id, name, address: null, brn: null, vat: null },
  });

  it("clears the company's cached data, locks the gate, and drops it from the list", () => {
    queryClient.setQueryData(
      ["memberships", VIEWER.id],
      [membership(ABC, "ABC Co Ltd"), membership(XYZ, "XYZ")],
    );
    queryClient.setQueryData(["overview", ABC, VIEWER.id], { latestRunNetPay: 18169.12 });
    queryClient.setQueryData(["runs", ABC, VIEWER.id], [{ id: "r1" }]);
    queryClient.setQueryData(["db", "rows", "employees", ABC, VIEWER.id], { rows: [], total: 0 });
    queryClient.setQueryData(["run-entries", "r1", VIEWER.id], [{ national_id: "X0000000000001" }]);
    queryClient.setQueryData(["delete-preview", ABC, VIEWER.id], { employees: 3 });
    queryClient.setQueryData(["overview", XYZ, VIEWER.id], { latestRunNetPay: 1 });
    localStorage.setItem("payroll-hub:company", ABC);
    grantUnlock(10);

    forgetCompany(ABC);

    const keys = queryClient
      .getQueryCache()
      .getAll()
      .map((query) => JSON.stringify(query.queryKey));
    expect(keys.some((key) => key.includes(ABC))).toBe(false);
    expect(queryClient.getQueryCache().findAll({ queryKey: ["run-entries"] })).toHaveLength(0);
    expect(queryClient.getQueryCache().findAll({ queryKey: ["db"] })).toHaveLength(0);
    // The other company's data, and the list without the deleted one, stay.
    expect(queryClient.getQueryData(["overview", XYZ, VIEWER.id])).toEqual({ latestRunNetPay: 1 });
    expect(
      queryClient.getQueryData<Membership[]>(["memberships", VIEWER.id])!.map((m) => m.company.id),
    ).toEqual([XYZ]);
    expect(isUnlocked()).toBe(false);
    expect(unlockState.get().lockedBy).toBe("cleared");
    expect(localStorage.getItem("payroll-hub:company")).toBeNull();
  });

  it("leaves a different remembered company alone", () => {
    localStorage.setItem("payroll-hub:company", XYZ);
    forgetCompany(ABC);
    expect(localStorage.getItem("payroll-hub:company")).toBe(XYZ);
  });
});

describe("classifyDeleteCompanyError", () => {
  it("asks for migration 0007 when the database still refuses approved runs", () => {
    const failure = classifyDeleteCompanyError({ code: "P0001", message: "PH_HAS_APPROVED_RUNS" });
    expect(failure.title).toBe("The database needs an update");
    expect(failure.message).toContain("0007_delete_company_any_runs.sql");
    expect(failure.message).not.toMatch(/back to draft/);
  });

  it("explains a refusal for someone who is not an admin of the company", () => {
    for (const message of ["PH_NOT_ADMIN", "PH_NOT_SIGNED_IN"]) {
      expect(classifyDeleteCompanyError({ code: "42501", message }).title).toBe(
        "You're not allowed to delete this company",
      );
    }
  });

  it("explains a name that doesn't match, and points at the name box", () => {
    expect(classifyDeleteCompanyError(new NameMismatchError())).toMatchObject({
      title: "That isn't the company's name",
      nameField: true,
    });
    expect(
      classifyDeleteCompanyError({ code: "22023", message: "PH_NAME_MISMATCH" }).nameField,
    ).toBe(true);
  });

  it("explains a locked gate", () => {
    expect(classifyDeleteCompanyError(new LockedError()).title).toBe("Confirm your password first");
  });

  it("says which migration to run when the function is missing", () => {
    const failure = classifyDeleteCompanyError({ code: "PGRST202", message: "not found" });
    expect(failure.title).toBe("Deleting companies isn't set up in the database yet");
    expect(failure.message).toContain("0007_delete_company_any_runs.sql");
  });

  it("explains an unreachable or paused database", () => {
    const failure = classifyDeleteCompanyError(new TypeError("Failed to fetch"));
    expect(failure.kind).toBe("unreachable");
    expect(failure.message).toMatch(/paused/i);
  });

  it("always says that nothing was deleted", () => {
    for (const error of [
      new LockedError(),
      new NameMismatchError(),
      { code: "P0001", message: "PH_HAS_APPROVED_RUNS" },
      { code: "42501", message: "PH_NOT_ADMIN" },
      { code: "PGRST202", message: "" },
      new TypeError("Failed to fetch"),
      { code: "XX000", message: "boom" },
      null,
    ]) {
      expect(classifyDeleteCompanyError(error).message).toMatch(/Nothing was deleted\.$/);
    }
  });
});
