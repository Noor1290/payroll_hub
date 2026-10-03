import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendOutcome } from "@/lib/bridge/hub";
import type { SendDataPayload } from "@/lib/bridge/protocol";
import { runSessionCleanup } from "@/lib/sessionCleanup";
import { grantUnlock, lock } from "@/lib/unlock";
import { applyTemplate, deleteTemplate, mappingTemplates, saveTemplate } from "./templates";
import { clearTransferLog, transferLog } from "./transferLog";

const send = vi.hoisted(() => vi.fn());
vi.mock("@/lib/bridge/bridge", () => ({ bridge: { send } }));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    loading: vi.fn(() => "toast-1"),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

const { deliver, retryTransfer } = await import("@/features/workspace/deliver");

// FAKE values, chosen to be easy to search for.
const SECRET_ID = "X0000000000001";
const SECRET_PAY = 18169.12;
const PAYLOAD: SendDataPayload = {
  dataType: "payroll-result",
  rows: [
    { ID: SECRET_ID, Surname: "DOE", "Net Pay": SECRET_PAY },
    { ID: "X0000000000002", Surname: "PALMYRE", "Net Pay": 24500 },
  ],
  meta: { period: "2026-09", label: "ABC Co Ltd" },
};
const FROM_APP = { label: "Payroll System", gated: false };
const FROM_DATABASE = { label: "Database, September 2026", gated: true };

const ok = (id: string): SendOutcome => ({ ok: true, id });
const failed = (
  id: string,
  reason: "timeout" | "not-ready" | "rejected" = "timeout",
): SendOutcome => ({
  ok: false,
  id,
  reason,
  ...(reason === "rejected" ? { error: `Row for ${SECRET_ID} is invalid` } : {}),
});

beforeEach(() => {
  send.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-03T14:32:00"));
});
afterEach(() => {
  clearTransferLog();
  lock();
  vi.useRealTimers();
  localStorage.clear();
});

describe("transfer log", () => {
  it("records a delivered transfer: who, when, how many, and the result", async () => {
    send.mockImplementation(async (_app, _payload, { id }) => ok(id));
    await deliver("pdf-editor", PAYLOAD, { source: FROM_APP });

    expect(transferLog.get()).toEqual([
      {
        id: expect.any(String),
        at: new Date("2026-10-03T14:32:00").getTime(),
        from: "Payroll System",
        toAppId: "pdf-editor",
        toName: "PDF Form Filler",
        rowCount: 2,
        dataType: "payroll-result",
        status: "delivered",
        reason: null,
        attempts: 1,
        canRetry: false,
      },
    ]);
  });

  it("shows a transfer as sending until the app answers", async () => {
    let answer!: (outcome: SendOutcome) => void;
    send.mockImplementation(
      (_app, _payload, { id }) => new Promise((r) => (answer = (o) => r({ ...o, id }))),
    );
    const done = deliver("pdf-editor", PAYLOAD, { source: FROM_APP });
    expect(transferLog.get()[0]!.status).toBe("sending");
    answer(ok(""));
    await done;
    expect(transferLog.get()[0]!.status).toBe("delivered");
  });

  it("records why a transfer failed, in fixed words", async () => {
    send.mockImplementationOnce(async (_a, _p, { id }) => failed(id, "not-ready"));
    send.mockImplementationOnce(async (_a, _p, { id }) => failed(id, "timeout"));
    send.mockImplementationOnce(async (_a, _p, { id }) => failed(id, "rejected"));
    for (let i = 0; i < 3; i++) await deliver("pdf-editor", PAYLOAD, { source: FROM_APP });

    expect(transferLog.get().map((entry) => `${entry.status}: ${entry.reason}`)).toEqual([
      "failed: refused by the app",
      "failed: no confirmation from the app (timeout)",
      "failed: app not ready (timeout)",
    ]);
  });

  it("never contains payroll values, not even inside an app's error text", async () => {
    send.mockImplementationOnce(async (_a, _p, { id }) => ok(id));
    send.mockImplementationOnce(async (_a, _p, { id }) => failed(id, "rejected"));
    await deliver("pdf-editor", PAYLOAD, { source: FROM_APP });
    await deliver("pdf-editor", PAYLOAD, { source: FROM_DATABASE, notify: false }).catch(() => {});

    const log = JSON.stringify(transferLog.get());
    expect(log).not.toContain(SECRET_ID);
    expect(log).not.toContain(String(SECRET_PAY));
    expect(log).not.toContain("DOE");
    expect(log).not.toContain("PALMYRE");
  });

  it("is not written to browser storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    send.mockImplementation(async (_a, _p, { id }) => failed(id));
    await deliver("pdf-editor", PAYLOAD, { source: FROM_APP });
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });
});

