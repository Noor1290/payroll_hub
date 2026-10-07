import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearTransferLog, transferLog } from "@/features/transfer/transferLog";
import { bridge, dataRequests } from "@/lib/bridge/bridge";
import { runSessionCleanup } from "@/lib/sessionCleanup";
import type { Membership } from "@/lib/supabase/schemas";
import { isUnlocked, lock } from "@/lib/unlock";
import { fake, type Call } from "@/test/fakeClient";
import {
  answerTemplateRequest,
  describeTemplateSave,
  exchangeContext,
  hasEmbeddedFile,
  saveTemplate,
} from "./appData";

vi.mock("@/lib/supabase/client", async () => ({
  supabase: (await import("@/test/fakeClient")).fake.client,
}));
const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  loading: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));

// FAKE values only.
const ME = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";
const ABC = "10000000-0000-4000-8000-000000000001";
const T1 = "20000000-0000-4000-8000-000000000001";
const T2 = "20000000-0000-4000-8000-000000000002";
const company = { id: ABC, name: "ABC Co Ltd", address: "Mauritius", brn: "C1234567", vat: "12%" };
const signIn = (role: Membership["role"] = "admin") =>
  exchangeContext.set({ viewer: { id: ME, isDemo: false }, membership: { role, company } });

const BODY = { title: "Payslip", lines: [{ label: "Net pay", column: "Net Pay" }] };
const summary = (more: Record<string, unknown> = {}) => ({
  id: T1,
  name: "Monthly payslip",
  draft_revision: 3,
  updated_by: ME,
  updated_at: "2026-09-01T09:00:00+04:00",
  ...more,
});
const table = (calls: Call[]) => fake.arg(calls, "from") as string | undefined;

const request = (params?: Record<string, unknown>) =>
  answerTemplateRequest({ dataType: "payslip-template", ...(params ? { params } : {}) });
const save = (row: Record<string, unknown>) =>
  saveTemplate({ dataType: "payslip-template", rows: [row] });

const DRAFT = {
  action: "save-draft",
  brn: "C1234567",
  template_id: T1,
  name: "Monthly payslip",
  body: BODY,
  expected_revision: 3,
};
const PUBLISH = { action: "publish", brn: "C1234567", template_id: T1, expected_revision: 3 };

beforeEach(() => {
  fake.reset();
  signIn();
  toast.success.mockClear();
  toast.error.mockClear();
});
afterEach(() => {
  runSessionCleanup();
  clearTransferLog();
  lock();
});

describe("payslip-template: list", () => {
  it("lists the selected company's templates without bodies, with the latest published version", async () => {
    fake.reset((calls) =>
      table(calls) === "payslip_templates"
        ? { data: [summary(), summary({ id: T2, name: "Yearly", updated_by: OTHER })] }
        : calls.some(([, column, value]) => column === "template_id" && value === T1)
          ? { data: [{ version: 2, published_at: "2026-09-02T09:00:00+04:00" }] }
          : { data: [] },
    );
    const answer = await request({ action: "list" });
    expect(answer).toEqual({
      ok: true,
      dataType: "payslip-template",
      meta: { label: "ABC Co Ltd", brn: "C1234567" },
      rows: [
        {
          template_id: T1,
          name: "Monthly payslip",
          draft_revision: 3,
          updated_at: "2026-09-01T09:00:00+04:00",
          updated_by_you: true,
          published_version: 2,
          published_at: "2026-09-02T09:00:00+04:00",
        },
        {
          template_id: T2,
          name: "Yearly",
          draft_revision: 3,
          updated_at: "2026-09-01T09:00:00+04:00",
          updated_by_you: false,
          published_version: null,
          published_at: null,
        },
      ],
    });
    expect(JSON.stringify(answer)).not.toContain(OTHER);
    // Reads only, each scoped to this company, and no body column in the list.
    for (const calls of fake.state.queries) {
      expect(calls[0]![0]).toBe("from");
      expect(calls).toEqual(expect.arrayContaining([["eq", "company_id", ABC]]));
      expect(String(fake.arg(calls, "select"))).not.toContain("body");
    }
  });

  it("answers with no rows when the company has no template yet", async () => {
    expect(await request({ action: "list" })).toMatchObject({ ok: true, rows: [] });
  });

  it("is answered for a viewer too: members may read, drafts included", async () => {
    signIn("viewer");
    expect(await request({ action: "list" })).toMatchObject({ ok: true });
    fake.reset(() => ({ data: { ...summary(), draft_body: BODY } }));
    expect(await request({ action: "load", template_id: T1 })).toMatchObject({ ok: true });
  });
});

