import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOSTING } from "@/config/origins";
import { clearTransferLog } from "@/features/transfer/transferLog";
import { bridge } from "@/lib/bridge/bridge";
import { demoMemberships } from "@/lib/demo/demoData";
import { demoForgetPayrollSetups } from "@/lib/demo/demoPayrollSetups";
import { runSessionCleanup } from "@/lib/sessionCleanup";
import { exchangeContext } from "./appData";
import { exchangeContextLoading, SIGN_IN_WAIT_MS } from "./exchangeContext";
// The handlers register themselves with the bridge when imported, as BridgeDialogs does.
import "./appData";
import "./payrollSetupData";
import "./pdfData";

/**
 * Known issue 4: after a reload or a sign-in, an app's frame can be ready, and ask, before the
 * dashboard has loaded who is signed in and which company is selected. The app was told "Nobody
 * is signed in to the dashboard" and showed "could not be loaded" until "Try again". The
 * dashboard now waits a few seconds for the sign-in state before answering. Seen with the
 * payroll app; the PDF form filler and the payslip app ask through the same code. FAKE values only.
 */
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

const ME = "00000000-0000-4000-8000-000000000001";
const ABC = demoMemberships.find((m) => m.company.brn === "C1234567")!;
const signIn = () => {
  exchangeContext.set({ viewer: { id: ME, isDemo: true }, membership: ABC });
  exchangeContextLoading.set(false);
};

let replies: { type: string; id: string; payload: Record<string, unknown> }[] = [];
let iframe: HTMLIFrameElement;

function connect(appId: string) {
  iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  const frame = iframe.contentWindow!;
  frame.postMessage = ((message: (typeof replies)[number]) => replies.push(message)) as never;
  bridge.start();
  bridge.attachFrame(appId, () => frame);
  return (type: string, id: string, payload: unknown) =>
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type, from: appId, to: "dashboard", version: 1, id, payload },
        origin: HOSTING.apps,
        source: frame,
      }),
    );
}
const reply = (id: string) => replies.find((r) => r.id === id);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  replies = [];
  exchangeContext.set(null);
  // Signed in, companies still loading: what the dashboard is just after a reload or a sign-in.
  exchangeContextLoading.set(true);
  demoForgetPayrollSetups();
});
afterEach(() => {
  bridge.detachFrame("payroll");
  bridge.detachFrame("pdf-editor");
  bridge.detachFrame("payslip");
  bridge.stop();
  iframe?.remove();
  runSessionCleanup();
  clearTransferLog();
  vi.useRealTimers();
});

describe("an app that asks before the dashboard knows who is signed in", () => {
  it.each([
    ["payroll", "payroll-setup", { action: "load" }],
    ["pdf-editor", "pdf-template", { action: "list" }],
    ["payslip", "statutory-rates", undefined],
  ])(
    "%s: the question waits for the sign-in and is answered, not refused",
    async (appId, dataType, params) => {
      const fromApp = connect(appId);
      fromApp("request-data", "early-000001", { dataType, ...(params ? { params } : {}) });
      await vi.advanceTimersByTimeAsync(300);
      // Nothing answered yet: no "Nobody is signed in" sent back while the session loads.
      expect(reply("early-000001")).toBeUndefined();
      signIn();
      await vi.waitFor(() => expect(reply("early-000001")).toBeTruthy());
      expect(reply("early-000001")!.payload).toMatchObject({ ok: true, meta: { brn: "C1234567" } });
    },
  );

  it("a save sent that early waits too, and is stored", async () => {
    const fromApp = connect("payroll");
    fromApp("send-data", "early-000002", {
      dataType: "payroll-setup",
      rows: [
        {
          action: "save-shared",
          brn: "C1234567",
          shared_setup_id: "30000000-0000-4000-8000-000000000001",
          name: "Shared column setup",
          body: { identityFields: [], globalColumns: [] },
          expected_revision: 0,
        },
      ],
    });
    await vi.advanceTimersByTimeAsync(300);
    signIn();
    await vi.waitFor(() => expect(reply("early-000002")).toBeTruthy());
    expect(reply("early-000002")!.payload).toMatchObject({ ok: true, result: { revision: 1 } });
  });

  it("nobody signs in: refused as before, once the wait is over", async () => {
    const fromApp = connect("payroll");
    fromApp("request-data", "early-000003", {
      dataType: "payroll-setup",
      params: { action: "load" },
    });
    await vi.advanceTimersByTimeAsync(SIGN_IN_WAIT_MS - 100);
    expect(reply("early-000003")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(reply("early-000003")).toBeTruthy());
    expect(reply("early-000003")!.payload).toMatchObject({
      ok: false,
      code: "unavailable",
      error: "Nobody is signed in to the dashboard, or no company is selected.",
    });
  });

  it("signed out (nothing loading): refused at once, as before", async () => {
    exchangeContextLoading.set(false);
    const fromApp = connect("payroll");
    fromApp("request-data", "early-000005", {
      dataType: "payroll-setup",
      params: { action: "load" },
    });
    await vi.waitFor(() => expect(reply("early-000005")).toBeTruthy(), { timeout: 1000 });
    expect(reply("early-000005")!.payload).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("signed in already: answered at once, with no wait", async () => {
    signIn();
    const fromApp = connect("payroll");
    fromApp("request-data", "early-000004", {
      dataType: "payroll-setup",
      params: { action: "load" },
    });
    await vi.waitFor(() => expect(reply("early-000004")).toBeTruthy(), { timeout: 1000 });
    expect(reply("early-000004")!.payload).toMatchObject({ ok: true });
  });
});
