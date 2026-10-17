import { describe, expect, it } from "vitest";
import {
  exitCode,
  formatTable,
  judgeRead,
  judgeReadCall,
  judgeStorageRead,
  judgeStorageRemove,
  judgeStorageWrite,
  judgeWrite,
  judgeWriteCall,
  type Row,
} from "./outcome.ts";

const permission = { code: "42501", message: "permission denied for table employees" };
const rls = { code: "42501", message: 'new row violates row-level security policy for table "employees"' };

describe("judgeRead", () => {
  it("passes when nothing comes back or the read is refused", () => {
    expect(judgeRead({ data: [], count: 0 }).status).toBe("PASS");
    expect(judgeRead({ error: permission }).status).toBe("PASS");
  });

  it("fails when any row comes back, or the count says rows exist", () => {
    expect(judgeRead({ data: [{ id: 1 }], count: 1 })).toEqual({ status: "FAIL", result: "1 row(s) returned" });
    expect(judgeRead({ data: [], count: 3 }).status).toBe("FAIL");
  });

  it("is unclear on an error that is not a permission refusal", () => {
    expect(judgeRead({ error: { code: "PGRST205", message: "Could not find the table" } }).status).toBe("UNCLEAR");
  });
});

describe("judgeWrite", () => {
  it("passes a refused insert, update or delete", () => {
    expect(judgeWrite("insert", { error: rls }).status).toBe("PASS");
    expect(judgeWrite("update", { error: permission }).status).toBe("PASS");
  });

  it("fails an insert that went through", () => {
    expect(judgeWrite("insert", { data: null, error: null }).status).toBe("FAIL");
  });

  it("passes an update or delete that changed 0 rows, and fails one that changed any", () => {
    expect(judgeWrite("update", { count: 0 }).status).toBe("PASS");
    expect(judgeWrite("delete", { count: 0 }).status).toBe("PASS");
    expect(judgeWrite("update", { count: 2 })).toEqual({ status: "FAIL", result: "2 row(s) UPDATED" });
    expect(judgeWrite("delete", { count: 1 })).toEqual({ status: "FAIL", result: "1 row(s) DELETED" });
  });

  it("is unclear when the count is missing, or the refusal is not a permission check", () => {
    expect(judgeWrite("update", { count: null }).status).toBe("UNCLEAR");
    expect(judgeWrite("insert", { error: { code: "23502", message: "null value in column" } }).status).toBe("UNCLEAR");
  });
});

describe("judgeWriteCall", () => {
  const refusals = ["PH_NOT_ADMIN", "PH_NOT_SIGNED_IN"];

  it("passes the expected refusal", () => {
    expect(judgeWriteCall({ error: { code: "42501", message: "PH_NOT_ADMIN" } }, refusals).status).toBe("PASS");
    expect(judgeWriteCall({ error: { code: "42501", message: "permission denied for function x" } }, refusals).status).toBe(
      "PASS",
    );
  });

  it("fails a call that ran, or that only the deliberately invalid argument stopped", () => {
    expect(judgeWriteCall({ data: { revision: 1 } }, refusals).status).toBe("FAIL");
    const guard = judgeWriteCall({ error: { code: "22023", message: "PH_INVALID_INPUT: the BRN is required" } }, refusals);
    expect(guard.status).toBe("FAIL");
    expect(guard.result).toContain("permission check did not stop it");
  });

  it("is unclear on any other error", () => {
    expect(judgeWriteCall({ error: { code: "PGRST202", message: "Could not find the function" } }, refusals).status).toBe(
      "UNCLEAR",
    );
  });
});

describe("judgeReadCall", () => {
  it("passes a refusal or an answer that reveals nothing", () => {
    expect(judgeReadCall({ data: false }, (data) => data === false).status).toBe("PASS");
    expect(judgeReadCall({ error: { code: "42501", message: "permission denied" } }, () => false).status).toBe("PASS");
    expect(judgeReadCall({ error: { code: "PGRST202", message: "not found" } }, () => false).status).toBe("PASS");
  });

  it("fails an answer the check does not accept", () => {
    expect(judgeReadCall({ data: true }, (data) => data === false)).toEqual({ status: "FAIL", result: "answered true" });
  });
});

describe("storage verdicts", () => {
  it("passes refused writes and empty answers, fails stored files and returned items", () => {
    expect(judgeStorageWrite({ error: { message: "new row violates row-level security policy", status: 403 } }).status).toBe(
      "PASS",
    );
    expect(judgeStorageWrite({ data: { path: "x" } }).status).toBe("FAIL");
    expect(judgeStorageRemove({ data: [] }).status).toBe("PASS");
    expect(judgeStorageRemove({ data: [{ name: "x" }] }).status).toBe("FAIL");
    expect(judgeStorageRead({ data: [] }).status).toBe("PASS");
    expect(judgeStorageRead({ error: { message: "Bucket not found" } }).status).toBe("PASS");
    expect(judgeStorageRead({ data: [{ name: "pdf-forms" }] }).status).toBe("FAIL");
  });
});

describe("the report", () => {
  const row = (status: Row["status"]): Row => ({
    who: "anon",
    object: "employees",
    action: "read",
    expected: "nothing or refused",
    result: "nothing returned",
    status,
  });

  it("prints one aligned line per row under a header", () => {
    const lines = formatTable([row("PASS"), { ...row("FAIL"), object: "payroll_months" }]).split("\n");
    expect(lines[0]).toMatch(/^WHO\s+OBJECT\s+ACTION\s+EXPECTED\s+RESULT\s+STATUS$/);
    expect(lines).toHaveLength(4);
    expect(lines[2]!.indexOf("read")).toBe(lines[3]!.indexOf("read"));
  });

  it("exits 1 on any FAIL, 2 on UNCLEAR only, 0 otherwise (SKIP counts as fine)", () => {
    expect(exitCode([row("PASS"), row("SKIP")])).toBe(0);
    expect(exitCode([row("PASS"), row("UNCLEAR")])).toBe(2);
    expect(exitCode([row("UNCLEAR"), row("FAIL")])).toBe(1);
  });
});
