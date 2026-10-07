import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transferLog } from "@/features/transfer/transferLog";
import { bridge, dataRequests, incomingBatches } from "@/lib/bridge/bridge";
import { runSessionCleanup } from "@/lib/sessionCleanup";

/**
 * A record (snapshots) of how the dashboard answers the apps over the bridge, message for
 * message, using the real hub and the real registry. Same idea as baseline.test.tsx: a change
 * shows up as a difference to read, and the record is updated only on purpose.
 *
 * FAKE values only.
 */
const ORIGIN = "https://noor1290.github.io";

interface Envelope {
  type: string;
  from: string;
  to: string;
  version: number;
  id: string;
  payload: unknown;
}

function connect(appId: string) {
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  const win = iframe.contentWindow!;
  const post = vi.fn();
  win.postMessage = post as unknown as Window["postMessage"];
  const calls = () => post.mock.calls as [Envelope, string][];
  const say = (type: string, id: string, payload: unknown = {}) =>
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type, from: appId, to: "dashboard", version: 1, id, payload },
        origin: ORIGIN,
        source: win,
      }),
    );
  bridge.attachFrame(appId, () => win);
  bridge.frameLoaded(appId);
  say("ready", "ready-0000001");
  say("pong", calls().at(-1)![0].id);
  const before = calls().length;
  /** What the dashboard posted to this app since it connected, pings left out. */
  const answers = () =>
    calls()
      .slice(before)
      .filter(([envelope]) => envelope.type !== "ping")
      .map(([envelope, targetOrigin]) => ({ ...envelope, targetOrigin }));
  return { say, answers };
}

const ROW = { ID: "X0000000000001", Surname: "DOE", "Net Pay": 18169.12 };

beforeEach(() => bridge.start());
afterEach(() => {
  bridge.stop();
  runSessionCleanup();
  document.body.innerHTML = "";
});

describe("baseline: what the dashboard answers over the bridge", () => {
  it("the payroll app sends results: acknowledged, held in memory, not logged", async () => {
    const app = connect("payroll");
    app.say("send-data", "message-0000001", {
      dataType: "payroll-result",
      rows: [ROW],
      meta: { period: "2026-10" },
    });
    await vi.waitFor(() => expect(app.answers()).toHaveLength(1));
    expect({
      answers: app.answers(),
      held: incomingBatches.get().map(({ appId, payload }) => ({ appId, payload })),
      transferLog: transferLog.get(),
    }).toMatchSnapshot();
  });

  it("the PDF Form Filler asks for a run: nothing is answered until the user decides", async () => {
    const app = connect("pdf-editor");
    app.say("request-data", "message-0000002", { dataType: "payroll-result", period: "2026-10" });
    await Promise.resolve();
    expect({
      answers: app.answers(),
      waiting: dataRequests.get().map(({ appId, payload }) => ({ appId, payload })),
    }).toMatchSnapshot();
  });

  it.each([
    [
      "the PDF Form Filler asks for statutory rates",
      "pdf-editor",
      "request-data",
      "statutory-rates",
    ],
    ["the PDF Form Filler sends payroll results", "pdf-editor", "send-data", "payroll-result"],
    ["the payroll app asks for a run", "payroll", "request-data", "payroll-result"],
    ["the payslip app asks for statutory rates", "payslip", "request-data", "statutory-rates"],
    ["the payslip app asks for a payslip template", "payslip", "request-data", "payslip-template"],
    ["the payslip app asks for issued payslips", "payslip", "request-data", "payslip-issue"],
    ["the payslip app sends statutory rates", "payslip", "send-data", "statutory-rates"],
    ["the payslip app sends a payslip template", "payslip", "send-data", "payslip-template"],
    ["the payslip app sends issued payslips", "payslip", "send-data", "payslip-issue"],
  ])("%s", async (_what, appId, type, dataType) => {
    const app = connect(appId);
    app.say(
      type,
      "message-0000003",
      type === "send-data" ? { dataType, rows: [{ any: "thing" }] } : { dataType },
    );
    await vi.waitFor(() => expect(app.answers()).toHaveLength(1));
    expect({
      answers: app.answers(),
      waiting: dataRequests.get().length,
      held: incomingBatches.get().length,
      transferLog: transferLog.get(),
    }).toMatchSnapshot();
  });
});
