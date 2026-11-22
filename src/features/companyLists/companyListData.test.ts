import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPANY_LIST, getApp } from "@/config/apps.config";
import { exchangeContext } from "@/features/workspace/appData";
import { answerRequest } from "@/features/workspace/deliver";
import { clearTransferLog } from "@/features/transfer/transferLog";
import { DATA_RULES } from "@/lib/bridge/protocol";
import { runSessionCleanup } from "@/lib/sessionCleanup";
import { fake, type Call } from "@/test/fakeClient";
import {
  answerCompanyListRequest,
  appReloads,
  pickerRequest,
  reloadApp,
  setCompanyOpener,
} from "./companyListData";

/**
 * company-list: the user's companies with the lists of the asking app, the picker and opening a
 * company. The database is the fake client. FAKE values only.
 */

vi.mock("@/lib/supabase/client", async () => ({
  supabase: (await import("@/test/fakeClient")).fake.client,
}));

const ME = "00000000-0000-4000-8000-0000000000a1";
const ABC = "10000000-0000-4000-8000-000000000001";
const XYZ = "10000000-0000-4000-8000-000000000002";
const DEF = "10000000-0000-4000-8000-000000000003";
const abc = { id: ABC, name: "ABC Co Ltd", address: null, brn: "C1234567", vat: null };
const def = { id: DEF, name: "DEF Ltd", address: null, brn: null, vat: null };
const xyz = { id: XYZ, name: "XYZ Trading Ltd", address: null, brn: "C2222222", vat: null };
const members = [
  { role: "admin", companies: abc },
  { role: "admin", companies: def },
  { role: "viewer", companies: xyz },
];
const ON = [
  { company_id: ABC, list: "payslips" },
  { company_id: ABC, list: "csg" },
  { company_id: XYZ, list: "prgf" },
  { company_id: DEF, list: "payroll" },
];

const table = (calls: Call[]) => fake.arg(calls, "from") as string | undefined;

beforeEach(() => {
  exchangeContext.set({
    viewer: { id: ME, isDemo: false },
    membership: { role: "admin", company: abc },
  });
  fake.reset((calls) => {
    if (table(calls) === "company_members") return { data: members };
    if (table(calls) === "company_app_lists") return { data: ON };
    return { data: [] };
  });
});
afterEach(() => {
  runSessionCleanup();
  clearTransferLog();
  vi.useRealTimers();
});

const ask = (params: Record<string, unknown>, appId = "payslip") =>
  answerCompanyListRequest(appId, { dataType: COMPANY_LIST, params });

describe("company-list in the registry", () => {
  it("is accepted by Payroll System, Payslip and MRA Returns, never by PDF Form Filler", () => {
    for (const id of ["payroll", "payslip", "mra-returns"]) {
      expect(getApp(id)!.accepts).toContain(COMPANY_LIST);
      expect(getApp(id)!.produces).not.toContain(COMPANY_LIST);
    }
    expect(getApp("pdf-editor")!.accepts).not.toContain(COMPANY_LIST);
    expect(DATA_RULES[COMPANY_LIST]).toEqual({ sendRows: 0, sendBytes: 0, answerRows: [0, 500] });
  });

  it("refuses an app without lists even if it asks", async () => {
    const answer = await ask({ action: "companies" }, "pdf-editor");
    expect(answer).toMatchObject({ ok: false, code: "forbidden" });
  });
});

