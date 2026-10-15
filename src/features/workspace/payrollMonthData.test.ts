import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APPS, getApp } from "@/config/apps.config";
import { HOSTING } from "@/config/origins";
import { clearTransferLog, transferLog } from "@/features/transfer/transferLog";
import { bridge, dataRequests } from "@/lib/bridge/bridge";
import { DATA_RULES } from "@/lib/bridge/protocol";
import { demoMemberships } from "@/lib/demo/demoData";
import { demoForgetPayrollMonths, demoPayrollMonthCounts } from "@/lib/demo/demoPayrollMonths";
import { demoForgetPayrollSetups } from "@/lib/demo/demoPayrollSetups";
import { GATED_QUERY_KEYS, PAYROLL_MONTHS_KEY } from "@/lib/queryClient";
import { runSessionCleanup } from "@/lib/sessionCleanup";
import type { Membership } from "@/lib/supabase/schemas";
import { grantUnlock, isUnlocked, lock } from "@/lib/unlock";
import { exchangeContext } from "./appData";
import {
  answerPayrollMonthRequest,
  describePayrollMonthSave,
  savePayrollMonthFromApp,
} from "./payrollMonthData";
import { savePayrollSetupFromApp } from "./payrollSetupData";

/**
 * The payroll app's months, on the dashboard's side: what the app sends is checked here and
 * carried out by the demo store, which follows the rules of migration 0014
 * (src/lib/demo/demoPayrollMonths.ts). The same rules in the real database are tested in
 * payrollMonths.db.test.ts. FAKE values only.
 */
const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  loading: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));

const ME = "00000000-0000-4000-8000-000000000001";
const membershipOf = (brn: string) => demoMemberships.find((m) => m.company.brn === brn)!;
const ABC = membershipOf("C1234567"); // admin
const XYZ = membershipOf("C7654321"); // viewer
const NEW = membershipOf("C0000001"); // admin
const signIn = (membership: Membership = ABC) =>
  exchangeContext.set({ viewer: { id: ME, isDemo: true }, membership });

const S1 = "30000000-0000-4000-8000-000000000001";
const SHARED = {
  identityFields: [{ id: "f1", key: "employeeId", name: "ID" }],
  idFieldKey: "employeeId",
  globalColumns: [{ id: "c1", key: "basicSalary", name: "Basic Salary", type: "input" }],
};
const OWN = { columns: [], customFields: [] };
const NIC = "X0000000000001";
const month = (salary = 18115) => [
  { id: "e1", values: { employeeId: "TST001", nationalId: NIC, basicSalary: salary } },
  { id: "e2", values: { employeeId: "TST002", basicSalary: 62500.5, age60: true } },
];

const request = (params: Record<string, unknown>) =>
  answerPayrollMonthRequest("payroll", { dataType: "payroll-month", params });
const send = (row: Record<string, unknown>) =>
  savePayrollMonthFromApp({ dataType: "payroll-month", rows: [row] });
const save = (more: Record<string, unknown> = {}) =>
  send({
    action: "save",
    brn: "C1234567",
    period: "2026-10",
    employees: month(),
    expected_revision: 0,
    shared_revision: 1,
    company_revision: 1,
    ...more,
  });

/** The shared setup, with ABC and NEW attached to it, as the payroll app's import makes it. */
async function setUp() {
  const setup = (row: Record<string, unknown>) =>
    savePayrollSetupFromApp({ dataType: "payroll-setup", rows: [row] });
  await setup({
    action: "save-shared",
    brn: "C1234567",
    shared_setup_id: S1,
    name: "Shared column setup",
    body: SHARED,
    expected_revision: 0,
  });
  await setup({ action: "attach-company", brn: "C1234567", shared_setup_id: S1, body: OWN });
  await setup({
    action: "attach-company",
    brn: "C1234567",
    company_brn: "C0000001",
    shared_setup_id: S1,
    body: OWN,
  });
}

beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  demoForgetPayrollSetups();
  demoForgetPayrollMonths();
  signIn();
  await setUp();
  grantUnlock(10);
  toast.success.mockClear();
  toast.error.mockClear();
});
afterEach(() => {
  lock();
  runSessionCleanup();
  clearTransferLog();
  vi.useRealTimers();
});

describe("the data type", () => {
  it("is the payroll app's only, to ask for and to send, one command per message, and gated", () => {
    const users = APPS.filter(
      (app) => app.accepts.includes("payroll-month") || app.produces.includes("payroll-month"),
    );
    expect(users.map((app) => app.id)).toEqual(["payroll"]);
    expect(getApp("payroll")).toMatchObject({
      accepts: ["payroll-setup", "payroll-month"],
      produces: ["payroll-result", "payroll-setup", "payroll-month"],
    });
    expect(DATA_RULES["payroll-month"]).toMatchObject({ sendRows: 1, answerRows: [0, 1_200] });
    expect(GATED_QUERY_KEYS).toContainEqual([PAYROLL_MONTHS_KEY]);
  });
});

