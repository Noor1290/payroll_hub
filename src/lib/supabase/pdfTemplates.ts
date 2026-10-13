import { z } from "zod";
import {
  demoCopyPdfFile,
  demoCopyPdfTemplate,
  demoDeletePdfTemplate,
  demoDownloadPdfFile,
  demoFetchPdfTemplate,
  demoFetchPdfTemplateHistory,
  demoFetchPdfTemplates,
  demoListPdfFiles,
  demoPdfFileExists,
  demoRemovePdfFiles,
  demoRestorePdfTemplate,
  demoSavePdfTemplate,
  demoUploadPdfFile,
} from "@/lib/demo/demoPdfTemplates";
import { supabase } from "./client";
import { NotConfiguredError } from "./errors";
import type { Viewer } from "./queries";

/**
 * PDF form templates (migration 0012_pdf_templates.sql): one row per template of a company,
 * every saved revision kept, and the PDF files themselves in the private Storage bucket
 * "pdf-forms" under <company id>/<sha-256 of the file>.pdf.
 *
 * A body is the fields drawn on the form and the template's company details: no payroll
 * figures and nobody's personal data. Members read; admins save, restore, copy and delete,
 * only through the database functions. The bucket's own policies say the same for the files.
 */

/** The file the owner runs to set this up; named in messages when it has not been run. */
export const PDF_TEMPLATES_MIGRATION = "0012_pdf_templates.sql";
export const PDF_BUCKET = "pdf-forms";
/** The largest PDF the bucket takes. The bucket and the database have the same limit. */
export const PDF_FILE_BYTES = 5 * 1024 * 1024;

const MAX_TEMPLATES = 50;
const MAX_HISTORY = 200;

const bodySchema = z.record(z.string(), z.unknown());
export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

const summarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  revision: z.number().int().min(1),
  pdf_sha256: sha256Schema,
  pdf_file_name: z.string(),
  pdf_bytes: z.number().int().min(1),
  pdf_pages: z.number().int().min(1),
  updated_by: z.uuid().nullable(),
  updated_at: z.string(),
});
export type PdfTemplateSummary = z.infer<typeof summarySchema>;

const templateSchema = summarySchema.extend({ body: bodySchema });
export type PdfTemplate = z.infer<typeof templateSchema>;

const revisionSchema = z.object({
  revision: z.number().int().min(1),
  name: z.string(),
  saved_by: z.uuid().nullable(),
  saved_at: z.string(),
});
export type PdfTemplateRevision = z.infer<typeof revisionSchema>;

const savedSchema = z.object({
  template_id: z.uuid(),
  name: z.string(),
  revision: z.number().int().min(1),
  updated_at: z.string(),
});
export type SavedPdfTemplate = z.infer<typeof savedSchema>;

const restoredSchema = savedSchema.extend({ restored_from: z.number().int().min(1) });

const deletedSchema = z.object({
  template_id: z.uuid(),
  name: z.string(),
  pdf_sha256: sha256Schema,
  file_still_used: z.boolean(),
});
export type DeletedPdfTemplate = z.infer<typeof deletedSchema>;

export interface PdfTemplateInput {
  /** Chosen by the app, so a save that is sent twice cannot make two templates. */
  templateId: string;
  name: string;
  body: Record<string, unknown>;
  /** The revision the caller last saw; 0 for a new template. */
  expectedRevision: number;
  pdfSha256: string;
  pdfFileName: string;
  pdfBytes: number;
  pdfPages: number;
}

export interface CopyInput {
  fromCompanyId: string;
  templateId: string;
  toCompanyId: string;
  newTemplateId: string;
  name: string;
}

const SUMMARY_COLUMNS =
  "id, name, revision, pdf_sha256, pdf_file_name, pdf_bytes, pdf_pages, updated_by, updated_at";

const filePath = (companyId: string, sha256: string) => `${companyId}/${sha256}.pdf`;

function client() {
  if (!supabase) throw new NotConfiguredError();
  return supabase;
}

/** Storage says "already exists" in more than one way, depending on its version. */
function alreadyExists(error: unknown): boolean {
  const { statusCode, status, message, error: kind } = (error ?? {}) as Record<string, unknown>;
  return (
    String(statusCode) === "409" ||
    status === 409 ||
    kind === "Duplicate" ||
    /already exists|duplicate/i.test(typeof message === "string" ? message : "")
  );
}

// ---------- the files ----------

