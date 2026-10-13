import { z } from "zod";
import { PDF_FILE, PDF_TEMPLATE } from "@/config/apps.config";
import { registerDataType } from "@/lib/bridge/bridge";
import {
  jsonBytes,
  PDF_TEMPLATE_BODY_BYTES,
  type ReceivedPayload,
  type RequestDataPayload,
  type ResponseDataPayload,
  type SendDataPayload,
} from "@/lib/bridge/protocol";
import {
  copyPdfTemplate,
  deletePdfTemplate,
  downloadPdfFile,
  fetchPdfTemplate,
  fetchPdfTemplateHistory,
  fetchPdfTemplates,
  PDF_FILE_BYTES,
  PDF_TEMPLATES_MIGRATION,
  pdfFileExists,
  restorePdfTemplate,
  savePdfTemplate,
  sha256Schema,
  uploadPdfFile,
} from "@/lib/supabase/pdfTemplates";
import { fetchMemberships } from "@/lib/supabase/queries";
import {
  answerMeta,
  brnSchema,
  exchangeContextFor,
  invalidRefusal,
  normaliseBrn,
  refusalFor,
  refuse,
} from "./appData";
import { answerRequest, recordSave } from "./deliver";

/**
 * The PDF form filler's two data types (docs/INTEGRATION.md, "PDF form filler: templates"):
 *
 *  - pdf-template: a company's form templates. A body is the fields drawn on the form and the
 *    template's company details: layout and the company's own name and numbers, nothing per
 *    employee. So, like payslip templates, it is answered and saved WITHOUT a dialog and
 *    without the password gate; every exchange is a row in the transfer log and every save
 *    shows a toast.
 *  - pdf-file: the blank PDF forms themselves, kept in the Storage bucket under the hash of
 *    their content. A file crosses the bridge as base64 text in one message. The dashboard
 *    checks it before it is stored: its size, that it starts as a PDF, and that its SHA-256
 *    is the one stated.
 *
 * The database and the bucket decide who may read (members) and write (admins); this file
 * checks the shape and that the app is talking about the company the user has selected.
 */

const templateIdSchema = z.uuid();
const templateNameSchema = z.string().trim().min(1).max(80);
const fileNameSchema = z.string().trim().min(1).max(200);

// ---------- base64 and hashing ----------

/** The bytes of a base64 text, or null when it is not base64. */
export function fromBase64(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return null;
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  // In pieces: a single call with millions of arguments overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const PDF_START = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const startsAsPdf = (bytes: Uint8Array) => PDF_START.every((byte, i) => bytes[i] === byte);

// ---------- pdf-file ----------

const fileParamsSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("exists"), brn: brnSchema.optional(), sha256: sha256Schema }),
  z.strictObject({
    action: z.literal("download"),
    brn: brnSchema.optional(),
    sha256: sha256Schema,
  }),
]);

const fileSaveSchema = z.strictObject({
  action: z.literal("upload"),
  brn: brnSchema,
  sha256: sha256Schema,
  /** The file, as base64 text. */
  data: z.string().min(1),
});

/** Whether the selected company has a file, or the file itself. */
export async function answerPdfFileRequest(
  payload: RequestDataPayload,
): Promise<ResponseDataPayload> {
  const params = fileParamsSchema.safeParse(payload.params ?? {});
  if (!params.success) return invalidRefusal(params.error);
  const current = exchangeContextFor(params.data.brn);
  if ("ok" in current) return current;
  const { viewer, membership } = current;
  const { sha256 } = params.data;

  try {
    if (params.data.action === "exists") {
      const exists = await pdfFileExists(viewer, membership.company.id, sha256);
      return {
        ok: true,
        dataType: PDF_FILE,
        rows: [{ sha256, exists }],
        meta: answerMeta(membership),
      };
    }
    const bytes = await downloadPdfFile(viewer, membership.company.id, sha256);
    if (!bytes) return refuse("not-found", "This company has no such PDF file in the dashboard.");
    // Never hand on something other than what was asked for.
    if ((await sha256Hex(bytes)) !== sha256) {
      return refuse("unavailable", "The stored PDF file is not the one that was asked for.");
    }
    return {
      ok: true,
      dataType: PDF_FILE,
      rows: [{ sha256, bytes: bytes.length, data: toBase64(bytes) }],
      meta: answerMeta(membership),
    };
  } catch (error) {
    return refusalFor(error, PDF_TEMPLATES_MIGRATION);
  }
}

