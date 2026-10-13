import type {
  CopyInput,
  DeletedPdfTemplate,
  PdfTemplate,
  PdfTemplateInput,
  PdfTemplateRevision,
  PdfTemplateSummary,
  SavedPdfTemplate,
} from "@/lib/supabase/pdfTemplates";
import { demoMemberships } from "./demoData";

/**
 * FAKE PDF templates and a fake file bucket for dev-only demo mode, so the mock PDF form
 * filler has something to talk to. They follow the same rules as migration
 * 0012_pdf_templates.sql: members read, admins write; the revision the caller last saw must
 * still be the latest; names unique per company; 50 templates per company; a template's file
 * must be in the bucket first; every revision is kept (the last 200). Everything here is
 * invented and lives in memory. Only reachable behind `import.meta.env.DEV`.
 */

const DEMO_USER_ID = "00000000-0000-4000-8000-000000000001";
const MAX_TEMPLATES = 50;
const MAX_HISTORY = 200;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message: string, code: string) => Object.assign(new Error(message), { code });

type Stored = PdfTemplate & { company_id: string };
type StoredRevision = PdfTemplateRevision & {
  company_id: string;
  template_id: string;
  body: Record<string, unknown>;
  pdf_sha256: string;
  pdf_file_name: string;
  pdf_bytes: number;
  pdf_pages: number;
};

const templates: Stored[] = [];
const history: StoredRevision[] = [];
/** The bucket: "<company id>/<sha256>.pdf" -> the file's bytes. */
const files = new Map<string, Uint8Array>();

const path = (companyId: string, sha256: string) => `${companyId}/${sha256}.pdf`;
const roleIn = (companyId: string) =>
  demoMemberships.find((m) => m.company.id === companyId)?.role ?? null;

function requireMember(companyId: string) {
  if (roleIn(companyId) === null) throw fail("PH_NOT_FOUND", "P0002");
}
function requireAdmin(companyId: string) {
  if (roleIn(companyId) !== "admin") throw fail("PH_NOT_ADMIN", "42501");
}

/** A row without the columns an answer leaves out. */
function without<T extends object, K extends keyof T>(row: T, ...keys: K[]): Omit<T, K> {
  const copy = { ...row };
  for (const key of keys) delete copy[key];
  return copy;
}

const summaryOf = (row: Stored): PdfTemplateSummary => without(row, "company_id", "body");

function keep(row: Stored) {
  history.push({
    company_id: row.company_id,
    template_id: row.id,
    revision: row.revision,
    name: row.name,
    body: row.body,
    pdf_sha256: row.pdf_sha256,
    pdf_file_name: row.pdf_file_name,
    pdf_bytes: row.pdf_bytes,
    pdf_pages: row.pdf_pages,
    saved_by: DEMO_USER_ID,
    saved_at: row.updated_at,
  });
  for (let i = history.length - 1; i >= 0; i--) {
    const old = history[i]!;
    if (old.template_id === row.id && old.revision <= row.revision - MAX_HISTORY) {
      history.splice(i, 1);
    }
  }
}

const nameTaken = (companyId: string, name: string, exceptId?: string) =>
  templates.some(
    (t) =>
      t.company_id === companyId &&
      t.id !== exceptId &&
      t.name.toLowerCase() === name.toLowerCase(),
  );

// ---------- the bucket ----------

export async function demoPdfFileExists(companyId: string, sha256: string): Promise<boolean> {
  await pause(50);
  if (roleIn(companyId) === null) return false;
  return files.has(path(companyId, sha256));
}

export async function demoUploadPdfFile(
  companyId: string,
  sha256: string,
  bytes: Uint8Array,
): Promise<{ alreadyThere: boolean }> {
  await pause(100);
  requireAdmin(companyId);
  const key = path(companyId, sha256);
  if (files.has(key)) return { alreadyThere: true };
  files.set(key, bytes.slice());
  return { alreadyThere: false };
}

export async function demoDownloadPdfFile(
  companyId: string,
  sha256: string,
): Promise<Uint8Array | null> {
  await pause(100);
  if (roleIn(companyId) === null) return null;
  return files.get(path(companyId, sha256))?.slice() ?? null;
}

