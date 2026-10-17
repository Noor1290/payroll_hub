import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import source from "../../../docs/bridge.js?raw";
import { HOSTING } from "@/config/origins";
import { bridge } from "./bridge";

/**
 * Rehearsal fix F1: an app says whether it holds changes not saved yet, so the dashboard can
 * ask before it reloads the app on a change of company. End to end: the real docs/bridge.js
 * (the file the apps carry) posts to the dashboard's real hub. Before the fix, bridge.js had no
 * `setUnsaved` and the hub had no `unsavedApps`.
 */

/** An app in the dashboard's workspace, running the real bridge.js. */
function openApp(appId: string, { init = true } = {}) {
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  const frame = iframe.contentWindow!;
  bridge.attachFrame(appId, () => frame);
  bridge.frameLoaded(appId);

  const posted: { type: string; payload: unknown }[] = [];
  const fake: Record<string, unknown> = {
    addEventListener: () => {},
    crypto: { randomUUID: () => crypto.randomUUID() },
    parent: {
      postMessage: (data: { type: string; payload: unknown }) => {
        posted.push({ type: data.type, payload: data.payload });
        window.dispatchEvent(
          new MessageEvent("message", { data, origin: HOSTING.apps, source: frame }),
        );
      },
    },
  };
  new Function("window", source as string)(fake);
  const api = fake.PayrollHubBridge as {
    init(options: { appId: string }): boolean;
    setUnsaved(unsaved: unknown): void;
  };
  if (init) api.init({ appId });
  /** Posts a message as this frame, bypassing bridge.js. */
  const raw = (data: unknown) =>
    window.dispatchEvent(
      new MessageEvent("message", { data, origin: HOSTING.apps, source: frame }),
    );
  return { api, posted, raw };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  bridge.start();
});

afterEach(() => {
  bridge.stop();
  for (const id of ["payroll", "pdf-editor", "payslip"]) bridge.detachFrame(id);
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("unsaved changes, from bridge.js to the dashboard", () => {
  it("lists an app while it says it holds unsaved changes, and not once it says it saved", () => {
    const payroll = openApp("payroll");
    openApp("payslip");
    expect(bridge.unsavedApps()).toEqual([]);

    payroll.api.setUnsaved(true);
    expect(bridge.unsavedApps()).toEqual(["payroll"]);

    payroll.api.setUnsaved(false);
    expect(bridge.unsavedApps()).toEqual([]);
  });

  it("sends only a change, with nothing in it but true or false", () => {
    const payroll = openApp("payroll");
    payroll.api.setUnsaved(true);
    payroll.api.setUnsaved(true);
    payroll.api.setUnsaved("yes");
    payroll.api.setUnsaved(false);
    expect(payroll.posted.filter((m) => m.type === "unsaved")).toEqual([
      { type: "unsaved", payload: { unsaved: true } },
      { type: "unsaved", payload: { unsaved: false } },
    ]);
  });

  it("sends nothing before init", () => {
    const app = openApp("payroll", { init: false });
    app.api.setUnsaved(true);
    expect(app.posted).toEqual([]);
    expect(bridge.unsavedApps()).toEqual([]);
  });

  it("forgets it when the page in the frame changes or the frame goes", () => {
    const payroll = openApp("payroll");
    payroll.api.setUnsaved(true);
    bridge.frameLoaded("payroll"); // a reload: the new page has said nothing yet
    expect(bridge.unsavedApps()).toEqual([]);

    payroll.api.setUnsaved(false);
    payroll.api.setUnsaved(true);
    bridge.detachFrame("payroll");
    expect(bridge.unsavedApps()).toEqual([]);
  });

  it("ignores a message with anything else in it, or from another app's name", () => {
    const payroll = openApp("payroll");
    const envelope = { from: "payroll", to: "dashboard", version: 1, id: "abcdefgh1" };
    payroll.raw({ ...envelope, type: "unsaved", payload: { unsaved: true, rows: [] } });
    payroll.raw({ ...envelope, type: "unsaved", payload: { unsaved: "true" } });
    payroll.raw({ ...envelope, from: "payslip", type: "unsaved", payload: { unsaved: true } });
    expect(bridge.unsavedApps()).toEqual([]);
    payroll.raw({ ...envelope, type: "unsaved", payload: { unsaved: true } });
    expect(bridge.unsavedApps()).toEqual(["payroll"]);
  });
});
