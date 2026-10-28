import { z } from "zod";
import {
  demoAttachMraTemplate,
  demoDetachMraTemplate,
  demoFetchMraCompanyDetails,
  demoFetchMraSettings,
  demoFetchMraTemplate,
  demoFetchMraTemplateAccess,
  demoFetchMraTemplateHistory,
  demoFetchMraTemplateLinks,
  demoFetchMraTemplateRevision,
  demoSaveMraCompanyDetails,
  demoSaveMraSettings,
  demoSaveMraTemplate,
  demoSaveMraTemplateValues,
} from "@/lib/demo/demoMraReturns";
import { supabase } from "./client";
import { NotConfiguredError } from "./errors";
import type { Viewer } from "./queries";

/**
 * MRA Returns (migration 0020_mra_returns.sql):
 *
 *  - mra_templates (and mra_template_history, every revision): the app's templates of a
 *    return file. Read by an ADMIN of a company using one; changed only by an admin of EVERY
 *    company using it.
 *  - mra_template_companies: which companies use a template, each with its own values. Read and
 *    changed by that company's admins.
 *  - mra_company_details: a company's ERN, telephone, mobile and declarant. Admins only.
 *  - mra_settings: the signed-in user's email for the returns. That user only.
 *
 * The body and the own values are the app's JSON, stored and returned exactly as sent. Nothing
 * here looks inside them. Writes go only through the database functions.
 */

/** The file the owner runs to set this up; named in messages when it has not been run. */
export const MRA_MIGRATION = "0020_mra_returns.sql";

/** How many revisions one history answer lists, newest first. All are kept in the database. */
const HISTORY_PAGE = 200;

const objectSchema = z.record(z.string(), z.unknown());

const templateSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  body: objectSchema,
  revision: z.number().int().min(1),
  updated_by: z.uuid().nullable(),
  updated_at: z.string(),
});
export type MraTemplate = z.infer<typeof templateSchema>;

const linkSchema = z.object({
  template_id: z.uuid(),
  company_id: z.uuid(),
  own_values: objectSchema,
  revision: z.number().int().min(1),
  updated_by: z.uuid().nullable(),
  updated_at: z.string(),
});
/** A company's use of a template, with its own values. */
export type MraTemplateLink = z.infer<typeof linkSchema>;

const accessSchema = z.object({
  can_change: z.boolean(),
  companies: z.number().int().min(0),
  admin_of: z.number().int().min(0),
});
export type MraTemplateAccess = z.infer<typeof accessSchema>;

const revisionSchema = z.object({
  revision: z.number().int().min(1),
  name: z.string(),
  saved_by: z.uuid().nullable(),
  saved_at: z.string(),
});
export type MraTemplateRevision = z.infer<typeof revisionSchema>;

const keptSchema = revisionSchema.extend({ body: objectSchema });
export type KeptMraTemplate = z.infer<typeof keptSchema>;

const detailsSchema = z.object({
  company_id: z.uuid(),
  ern: z.string(),
  telephone: z.string(),
  mobile: z.string(),
  declarant: z.string(),
  revision: z.number().int().min(1),
  updated_at: z.string(),
});
export type MraCompanyDetails = z.infer<typeof detailsSchema>;

const settingsSchema = z.object({
  email: z.string(),
  revision: z.number().int().min(1),
  updated_at: z.string(),
});
export type MraSettings = z.infer<typeof settingsSchema>;

const savedTemplateSchema = z.object({
  template_id: z.uuid(),
  name: z.string(),
  revision: z.number().int().min(1),
  updated_at: z.string(),
});
export type SavedMraTemplate = z.infer<typeof savedTemplateSchema>;

const savedLinkSchema = z.object({
  template_id: z.uuid(),
  company_id: z.uuid(),
  revision: z.number().int().min(1),
  updated_at: z.string(),
});
export type SavedMraTemplateLink = z.infer<typeof savedLinkSchema>;

const detachedSchema = z.object({ template_id: z.uuid(), name: z.string(), deleted: z.boolean() });
export type DetachedMraTemplate = z.infer<typeof detachedSchema>;