export async function demoCopyPdfFile(
  fromCompanyId: string,
  toCompanyId: string,
  sha256: string,
): Promise<void> {
  await pause(50);
  requireMember(fromCompanyId);
  requireAdmin(toCompanyId);
  const source = files.get(path(fromCompanyId, sha256));
  if (!source) throw fail("PH_NO_FILE", "P0002");
  if (!files.has(path(toCompanyId, sha256))) files.set(path(toCompanyId, sha256), source.slice());
}

export async function demoRemovePdfFiles(companyId: string, sha256s: string[]): Promise<void> {
  await pause(50);
  requireAdmin(companyId);
  for (const sha256 of sha256s) files.delete(path(companyId, sha256));
}

export async function demoListPdfFiles(companyId: string): Promise<string[]> {
  await pause(50);
  if (roleIn(companyId) === null) return [];
  const prefix = `${companyId}/`;
  return [...files.keys()]
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length, -4));
}

// ---------- the tables ----------

export async function demoFetchPdfTemplates(companyId: string): Promise<PdfTemplateSummary[]> {
  await pause(150);
  if (roleIn(companyId) === null) return [];
  return templates
    .filter((t) => t.company_id === companyId)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(summaryOf);
}

export async function demoFetchPdfTemplate(
  companyId: string,
  templateId: string,
): Promise<PdfTemplate | null> {
  await pause(100);
  if (roleIn(companyId) === null) return null;
  const found = templates.find((t) => t.company_id === companyId && t.id === templateId);
  if (!found) return null;
  return structuredClone(without(found, "company_id"));
}

export async function demoFetchPdfTemplateHistory(
  companyId: string,
  templateId: string,
): Promise<PdfTemplateRevision[]> {
  await pause(100);
  if (roleIn(companyId) === null) return [];
  return history
    .filter((h) => h.company_id === companyId && h.template_id === templateId)
    .sort((a, b) => b.revision - a.revision)
    .map(({ revision, name, saved_by, saved_at }) => ({ revision, name, saved_by, saved_at }));
}

export async function demoSavePdfTemplate(
  companyId: string,
  input: PdfTemplateInput,
): Promise<SavedPdfTemplate> {
  await pause(200);
  requireAdmin(companyId);
  const name = input.name.trim();
  if (!files.has(path(companyId, input.pdfSha256))) throw fail("PH_NO_FILE", "P0002");

  const existing = templates.find((t) => t.id === input.templateId);
  const now = new Date().toISOString();
  let row: Stored;
  if (!existing) {
    if (input.expectedRevision !== 0) throw fail("PH_NOT_FOUND", "P0002");
    if (templates.filter((t) => t.company_id === companyId).length >= MAX_TEMPLATES) {
      throw fail("PH_LIMIT", "54000");
    }
    if (nameTaken(companyId, name)) throw fail("PH_DUPLICATE_NAME", "23505");
    row = {
      company_id: companyId,
      id: input.templateId,
      name,
      body: structuredClone(input.body),
      revision: 1,
      pdf_sha256: input.pdfSha256,
      pdf_file_name: input.pdfFileName,
      pdf_bytes: input.pdfBytes,
      pdf_pages: input.pdfPages,
      updated_by: DEMO_USER_ID,
      updated_at: now,
    };
    templates.push(row);
  } else {
    if (existing.company_id !== companyId) throw fail("PH_NOT_FOUND", "P0002");
    if (existing.revision !== input.expectedRevision) throw fail("PH_STALE", "P0001");
    if (nameTaken(companyId, name, existing.id)) throw fail("PH_DUPLICATE_NAME", "23505");
    Object.assign(existing, {
      name,
      body: structuredClone(input.body),
      revision: existing.revision + 1,
      pdf_sha256: input.pdfSha256,
      pdf_file_name: input.pdfFileName,
      pdf_bytes: input.pdfBytes,
      pdf_pages: input.pdfPages,
      updated_by: DEMO_USER_ID,
      updated_at: now,
    });
    row = existing;
  }
  keep(row);
  return {
    template_id: row.id,
    name: row.name,
    revision: row.revision,
    updated_at: row.updated_at,
  };
}

