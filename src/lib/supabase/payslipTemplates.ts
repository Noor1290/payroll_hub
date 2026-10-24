import { z } from "zod";
import {
  demoFetchRunColumns,
  demoFetchTemplateDraft,
  demoFetchTemplateInUse,
  demoFetchTemplates,
  demoFetchTemplateVersion,
  demoPublishTemplate,
  demoPublishTemplateCopy,
  demoSaveTemplateDraft,
  demoSetTemplateInUse,
} from "@/lib/demo/demoAppData";
import { supabase } from "./client";
import { isMissingTable, NotConfiguredError } from "./errors";
import type { Viewer } from "./queries";

/**
 * Payslip templates (migration 0010_payslip_templates.sql): a draft per template, and the
 * versions that were published. A body is layout and labels, never payroll figures.
 * Members read; admins save a draft and publish, only through the two database functions.
 */

/** The file the owner runs to set this up; named in messages when the tables are not there. */
export const TEMPLATES_MIGRATION = "0010_payslip_templates.sql";
/**
 * The one used for the payslips, publishing to several companies, and the column names of a
 * company's newest run (0018_payslip_template_in_use.sql).
 */
export const IN_USE_MIGRATION = "0018_payslip_template_in_use.sql";

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

const inUseSchema = z.object({ template_id: z.uuid(), version: z.number().int().min(1) });
export type TemplateInUse = z.infer<typeof inUseSchema>;

/**
 * The published version the company's payslips use (migration 0018), or null when none was
 * chosen. Against a database without 0018 it is null too: nothing can have been chosen there.
 */
export async function fetchTemplateInUse(
  viewer: Viewer,
  companyId: string,
): Promise<TemplateInUse | null> {
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchTemplateInUse(companyId);
  if (!supabase) throw new NotConfiguredError();

  const { data, error } = await supabase
    .from("payslip_template_in_use")
    .select("template_id, version")
    .eq("company_id", companyId)
    .limit(1);
  if (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
  return z.array(inUseSchema).parse(data)[0] ?? null;
}

const setInUseSchema = z.object({
  template_id: z.uuid().nullable(),
  version: z.number().int().min(1).nullable(),
});
export type SetInUse = z.infer<typeof setInUseSchema>;

/** Names the version used for the payslips, or clears it (both null), through the database function. */
export async function setTemplateInUse(
  viewer: Viewer,
  companyId: string,
  templateId: string | null,
  version: number | null,
): Promise<SetInUse> {
  if (import.meta.env.DEV && viewer.isDemo) {
    return demoSetTemplateInUse(companyId, templateId, version);
  }
  if (!supabase) throw new NotConfiguredError();

  const { data, error } = await supabase.rpc("set_payslip_template_in_use", {
    p_company_id: companyId,
    p_template_id: templateId,
    p_version: version,
  });
  if (error) throw error;
  return setInUseSchema.parse(data);
}

const copySchema = z.object({
  template_id: z.uuid(),
  name: z.string(),
  version: z.number().int().min(1),
  draft_revision: z.number().int().min(1),
  /** A new template was made in that company. */
  created: z.boolean(),
  /** A new version was added; false when its latest version already was exactly this. */
  published: z.boolean(),
  published_at: z.string(),
});
export type PublishedCopy = z.infer<typeof copySchema>;

export interface CopyInput {
  name: string;
  body: Record<string, unknown>;
  /** The draft revision of that company's template with this name when it was checked; 0 for none. */
  expectedRevision: number;
}

/**
 * Publishes a body to one company through `publish_payslip_template_copy`: its template with the
 * same name (capitals ignored) gets a new version, or a new template is made at version 1, and
 * that version becomes the one used for its payslips. All of it or nothing; the database checks
 * that the caller is an admin of that company.
 */
export async function publishTemplateCopy(
  viewer: Viewer,
  companyId: string,
  input: CopyInput,
): Promise<PublishedCopy> {
  if (import.meta.env.DEV && viewer.isDemo) return demoPublishTemplateCopy(companyId, input);
  if (!supabase) throw new NotConfiguredError();

  const { data, error } = await supabase.rpc("publish_payslip_template_copy", {
    p_company_id: companyId,
    p_name: input.name,
    p_body: input.body,
    p_expected_revision: input.expectedRevision,
  });
  if (error) throw error;
  return copySchema.parse(data);
}

const runColumnsSchema = z.object({
  /** "YYYY-MM-01" of the newest saved run, or null when the company has none. */
  period: z
    .string()
    .regex(/^\d{4}-\d{2}-01$/)
    .nullable(),
  employees: z.number().int().min(0),
  /** Key names only, never a value. */
  keys: z.array(z.string()),
});
export type RunColumns = z.infer<typeof runColumnsSchema>;

/**
 * The newest saved run's month, its number of employees and the names of the keys stored in its
 * entries' `extra`, through `payroll_run_columns`. The database checks the caller is an admin of
 * the company and returns names only, never a value.
 */
export async function fetchRunColumns(viewer: Viewer, companyId: string): Promise<RunColumns> {
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchRunColumns(companyId);
  if (!supabase) throw new NotConfiguredError();

  const { data, error } = await supabase.rpc("payroll_run_columns", { p_company_id: companyId });
  if (error) throw error;
  return runColumnsSchema.parse(data);
}
