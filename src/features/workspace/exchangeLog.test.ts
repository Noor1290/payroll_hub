import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearTransferLog, transferLog } from "@/features/transfer/transferLog";
import { bridge, dataRequests } from "@/lib/bridge/bridge";
import type { ReceivedPayload, ResponseDataPayload } from "@/lib/bridge/protocol";
import { REFUSAL_CODES } from "@/lib/bridge/protocol";
import { runSessionCleanup } from "@/lib/sessionCleanup";
import "./appData";
import { answerRequest, recordSave } from "./deliver";

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  loading: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));

// FAKE values, chosen to be easy to search for.
const SECRET_ID = "X0000000000001";
const SECRET_PAY = 18169.12;
const ROWS = [{ ID: SECRET_ID, Surname: "DOE", "Net Pay": SECRET_PAY }];

const rows = () => transferLog.get().map((row) => ({ ...row, at: undefined, id: undefined }));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
});
afterEach(() => {
  runSessionCleanup();
  clearTransferLog();
});

describe("answerRequest", () => {
  it("logs the request as waiting, then as answered with the number of rows and the period", async () => {
    const answer = deferred<ResponseDataPayload>();
    const done = answerRequest("pdf-editor", "payroll-result", () => answer.promise);
    expect(rows()).toEqual([
      {
        kind: "request",
        from: "Database",
        toAppId: "pdf-editor",
        toName: "PDF Form Filler",
        dataType: "payroll-result",
        rowCount: 0,
        status: "sending",
        reason: null,
        attempts: 1,
        canRetry: false,
      },
    ]);

    const response: ResponseDataPayload = {
      ok: true,
      dataType: "payroll-result",
      rows: ROWS,
      meta: { period: "2026-09", label: "ABC Co Ltd" },
    };
    answer.resolve(response);
    // The answer itself is passed on untouched.
    expect(await done).toBe(response);
    expect(rows()).toEqual([
      expect.objectContaining({
        from: "Database, September 2026",
        status: "delivered",
        rowCount: 1,
        reason: null,
      }),
    ]);
  });

  it("never puts a value from the rows into the log", async () => {
    await answerRequest("pdf-editor", "payroll-result", async () => ({
      ok: true,
      dataType: "payroll-result",
      rows: ROWS,
    }));
    const text = JSON.stringify(transferLog.get());
    expect(text).not.toContain(SECRET_ID);
    expect(text).not.toContain(String(SECRET_PAY));
    expect(text).not.toContain("DOE");
  });

  it.each(REFUSAL_CODES)(
    "logs a refusal with code %s as a fixed phrase, not the app-facing text",
    async (code) => {
      const error = `Something about ${SECRET_ID}`;
      const response = await answerRequest("payslip", "statutory-rates", async () => ({
        ok: false,
        code,
        error,
      }));
      expect(response).toEqual({ ok: false, code, error });
      const [row] = rows();
      expect(row).toMatchObject({ status: "failed", canRetry: false });
      expect(row!.reason).toMatch(/^[a-z ()]+$/);
      expect(JSON.stringify(row)).not.toContain(SECRET_ID);
    },
  );

  it('answers "unavailable" and logs it when getting the data throws', async () => {
    const response = await answerRequest("payslip", "statutory-rates", () =>
      Promise.reject(new Error(`boom ${SECRET_ID}`)),
    );
    expect(response).toMatchObject({ ok: false, code: "unavailable" });
    expect(JSON.stringify(response)).not.toContain(SECRET_ID);
    expect(rows()[0]).toMatchObject({ status: "failed", reason: "not available" });
  });

  it("adds nothing back when the log was emptied while the request was open", async () => {
    const answer = deferred<ResponseDataPayload>();
    const done = answerRequest("pdf-editor", "payroll-result", () => answer.promise);
    clearTransferLog();
    answer.resolve({ ok: false, code: "denied", error: "No." });
    await done;
    expect(transferLog.get()).toEqual([]);
  });
});

describe("recordSave", () => {
  const describeIt = (result: Record<string, unknown>) =>
    `Rates saved (revision ${String(result.revision)})`;

  it("logs a save from the app to the database and tells the user", async () => {
    const ack = await recordSave(
      "payslip",
      "statutory-rates",
      "the statutory rates",
      async () => ({ ok: true, result: { effective_from: "2026-07", revision: 2 } }),
      describeIt,
    );
    expect(ack).toEqual({ ok: true, result: { effective_from: "2026-07", revision: 2 } });
    expect(rows()).toEqual([
      {
        kind: "save",
        from: "Payslip Automation",
        toAppId: "database",
        toName: "Database",
        dataType: "statutory-rates",
        rowCount: 1,
        status: "delivered",
        reason: null,
        attempts: 1,
        canRetry: false,
      },
    ]);
    expect(toast.success).toHaveBeenCalledWith("Rates saved (revision 2)", {
      description: "Saved from Payslip Automation.",
    });
  });

  it("logs and announces a refused save, with the reason the app was given", async () => {
    const refusal: ReceivedPayload = {
      ok: false,
      code: "stale",
      error: "Someone saved first. Reload.",
    };
    const ack = await recordSave(
      "payslip",
      "statutory-rates",
      "the statutory rates",
      async () => refusal,
      describeIt,
    );
    expect(ack).toBe(refusal);
    expect(rows()[0]).toMatchObject({ status: "failed", reason: "someone else saved first" });
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "Payslip Automation could not save the statutory rates",
      {
        description: "Someone saved first. Reload.",
      },
    );
  });

  it('answers "unavailable" when the save throws', async () => {
    const ack = await recordSave(
      "payslip",
      "statutory-rates",
      "the statutory rates",
      () => Promise.reject(new Error("boom")),
      describeIt,
    );
    expect(ack).toMatchObject({ ok: false, code: "unavailable" });
    expect(rows()[0]).toMatchObject({ status: "failed", reason: "not available" });
  });
});

describe("payroll results asked for by an app", () => {
  const ask = () => {
    // Reach the registered handler the way the hub does.
    const handlers = (
      bridge as unknown as {
        handlers: { onRequest: (a: string, p: unknown) => Promise<ResponseDataPayload> };
      }
    ).handlers;
    return handlers.onRequest("pdf-editor", { dataType: "payroll-result" });
  };

  it("still wait for the user, and are logged when the user declines", async () => {
    const reply = ask();
    expect(dataRequests.get()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ kind: "request", status: "sending", toAppId: "pdf-editor" });

    dataRequests.get()[0]!.respond({ ok: false, code: "denied", error: "Declined." });
    await expect(reply).resolves.toEqual({ ok: false, code: "denied", error: "Declined." });
    expect(rows()[0]).toMatchObject({ status: "failed", reason: "declined in the dashboard" });
  });

  it("leave nothing in the log when the session ends while one is open", async () => {
    const reply = ask();
    runSessionCleanup();
    await expect(reply).resolves.toMatchObject({ ok: false, code: "unavailable" });
    expect(transferLog.get()).toEqual([]);
  });
});