describe("retrying a failed transfer", () => {
  it("resends the same data with the same message id, and updates the same log row", async () => {
    send.mockImplementationOnce(async (_a, _p, { id }) => failed(id));
    const first = await deliver("pdf-editor", PAYLOAD, { source: FROM_APP });
    expect(transferLog.get()[0]).toMatchObject({ status: "failed", canRetry: true, attempts: 1 });

    send.mockImplementationOnce(async (_a, _p, { id }) => ok(id));
    const second = await retryTransfer(first.id);

    expect(second).toEqual({ ok: true, id: first.id });
    expect(send.mock.calls[1]).toEqual(["pdf-editor", PAYLOAD, { id: first.id }]);
    expect(transferLog.get()).toHaveLength(1);
    expect(transferLog.get()[0]).toMatchObject({
      status: "delivered",
      reason: null,
      attempts: 2,
      canRetry: false,
    });
  });

  it("cannot be retried once it was delivered", async () => {
    send.mockImplementation(async (_a, _p, { id }) => ok(id));
    const outcome = await deliver("pdf-editor", PAYLOAD, { source: FROM_APP });
    expect(retryTransfer(outcome.id)).toBeNull();
  });

  it("keeps only the five most recent failed payloads in memory", async () => {
    send.mockImplementation(async (_a, _p, { id }) => failed(id));
    const ids: string[] = [];
    for (let i = 0; i < 7; i++)
      ids.push((await deliver("pdf-editor", PAYLOAD, { source: FROM_APP })).id);

    const retryable = transferLog
      .get()
      .filter((entry) => entry.canRetry)
      .map((entry) => entry.id);
    expect(retryable).toHaveLength(5);
    expect(retryable).not.toContain(ids[0]);
    expect(retryable).not.toContain(ids[1]);
    expect(retryTransfer(ids[0]!)).toBeNull();
  });

  it("drops everything when the session ends", async () => {
    send.mockImplementation(async (_a, _p, { id }) => failed(id));
    const outcome = await deliver("pdf-editor", PAYLOAD, { source: FROM_APP });
    runSessionCleanup();
    expect(transferLog.get()).toEqual([]);
    expect(retryTransfer(outcome.id)).toBeNull();
  });
});

describe("data from a saved run (behind the password gate)", () => {
  it("is not sent while the gate is locked", async () => {
    const outcome = await deliver("pdf-editor", PAYLOAD, { source: FROM_DATABASE });
    expect(send).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ ok: false, reason: "unavailable" });
    expect(transferLog.get()[0]).toMatchObject({ status: "failed", reason: "dashboard locked" });
  });

  it("is sent while the gate is open", async () => {
    grantUnlock(10);
    send.mockImplementation(async (_a, _p, { id }) => ok(id));
    await expect(deliver("pdf-editor", PAYLOAD, { source: FROM_DATABASE })).resolves.toMatchObject({
      ok: true,
    });
    expect(transferLog.get()[0]!.from).toBe("Database, September 2026");
  });

  it("can no longer be retried once the gate locks; data from an app still can", async () => {
    grantUnlock(10);
    send.mockImplementation(async (_a, _p, { id }) => failed(id));
    const fromDatabase = await deliver("pdf-editor", PAYLOAD, { source: FROM_DATABASE });
    const fromApp = await deliver("pdf-editor", PAYLOAD, { source: FROM_APP });

    lock();

    expect(retryTransfer(fromDatabase.id)).toBeNull();
    const byId = Object.fromEntries(transferLog.get().map((entry) => [entry.id, entry.canRetry]));
    expect(byId[fromDatabase.id]).toBe(false);
    expect(byId[fromApp.id]).toBe(true);
  });
});

describe("mapping templates", () => {
  const columns = [
    { key: "ID", label: "National ID", type: "string" as const, sensitive: true, money: false },
    { key: "Net Pay", label: "Net pay", type: "number" as const, sensitive: true, money: true },
  ];
  const fields = [
    {
      key: "Employee",
      label: "Employee",
      type: "string" as const,
      required: true,
      sensitive: true,
    },
    { key: "Pay", label: "Pay", type: "number" as const, required: true, sensitive: true },
  ];

  afterEach(() => {
    for (const template of mappingTemplates.get()) deleteTemplate(template.id);
  });

  it("saves column names only, under a namespaced key", () => {
    saveTemplate({
      name: " Payroll to Payslip ",
      destinationId: "payslip",
      dataType: "payroll-result",
      mapping: { Employee: "ID", Pay: "Net Pay", Unused: "" },
    });

    const stored = localStorage.getItem("payroll-hub:mapping-templates")!;
    expect(JSON.parse(stored)).toEqual([
      {
        id: "payslip:payroll to payslip",
        name: "Payroll to Payslip",
        destinationId: "payslip",
        dataType: "payroll-result",
        mapping: { Employee: "ID", Pay: "Net Pay" },
        savedAt: expect.any(String),
      },
    ]);
    // Names of columns, never a value from a row.
    expect(stored).not.toContain(SECRET_ID);
    expect(stored).not.toContain(String(SECRET_PAY));
  });

  it("replaces a template saved again under the same name, and can delete it", () => {
    const input = { destinationId: "payslip", dataType: "payroll-result" };
    saveTemplate({ ...input, name: "Mine", mapping: { Employee: "ID" } });
    saveTemplate({ ...input, name: "mine", mapping: { Pay: "Net Pay" } });
    expect(mappingTemplates.get()).toHaveLength(1);
    expect(mappingTemplates.get()[0]!.mapping).toEqual({ Pay: "Net Pay" });

    deleteTemplate(mappingTemplates.get()[0]!.id);
    expect(mappingTemplates.get()).toEqual([]);
    expect(localStorage.getItem("payroll-hub:mapping-templates")).toBe("[]");
  });

  it("refuses a blank name", () => {
    expect(
      saveTemplate({ name: "  ", destinationId: "payslip", dataType: "x", mapping: {} }),
    ).toBeNull();
    expect(mappingTemplates.get()).toEqual([]);
  });

  it("applies only the parts that still fit the data and the destination", () => {
    const template = saveTemplate({
      name: "Old",
      destinationId: "payslip",
      dataType: "payroll-result",
      mapping: { Employee: "ID", Pay: "Salary (renamed since)", Gone: "Net Pay" },
    })!;
    expect(applyTemplate(template, columns, fields)).toEqual({ Employee: "ID" });
  });
});
