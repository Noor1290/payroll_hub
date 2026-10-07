import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import september from "../../../samples/ABC Co Ltd-pdf-fill-2026-09.json?raw";
import october from "../../../samples/ABC Co Ltd-pdf-fill-2026-10.json?raw";
import { APPS, getApp } from "@/config/apps.config";
import { toExportRow } from "@/config/payrollFields";
import { AuthContext, type AuthContextValue } from "@/features/auth/auth-context";
import { CompanyContext, type CompanyContextValue } from "@/features/company/company-context";
import { toRpcRow } from "@/features/import/importPlan";
import { parsePayrollRows } from "@/features/import/parsePayroll";
import { autoMap, buildOutput, tableFromReceived, tableFromRun } from "@/features/transfer/mapping";
import { transferLog } from "@/features/transfer/transferLog";
import { bridge } from "@/lib/bridge/bridge";
import { runSessionCleanup } from "@/lib/sessionCleanup";
import { fetchRunEntries, fetchRuns } from "@/lib/supabase/payroll";
import type { Membership } from "@/lib/supabase/schemas";
import { grantUnlock, lock } from "@/lib/unlock";
import { BridgeDialogs } from "./BridgeDialogs";

/**
 * A record of what the dashboard does today, kept in __snapshots__ next to this file, so a
 * later change shows up as a visible difference in review instead of going unnoticed:
 * what an import stores, what an app receives from a saved run, and the whole exchange when
 * an app asks for a run ("Get from dashboard").
 *
 * If a test here fails, read the difference first. Update the record (`npm test -- -u
 * baseline`) only when the change is one you meant to make. FAKE values only.
 */

vi.mock("@/lib/supabase/payroll", async (original) => ({
  ...(await original<typeof import("@/lib/supabase/payroll")>()),
  fetchRuns: vi.fn(),
  fetchRunEntries: vi.fn(),
}));

const SAMPLES = { "2026-09": september, "2026-10": october } as const;
type Month = keyof typeof SAMPLES;

const fileRows = (month: Month) => JSON.parse(SAMPLES[month]) as Record<string, unknown>[];

function imported(month: Month) {
  const parsed = parsePayrollRows(fileRows(month));
  expect(parsed.fatal).toBeNull();
  expect(parsed.errors).toEqual([]);
  return parsed;
}

/** What an app is sent for a saved run: the stored rows, back in the payroll app's shape. */
function exported(month: Month) {
  const parsed = imported(month);
  return parsed.rows.map((row) => toExportRow(row, parsed.company!));
}