describe("payslip-template: load", () => {
  it("returns the draft, body exactly as stored, when no version is named", async () => {
    fake.reset(() => ({ data: { ...summary({ updated_by: OTHER }), draft_body: BODY } }));
    const answer = await request({ action: "load", template_id: T1, brn: "c1234567" });
    expect(answer).toEqual({
      ok: true,
      dataType: "payslip-template",
      meta: { label: "ABC Co Ltd", brn: "C1234567" },
      rows: [
        {
          template_id: T1,
          name: "Monthly payslip",
          draft_revision: 3,
          body: BODY,
          updated_at: "2026-09-01T09:00:00+04:00",
          updated_by_you: false,
        },
      ],
    });
    expect(fake.state.queries).toHaveLength(1);
    expect(fake.state.queries[0]).toEqual(
      expect.arrayContaining([
        ["from", "payslip_templates"],
        ["eq", "company_id", ABC],
        ["eq", "id", T1],
      ]),
    );
  });

  it("returns a published version when one is named", async () => {
    fake.reset(() => ({
      data: {
        template_id: T1,
        version: 2,
        name: "Monthly payslip",
        body: BODY,
        published_by: ME,
        published_at: "2026-09-02T09:00:00+04:00",
      },
    }));
    const answer = await request({ action: "load", template_id: T1, version: 2 });
    expect(answer).toMatchObject({
      ok: true,
      rows: [
        {
          template_id: T1,
          name: "Monthly payslip",
          version: 2,
          body: BODY,
          published_at: "2026-09-02T09:00:00+04:00",
          published_by_you: true,
        },
      ],
    });
    expect(fake.state.queries[0]).toEqual(
      expect.arrayContaining([
        ["from", "payslip_template_versions"],
        ["eq", "company_id", ABC],
        ["eq", "template_id", T1],
        ["eq", "version", 2],
      ]),
    );
  });

  it("says not-found for a template or a version this company does not have", async () => {
    fake.reset(() => ({ data: null }));
    expect(await request({ action: "load", template_id: T2 })).toMatchObject({
      ok: false,
      code: "not-found",
    });
    expect(await request({ action: "load", template_id: T1, version: 9 })).toMatchObject({
      ok: false,
      code: "not-found",
    });
  });

  it.each([
    ["no params", undefined],
    ["no action", { brn: "C1234567" }],
    ["an action it does not know", { action: "delete", template_id: T1 }],
    ["a load without a template", { action: "load" }],
    ["a template id that is not a uuid", { action: "load", template_id: "1" }],
    ["version 0", { action: "load", template_id: T1, version: 0 }],
    ['version "latest"', { action: "load", template_id: T1, version: "latest" }],
    ["a field it does not know", { action: "list", company: ABC }],
  ])("refuses %s as invalid, without reading anything", async (_what, params) => {
    expect(await request(params)).toMatchObject({ ok: false, code: "invalid" });
    expect(fake.state.queries).toHaveLength(0);
  });

  it("refuses another company's BRN, and nobody signed in, without reading anything", async () => {
    expect(await request({ action: "list", brn: "C7654321" })).toMatchObject({
      ok: false,
      code: "wrong-company",
    });
    exchangeContext.set(null);
    expect(await request({ action: "list" })).toMatchObject({ ok: false, code: "unavailable" });
    expect(fake.state.queries).toHaveLength(0);
  });

  it("names the migration to run when the tables are not there", async () => {
    fake.reset(() => ({ error: { code: "PGRST205", message: "not in the schema cache" } }));
    const answer = await request({ action: "list" });
    expect(answer).toMatchObject({ ok: false, code: "unavailable" });
    expect((answer as { error: string }).error).toContain("0010_payslip_templates.sql");
  });

  it("refuses rather than pass on a row that is not what it expects", async () => {
    fake.reset(() => ({ data: { ...summary(), draft_body: "not an object" } }));
    expect(await request({ action: "load", template_id: T1 })).toMatchObject({
      ok: false,
      code: "unavailable",
    });
  });
});