/** Checks a file and puts it in the bucket. Uploading the same file twice stores it once. */
export async function savePdfFile(payload: SendDataPayload): Promise<ReceivedPayload> {
  const row = fileSaveSchema.safeParse(payload.rows[0]);
  if (!row.success) return invalidRefusal(row.error);
  const current = exchangeContextFor(row.data.brn);
  if ("ok" in current) return current;
  if (current.membership.role !== "admin") {
    return refuse("forbidden", "Only an admin of this company can add a PDF form.");
  }

  const bytes = fromBase64(row.data.data);
  if (!bytes || bytes.length === 0) return refuse("invalid", '"data" is not a file in base64.');
  if (bytes.length > PDF_FILE_BYTES) {
    return refuse("too-large", "The PDF is larger than the dashboard stores (5 MB).");
  }
  if (!startsAsPdf(bytes)) return refuse("invalid", "The file is not a PDF.");
  if ((await sha256Hex(bytes)) !== row.data.sha256) {
    return refuse("invalid", "The file is not the one its hash names. Nothing was stored.");
  }

  try {
    const { alreadyThere } = await uploadPdfFile(
      current.viewer,
      current.membership.company.id,
      row.data.sha256,
      bytes,
    );
    return {
      ok: true,
      result: { sha256: row.data.sha256, bytes: bytes.length, already_there: alreadyThere },
    };
  } catch (error) {
    return refusalFor(error, PDF_TEMPLATES_MIGRATION);
  }
}

// ---------- pdf-template ----------

const templateParamsSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("list"), brn: brnSchema.optional() }),
  z.strictObject({
    action: z.literal("load"),
    brn: brnSchema.optional(),
    template_id: templateIdSchema,
  }),
  z.strictObject({
    action: z.literal("history"),
    brn: brnSchema.optional(),
    template_id: templateIdSchema,
  }),
  /** The user's other companies a template can be copied to. */
  z.strictObject({ action: z.literal("companies"), brn: brnSchema.optional() }),
]);

const templateSaveSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("save"),
    brn: brnSchema,
    /** Chosen by the app, for a new template too. */
    template_id: templateIdSchema,
    name: templateNameSchema,
    body: z.record(z.string(), z.unknown()),
    /** The revision last seen; 0 for a new template. */
    expected_revision: z.number().int().min(0),
    pdf_sha256: sha256Schema,
    pdf_file_name: fileNameSchema,
    pdf_bytes: z.number().int().min(1).max(PDF_FILE_BYTES),
    pdf_pages: z.number().int().min(1).max(10_000),
  }),
  z.strictObject({
    action: z.literal("restore"),
    brn: brnSchema,
    template_id: templateIdSchema,
    revision: z.number().int().min(1),
    expected_revision: z.number().int().min(1),
  }),
  z.strictObject({
    action: z.literal("copy-to-company"),
    brn: brnSchema,
    template_id: templateIdSchema,
    to_brn: brnSchema,
    new_template_id: templateIdSchema,
    name: templateNameSchema,
  }),
  z.strictObject({
    action: z.literal("delete"),
    brn: brnSchema,
    template_id: templateIdSchema,
    expected_revision: z.number().int().min(1),
  }),
]);

/** A `data:` URI anywhere in a body: a file embedded in it. PDFs belong in the bucket. */
const EMBEDDED_FILE = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i;

/** The company's templates, one with its body, its kept revisions, or where it can be copied. */
export async function answerPdfTemplateRequest(
  payload: RequestDataPayload,
): Promise<ResponseDataPayload> {
  const params = templateParamsSchema.safeParse(payload.params ?? {});
  if (!params.success) return invalidRefusal(params.error);
  const current = exchangeContextFor(params.data.brn);
  if ("ok" in current) return current;
  const { viewer, membership } = current;
  const companyId = membership.company.id;
  // Not anyone's user id: only whether it was the person now signed in.
  const you = (id: string | null) => id !== null && id === viewer.id;
  const answer = (rows: Record<string, unknown>[]): ResponseDataPayload => ({
    ok: true,
    dataType: PDF_TEMPLATE,
    rows,
    meta: answerMeta(membership),
  });

  try {
    switch (params.data.action) {
      case "list": {
        const templates = await fetchPdfTemplates(viewer, companyId);
        return answer(
          templates.map(({ id, updated_by, ...template }) => ({
            template_id: id,
            ...template,
            updated_by_you: you(updated_by),
          })),
        );
      }
      case "load": {
        const template = await fetchPdfTemplate(viewer, companyId, params.data.template_id);
        if (!template) return refuse("not-found", "This company has no such PDF template.");
        const { id, updated_by, ...rest } = template;
        return answer([{ template_id: id, ...rest, updated_by_you: you(updated_by) }]);
      }
      case "history": {
        const revisions = await fetchPdfTemplateHistory(viewer, companyId, params.data.template_id);
        return answer(
          revisions.map(({ saved_by, ...revision }) => ({
            ...revision,
            saved_by_you: you(saved_by),
          })),
        );
      }
      case "companies": {
        const memberships = await fetchMemberships(viewer);
        return answer(
          memberships
            .filter((m) => m.role === "admin" && m.company.id !== companyId && m.company.brn)
            .map((m) => ({ brn: m.company.brn, name: m.company.name })),
        );
      }
    }
  } catch (error) {
    return refusalFor(error, PDF_TEMPLATES_MIGRATION);
  }
}