/** True when this company's bucket folder has the file with that hash. */
export async function pdfFileExists(
  viewer: Viewer,
  companyId: string,
  sha256: string,
): Promise<boolean> {
  if (import.meta.env.DEV && viewer.isDemo) return demoPdfFileExists(companyId, sha256);
  const { data, error } = await client()
    .storage.from(PDF_BUCKET)
    .list(companyId, { search: sha256, limit: 5 });
  if (error) throw error;
  return (data ?? []).some((file) => file.name === `${sha256}.pdf`);
}

/**
 * Puts a file in the bucket under its hash. A file that is already there is left as it is:
 * the name is the content's hash, so it is the same file.
 */
export async function uploadPdfFile(
  viewer: Viewer,
  companyId: string,
  sha256: string,
  bytes: Uint8Array,
): Promise<{ alreadyThere: boolean }> {
  if (import.meta.env.DEV && viewer.isDemo) return demoUploadPdfFile(companyId, sha256, bytes);
  const { error } = await client()
    .storage.from(PDF_BUCKET)
    .upload(
      filePath(companyId, sha256),
      new Blob([bytes as BlobPart], { type: "application/pdf" }),
      {
        contentType: "application/pdf",
        upsert: false,
      },
    );
  if (!error) return { alreadyThere: false };
  if (alreadyExists(error)) return { alreadyThere: true };
  throw error;
}

/** The file's bytes, or null when this company has no such file. */
export async function downloadPdfFile(
  viewer: Viewer,
  companyId: string,
  sha256: string,
): Promise<Uint8Array | null> {
  if (import.meta.env.DEV && viewer.isDemo) return demoDownloadPdfFile(companyId, sha256);
  if (!(await pdfFileExists(viewer, companyId, sha256))) return null;
  const { data, error } = await client()
    .storage.from(PDF_BUCKET)
    .download(filePath(companyId, sha256));
  if (error) throw error;
  return new Uint8Array(await data.arrayBuffer());
}

/** Copies a file from one company's folder to another's. Already there counts as done. */
export async function copyPdfFile(
  viewer: Viewer,
  fromCompanyId: string,
  toCompanyId: string,
  sha256: string,
): Promise<void> {
  if (import.meta.env.DEV && viewer.isDemo)
    return demoCopyPdfFile(fromCompanyId, toCompanyId, sha256);
  if (await pdfFileExists(viewer, toCompanyId, sha256)) return;
  const { error } = await client()
    .storage.from(PDF_BUCKET)
    .copy(filePath(fromCompanyId, sha256), filePath(toCompanyId, sha256));
  if (error && !alreadyExists(error)) throw error;
}

/** Removes files from a company's folder. */
export async function removePdfFiles(
  viewer: Viewer,
  companyId: string,
  sha256s: string[],
): Promise<void> {
  if (sha256s.length === 0) return;
  if (import.meta.env.DEV && viewer.isDemo) return demoRemovePdfFiles(companyId, sha256s);
  const { error } = await client()
    .storage.from(PDF_BUCKET)
    .remove(sha256s.map((sha256) => filePath(companyId, sha256)));
  if (error) throw error;
}

/**
 * Removes every file a company has in the bucket, before the company itself is deleted (the
 * database function cannot reach the files). Does nothing, and does not fail, when the bucket
 * is not there yet because migration 0012 has not been run.
 */
export async function removeAllPdfFiles(viewer: Viewer, companyId: string): Promise<number> {
  if (import.meta.env.DEV && viewer.isDemo) {
    const hashes = await demoListPdfFiles(companyId);
    await demoRemovePdfFiles(companyId, hashes);
    return hashes.length;
  }
  const bucket = client().storage.from(PDF_BUCKET);
  let removed = 0;
  for (;;) {
    const { data, error } = await bucket.list(companyId, { limit: 100 });
    if (error) {
      if (/not found/i.test(error.message)) return removed;
      throw error;
    }
    const names = (data ?? []).map((file) => `${companyId}/${file.name}`);
    if (names.length === 0) return removed;
    const gone = await bucket.remove(names);
    if (gone.error) throw gone.error;
    removed += names.length;
  }
}

// ---------- the templates ----------

/** A company's templates by name, without their bodies. */
export async function fetchPdfTemplates(
  viewer: Viewer,
  companyId: string,
): Promise<PdfTemplateSummary[]> {
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchPdfTemplates(companyId);
  const { data, error } = await client()
    .from("pdf_templates")
    .select(SUMMARY_COLUMNS)
    .eq("company_id", companyId)
    .order("name", { ascending: true })
    .range(0, MAX_TEMPLATES - 1);
  if (error) throw error;
  return z.array(summarySchema).parse(data);
}