describe("payslip-template: save-draft", () => {
  const saved = () => ({
    data: {
      template_id: T1,
      name: "Monthly payslip",
      draft_revision: 4,
      updated_at: "2026-09-03T09:00:00+04:00",
    },
  });

  it("calls the database function with the body exactly as sent, and returns the new revision", async () => {
    fake.reset(saved);
    expect(await save(DRAFT)).toEqual({
      ok: true,
      result: {
        template_id: T1,
        name: "Monthly payslip",
        draft_revision: 4,
        updated_at: "2026-09-03T09:00:00+04:00",
      },
    });
    expect(fake.state.queries).toEqual([
      [
        [
          "rpc",
          "save_payslip_template_draft",
          {
            p_company_id: ABC,
            p_template_id: T1,
            p_name: "Monthly payslip",
            p_body: BODY,
            p_expected_revision: 3,
          },
        ],
      ],
    ]);
  });

  it("creates a template when no id is given: null id, revision 0, name trimmed", async () => {
    for (const template_id of [undefined, null]) {
      fake.reset(saved);
      await save({ ...DRAFT, template_id, name: "  New one ", expected_revision: 0 });
      expect(fake.arg(fake.state.queries[0]!, "rpc", 1)).toMatchObject({
        p_template_id: null,
        p_name: "New one",
        p_expected_revision: 0,
      });
    }
  });

  it("refuses a body over 150 KB as too large, before reaching the database", async () => {
    const answer = await save({ ...DRAFT, body: { pad: "x".repeat(150_000) } });
    expect(answer).toMatchObject({ ok: false, code: "too-large" });
    expect(fake.state.queries).toHaveLength(0);
    fake.reset(saved);
    expect(await save({ ...DRAFT, body: { pad: "x".repeat(149_000) } })).toMatchObject({
      ok: true,
    });
  });

  it.each([
    ["a logo as a data URI", { logo: "data:image/png;base64,AAAA" }],
    [
      "an image deep inside a line",
      { lines: [{ cells: [{ src: " DATA:image/svg+xml,<svg/>" }] }] },
    ],
    ["an embedded PDF", { attachment: "data:application/pdf;base64,AAAA" }],
    ["an image used as a name", { "data:image/gif;base64,AAAA": 1 }],
  ])("refuses a body with %s, before reaching the database", async (_what, body) => {
    expect(await save({ ...DRAFT, body })).toMatchObject({ ok: false, code: "invalid" });
    expect(fake.state.queries).toHaveLength(0);
  });

  it("does not mistake ordinary text for an image", () => {
    expect(hasEmbeddedFile(BODY)).toBe(false);
    expect(hasEmbeddedFile({ note: "Payroll data: basic salary / net pay", n: 1, x: null })).toBe(
      false,
    );
  });

  it.each([
    ["no BRN", { brn: undefined }],
    ["no name", { name: "   " }],
    ["a name of 81 characters", { name: "x".repeat(81) }],
    ["a body that is a list", { body: [BODY] }],
    ["a body that is text", { body: "{}" }],
    ["no last-seen revision", { expected_revision: undefined }],
    ["a fractional revision", { expected_revision: 1.5 }],
    ["a template id that is not a uuid", { template_id: "1" }],
    ["a field it does not know", { company_id: ABC }],
  ])("refuses %s as invalid, before reaching the database", async (_what, change) => {
    expect(await save({ ...DRAFT, ...change })).toMatchObject({ ok: false, code: "invalid" });
    expect(fake.state.queries).toHaveLength(0);
  });

  it("refuses a viewer, and another company, before reaching the database", async () => {
    expect(await save({ ...DRAFT, brn: "C7654321" })).toMatchObject({
      ok: false,
      code: "wrong-company",
    });
    signIn("viewer");
    expect(await save(DRAFT)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await save(PUBLISH)).toMatchObject({ ok: false, code: "forbidden" });
    expect(fake.state.queries).toHaveLength(0);
  });

  it.each([
    ["P0001", "PH_STALE", "stale"],
    ["23505", "PH_DUPLICATE_NAME", "invalid"],
    ["54000", "PH_LIMIT", "too-large"],
    ["54000", "PH_TOO_LARGE", "too-large"],
    ["P0002", "PH_NOT_FOUND", "not-found"],
    ["42501", "PH_NOT_ADMIN", "forbidden"],
    ["PGRST202", "Could not find the function", "unavailable"],
  ])("tells the app %s %s as code %s", async (code, message, expected) => {
    fake.reset(() => ({ error: { code, message } }));
    expect(await save(DRAFT)).toMatchObject({ ok: false, code: expected });
  });
});

describe("payslip-template: publish", () => {
  const published = () => ({
    data: {
      template_id: T1,
      version: 3,
      draft_revision: 3,
      published_at: "2026-09-03T09:00:00+04:00",
    },
  });

  it("calls the database function and returns the new version", async () => {
    fake.reset(published);
    expect(await save(PUBLISH)).toEqual({ ok: true, result: published().data });
    expect(fake.state.queries).toEqual([
      [
        [
          "rpc",
          "publish_payslip_template",
          { p_company_id: ABC, p_template_id: T1, p_expected_revision: 3 },
        ],
      ],
    ]);
  });

  it.each([
    ["no template", { template_id: undefined }],
    ["revision 0", { expected_revision: 0 }],
    ["a body", { body: BODY }],
    ["no BRN", { brn: undefined }],
  ])("refuses %s as invalid, before reaching the database", async (_what, change) => {
    expect(await save({ ...PUBLISH, ...change })).toMatchObject({ ok: false, code: "invalid" });
    expect(fake.state.queries).toHaveLength(0);
  });

  it("refuses an action it does not know: there is no delete or archive", async () => {
    for (const action of ["delete", "archive", undefined]) {
      expect(await save({ ...PUBLISH, action })).toMatchObject({ ok: false, code: "invalid" });
    }
    expect(fake.state.queries).toHaveLength(0);
  });

  it.each([
    ["PH_STALE", "stale"],
    ["PH_NO_CHANGE", "no-change"],
    ["PH_NOT_FOUND", "not-found"],
  ])("tells the app %s as code %s", async (message, expected) => {
    fake.reset(() => ({ error: { code: "P0001", message } }));
    expect(await save(PUBLISH)).toMatchObject({ ok: false, code: expected });
  });

  it("words the toast from the name and the numbers only", () => {
    expect(describeTemplateSave({ template_id: T1, name: "Monthly", draft_revision: 4 })).toBe(
      'Payslip template "Monthly" saved as a draft (revision 4)',
    );
    expect(describeTemplateSave({ template_id: T1, version: 3, draft_revision: 4 })).toBe(
      "Payslip template published (version 3)",
    );
  });
});