/** Saves, restores, copies or deletes a template. A body is stored exactly as sent. */
export async function savePdfTemplateFromApp(payload: SendDataPayload): Promise<ReceivedPayload> {
  const row = templateSaveSchema.safeParse(payload.rows[0]);
  if (!row.success) return invalidRefusal(row.error);
  const current = exchangeContextFor(row.data.brn);
  if ("ok" in current) return current;
  const { viewer, membership } = current;
  const companyId = membership.company.id;
  const command = row.data;

  // Copying only reads this company; everything else changes it.
  if (command.action !== "copy-to-company" && membership.role !== "admin") {
    return refuse("forbidden", "Only an admin of this company can change its PDF templates.");
  }

  try {
    switch (command.action) {
      case "save": {
        if (jsonBytes(command.body) > PDF_TEMPLATE_BODY_BYTES) {
          return refuse("too-large", "The template is larger than the dashboard accepts (250 KB).");
        }
        if (EMBEDDED_FILE.test(JSON.stringify(command.body))) {
          return refuse("invalid", "A template cannot contain a file. The PDF is sent separately.");
        }
        const saved = await savePdfTemplate(viewer, companyId, {
          templateId: command.template_id,
          name: command.name,
          body: command.body,
          expectedRevision: command.expected_revision,
          pdfSha256: command.pdf_sha256,
          pdfFileName: command.pdf_file_name,
          pdfBytes: command.pdf_bytes,
          pdfPages: command.pdf_pages,
        });
        return { ok: true, result: { action: "save", ...saved } };
      }
      case "restore": {
        const restored = await restorePdfTemplate(
          viewer,
          companyId,
          command.template_id,
          command.revision,
          command.expected_revision,
        );
        return { ok: true, result: { action: "restore", ...restored } };
      }
      case "delete": {
        const deleted = await deletePdfTemplate(
          viewer,
          companyId,
          command.template_id,
          command.expected_revision,
        );
        return {
          ok: true,
          result: { action: "delete", template_id: deleted.template_id, name: deleted.name },
        };
      }
      case "copy-to-company": {
        const target = (await fetchMemberships(viewer)).find(
          (m) => m.company.brn && normaliseBrn(m.company.brn) === normaliseBrn(command.to_brn),
        );
        if (!target || target.company.id === companyId) {
          return refuse("not-found", "You have no other company with that BRN in the dashboard.");
        }
        if (target.role !== "admin") {
          return refuse("forbidden", "Only an admin of that company can add a template to it.");
        }
        const source = await fetchPdfTemplate(viewer, companyId, command.template_id);
        if (!source) return refuse("not-found", "This company has no such PDF template.");
        const copied = await copyPdfTemplate(
          viewer,
          {
            fromCompanyId: companyId,
            templateId: command.template_id,
            toCompanyId: target.company.id,
            newTemplateId: command.new_template_id,
            name: command.name,
          },
          source.pdf_sha256,
        );
        return {
          ok: true,
          result: { action: "copy-to-company", ...copied, to_company: target.company.name },
        };
      }
    }
  } catch (error) {
    return refusalFor(error, PDF_TEMPLATES_MIGRATION);
  }
}

/** The toast for a template save. Names and numbers only. */
export function describePdfTemplateSave(result: Record<string, unknown>): string {
  const name = `"${String(result.name)}"`;
  switch (result.action) {
    case "restore":
      return `PDF template ${name} put back to revision ${String(result.restored_from)}`;
    case "delete":
      return `PDF template ${name} deleted`;
    case "copy-to-company":
      return `PDF template ${name} copied to ${String(result.to_company)}`;
    default:
      return `PDF template ${name} saved (revision ${String(result.revision)})`;
  }
}

// ---------- registration ----------

registerDataType(PDF_TEMPLATE, {
  request: (appId, payload) =>
    answerRequest(appId, PDF_TEMPLATE, () => answerPdfTemplateRequest(payload)),
  save: (appId, payload) =>
    recordSave(
      appId,
      PDF_TEMPLATE,
      "the PDF template",
      () => savePdfTemplateFromApp(payload),
      describePdfTemplateSave,
    ),
});

registerDataType(PDF_FILE, {
  request: (appId, payload) => answerRequest(appId, PDF_FILE, () => answerPdfFileRequest(payload)),
  save: (appId, payload) =>
    recordSave(
      appId,
      PDF_FILE,
      "the PDF form",
      () => savePdfFile(payload),
      (result) =>
        result.already_there
          ? "PDF form already in the dashboard"
          : "PDF form stored in the dashboard",
    ),
});