describe("payroll-month while the password gate is locked", () => {
  beforeEach(() => lock());

  it("says whether it is open, to any member, with nothing else in the answer", async () => {
    expect(await request({ action: "gate" })).toMatchObject({
      ok: true,
      rows: [{ unlocked: false }],
    });
    signIn(XYZ);
    expect(await request({ action: "gate" })).toMatchObject({
      ok: true,
      rows: [{ unlocked: false }],
    });
  });

  it("refuses every read and every save at once as locked, and stores nothing", async () => {
    for (const params of [
      { action: "list", brn: "C1234567" },
      { action: "load", brn: "C1234567", periods: ["2026-10"] },
      { action: "history", brn: "C1234567", period: "2026-10" },
    ]) {
      expect(await request(params), params.action).toMatchObject({ ok: false, code: "locked" });
    }
    expect(await save()).toMatchObject({ ok: false, code: "locked" });
    expect(
      await send({
        action: "key-change",
        brn: "C1234567",
        moves: [{ old_key: "basicSalary", new_key: "basicPay", company_brn: null }],
        shared: {
          shared_setup_id: S1,
          name: "Shared column setup",
          body: SHARED,
          expected_revision: 1,
        },
      }),
    ).toMatchObject({ ok: false, code: "locked" });
    expect(demoPayrollMonthCounts(ABC.company.id)).toEqual({
      payrollMonths: 0,
      payrollMonthRevisions: 0,
    });
  });

  it("'unlock' asks for the password in the dashboard, and answers once the gate is open", async () => {
    const asked = request({ action: "unlock", brn: "C1234567" });
    await vi.waitFor(() => expect(dataRequests.get()).toHaveLength(1));
    const [waiting] = dataRequests.get();
    expect(waiting!.question).toMatchObject({ unlockOnly: true, what: "the employees' figures" });
    grantUnlock(10);
    // The dialog answers by itself once unlocked (BridgeDialogs); here, as it would.
    waiting!.respond(await waiting!.question!.answer());
    expect(await asked).toMatchObject({ ok: true, rows: [{ unlocked: true }] });
  });

  it("'unlock' turned down is not an unlock", async () => {
    const asked = request({ action: "unlock", brn: "C1234567" });
    await vi.waitFor(() => expect(dataRequests.get()).toHaveLength(1));
    dataRequests.get()[0]!.respond({ ok: false, code: "denied", error: "Not now." });
    expect(await asked).toMatchObject({ ok: false, code: "denied" });
    expect(isUnlocked()).toBe(false);
  });
});