export async function demoRestorePdfTemplate(
  companyId: string,
  templateId: string,
  revision: number,
  expectedRevision: number,
): Promise<SavedPdfTemplate & { restored_from: number }> {
  await pause(200);
  requireAdmin(companyId);
  const row = templates.find((t) => t.company_id === companyId && t.id === templateId);
  if (!row) throw fail("PH_NOT_FOUND", "P0002");
  if (row.revision !== expectedRevision) throw fail("PH_STALE", "P0001");
  const old = history.find(
    (h) => h.company_id === companyId && h.template_id === templateId && h.revision === revision,
  );
  if (!old) throw fail("PH_NOT_FOUND", "P0002");
  if (!files.has(path(companyId, old.pdf_sha256))) throw fail("PH_NO_FILE", "P0002");
  if (nameTaken(companyId, old.name, row.id)) throw fail("PH_DUPLICATE_NAME", "23505");
  Object.assign(row, {
    name: old.name,
    body: structuredClone(old.body),
    revision: row.revision + 1,
    pdf_sha256: old.pdf_sha256,
    pdf_file_name: old.pdf_file_name,
    pdf_bytes: old.pdf_bytes,
    pdf_pages: old.pdf_pages,
    updated_by: DEMO_USER_ID,
    updated_at: new Date().toISOString(),
  });
  keep(row);
  return {
    template_id: row.id,
    name: row.name,
    revision: row.revision,
    restored_from: revision,
    updated_at: row.updated_at,
  };
}

export async function demoCopyPdfTemplate(input: CopyInput): Promise<SavedPdfTemplate> {
  await pause(200);
  requireAdmin(input.toCompanyId);
  const name = input.name.trim();
  const source =
    roleIn(input.fromCompanyId) === null
      ? undefined
      : templates.find((t) => t.company_id === input.fromCompanyId && t.id === input.templateId);
  if (!source) throw fail("PH_NOT_FOUND", "P0002");
  if (!files.has(path(input.toCompanyId, source.pdf_sha256))) throw fail("PH_NO_FILE", "P0002");
  if (templates.filter((t) => t.company_id === input.toCompanyId).length >= MAX_TEMPLATES) {
    throw fail("PH_LIMIT", "54000");
  }
  if (templates.some((t) => t.id === input.newTemplateId)) throw fail("PH_STALE", "P0001");
  if (nameTaken(input.toCompanyId, name)) throw fail("PH_DUPLICATE_NAME", "23505");
  const row: Stored = {
    ...structuredClone(source),
    company_id: input.toCompanyId,
    id: input.newTemplateId,
    name,
    revision: 1,
    updated_by: DEMO_USER_ID,
    updated_at: new Date().toISOString(),
  };
  templates.push(row);
  keep(row);
  return {
    template_id: row.id,
    name: row.name,
    revision: row.revision,
    updated_at: row.updated_at,
  };
}

export async function demoDeletePdfTemplate(
  companyId: string,
  templateId: string,
  expectedRevision: number,
): Promise<DeletedPdfTemplate> {
  await pause(200);
  requireAdmin(companyId);
  const index = templates.findIndex((t) => t.company_id === companyId && t.id === templateId);
  const row = templates[index];
  if (!row) throw fail("PH_NOT_FOUND", "P0002");
  if (row.revision !== expectedRevision) throw fail("PH_STALE", "P0001");
  templates.splice(index, 1);
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.template_id === templateId) history.splice(i, 1);
  }
  return {
    template_id: row.id,
    name: row.name,
    pdf_sha256: row.pdf_sha256,
    file_still_used:
      templates.some((t) => t.company_id === companyId && t.pdf_sha256 === row.pdf_sha256) ||
      history.some((h) => h.company_id === companyId && h.pdf_sha256 === row.pdf_sha256),
  };
}

/** Rows the demo company has here, for the delete-company preview. */
export function demoPdfTemplateCounts(companyId: string) {
  return {
    pdfTemplates: templates.filter((t) => t.company_id === companyId).length,
    pdfTemplateRevisions: history.filter((h) => h.company_id === companyId).length,
  };
}

/** Removes everything a deleted demo company had here. Also used by tests to start clean. */
export function demoForgetPdfTemplates(companyId?: string): void {
  for (const rows of [templates, history] as { company_id: string }[][]) {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (companyId === undefined || rows[i]!.company_id === companyId) rows.splice(i, 1);
    }
  }
  for (const key of [...files.keys()]) {
    if (companyId === undefined || key.startsWith(`${companyId}/`)) files.delete(key);
  }
}
