import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearTransferLog, transferLog } from "@/features/transfer/transferLog";
import { APPS } from "@/config/apps.config";
import { HOSTING } from "@/config/origins";
import { bridge } from "@/lib/bridge/bridge";
import { DATA_RULES } from "@/lib/bridge/protocol";
import { demoMemberships } from "@/lib/demo/demoData";
import { demoForgetPdfTemplates } from "@/lib/demo/demoPdfTemplates";
import { runSessionCleanup } from "@/lib/sessionCleanup";
import type { Membership } from "@/lib/supabase/schemas";
import { exchangeContext } from "./appData";
import {
  answerPdfFileRequest,
  answerPdfTemplateRequest,
  describePdfTemplateSave,
  fromBase64,
  savePdfFile,
  savePdfTemplateFromApp,
  sha256Hex,
  toBase64,
} from "./pdfData";

/**
 * The PDF form filler's two data types, end to end on the dashboard's side: what an app sends
 * is checked here and carried out by the demo store, which follows the rules of migration
 * 0012 (src/lib/demo/demoPdfTemplates.ts). The same rules in the real database are tested in
 * pdfTemplates.db.test.ts. FAKE values only.
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

const T1 = "20000000-0000-4000-8000-000000000001";
const T2 = "20000000-0000-4000-8000-000000000002";
const T3 = "20000000-0000-4000-8000-000000000003";

const pdfBytes = (text = "fake form") => new TextEncoder().encode(`%PDF-1.7\n% ${text}\n%%EOF\n`);
const FILE = pdfBytes();
let SHA = "";
const BODY = {
  boxes: [{ id: "b1", name: "Surname", page: 1, x: 10, y: 20, width: 100, height: 18 }],
  employerFields: [{ id: "companyName", label: "Company Name", value: "ABC Co Ltd" }],
};

const fileRequest = (params: Record<string, unknown>) =>
  answerPdfFileRequest({ dataType: "pdf-file", params });
const upload = (row: Record<string, unknown>) => savePdfFile({ dataType: "pdf-file", rows: [row] });
const request = (params?: Record<string, unknown>) =>
  answerPdfTemplateRequest({ dataType: "pdf-template", ...(params ? { params } : {}) });
const send = (row: Record<string, unknown>) =>
  savePdfTemplateFromApp({ dataType: "pdf-template", rows: [row] });

const uploadRow = (bytes = FILE, sha = SHA) => ({
  action: "upload",
  brn: "C1234567",
  sha256: sha,
  data: toBase64(bytes),
});
const saveRow = (more: Record<string, unknown> = {}) => ({
  action: "save",
  brn: "C1234567",
  template_id: T1,
  name: "Statement of Emoluments",
  body: BODY,
  expected_revision: 0,
  pdf_sha256: SHA,
  pdf_file_name: "form.pdf",
  pdf_bytes: FILE.length,
  pdf_pages: 1,
  ...more,
});

beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  SHA = await sha256Hex(FILE);
  demoForgetPdfTemplates();
  signIn();
  toast.success.mockClear();
  toast.error.mockClear();
});
afterEach(() => {
  runSessionCleanup();
  clearTransferLog();
  vi.useRealTimers();
});

describe("base64 and the hash", () => {
  it("turns bytes into text and back without changing one of them, large files included", async () => {
    const big = new Uint8Array(300_000).map((_, i) => (i * 31) % 256);
    expect(fromBase64(toBase64(big))).toEqual(big);
    expect(fromBase64("not base64!")).toBeNull();
    expect(fromBase64("abc")).toBeNull();
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("pdf-file: upload", () => {
  it("stores a PDF under its hash, once however often it is sent", async () => {
    expect(await upload(uploadRow())).toEqual({
      ok: true,
      result: { sha256: SHA, bytes: FILE.length, already_there: false },
    });
    expect(await upload(uploadRow())).toMatchObject({ ok: true, result: { already_there: true } });
    expect(await fileRequest({ action: "exists", sha256: SHA })).toMatchObject({
      ok: true,
      rows: [{ sha256: SHA, exists: true }],
      meta: { brn: "C1234567", role: "admin" },
    });
  });

  it("refuses a file that is not what its hash says, before anything is stored", async () => {
    const other = await sha256Hex(pdfBytes("another form"));
    expect(await upload(uploadRow(FILE, other))).toMatchObject({ ok: false, code: "invalid" });
    expect(await fileRequest({ action: "exists", sha256: other })).toMatchObject({
      rows: [{ exists: false }],
    });
  });

  it("refuses what is not a PDF, what is not base64, and what is over 5 MB", async () => {
    const text = new TextEncoder().encode("just some notes");
    expect(await upload(uploadRow(text, await sha256Hex(text)))).toMatchObject({
      ok: false,
      code: "invalid",
      error: "The file is not a PDF.",
    });
    expect(await upload({ ...uploadRow(), data: "%%%" })).toMatchObject({
      ok: false,
      code: "invalid",
    });
    const huge = new Uint8Array(5 * 1024 * 1024 + 1);
    huge.set(FILE);
    expect(await upload(uploadRow(huge, await sha256Hex(huge)))).toMatchObject({
      ok: false,
      code: "too-large",
    });
  });

  it("is for admins of the selected company: a viewer and another company's BRN are refused", async () => {
    signIn(XYZ);
    expect(await upload({ ...uploadRow(), brn: "C7654321" })).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    signIn();
    expect(await upload({ ...uploadRow(), brn: "C7654321" })).toMatchObject({
      ok: false,
      code: "wrong-company",
    });
    expect(await upload({ ...uploadRow(), extra: true })).toMatchObject({
      ok: false,
      code: "invalid",
    });
  });

  it("fits a 5 MB PDF in one message, and no more than that", () => {
    const base64Of5Mb = Math.ceil((5 * 1024 * 1024) / 3) * 4;
    expect(DATA_RULES["pdf-file"]!.sendBytes!).toBeGreaterThan(base64Of5Mb + 500);
    expect(DATA_RULES["pdf-file"]!.sendBytes!).toBeLessThan(base64Of5Mb * 1.02);
    expect(DATA_RULES["pdf-file"]!.sendRows).toBe(1);
    expect(DATA_RULES["pdf-template"]!.sendRows).toBe(1);
  });
});

describe("pdf-file: download", () => {
  it("returns the same bytes that were uploaded", async () => {
    await upload(uploadRow());
    const answer = await fileRequest({ action: "download", sha256: SHA });
    expect(answer).toMatchObject({ ok: true, rows: [{ sha256: SHA, bytes: FILE.length }] });
    const row = (answer as unknown as { rows: { data: string }[] }).rows[0]!;
    expect([...fromBase64(row.data)!]).toEqual([...FILE]);
  });

  it("says not-found for a file the company does not have, and for another company's file", async () => {
    expect(await fileRequest({ action: "download", sha256: SHA })).toMatchObject({
      ok: false,
      code: "not-found",
    });
    await upload(uploadRow());
    signIn(NEW);
    expect(await fileRequest({ action: "download", sha256: SHA })).toMatchObject({
      ok: false,
      code: "not-found",
    });
    expect(await fileRequest({ action: "exists", sha256: SHA })).toMatchObject({
      rows: [{ exists: false }],
    });
  });

  it("checks the request: a hash, a known action, the selected company", async () => {
    expect(await fileRequest({ action: "download", sha256: "abc" })).toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(await fileRequest({ action: "list" })).toMatchObject({ ok: false, code: "invalid" });
    expect(await fileRequest({ action: "exists", sha256: SHA, brn: "C7654321" })).toMatchObject({
      ok: false,
      code: "wrong-company",
    });
  });
});

describe("pdf-template: save, list and load", () => {
  beforeEach(async () => {
    await upload(uploadRow());
  });

  it("creates a template at revision 1 and returns it exactly as sent", async () => {
    expect(await send(saveRow())).toMatchObject({
      ok: true,
      result: { action: "save", template_id: T1, name: "Statement of Emoluments", revision: 1 },
    });
    expect(await request({ action: "list" })).toMatchObject({
      ok: true,
      dataType: "pdf-template",
      meta: { label: "ABC Co Ltd", brn: "C1234567", role: "admin" },
      rows: [
        {
          template_id: T1,
          name: "Statement of Emoluments",
          revision: 1,
          pdf_sha256: SHA,
          pdf_file_name: "form.pdf",
          pdf_bytes: FILE.length,
          pdf_pages: 1,
          updated_by_you: true,
        },
      ],
    });
    const loaded = await request({ action: "load", template_id: T1 });
    expect(loaded).toMatchObject({
      ok: true,
      rows: [{ template_id: T1, revision: 1, body: BODY }],
    });
    // Never a user id, and a list never carries bodies.
    expect(JSON.stringify(loaded)).not.toContain(ME);
    expect(JSON.stringify(await request({ action: "list" }))).not.toContain("boxes");
  });

  it("refuses a template whose file has not been sent", async () => {
    const missing = "c".repeat(64);
    expect(await send(saveRow({ pdf_sha256: missing }))).toMatchObject({
      ok: false,
      code: "not-found",
      error: expect.stringContaining("Send the file first"),
    });
    expect(await request({ action: "list" })).toMatchObject({ rows: [] });
  });

  it("refuses a save over someone else's newer revision, and the same save sent twice", async () => {
    await send(saveRow());
    expect(await send(saveRow())).toMatchObject({ ok: false, code: "stale" });
    expect(await send(saveRow({ expected_revision: 1, name: "Renamed" }))).toMatchObject({
      ok: true,
      result: { revision: 2 },
    });
    expect(await send(saveRow({ expected_revision: 1, name: "From an old copy" }))).toMatchObject({
      ok: false,
      code: "stale",
    });
    expect(await request({ action: "load", template_id: T1 })).toMatchObject({
      rows: [{ name: "Renamed" }],
    });
  });

  it("refuses a body that is too large or that carries a file, a duplicate name, and unknown fields", async () => {
    expect(await send(saveRow({ body: { text: "x".repeat(251_000) } }))).toMatchObject({
      ok: false,
      code: "too-large",
    });
    expect(
      await send(saveRow({ body: { boxes: [], pdfData: "data:application/pdf;base64,JVBERi0=" } })),
    ).toMatchObject({ ok: false, code: "invalid" });
    await send(saveRow());
    expect(await send(saveRow({ template_id: T2, name: "statement of emoluments" }))).toMatchObject(
      {
        ok: false,
        code: "invalid",
        error: "This company already has one with that name.",
      },
    );
    expect(await send(saveRow({ template_id: T2, name: "Other", pdfData: "x" }))).toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(await send({ ...saveRow(), template_id: "not-a-uuid" })).toMatchObject({
      ok: false,
      code: "invalid",
    });
  });

  it("is for admins of the selected company; a viewer can still read", async () => {
    await send(saveRow());
    expect(await send(saveRow({ brn: "C7654321" }))).toMatchObject({
      ok: false,
      code: "wrong-company",
    });
    signIn(XYZ);
    expect(await send(saveRow({ brn: "C7654321", template_id: T2 }))).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    expect(await request({ action: "list" })).toMatchObject({
      ok: true,
      rows: [],
      meta: { role: "member" },
    });
    // And never another company's template.
    expect(await request({ action: "load", template_id: T1 })).toMatchObject({
      ok: false,
      code: "not-found",
    });
  });

  it("is refused as unavailable when nobody is signed in", async () => {
    exchangeContext.set(null);
    expect(await request({ action: "list" })).toMatchObject({ ok: false, code: "unavailable" });
    expect(await send(saveRow())).toMatchObject({ ok: false, code: "unavailable" });
  });
});

describe("pdf-template: history, restore, delete, copy", () => {
  beforeEach(async () => {
    await upload(uploadRow());
    await send(saveRow());
    await send(
      saveRow({
        expected_revision: 1,
        name: "Second name",
        body: { boxes: [], employerFields: [] },
      }),
    );
  });

  it("keeps every revision and can make an earlier one the newest", async () => {
    expect(await request({ action: "history", template_id: T1 })).toMatchObject({
      ok: true,
      rows: [
        { revision: 2, name: "Second name", saved_by_you: true },
        { revision: 1, name: "Statement of Emoluments", saved_by_you: true },
      ],
    });
    expect(
      await send({
        action: "restore",
        brn: "C1234567",
        template_id: T1,
        revision: 1,
        expected_revision: 1,
      }),
    ).toMatchObject({ ok: false, code: "stale" });
    expect(
      await send({
        action: "restore",
        brn: "C1234567",
        template_id: T1,
        revision: 1,
        expected_revision: 2,
      }),
    ).toMatchObject({
      ok: true,
      result: { action: "restore", revision: 3, restored_from: 1 },
    });
    expect(await request({ action: "load", template_id: T1 })).toMatchObject({
      rows: [{ revision: 3, name: "Statement of Emoluments", body: BODY }],
    });
  });

  it("deletes a template only at the revision last seen, and its file when nothing else uses it", async () => {
    expect(
      await send({ action: "delete", brn: "C1234567", template_id: T1, expected_revision: 1 }),
    ).toMatchObject({ ok: false, code: "stale" });
    expect(
      await send({ action: "delete", brn: "C1234567", template_id: T1, expected_revision: 2 }),
    ).toMatchObject({
      ok: true,
      result: { action: "delete", template_id: T1, name: "Second name" },
    });
    expect(await request({ action: "list" })).toMatchObject({ rows: [] });
    expect(await fileRequest({ action: "exists", sha256: SHA })).toMatchObject({
      rows: [{ exists: false }],
    });
  });

  it("lists the user's other companies they are an admin of, and copies a template and its file to one", async () => {
    const companies = await request({ action: "companies" });
    expect(companies).toMatchObject({ ok: true });
    const brns = (companies as unknown as { rows: { brn: string }[] }).rows.map((r) => r.brn);
    expect(brns).toContain("C0000001");
    expect(brns).not.toContain("C1234567"); // the selected one
    expect(brns).not.toContain("C7654321"); // only a viewer there

    const copy = (more: Record<string, unknown> = {}) =>
      send({
        action: "copy-to-company",
        brn: "C1234567",
        template_id: T1,
        to_brn: "C0000001",
        new_template_id: T3,
        name: "Copied form",
        ...more,
      });
    expect(await copy({ to_brn: "C7654321" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await copy({ to_brn: "C9999999" })).toMatchObject({ ok: false, code: "not-found" });
    expect(await copy({ to_brn: "C1234567" })).toMatchObject({ ok: false, code: "not-found" });
    expect(await copy()).toMatchObject({
      ok: true,
      result: {
        action: "copy-to-company",
        template_id: T3,
        revision: 1,
        to_company: "New Venture Ltd",
      },
    });
    // Sent twice: stored once.
    expect(await copy()).toMatchObject({ ok: false, code: "stale" });

    signIn(NEW);
    expect(await request({ action: "list" })).toMatchObject({
      rows: [{ template_id: T3, name: "Copied form", pdf_sha256: SHA }],
    });
    expect(await fileRequest({ action: "download", sha256: SHA })).toMatchObject({
      ok: true,
      rows: [{ bytes: FILE.length }],
    });
  });
});

describe("what the user is told", () => {
  it("names the template and the revision in the toast, and nothing else", () => {
    expect(describePdfTemplateSave({ action: "save", name: "Form", revision: 4 })).toBe(
      'PDF template "Form" saved (revision 4)',
    );
    expect(describePdfTemplateSave({ action: "restore", name: "Form", restored_from: 2 })).toBe(
      'PDF template "Form" put back to revision 2',
    );
    expect(describePdfTemplateSave({ action: "delete", name: "Form" })).toBe(
      'PDF template "Form" deleted',
    );
    expect(
      describePdfTemplateSave({
        action: "copy-to-company",
        name: "Form",
        to_company: "New Venture Ltd",
      }),
    ).toBe('PDF template "Form" copied to New Venture Ltd');
  });

  it("over the bridge, from the PDF form filler's frame: answered, one log row each, and no file content in the log", async () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const frame = iframe.contentWindow!;
    const replies: { type: string; id: string; payload: Record<string, unknown> }[] = [];
    frame.postMessage = ((message: (typeof replies)[number]) => replies.push(message)) as never;
    bridge.start();
    bridge.attachFrame("pdf-editor", () => frame);
    const fromApp = (type: string, id: string, payload: unknown, app = "pdf-editor") =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type, from: app, to: "dashboard", version: 1, id, payload },
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

    fromApp("send-data", "upload-00001", { dataType: "pdf-file", rows: [uploadRow()] });
    expect((await reply("upload-00001")).payload).toMatchObject({ ok: true });
    fromApp("send-data", "save-0000001", { dataType: "pdf-template", rows: [saveRow()] });
    expect((await reply("save-0000001")).payload).toMatchObject({
      ok: true,
      result: { revision: 1 },
    });
    fromApp("request-data", "list-0000001", {
      dataType: "pdf-template",
      params: { action: "list" },
    });
    expect((await reply("list-0000001")).payload).toMatchObject({
      ok: true,
      rows: [{ template_id: T1 }],
    });

    const log = transferLog.get();
    expect(log.map((row) => row.dataType)).toEqual(
      expect.arrayContaining(["pdf-file", "pdf-template", "pdf-template"]),
    );
    expect(log).toHaveLength(3);
    const written = JSON.stringify(log);
    expect(written).not.toContain(toBase64(FILE).slice(0, 24));
    expect(written).not.toContain("Surname");
    expect(toast.success).toHaveBeenCalledTimes(2);

    bridge.detachFrame("pdf-editor");
    bridge.stop();
    iframe.remove();
  });

  it("only the PDF form filler may use the two data types", () => {
    const allowed = APPS.filter(
      (app) => app.accepts.includes("pdf-template") || app.produces.includes("pdf-file"),
    );
    expect(allowed.map((app) => app.id)).toEqual(["pdf-editor"]);
  });
});

describe("the production build", () => {
  it("can drop the demo store: every use of it is behind `import.meta.env.DEV`, written out in place", async () => {
    // A helper function around that test hides it from the build tool, and the demo store,
    // with its sample company names, then reaches the published site (the deploy refuses it).
    const source = (await import("@/lib/supabase/pdfTemplates.ts?raw")).default as string;
    const guarded = source.split("import.meta.env.DEV && viewer.isDemo").length - 1;
    const demoCalls = [...source.matchAll(/\bdemo[A-Z]\w+\(/g)].length;
    expect(demoCalls).toBeGreaterThan(10);
    expect(guarded).toBeGreaterThanOrEqual(demoCalls - 1); // removeAllPdfFiles makes two calls behind one test
    expect(source).not.toMatch(/=>\s*import\.meta\.env\.DEV/);
  });
});

describe("pdf-template: one kept revision", () => {
  beforeEach(async () => {
    await upload(uploadRow());
    await send(saveRow());
    await send(saveRow({ expected_revision: 1, name: "Second name", body: { boxes: [] } }));
  });

  it("returns an earlier revision as it was saved, with its file, and changes nothing", async () => {
    const first = await request({ action: "load", template_id: T1, revision: 1 });
    expect(first).toMatchObject({
      ok: true,
      rows: [
        {
          template_id: T1,
          revision: 1,
          name: "Statement of Emoluments",
          body: BODY,
          pdf_sha256: SHA,
          pdf_file_name: "form.pdf",
          pdf_pages: 1,
          saved_by_you: true,
        },
      ],
    });
    expect(JSON.stringify(first)).not.toContain(ME);
    // Looking at it restored nothing: the template is still at revision 2.
    expect(await request({ action: "load", template_id: T1 })).toMatchObject({
      rows: [{ revision: 2, name: "Second name" }],
    });
    expect(await request({ action: "history", template_id: T1 })).toMatchObject({
      rows: [{ revision: 2 }, { revision: 1 }],
    });
  });

  it("says not-found for a revision that was never kept, and for another company's template", async () => {
    expect(await request({ action: "load", template_id: T1, revision: 9 })).toMatchObject({
      ok: false,
      code: "not-found",
    });
    expect(await request({ action: "load", template_id: T1, revision: 0 })).toMatchObject({
      ok: false,
      code: "invalid",
    });
    signIn(NEW);
    expect(await request({ action: "load", template_id: T1, revision: 1 })).toMatchObject({
      ok: false,
      code: "not-found",
    });
  });

  it("can be read by someone who is not an admin, who still cannot restore it", async () => {
    // XYZ is the company this user only views; give it a template through the demo store's own rules.
    signIn(XYZ);
    expect(await request({ action: "history", template_id: T1 })).toMatchObject({
      ok: true,
      rows: [],
    });
    expect(
      await send({
        action: "restore",
        brn: "C7654321",
        template_id: T1,
        revision: 1,
        expected_revision: 2,
      }),
    ).toMatchObject({ ok: false, code: "forbidden" });
  });
});