describe("payroll-month: who may", () => {
  it("only an admin of the company: a viewer is refused everything but 'gate', without a prompt", async () => {
    signIn(XYZ);
    for (const params of [
      { action: "unlock", brn: "C7654321" },
      { action: "list", brn: "C7654321" },
      { action: "load", brn: "C7654321", periods: ["2026-10"] },
    ]) {
      expect(await request(params), params.action).toMatchObject({ ok: false, code: "forbidden" });
    }
    expect(await save({ brn: "C7654321" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(dataRequests.get()).toHaveLength(0);
  });

  it("only the company selected in the dashboard, or another of the user's by BRN where they are an admin", async () => {
    expect(await save({ brn: "C7654321" })).toMatchObject({ ok: false, code: "wrong-company" });
    expect(await save({ company_brn: "C7654321" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await save({ company_brn: "NO-SUCH" })).toMatchObject({ ok: false, code: "not-found" });
    expect(await save({ company_brn: "C0000001" })).toMatchObject({
      ok: true,
      result: { brn: "C0000001", period: "2026-10", revision: 1 },
    });
    expect(demoPayrollMonthCounts(NEW.company.id).payrollMonths).toBe(1);
    expect(demoPayrollMonthCounts(ABC.company.id).payrollMonths).toBe(0);
  });
});

describe("payroll-month: saving and reading a month", () => {
  it("stores a new month at revision 1 and gives it back exactly, without a toast", async () => {
    expect(await save()).toMatchObject({
      ok: true,
      result: {
        action: "save",
        brn: "C1234567",
        period: "2026-10",
        revision: 1,
        employee_count: 2,
      },
    });
    const loaded = await request({
      action: "load",
      brn: "C1234567",
      periods: ["2026-10", "2026-09"],
    });
    expect(loaded).toMatchObject({
      ok: true,
      meta: { brn: "C1234567", role: "admin" },
      rows: [
        {
          period: "2026-10",
          revision: 1,
          shared_revision: 1,
          company_revision: 1,
          employee_count: 2,
          updated_by_you: true,
        },
      ],
    });
    expect(loaded.ok && loaded.rows[0]!.employees).toEqual(month());
    expect(loaded.ok && "updated_by" in loaded.rows[0]!).toBe(false);
  });

  it("lists every month without its employees: the keys it holds, never a value", async () => {
    await save();
    await save({ period: "2026-09" });
    const list = await request({ action: "list", brn: "C1234567" });
    expect(list).toMatchObject({
      ok: true,
      rows: [
        {
          period: "2026-09",
          revision: 1,
          employee_count: 2,
          value_keys: ["age60", "basicSalary", "employeeId", "nationalId"],
        },
        { period: "2026-10", revision: 1 },
      ],
    });
    const text = JSON.stringify(list);
    for (const value of [NIC, "TST001", "18115", "62500.5"]) expect(text).not.toContain(value);
  });

  it("refuses an old revision as stale, and the same save sent twice stores once", async () => {
    await save();
    expect(await save()).toMatchObject({ ok: false, code: "stale" });
    expect(await save({ expected_revision: 1, employees: month(19115) })).toMatchObject({
      ok: true,
      result: { revision: 2 },
    });
    expect(await save({ expected_revision: 1, employees: month(1) })).toMatchObject({
      ok: false,
      code: "stale",
      error: expect.stringContaining("Someone else saved this month"),
    });
    expect(demoPayrollMonthCounts(ABC.company.id)).toEqual({
      payrollMonths: 1,
      payrollMonthRevisions: 2,
    });
  });

  it("refuses what is malformed or too large, naming fields, never values", async () => {
    const huge = [{ id: "e1", values: { note: "x".repeat(1_000_100) } }];
    expect(await save({ employees: huge })).toMatchObject({ ok: false, code: "too-large" });
    expect(await save({ period: "2026-13" })).toMatchObject({ ok: false, code: "invalid" });
    expect(await save({ employees: [{ id: "e1" }] })).toMatchObject({ ok: false, code: "invalid" });
    const extra = await save({ employees: [{ id: "e1", values: {}, nationalId: NIC }] });
    expect(extra).toMatchObject({ ok: false, code: "invalid" });
    expect(JSON.stringify(extra)).not.toContain(NIC);
    expect(await save({ shared_revision: 9 })).toMatchObject({ ok: false, code: "invalid" });
    expect(
      await request({ action: "load", brn: "C1234567", periods: Array(13).fill("2026-10") }),
    ).toMatchObject({ ok: false, code: "invalid" });
    expect(demoPayrollMonthCounts(ABC.company.id).payrollMonths).toBe(0);
  });

  it("a company with no column setup has no months", async () => {
    demoForgetPayrollSetups();
    expect(await save()).toMatchObject({ ok: false, code: "not-found" });
  });

  it("a read that the gate locks in the middle of answers locked, with nothing in it", async () => {
    await save();
    const reading = request({ action: "load", brn: "C1234567", periods: ["2026-10"] });
    lock();
    const answer = await reading;
    expect(answer).toMatchObject({ ok: false, code: "locked" });
    expect(JSON.stringify(answer)).not.toContain("TST001");
  });
});

describe("payroll-month: a change of key", () => {
  it("saves the setup with the new key and moves the values in every month of every attached company", async () => {
    await save();
    await save({ company_brn: "C0000001" });
    const renamed = JSON.parse(
      JSON.stringify(SHARED).replaceAll("basicSalary", "basicPay"),
    ) as typeof SHARED;
    const changed = await send({
      action: "key-change",
      brn: "C1234567",
      moves: [{ old_key: "basicSalary", new_key: "basicPay", company_brn: null }],
      shared: {
        shared_setup_id: S1,
        name: "Shared column setup",
        body: renamed,
        expected_revision: 1,
      },
    });
    expect(changed).toMatchObject({
      ok: true,
      result: {
        action: "key-change",
        setup: { shared_setup_id: S1, revision: 2 },
        months: expect.arrayContaining([
          { brn: "C1234567", period: "2026-10", revision: 2 },
          { brn: "C0000001", period: "2026-10", revision: 2 },
        ]),
      },
    });
    const loaded = await request({ action: "load", brn: "C1234567", periods: ["2026-10"] });
    expect(JSON.stringify(loaded)).toContain('"basicPay":18115');
    expect(JSON.stringify(loaded)).not.toContain("basicSalary");
    expect(describePayrollMonthSave(changed.ok ? changed.result! : {})).toBe(
      "Payroll column key changed, with its values in 2 months",
    );
  });

  it("a stale setup changes nothing, in the setup or a month", async () => {
    await save();
    const changed = await send({
      action: "key-change",
      brn: "C1234567",
      moves: [{ old_key: "basicSalary", new_key: "basicPay", company_brn: null }],
      shared: {
        shared_setup_id: S1,
        name: "Shared column setup",
        body: SHARED,
        expected_revision: 5,
      },
    });
    expect(changed).toMatchObject({ ok: false, code: "stale" });
    const loaded = await request({ action: "load", brn: "C1234567", periods: ["2026-10"] });
    expect(JSON.stringify(loaded)).toContain('"basicSalary":18115');
  });

  it("needs exactly one setup: the shared one or the company's own", async () => {
    expect(
      await send({
        action: "key-change",
        brn: "C1234567",
        moves: [{ old_key: "a", new_key: "b", company_brn: null }],
      }),
    ).toMatchObject({ ok: false, code: "invalid" });
  });
});

describe("the transfer log and the toasts", () => {
  it("over the bridge: one row per exchange with counts only, no toast for a saved month, one for a refused one", async () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const frame = iframe.contentWindow!;
    const replies: { type: string; id: string; payload: Record<string, unknown> }[] = [];
    frame.postMessage = ((message: (typeof replies)[number]) => replies.push(message)) as never;
    bridge.start();
    bridge.attachFrame("payroll", () => frame);
    const fromApp = (type: string, id: string, payload: unknown) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type, from: "payroll", to: "dashboard", version: 1, id, payload },
          origin: HOSTING.apps,
          source: frame,
        }),
      );
    const reply = (id: string) =>
      vi.waitFor(() => {
        const found = replies.find((r) => r.id === id);
        expect(found).toBeTruthy();
        return found!;
      });
    const row = {
      action: "save",
      brn: "C1234567",
      period: "2026-10",
      employees: month(),
      expected_revision: 0,
      shared_revision: 1,
      company_revision: 1,
    };
    fromApp("send-data", "month-000001", { dataType: "payroll-month", rows: [row] });
    expect((await reply("month-000001")).payload).toMatchObject({
      ok: true,
      result: { revision: 1 },
    });
    fromApp("send-data", "month-000002", { dataType: "payroll-month", rows: [row] });
    expect((await reply("month-000002")).payload).toMatchObject({ ok: false, code: "stale" });
    fromApp("request-data", "month-000003", {
      dataType: "payroll-month",
      params: { action: "load", brn: "C1234567", periods: ["2026-10"] },
    });
    expect((await reply("month-000003")).payload).toMatchObject({ ok: true });

    const log = transferLog.get();
    expect(log.map((r) => r.dataType)).toEqual(["payroll-month", "payroll-month", "payroll-month"]);
    const written = JSON.stringify(log);
    for (const secret of [NIC, "TST001", "18115", "basicSalary"])
      expect(written).not.toContain(secret);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(toast.error.mock.calls)).not.toContain("TST001");

    bridge.detachFrame("payroll");
    bridge.stop();
    iframe.remove();
  });

  it("describes a saved month by company, month and revision only", () => {
    expect(
      describePayrollMonthSave({
        action: "save",
        company: "ABC Co Ltd",
        period: "2026-10",
        revision: 3,
      }),
    ).toBe("ABC Co Ltd: October 2026 saved (revision 3)");
  });
});

describe("telling the payroll app when the gate opens or locks", () => {
  it("sends whether it is open, and nothing else, only when that changes", () => {
    lock();
    const sent = vi.spyOn(bridge, "send").mockResolvedValue({ ok: true, id: "x" });
    grantUnlock(10);
    grantUnlock(10); // still open: not told again
    lock();
    expect(sent.mock.calls).toEqual([
      ["payroll", { dataType: "payroll-month", rows: [{ action: "gate", unlocked: true }] }],
      ["payroll", { dataType: "payroll-month", rows: [{ action: "gate", unlocked: false }] }],
    ]);
    sent.mockRestore();
  });
});

describe("the production build", () => {
  it("can drop the demo store: every use of it is behind `import.meta.env.DEV`, written out in place", async () => {
    const source = (await import("@/lib/supabase/payrollMonths.ts?raw")).default as string;
    const guarded = source.split("import.meta.env.DEV && viewer.isDemo").length - 1;
    const demoCalls = [...source.matchAll(/\bdemo[A-Z]\w+\(/g)].length;
    expect(demoCalls).toBe(5);
    expect(guarded).toBe(demoCalls);
    expect(source).not.toMatch(/=>\s*import\.meta\.env\.DEV/);
  });
});