describe("payslip-template over the bridge: no dialog, no password gate", () => {
  const ORIGIN = "https://noor1290.github.io";
  interface Sent {
    type: string;
    id: string;
    payload: Record<string, unknown>;
  }

  function connect() {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const win = iframe.contentWindow!;
    const post = vi.fn();
    win.postMessage = post as unknown as Window["postMessage"];
    const say = (type: string, id: string, payload: unknown = {}) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type, from: "payslip", to: "dashboard", version: 1, id, payload },
          origin: ORIGIN,
          source: win,
        }),
      );
    bridge.start();
    bridge.attachFrame("payslip", () => win);
    bridge.frameLoaded("payslip");
    say("ready", "ready-0000001");
    const sent = (type: string) =>
      (post.mock.calls as [Sent, string][]).filter(([m]) => m.type === type).map(([m]) => m);
    return { say, sent };
  }
  afterEach(() => {
    bridge.stop();
    document.body.innerHTML = "";
  });

  it("answers a load straight away while the gate is locked, and logs it without the body", async () => {
    fake.reset(() => ({ data: { ...summary(), draft_body: BODY } }));
    const app = connect();
    expect(isUnlocked()).toBe(false);
    app.say("request-data", "request-000001", {
      dataType: "payslip-template",
      params: { action: "load", template_id: T1, brn: "C1234567" },
    });
    await vi.waitFor(() => expect(app.sent("response-data")).toHaveLength(1));

    expect(app.sent("response-data")[0]).toMatchObject({
      id: "request-000001",
      payload: { ok: true, dataType: "payslip-template", meta: { brn: "C1234567" } },
    });
    expect(dataRequests.get()).toHaveLength(0); // nothing waiting on the user
    expect(transferLog.get()).toEqual([
      expect.objectContaining({
        kind: "request",
        from: "Database",
        toName: "Payslip Automation",
        dataType: "payslip-template",
        status: "delivered",
        rowCount: 1,
      }),
    ]);
    expect(JSON.stringify(transferLog.get())).not.toMatch(/Net pay|Monthly payslip/);
  });

  it("saves a draft, answers with the result, logs it and shows a toast", async () => {
    fake.reset(() => ({
      data: { template_id: T1, name: "Monthly payslip", draft_revision: 4, updated_at: "t" },
    }));
    const app = connect();
    app.say("send-data", "save-00000001", { dataType: "payslip-template", rows: [DRAFT] });
    await vi.waitFor(() => expect(app.sent("received")).toHaveLength(1));

    expect(app.sent("received")[0]).toMatchObject({
      id: "save-00000001",
      payload: { ok: true, result: { template_id: T1, draft_revision: 4 } },
    });
    expect(transferLog.get()).toEqual([
      expect.objectContaining({
        kind: "save",
        from: "Payslip Automation",
        toName: "Database",
        dataType: "payslip-template",
        status: "delivered",
      }),
    ]);
    expect(toast.success).toHaveBeenCalledWith(
      'Payslip template "Monthly payslip" saved as a draft (revision 4)',
      { description: "Saved from Payslip Automation." },
    );
    expect(JSON.stringify(transferLog.get())).not.toMatch(/Net pay|Monthly payslip/);
  });

  it("tells the app, the log and the user when a publish is refused as stale", async () => {
    fake.reset(() => ({ error: { code: "P0001", message: "PH_STALE" } }));
    const app = connect();
    app.say("send-data", "save-00000002", { dataType: "payslip-template", rows: [PUBLISH] });
    await vi.waitFor(() => expect(app.sent("received")).toHaveLength(1));
    expect(app.sent("received")[0]!.payload).toMatchObject({ ok: false, code: "stale" });
    expect(transferLog.get()[0]).toMatchObject({
      status: "failed",
      reason: "someone else saved first",
    });
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});