describe("companies", () => {
  it("lists every company of the user with only the asking app's lists", async () => {
    const answer = await ask({ action: "companies" });
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.rows).toEqual([
      {
        company_id: ABC,
        brn: "C1234567",
        name: "ABC Co Ltd",
        admin: true,
        selected: true,
        lists: ["payslips"],
      },
      { company_id: DEF, brn: "", name: "DEF Ltd", admin: true, selected: false, lists: [] },
      {
        company_id: XYZ,
        brn: "C2222222",
        name: "XYZ Trading Ltd",
        admin: false,
        selected: false,
        lists: [],
      },
    ]);
  });

  it("gives MRA Returns its two lists, CSG and PRGF", async () => {
    const answer = await ask({ action: "companies" }, "mra-returns");
    if (!answer.ok) throw new Error("refused");
    expect(answer.rows.map((row) => row.lists)).toEqual([["csg"], [], ["prgf"]]);
  });

  it("refuses when the app shows another company than the one selected", async () => {
    const answer = await ask({ action: "companies", brn: "C2222222" });
    expect(answer).toMatchObject({ ok: false, code: "wrong-company" });
  });

  it("names migration 0024 when the table is not there yet", async () => {
    fake.reset((calls) =>
      table(calls) === "company_members"
        ? { data: members }
        : { error: { code: "PGRST205", message: "missing" } },
    );
    const answer = await ask({ action: "companies" });
    expect(answer).toMatchObject({ ok: false, code: "unavailable" });
    if (!answer.ok) expect(answer.error).toContain("0024_company_lists_and_status.sql");
  });

  it("is refused with unknown parameters", async () => {
    expect(await ask({ action: "companies", list: "csg" })).toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(await ask({ action: "save" })).toMatchObject({ ok: false, code: "invalid" });
    expect(await ask({ action: "open-company", company_id: XYZ, period: "2026-13" })).toMatchObject(
      { ok: false, code: "invalid" },
    );
  });

  it("goes through the usual request log (answerRequest)", async () => {
    const answer = await answerRequest("payslip", COMPANY_LIST, () => ask({ action: "companies" }));
    expect(answer.ok).toBe(true);
  });
});

describe("open-picker", () => {
  it("opens the picker with the asking app's lists, and answers at once", async () => {
    const answer = await ask({ action: "open-picker" }, "mra-returns");
    expect(answer).toMatchObject({ ok: true, rows: [] });
    expect(pickerRequest.get()).toEqual({
      appId: "mra-returns",
      appName: "MRA Returns",
      lists: ["csg", "prgf"],
    });
  });

  it("is closed on sign-out", async () => {
    await ask({ action: "open-picker" });
    runSessionCleanup();
    expect(pickerRequest.get()).toBeNull();
  });
});

describe("open-company", () => {
  it("selects another company of the user, and marks it once for that app", async () => {
    const opened: string[] = [];
    const stop = setCompanyOpener((id) => opened.push(id));
    const answer = await ask({ action: "open-company", company_id: XYZ, period: "2026-10" });
    expect(answer).toMatchObject({ ok: true, rows: [{ switched: true }] });
    await vi.waitFor(() => expect(opened).toEqual([XYZ]));

    // The dashboard now has XYZ selected; the app reloads and asks again.
    exchangeContext.set({
      viewer: { id: ME, isDemo: false },
      membership: { role: "viewer", company: xyz },
    });
    const first = await ask({ action: "companies" });
    if (!first.ok) throw new Error("refused");
    expect(first.rows.find((row) => row.company_id === XYZ)).toMatchObject({
      open: true,
      open_period: "2026-10",
    });
    const again = await ask({ action: "companies" });
    if (!again.ok) throw new Error("refused");
    expect(again.rows.some((row) => "open" in row)).toBe(false);
    stop();
  });

  it("does not mark it for another app", async () => {
    const stop = setCompanyOpener(() => {});
    await ask({ action: "open-company", company_id: XYZ }, "payslip");
    exchangeContext.set({
      viewer: { id: ME, isDemo: false },
      membership: { role: "viewer", company: xyz },
    });
    const other = await ask({ action: "companies" }, "mra-returns");
    if (!other.ok) throw new Error("refused");
    expect(other.rows.some((row) => "open" in row)).toBe(false);
    stop();
  });

  it("changes nothing for the company already selected", async () => {
    const opened: string[] = [];
    const stop = setCompanyOpener((id) => opened.push(id));
    const answer = await ask({ action: "open-company", company_id: ABC });
    expect(answer).toMatchObject({ ok: true, rows: [{ switched: false }] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(opened).toEqual([]);
    stop();
  });

  it("refuses a company the user is not a member of", async () => {
    const answer = await ask({
      action: "open-company",
      company_id: "10000000-0000-4000-8000-000000000009",
    });
    expect(answer).toMatchObject({ ok: false, code: "forbidden" });
  });
});

describe("reloadApp", () => {
  it("counts up per app", () => {
    const before = appReloads.get().payslip ?? 0;
    reloadApp("payslip");
    expect(appReloads.get().payslip).toBe(before + 1);
  });
});