export interface MraTemplateInput {
  /** Chosen by the app, so a save that is sent twice cannot make two templates. */
  templateId: string;
  /** The company the user is working in: a new template is made for it. */
  companyId: string;
  name: string;
  body: Record<string, unknown>;
  /** The revision the caller last saw; 0 for a new template. */
  expectedRevision: number;
}

export interface MraDetailsInput {
  ern: string;
  telephone: string;
  mobile: string;
  declarant: string;
  /** The revision the caller last saw; 0 when the company has none yet. */
  expectedRevision: number;
}

const TEMPLATE_COLUMNS = "id, name, body, revision, updated_by, updated_at";
const LINK_COLUMNS = "template_id, company_id, own_values, revision, updated_by, updated_at";

function client() {
  if (!supabase) throw new NotConfiguredError();
  return supabase;
}

// ---------- reading ----------

/** The templates these companies use, with each company's own values. Admins only (RLS). */
export async function fetchMraTemplateLinks(
  viewer: Viewer,
  companyIds: string[],
): Promise<MraTemplateLink[]> {
  if (companyIds.length === 0) return [];
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchMraTemplateLinks(companyIds);
  const { data, error } = await client()
    .from("mra_template_companies")
    .select(LINK_COLUMNS)
    .in("company_id", companyIds)
    .order("template_id", { ascending: true })
    .range(0, 999);
  if (error) throw error;
  return z.array(linkSchema).parse(data);
}

/** Templates by id, bodies included. The ones the caller may not read are left out. */
export async function fetchMraTemplates(viewer: Viewer, ids: string[]): Promise<MraTemplate[]> {
  if (ids.length === 0) return [];
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchMraTemplate(ids);
  const { data, error } = await client()
    .from("mra_templates")
    .select(TEMPLATE_COLUMNS)
    .in("id", ids)
    .order("name", { ascending: true });
  if (error) throw error;
  return z.array(templateSchema).parse(data);
}

/** Whether the caller may change a template, and the counts the app shows when not. */
export async function fetchMraTemplateAccess(
  viewer: Viewer,
  templateId: string,
): Promise<MraTemplateAccess> {
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchMraTemplateAccess(templateId);
  const { data, error } = await client().rpc("mra_template_access", { p_template_id: templateId });
  if (error) throw error;
  return accessSchema.parse(data);
}

/** A template's kept revisions, newest first, without their bodies. */
export async function fetchMraTemplateHistory(
  viewer: Viewer,
  templateId: string,
): Promise<MraTemplateRevision[]> {
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchMraTemplateHistory(templateId);
  const { data, error } = await client()
    .from("mra_template_history")
    .select("revision, name, saved_by, saved_at")
    .eq("template_id", templateId)
    .order("revision", { ascending: false })
    .range(0, HISTORY_PAGE - 1);
  if (error) throw error;
  return z.array(revisionSchema).parse(data);
}

/** One kept revision, body included. Null when there is no such revision for the caller. */
export async function fetchMraTemplateRevision(
  viewer: Viewer,
  templateId: string,
  revision: number,
): Promise<KeptMraTemplate | null> {
  if (import.meta.env.DEV && viewer.isDemo) {
    return demoFetchMraTemplateRevision(templateId, revision);
  }
  const { data, error } = await client()
    .from("mra_template_history")
    .select("revision, name, saved_by, saved_at, body")
    .eq("template_id", templateId)
    .eq("revision", revision)
    .maybeSingle();
  if (error) throw error;
  return keptSchema.nullable().parse(data);
}

/** A company's MRA details. Null when none are saved yet (or the caller is not its admin). */
export async function fetchMraCompanyDetails(
  viewer: Viewer,
  companyId: string,
): Promise<MraCompanyDetails | null> {
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchMraCompanyDetails(companyId);
  const { data, error } = await client()
    .from("mra_company_details")
    .select("company_id, ern, telephone, mobile, declarant, revision, updated_at")
    .eq("company_id", companyId)
    .maybeSingle();
  if (error) throw error;
  return detailsSchema.nullable().parse(data);
}

/** The signed-in user's email for the MRA returns. Null when none is saved yet. */
export async function fetchMraSettings(viewer: Viewer): Promise<MraSettings | null> {
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchMraSettings();
  const { data, error } = await client()
    .from("mra_settings")
    .select("email, revision, updated_at")
    .eq("user_id", viewer.id)
    .maybeSingle();
  if (error) throw error;
  return settingsSchema.nullable().parse(data);
}