const pick = (row: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(keys.filter((key) => key in row).map((key) => [key, row[key]]));

describe("baseline: the app registry", () => {
  it("lists these apps, with these data types and expected fields", () => {
    expect(
      APPS.map(({ id, name, url, status, accepts, produces, protocolVersion, expectedFields }) => ({
        id,
        name,
        url,
        status,
        accepts,
        produces,
        protocolVersion,
        expectedFields: expectedFields.map(
          (f) =>
            `${f.key} | ${f.type}${f.required ? " | required" : ""}${f.sensitive ? " | sensitive" : ""}`,
        ),
      })),
    ).toMatchSnapshot();
  });
});

describe.each(Object.keys(SAMPLES) as Month[])("baseline: the %s sample", (month) => {
  it("is stored like this by an import", () => {
    expect(imported(month).rows.map(toRpcRow)).toMatchSnapshot();
  });

  it("is sent like this to an app from a saved run", () => {
    expect(exported(month)).toMatchSnapshot();
  });

  it("reaches the PDF Form Filler through the wizard as the saved run, less the fields it did not ask for", () => {
    const fields = getApp("pdf-editor")!.expectedFields;
    const keys = fields.map((field) => field.key);
    const parsed = imported(month);

    const fromRun = tableFromRun(parsed.rows, parsed.company!);
    expect(buildOutput(fromRun.rows, autoMap(fromRun.columns, fields), fields)).toEqual(
      exported(month).map((row) => pick(row, keys)),
    );

    // Data straight from the payroll app: what it sent, trimmed, same fields.
    const received = tableFromReceived(fileRows(month));
    expect(buildOutput(received.rows, autoMap(received.columns, fields), fields)).toEqual(
      exported(month).map((row) => pick(row, keys)),
    );
  });
});

describe("baseline: an app asks for a saved run (Get from dashboard)", () => {
  const ORIGIN = "https://noor1290.github.io";
  const REQUEST_ID = "request-0000001";

  const current: Membership = {
    role: "admin",
    company: {
      id: "10000000-0000-4000-8000-000000000001",
      name: "ABC Co Ltd",
      address: "Mauritius",
      brn: "C1234567",
      vat: "12%",
    },
  };
  const auth: AuthContextValue = {
    status: "signed-in",
    user: { id: "00000000-0000-4000-8000-0000000000a1", email: "admin@example.com", isDemo: false },
    notice: null,
    signIn: async () => null,
    signInDemo: null,
    signOut: async () => {},
    clearNotice: () => {},
  };
  const company: CompanyContextValue = {
    status: "ready",
    failure: null,
    retry: () => {},
    memberships: [current],
    current,
    isAdmin: true,
    canAddCompany: true,
    select: () => {},
  };

  interface Envelope {
    type: string;
    from: string;
    to: string;
    version: number;
    id: string;
    payload: unknown;
  }

  /** A real iframe window (so the hub's source check is genuine) with postMessage recorded. */
  function makeFrame() {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const win = iframe.contentWindow!;
    const post = vi.fn();
    win.postMessage = post as unknown as Window["postMessage"];
    return { win, calls: () => post.mock.calls as [Envelope, string][] };
  }

  const fromApp = (source: Window, type: string, id: string, payload: unknown = {}) =>
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type, from: "pdf-editor", to: "dashboard", version: 1, id, payload },
        origin: ORIGIN,
        source,
      }),
    );

  afterEach(() => {
    cleanup();
    bridge.stop();
    runSessionCleanup();
    lock();
    document.body.innerHTML = "";
  });

  it("asks the user, then answers with the run's rows and writes this to the transfer log", async () => {
    const run = imported("2026-10");
    vi.mocked(fetchRuns).mockResolvedValue([
      {
        id: "20000000-0000-4000-8000-000000000001",
        period: "2026-10-01",
        status: "draft",
        createdBy: null,
        createdAt: "2026-10-05T08:00:00+00:00",
        entryCount: run.rows.length,
      },
    ]);
    vi.mocked(fetchRunEntries).mockResolvedValue(run.rows);

    const frame = makeFrame();
    bridge.start();
    bridge.attachFrame("pdf-editor", () => frame.win);
    bridge.frameLoaded("pdf-editor");
    fromApp(frame.win, "ready", "ready-0000001");
    fromApp(frame.win, "pong", frame.calls().at(-1)![0].id);
    const before = frame.calls().length;

    grantUnlock(10);
    render(
      <MemoryRouter>
        <AuthContext.Provider value={auth}>
          <CompanyContext.Provider value={company}>
            <BridgeDialogs />
          </CompanyContext.Provider>
        </AuthContext.Provider>
      </MemoryRouter>,
    );
    act(
      () =>
        void fromApp(frame.win, "request-data", REQUEST_ID, {
          dataType: "payroll-result",
          period: "2026-10",
        }),
    );

    // Nothing leaves until the user says so.
    expect(screen.getByRole("alertdialog").textContent).toContain(
      "PDF Form Filler is asking for payroll data",
    );
    expect(frame.calls()).toHaveLength(before);

    fireEvent.click(screen.getByRole("button", { name: "Send the October 2026 run" }));
    await vi.waitFor(() => expect(frame.calls().length).toBeGreaterThan(before));

    const sent = frame.calls().slice(before);
    expect(sent).toHaveLength(1);
    const [envelope, targetOrigin] = sent[0]!;
    const { rows, ...payload } = envelope.payload as { rows: unknown[] } & Record<string, unknown>;

    // The rows are exactly what the saved run exports (recorded above for this sample).
    expect(rows).toEqual(exported("2026-10"));
    expect({
      targetOrigin,
      envelope: {
        ...envelope,
        id: envelope.id === REQUEST_ID ? "(the request's id)" : envelope.id,
        payload: { ...payload, rows: `(${rows.length} rows, checked above)` },
      },
      dialogStillOpen: screen.queryByRole("alertdialog") !== null,
      // Without what changes on every run: the time and the generated id.
      transferLog: transferLog.get().map((row) => ({ ...row, at: "(time)", id: "(id)" })),
    }).toMatchSnapshot();
  });
});
