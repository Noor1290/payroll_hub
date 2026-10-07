import { z } from "zod";
import {
  demoFetchTemplateDraft,
  demoFetchTemplates,
  demoFetchTemplateVersion,
  demoPublishTemplate,
  demoSaveTemplateDraft,
} from "@/lib/demo/demoAppData";
import { supabase } from "./client";
import { NotConfiguredError } from "./errors";
import type { Viewer } from "./queries";

/**
 * Payslip templates (migration 0010_payslip_templates.sql): a draft per template, and the
 * versions that were published. A body is layout and labels, never payroll figures.
 * Members read; admins save a draft and publish, only through the two database functions.
 */

/** The file the owner runs to set this up; named in messages when the tables are not there. */
export const TEMPLATES_MIGRATION = "0010_payslip_templates.sql";

/** A company never has more than this (the function refuses the next one). */
const MAX_TEMPLATES = 50;

const bodySchema = z.record(z.string(), z.unknown());

const summarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  draft_revision: z.number().int().min(1),
  updated_by: z.uuid().nullable(),
  updated_at: z.string(),
});
const latestSchema = z.object({ version: z.number().int().min(1), published_at: z.string() });

/** A template without its body, with its latest published version when it has one. */
export type TemplateSummary = z.infer<typeof summarySchema> & {
  published: z.infer<typeof latestSchema> | null;
};

const draftSchema = summarySchema.extend({ draft_body: bodySchema });
export type TemplateDraft = z.infer<typeof draftSchema>;

const versionSchema = z.object({
  template_id: z.uuid(),
  version: z.number().int().min(1),
  name: z.string(),
  body: bodySchema,
  published_by: z.uuid().nullable(),
  published_at: z.string(),
});
export type TemplateVersion = z.infer<typeof versionSchema>;

const savedDraftSchema = z.object({
  template_id: z.uuid(),
  name: z.string(),
  draft_revision: z.number().int().min(1),
  updated_at: z.string(),
});
export type SavedDraft = z.infer<typeof savedDraftSchema>;

const publishedSchema = z.object({
  template_id: z.uuid(),
  version: z.number().int().min(1),
  draft_revision: z.number().int().min(1),
  published_at: z.string(),
});
export type PublishedTemplate = z.infer<typeof publishedSchema>;

export interface DraftInput {
  /** Null for a new template. */
  templateId: string | null;
  name: string;
  body: Record<string, unknown>;
  /** The draft revision the caller last saw; 0 for a new template. */
  expectedRevision: number;
}

const SUMMARY_COLUMNS = "id, name, draft_revision, updated_by, updated_at";

/** A company's templates by name, without their bodies. */
export async function fetchTemplates(
  viewer: Viewer,
  companyId: string,
): Promise<TemplateSummary[]> {
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchTemplates(companyId);
  if (!supabase) throw new NotConfiguredError();
  const client = supabase;

  const { data, error } = await client
    .from("payslip_templates")
    .select(SUMMARY_COLUMNS)
    .eq("company_id", companyId)
    .order("name", { ascending: true })
    .range(0, MAX_TEMPLATES - 1);
  if (error) throw error;
  const templates = z.array(summarySchema).parse(data);

  // One small read per template: a single read of every version could be cut short by the
  // API's row limit and then name an older version as the latest.
  return Promise.all(
    templates.map(async (template) => {
      const latest = await client
        .from("payslip_template_versions")
        .select("version, published_at")
        .eq("company_id", companyId)
        .eq("template_id", template.id)
        .order("version", { ascending: false })
        .limit(1);
      if (latest.error) throw latest.error;
      return { ...template, published: z.array(latestSchema).parse(latest.data)[0] ?? null };
    }),
  );
}

/** One template's draft, body included. Null when this company has no such template. */
export async function fetchTemplateDraft(
  viewer: Viewer,
  companyId: string,
  templateId: string,
): Promise<TemplateDraft | null> {
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchTemplateDraft(companyId, templateId);
  if (!supabase) throw new NotConfiguredError();

  const { data, error } = await supabase
    .from("payslip_templates")
    .select(`${SUMMARY_COLUMNS}, draft_body`)
    .eq("company_id", companyId)
    .eq("id", templateId)
    .maybeSingle();
  if (error) throw error;
  return draftSchema.nullable().parse(data);
}

/** One published version, body included. Null when this company has no such version. */
export async function fetchTemplateVersion(
  viewer: Viewer,
  companyId: string,
  templateId: string,
  version: number,
): Promise<TemplateVersion | null> {
  if (import.meta.env.DEV && viewer.isDemo) {
    return demoFetchTemplateVersion(companyId, templateId, version);
  }
  if (!supabase) throw new NotConfiguredError();

  const { data, error } = await supabase
    .from("payslip_template_versions")
    .select("template_id, version, name, body, published_by, published_at")
    .eq("company_id", companyId)
    .eq("template_id", templateId)
    .eq("version", version)
    .maybeSingle();
  if (error) throw error;
  return versionSchema.nullable().parse(data);
}

/**
 * Creates a template or saves over its draft through `save_payslip_template_draft`. The
 * database decides: admin of that company, name unique in it, body within its limit, and
 * `expectedRevision` still the current one (PH_STALE otherwise, never an overwrite).
 */
export async function saveTemplateDraft(
  viewer: Viewer,
  companyId: string,
  input: DraftInput,
): Promise<SavedDraft> {
  if (import.meta.env.DEV && viewer.isDemo) return demoSaveTemplateDraft(companyId, input);
  if (!supabase) throw new NotConfiguredError();

  const { data, error } = await supabase.rpc("save_payslip_template_draft", {
    p_company_id: companyId,
    p_template_id: input.templateId,
    p_name: input.name,
    p_body: input.body,
    p_expected_revision: input.expectedRevision,
  });
  if (error) throw error;
  return savedDraftSchema.parse(data);
}

/** Publishes the draft the caller last saw as the next version, through the database function. */
export async function publishTemplate(
  viewer: Viewer,
  companyId: string,
  templateId: string,
  expectedRevision: number,
): Promise<PublishedTemplate> {
  if (import.meta.env.DEV && viewer.isDemo) {
    return demoPublishTemplate(companyId, templateId, expectedRevision);
  }
  if (!supabase) throw new NotConfiguredError();

  const { data, error } = await supabase.rpc("publish_payslip_template", {
    p_company_id: companyId,
    p_template_id: templateId,
    p_expected_revision: expectedRevision,
  });
  if (error) throw error;
  return publishedSchema.parse(data);
}