/** One template, body included. Null when this company has no such template. */
export async function fetchPdfTemplate(
  viewer: Viewer,
  companyId: string,
  templateId: string,
): Promise<PdfTemplate | null> {
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchPdfTemplate(companyId, templateId);
  const { data, error } = await client()
    .from("pdf_templates")
    .select(`${SUMMARY_COLUMNS}, body`)
    .eq("company_id", companyId)
    .eq("id", templateId)
    .maybeSingle();
  if (error) throw error;
  return templateSchema.nullable().parse(data);
}

/** The kept revisions of one template, newest first, without their bodies. */
export async function fetchPdfTemplateHistory(
  viewer: Viewer,
  companyId: string,
  templateId: string,
): Promise<PdfTemplateRevision[]> {
  if (import.meta.env.DEV && viewer.isDemo)
    return demoFetchPdfTemplateHistory(companyId, templateId);
  const { data, error } = await client()
    .from("pdf_template_history")
    .select("revision, name, saved_by, saved_at")
    .eq("company_id", companyId)
    .eq("template_id", templateId)
    .order("revision", { ascending: false })
    .range(0, MAX_HISTORY - 1);
  if (error) throw error;
  return z.array(revisionSchema).parse(data);
}

/**
 * Creates a template or saves over it through `save_pdf_template`. The database decides:
 * admin of that company, name unique in it, the file in the bucket, and `expectedRevision`
 * still the current one (PH_STALE otherwise, never an overwrite).
 */
export async function savePdfTemplate(
  viewer: Viewer,
  companyId: string,
  input: PdfTemplateInput,
): Promise<SavedPdfTemplate> {
  if (import.meta.env.DEV && viewer.isDemo) return demoSavePdfTemplate(companyId, input);
  const { data, error } = await client().rpc("save_pdf_template", {
    p_company_id: companyId,
    p_template_id: input.templateId,
    p_name: input.name,
    p_body: input.body,
    p_expected_revision: input.expectedRevision,
    p_pdf_sha256: input.pdfSha256,
    p_pdf_file_name: input.pdfFileName,
    p_pdf_bytes: input.pdfBytes,
    p_pdf_pages: input.pdfPages,
  });
  if (error) throw error;
  return savedSchema.parse(data);
}

/** Makes an earlier revision the newest one. */
export async function restorePdfTemplate(
  viewer: Viewer,
  companyId: string,
  templateId: string,
  revision: number,
  expectedRevision: number,
): Promise<SavedPdfTemplate & { restored_from: number }> {
  if (import.meta.env.DEV && viewer.isDemo) {
    return demoRestorePdfTemplate(companyId, templateId, revision, expectedRevision);
  }
  const { data, error } = await client().rpc("restore_pdf_template", {
    p_company_id: companyId,
    p_template_id: templateId,
    p_revision: revision,
    p_expected_revision: expectedRevision,
  });
  if (error) throw error;
  return restoredSchema.parse(data);
}

/**
 * Copies a template to another company: first its file, into that company's folder, then
 * the row, through `copy_pdf_template`.
 */
export async function copyPdfTemplate(
  viewer: Viewer,
  input: CopyInput,
  sha256: string,
): Promise<SavedPdfTemplate> {
  await copyPdfFile(viewer, input.fromCompanyId, input.toCompanyId, sha256);
  if (import.meta.env.DEV && viewer.isDemo) return demoCopyPdfTemplate(input);
  const { data, error } = await client().rpc("copy_pdf_template", {
    p_from_company_id: input.fromCompanyId,
    p_template_id: input.templateId,
    p_to_company_id: input.toCompanyId,
    p_new_template_id: input.newTemplateId,
    p_name: input.name,
  });
  if (error) throw error;
  return savedSchema.parse(data);
}

/**
 * Deletes a template and its history, then its file when nothing else of that company uses
 * it. A file that could not be removed is left behind; the template is gone either way.
 */
export async function deletePdfTemplate(
  viewer: Viewer,
  companyId: string,
  templateId: string,
  expectedRevision: number,
): Promise<DeletedPdfTemplate> {
  let deleted: DeletedPdfTemplate;
  if (import.meta.env.DEV && viewer.isDemo) {
    deleted = await demoDeletePdfTemplate(companyId, templateId, expectedRevision);
  } else {
    const { data, error } = await client().rpc("delete_pdf_template", {
      p_company_id: companyId,
      p_template_id: templateId,
      p_expected_revision: expectedRevision,
    });
    if (error) throw error;
    deleted = deletedSchema.parse(data);
  }
  if (!deleted.file_still_used) {
    try {
      await removePdfFiles(viewer, companyId, [deleted.pdf_sha256]);
    } catch {
      // An unused file left in a private bucket harms nothing; the delete itself succeeded.
    }
  }
  return deleted;
}
