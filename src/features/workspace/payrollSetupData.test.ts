import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APPS, getApp } from "@/config/apps.config";
import { HOSTING } from "@/config/origins";
import { clearTransferLog, transferLog } from "@/features/transfer/transferLog";
import { bridge } from "@/lib/bridge/bridge";
import { DATA_RULES } from "@/lib/bridge/protocol";
import { demoMemberships } from "@/lib/demo/demoData";
import { demoForgetPayrollSetups, demoSeedAttachedCompany } from "@/lib/demo/demoPayrollSetups";
import { runSessionCleanup } from "@/lib/sessionCleanup";
import type { Membership } from "@/lib/supabase/schemas";
import { exchangeContext } from "./appData";
import {
  answerPayrollSetupRequest,
  describePayrollSetupSave,
  savePayrollSetupFromApp,
} from "./payrollSetupData";

/**
 * The payroll app's column setup, end to end on the dashboard's side: what the app sends is
 * checked here and carried out by the demo store, which follows the rules of migration 0013
 * (src/lib/demo/demoPayrollSetups.ts). The same rules in the real database are tested in
 * payrollSetups.db.test.ts. FAKE values only.
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
  globalColumns: [
    {
      id: "c1",
      key: "basicSalary",
      name: "Basic Salary",
      type: "input",
      category: "earnings",
      valueType: "number",
      decimals: 2,
    },
    {
      id: "c2",
      key: "employeeCsg",
      name: "Employee CSG",
      type: "formula",
      formula: "basicSalary * 0.015",
      decimals: 2,
    },
  ],
};
const OWN = {
  columns: [{ id: "k1", key: "transport", name: "Transport", type: "input" }],
  customFields: [],
};

const request = (params: Record<string, unknown>) =>
  answerPayrollSetupRequest({ dataType: "payroll-setup", params });
const send = (row: Record<string, unknown>) =>
  savePayrollSetupFromApp({ dataType: "payroll-setup", rows: [row] });

const createShared = (more: Record<string, unknown> = {}) =>
  send({
    action: "save-shared",
    brn: "C1234567",
    shared_setup_id: S1,
    name: "Shared column setup",
    body: SHARED,
    expected_revision: 0,
    ...more,
  });
const attach = (more: Record<string, unknown> = {}) =>
  send({ action: "attach-company", brn: "C1234567", shared_setup_id: S1, body: OWN, ...more });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  demoForgetPayrollSetups();
  signIn();
  toast.success.mockClear();
  toast.error.mockClear();
});
afterEach(() => {
  runSessionCleanup();
  clearTransferLog();
  vi.useRealTimers();
});

describe("the data type", () => {
  it("is the payroll app's only, to ask for and to send, one command per message", () => {
    const users = APPS.filter(
      (app) => app.accepts.includes("payroll-setup") || app.produces.includes("payroll-setup"),
    );
    expect(users.map((app) => app.id)).toEqual(["payroll"]);
    expect(getApp("payroll")).toMatchObject({
      accepts: ["payroll-setup"],
      produces: ["payroll-result", "payroll-setup"],
    });
    expect(DATA_RULES["payroll-setup"]).toMatchObject({ sendRows: 1, answerRows: [0, 500] });
  });
});

describe("payroll-setup: load", () => {
  it("answers nothing, with the company and the role, while the company has no setup", async () => {
    expect(await request({ action: "load" })).toEqual({
      ok: true,
      dataType: "payroll-setup",
      rows: [],
      meta: { label: "ABC Co Ltd", brn: "C1234567", role: "admin" },
    });
  });

  it("returns the shared setup and the company's own, exactly as they were sent", async () => {
    expect(await createShared()).toMatchObject({
      ok: true,
      result: { action: "save-shared", revision: 1 },
    });
    expect(await attach()).toMatchObject({
      ok: true,
      result: { action: "attach-company", brn: "C1234567", company: "ABC Co Ltd", revision: 1 },
    });
    const loaded = await request({ action: "load" });
    expect(loaded).toMatchObject({
      ok: true,
      rows: [
        {
          kind: "shared",
          shared_setup_id: S1,
          body: SHARED,
          revision: 1,
          can_change: true,
          companies: 1,
          admin_of: 1,
          updated_by_you: true,
        },
        {
          kind: "company",
          brn: "C1234567",
          name: "ABC Co Ltd",
          address: "Mauritius",
          role: "admin",
          selected: true,
          body: OWN,
          revision: 1,
        },
      ],
    });
    // Never anyone's user id.
    expect(JSON.stringify(loaded)).not.toContain(ME);
  });

  it("refuses a BRN that is not the selected company's, and anything not asked for properly", async () => {
    expect(await request({ action: "load", brn: "C7654321" })).toMatchObject({
      ok: false,
      code: "wrong-company",
    });
    expect(await request({ action: "load", extra: 1 })).toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(await request({ action: "drop" })).toMatchObject({ ok: false, code: "invalid" });
    exchangeContext.set(null);
    expect(await request({ action: "load" })).toMatchObject({ ok: false, code: "unavailable" });
  });
});

describe("payroll-setup: saves", () => {
  it("a Global column changed by one admin is what the next load returns, for every attached company", async () => {
    await createShared();
    await attach();
    await attach({ company_brn: "C0000001", body: { columns: [], customFields: [] } });
    const changed = {
      ...SHARED,
      globalColumns: [
        ...SHARED.globalColumns,
        { id: "c3", key: "bonus", name: "Bonus", type: "input" },
      ],
    };
    expect(await createShared({ body: changed, expected_revision: 1 })).toMatchObject({
      ok: true,
      result: { revision: 2 },
    });

    for (const membership of [ABC, NEW]) {
      signIn(membership);
      const loaded = await request({ action: "load" });
      expect(loaded.ok && loaded.rows[0]).toMatchObject({
        kind: "shared",
        revision: 2,
        body: changed,
      });
      const companies = loaded.ok ? loaded.rows.filter((r) => r.kind === "company") : [];
      expect(Object.fromEntries(companies.map((r) => [r.brn, r.selected]))).toEqual({
        C1234567: membership === ABC,
        C0000001: membership === NEW,
      });
    }
  });

  it("refuses a save that carries an old revision, and the same new setup sent twice is stored once", async () => {
    await createShared();
    expect(await createShared()).toMatchObject({ ok: false, code: "stale" });
    expect(await createShared({ expected_revision: 1, body: { a: 1 } })).toMatchObject({
      ok: true,
    });
    expect(await createShared({ expected_revision: 1, body: { b: 2 } })).toMatchObject({
      ok: false,
      code: "stale",
    });
  });

  it("saves company setups together with the shared setup, named by BRN, and says which", async () => {
    await createShared();
    await attach();
    await attach({ company_brn: "C0000001" });
    const saved = await createShared({
      expected_revision: 1,
      body: { renamed: true },
      companies: [
        { company_brn: "C1234567", body: { columns: ["renamed"] }, expected_revision: 1 },
        { company_brn: "c0000001 ", body: { columns: ["renamed too"] }, expected_revision: 1 },
      ],
    });
    expect(saved).toMatchObject({
      ok: true,
      result: {
        revision: 2,
        companies: [
          { brn: "C1234567", revision: 2 },
          { brn: "C0000001", revision: 2 },
        ],
      },
    });
    // One company with an old revision: nothing at all is stored.
    expect(
      await createShared({
        expected_revision: 2,
        body: { third: true },
        companies: [{ company_brn: "C0000001", body: {}, expected_revision: 1 }],
      }),
    ).toMatchObject({ ok: false, code: "stale" });
    const loaded = await request({ action: "load" });
    expect(loaded.ok && loaded.rows[0]).toMatchObject({ revision: 2, body: { renamed: true } });
    // A company the user does not have, or one named twice.
    expect(
      await createShared({
        expected_revision: 2,
        companies: [{ company_brn: "C9999999", body: {}, expected_revision: 1 }],
      }),
    ).toMatchObject({ ok: false, code: "not-found" });
    expect(
      await createShared({
        expected_revision: 2,
        companies: [
          { company_brn: "C1234567", body: {}, expected_revision: 2 },
          { company_brn: "c1234567", body: {}, expected_revision: 2 },
        ],
      }),
    ).toMatchObject({ ok: false, code: "invalid" });
  });

  it("an admin of some but not all attached companies cannot change the shared setup or attach to it", async () => {
    await createShared();
    await attach();
    // XYZ, which this user only views, was attached by another admin.
    demoSeedAttachedCompany(XYZ.company.id, S1, { columns: [], customFields: [] });
    const loaded = await request({ action: "load" });
    expect(loaded.ok && loaded.rows[0]).toMatchObject({
      can_change: false,
      companies: 2,
      admin_of: 1,
    });
    expect(await createShared({ expected_revision: 1, body: { changed: true } })).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    expect(await attach({ company_brn: "C0000001" })).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    // Its own columns are still the admin's to change.
    expect(
      await send({
        action: "save-company",
        brn: "C1234567",
        body: { columns: [] },
        expected_revision: 1,
      }),
    ).toMatchObject({
      ok: true,
      result: { action: "save-company", revision: 2 },
    });
  });

  it("a viewer can read and not save", async () => {
    await createShared();
    await attach();
    demoSeedAttachedCompany(XYZ.company.id, S1, OWN);
    signIn(XYZ);
    const loaded = await request({ action: "load" });
    expect(loaded).toMatchObject({ ok: true, meta: { role: "member" } });
    expect(loaded.ok && loaded.rows.find((r) => r.selected)).toMatchObject({
      role: "member",
      body: OWN,
    });
    expect(
      await send({ action: "save-company", brn: "C7654321", body: {}, expected_revision: 1 }),
    ).toMatchObject({
      ok: false,
      code: "forbidden",
    });
  });

  it("attaches a company once, and only to a setup the user may change", async () => {
    expect(await attach()).toMatchObject({ ok: false, code: "not-found" });
    await createShared();
    await attach();
    expect(await attach()).toMatchObject({ ok: false, code: "stale" });
    expect(await attach({ company_brn: "C7654321" })).toMatchObject({
      ok: false,
      code: "forbidden",
    });
  });

  it("refuses a body over 250 KB, a malformed save, and a save for another selected company", async () => {
    const big = { text: "x".repeat(260_000) };
    expect(await createShared({ body: big })).toMatchObject({ ok: false, code: "too-large" });
    expect(await createShared({ shared_setup_id: "not-an-id" })).toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(await createShared({ name: " " })).toMatchObject({ ok: false, code: "invalid" });
    expect(await createShared({ unexpected: true })).toMatchObject({ ok: false, code: "invalid" });
    expect(await createShared({ brn: "C0000001" })).toMatchObject({
      ok: false,
      code: "wrong-company",
    });
    expect(
      await send({ action: "save-company", brn: "C1234567", body: {}, expected_revision: 1 }),
    ).toMatchObject({
      ok: false,
      code: "not-found",
    });
  });
});

describe("payroll-setup: history, one revision, and the companies to link to", () => {
  it("lists every revision newest first, and returns one as it was saved", async () => {
    await createShared();
    await attach();
    await createShared({ expected_revision: 1, body: { second: true } });
    expect(await request({ action: "history", target: "shared" })).toMatchObject({
      ok: true,
      rows: [
        { revision: 2, saved_by_you: true },
        { revision: 1, saved_by_you: true },
      ],
    });
    expect(await request({ action: "revision", target: "shared", revision: 1 })).toMatchObject({
      ok: true,
      rows: [{ revision: 1, body: SHARED }],
    });
    expect(await request({ action: "revision", target: "company", revision: 1 })).toMatchObject({
      rows: [{ revision: 1, body: OWN }],
    });
    expect(await request({ action: "revision", target: "shared", revision: 9 })).toMatchObject({
      ok: false,
      code: "not-found",
    });
    signIn(NEW);
    expect(await request({ action: "history", target: "company" })).toMatchObject({
      ok: false,
      code: "not-found",
    });
  });

  it("lists only the companies the user is an admin of, and whether each has a setup", async () => {
    await createShared();
    await attach();
    const answer = await request({ action: "companies" });
    expect(answer.ok && answer.rows).toHaveLength(3);
    expect(answer).toMatchObject({
      ok: true,
      rows: expect.arrayContaining([
        expect.objectContaining({
          brn: "C1234567",
          name: "ABC Co Ltd",
          has_setup: true,
          shared_setup_id: S1,
          selected: true,
        }),
        expect.objectContaining({
          brn: "C0000001",
          name: "New Venture Ltd",
          has_setup: false,
          shared_setup_id: null,
          selected: false,
        }),
        expect.objectContaining({
          brn: "C0000002",
          name: "Big Sample Ltd",
          has_setup: false,
          shared_setup_id: null,
          selected: false,
        }),
      ]),
    });
    // XYZ is one this user only views: not offered.
    expect(JSON.stringify(answer)).not.toContain("C7654321");
  });
});

describe("what the user is told", () => {
  it("names the company and the revision in the toast, and nothing from the columns", () => {
    expect(describePayrollSetupSave({ action: "save-shared", revision: 3, companies: [] })).toBe(
      "Shared payroll columns saved (revision 3)",
    );
    expect(
      describePayrollSetupSave({ action: "save-shared", revision: 4, companies: [{}, {}] }),
    ).toBe("Shared payroll columns saved (revision 4), with the columns of 2 companies");
    expect(
      describePayrollSetupSave({ action: "save-company", company: "ABC Co Ltd", revision: 2 }),
    ).toBe("Payroll columns of ABC Co Ltd saved (revision 2)");
    expect(describePayrollSetupSave({ action: "attach-company", company: "ABC Co Ltd" })).toBe(
      "ABC Co Ltd now uses the shared payroll columns",
    );
  });

  it("over the bridge, from the payroll app's frame: answered, one log row each, and nothing from the columns in the log", async () => {
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
      action: "save-shared",
      brn: "C1234567",
      shared_setup_id: S1,
      name: "Shared column setup",
      body: SHARED,
      expected_revision: 0,
    };
    fromApp("send-data", "save-0000001", { dataType: "payroll-setup", rows: [row] });
    expect((await reply("save-0000001")).payload).toMatchObject({
      ok: true,
      result: { revision: 1 },
    });
    fromApp("send-data", "attach-00001", {
      dataType: "payroll-setup",
      rows: [{ action: "attach-company", brn: "C1234567", shared_setup_id: S1, body: OWN }],
    });
    expect((await reply("attach-00001")).payload).toMatchObject({ ok: true });
    fromApp("request-data", "load-0000001", {
      dataType: "payroll-setup",
      params: { action: "load" },
    });
    expect((await reply("load-0000001")).payload).toMatchObject({
      ok: true,
      rows: [{ kind: "shared" }, { kind: "company" }],
    });

    const log = transferLog.get();
    expect(log.map((r) => r.dataType)).toEqual(["payroll-setup", "payroll-setup", "payroll-setup"]);
    const written = JSON.stringify(log);
    for (const secret of ["basicSalary", "Basic Salary", "Transport", "0.015"])
      expect(written).not.toContain(secret);
    expect(toast.success).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(toast.success.mock.calls)).not.toContain("Basic Salary");

    bridge.detachFrame("payroll");
    bridge.stop();
    iframe.remove();
  });
});

describe("the production build", () => {
  it("can drop the demo store: every use of it is behind `import.meta.env.DEV`, written out in place", async () => {
    const source = (await import("@/lib/supabase/payrollSetups.ts?raw")).default as string;
    const guarded = source.split("import.meta.env.DEV && viewer.isDemo").length - 1;
    const demoCalls = [...source.matchAll(/\bdemo[A-Z]\w+\(/g)].length;
    expect(demoCalls).toBeGreaterThanOrEqual(10);
    expect(guarded).toBe(demoCalls);
    expect(source).not.toMatch(/=>\s*import\.meta\.env\.DEV/);
  });
});