// ---------- saving ----------

/**
 * Makes a template for a company, or saves over one, through `save_mra_template`. The database
 * decides who may (an admin of every company using it) and refuses an old revision (PH_STALE).
 */
export async function saveMraTemplate(
  viewer: Viewer,
  input: MraTemplateInput,
): Promise<SavedMraTemplate> {
  if (import.meta.env.DEV && viewer.isDemo) return demoSaveMraTemplate(input);
  const { data, error } = await client().rpc("save_mra_template", {
    p_template_id: input.templateId,
    p_company_id: input.companyId,
    p_name: input.name,
    p_body: input.body,
    p_expected_revision: input.expectedRevision,
  });
  if (error) throw error;
  return savedTemplateSchema.parse(data);
}

/** Saves a company's own values for a template, through `save_mra_template_values`. */
export async function saveMraTemplateValues(
  viewer: Viewer,
  templateId: string,
  companyId: string,
  values: Record<string, unknown>,
  expectedRevision: number,
): Promise<SavedMraTemplateLink> {
  if (import.meta.env.DEV && viewer.isDemo) {
    return demoSaveMraTemplateValues(templateId, companyId, values, expectedRevision);
  }
  const { data, error } = await client().rpc("save_mra_template_values", {
    p_template_id: templateId,
    p_company_id: companyId,
    p_own_values: values,
    p_expected_revision: expectedRevision,
  });
  if (error) throw error;
  return savedLinkSchema.parse(data);
}

/** Uses a template in another company too, through `attach_mra_template`. */
export async function attachMraTemplate(
  viewer: Viewer,
  templateId: string,
  companyId: string,
  values: Record<string, unknown>,
): Promise<SavedMraTemplateLink> {
  if (import.meta.env.DEV && viewer.isDemo)
    return demoAttachMraTemplate(templateId, companyId, values);
  const { data, error } = await client().rpc("attach_mra_template", {
    p_template_id: templateId,
    p_company_id: companyId,
    p_own_values: values,
  });
  if (error) throw error;
  return savedLinkSchema.parse(data);
}

/**
 * Takes a template out of a company, through `detach_mra_template`. From the last company using
 * it, that deletes the template and its history for good (`deleted: true`).
 */
export async function detachMraTemplate(
  viewer: Viewer,
  templateId: string,
  companyId: string,
  expectedRevision: number,
): Promise<DetachedMraTemplate> {
  if (import.meta.env.DEV && viewer.isDemo) {
    return demoDetachMraTemplate(templateId, companyId, expectedRevision);
  }
  const { data, error } = await client().rpc("detach_mra_template", {
    p_template_id: templateId,
    p_company_id: companyId,
    p_expected_revision: expectedRevision,
  });
  if (error) throw error;
  return detachedSchema.parse(data);
}

/** Saves a company's MRA details through `save_mra_company_details`. */
export async function saveMraCompanyDetails(
  viewer: Viewer,
  companyId: string,
  input: MraDetailsInput,
): Promise<MraCompanyDetails> {
  if (import.meta.env.DEV && viewer.isDemo) return demoSaveMraCompanyDetails(companyId, input);
  const { data, error } = await client().rpc("save_mra_company_details", {
    p_company_id: companyId,
    p_ern: input.ern,
    p_telephone: input.telephone,
    p_mobile: input.mobile,
    p_declarant: input.declarant,
    p_expected_revision: input.expectedRevision,
  });
  if (error) throw error;
  return detailsSchema.parse(data);
}

/** Saves the signed-in user's email for the MRA returns through `save_mra_settings`. */
export async function saveMraSettings(
  viewer: Viewer,
  email: string,
  expectedRevision: number,
): Promise<MraSettings> {
  if (import.meta.env.DEV && viewer.isDemo) return demoSaveMraSettings(email, expectedRevision);
  const { data, error } = await client().rpc("save_mra_settings", {
    p_email: email,
    p_expected_revision: expectedRevision,
  });
  if (error) throw error;
  return settingsSchema.parse(data);
}
