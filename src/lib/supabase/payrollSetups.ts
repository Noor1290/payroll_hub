import { z } from "zod";
import {
  demoAttachPayrollCompany,
  demoFetchAttachedCompanySetups,
  demoFetchCompanySetup,
  demoFetchCompanySetupLinks,
  demoFetchSetupHistory,
  demoFetchSetupRevision,
  demoFetchSharedSetup,
  demoFetchSharedSetupAccess,
  demoSaveCompanySetup,
  demoSaveSharedSetup,
} from "@/lib/demo/demoPayrollSetups";
import { supabase } from "./client";
import { NotConfiguredError } from "./errors";
import type { Viewer } from "./queries";

/**
 * The payroll app's column setup (migration 0013_payroll_setups.sql):
 *
 *  - payroll_shared_setups: one shared setup (identity fields, the ID field, the Global
 *    columns) that companies are attached to. Read by any member of an attached company;
 *    changed only by an admin of EVERY attached company.
 *  - payroll_company_setups: one row per company, naming its shared setup and holding the
 *    company's own columns and details. Members read, admins save.
 *  - their history tables: every revision ever saved, none dropped.
 *
 * Both bodies are the payroll app's own JSON, stored and returned exactly as sent. Nothing
 * here looks inside them. Writes go only through the database functions.
 */

/** The file the owner runs to set this up; named in messages when it has not been run. */
export const PAYROLL_SETUPS_MIGRATION = "0013_payroll_setups.sql";

/** How many revisions one history answer lists, newest first. All are kept in the database. */
const HISTORY_PAGE = 200;

const bodySchema = z.record(z.string(), z.unknown());

const sharedSetupSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  body: bodySchema,
  revision: z.number().int().min(1),
  updated_by: z.uuid().nullable(),
  updated_at: z.string(),
});
export type SharedSetup = z.infer<typeof sharedSetupSchema>;

const companySetupSchema = z.object({
  company_id: z.uuid(),
  shared_setup_id: z.uuid(),
  body: bodySchema,
  revision: z.number().int().min(1),
  updated_by: z.uuid().nullable(),
  updated_at: z.string(),
});
export type CompanySetup = z.infer<typeof companySetupSchema>;

const linkSchema = z.object({ company_id: z.uuid(), shared_setup_id: z.uuid() });
export type CompanySetupLink = z.infer<typeof linkSchema>;

const accessSchema = z.object({
  can_change: z.boolean(),
  companies: z.number().int().min(0),
  admin_of: z.number().int().min(0),
});
export type SharedSetupAccess = z.infer<typeof accessSchema>;

const revisionSchema = z.object({
  revision: z.number().int().min(1),
  saved_by: z.uuid().nullable(),
  saved_at: z.string(),
});
export type SetupRevision = z.infer<typeof revisionSchema>;

const keptRevisionSchema = revisionSchema.extend({
  body: bodySchema,
  /** A company's revision: which shared setup the company was attached to when it was saved. */
  shared_setup_id: z.uuid().optional(),
});
export type KeptSetupRevision = z.infer<typeof keptRevisionSchema>;

const savedSharedSchema = z.object({
  shared_setup_id: z.uuid(),
  name: z.string(),
  revision: z.number().int().min(1),
  updated_at: z.string(),
  companies: z.array(z.object({ company_id: z.uuid(), revision: z.number().int().min(1) })),
});
export type SavedSharedSetup = z.infer<typeof savedSharedSchema>;

const savedCompanySchema = z.object({
  company_id: z.uuid(),
  shared_setup_id: z.uuid(),
  revision: z.number().int().min(1),
  updated_at: z.string(),
});
export type SavedCompanySetup = z.infer<typeof savedCompanySchema>;

export interface SharedSetupInput {
  /** Chosen by the app, so a save that is sent twice cannot make two setups. */
  setupId: string;
  name: string;
  body: Record<string, unknown>;
  /** The revision the caller last saw; 0 for a new shared setup. */
  expectedRevision: number;
  /** Attached companies whose own setups change in the same step, all or nothing. */
  companies: { companyId: string; body: Record<string, unknown>; expectedRevision: number }[];
}

/** Which of the two kinds of setup a history or revision is about. */
export type SetupTarget = { kind: "shared"; id: string } | { kind: "company"; id: string };

const SHARED_COLUMNS = "id, name, body, revision, updated_by, updated_at";
const COMPANY_COLUMNS = "company_id, shared_setup_id, body, revision, updated_by, updated_at";

function client() {
  if (!supabase) throw new NotConfiguredError();
  return supabase;
}

// ---------- reading ----------

/** A company's own setup. Null when it has none (it is not attached to a shared setup yet). */
export async function fetchCompanySetup(
  viewer: Viewer,
  companyId: string,
): Promise<CompanySetup | null> {
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchCompanySetup(companyId);
  const { data, error } = await client()
    .from("payroll_company_setups")
    .select(COMPANY_COLUMNS)
    .eq("company_id", companyId)
    .maybeSingle();
  if (error) throw error;
  return companySetupSchema.nullable().parse(data);
}

/** Which shared setup each of these companies is attached to, for those that are. */
export async function fetchCompanySetupLinks(
  viewer: Viewer,
  companyIds: string[],
): Promise<CompanySetupLink[]> {
  if (companyIds.length === 0) return [];
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchCompanySetupLinks(companyIds);
  const { data, error } = await client()
    .from("payroll_company_setups")
    .select("company_id, shared_setup_id")
    .in("company_id", companyIds);
  if (error) throw error;
  return z.array(linkSchema).parse(data);
}

/** A shared setup. Null when there is none, or the caller may not read it. */
export async function fetchSharedSetup(
  viewer: Viewer,
  setupId: string,
): Promise<SharedSetup | null> {
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchSharedSetup(setupId);
  const { data, error } = await client()
    .from("payroll_shared_setups")
    .select(SHARED_COLUMNS)
    .eq("id", setupId)
    .maybeSingle();
  if (error) throw error;
  return sharedSetupSchema.nullable().parse(data);
}

/**
 * The own setups of the companies attached to a shared setup that the caller is a member of.
 * Companies the caller is not a member of stay out (row level security).
 */
export async function fetchAttachedCompanySetups(
  viewer: Viewer,
  setupId: string,
): Promise<CompanySetup[]> {
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchAttachedCompanySetups(setupId);
  const { data, error } = await client()
    .from("payroll_company_setups")
    .select(COMPANY_COLUMNS)
    .eq("shared_setup_id", setupId)
    .order("company_id", { ascending: true })
    .range(0, 199);
  if (error) throw error;
  return z.array(companySetupSchema).parse(data);
}

/** Whether the caller may change a shared setup, and the counts the app shows when not. */
export async function fetchSharedSetupAccess(
  viewer: Viewer,
  setupId: string,
): Promise<SharedSetupAccess> {
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchSharedSetupAccess(setupId);
  const { data, error } = await client().rpc("payroll_shared_setup_access", {
    p_setup_id: setupId,
  });
  if (error) throw error;
  return accessSchema.parse(data);
}

/** The kept revisions of a setup, newest first, without their bodies. */
export async function fetchSetupHistory(
  viewer: Viewer,
  target: SetupTarget,
): Promise<SetupRevision[]> {
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchSetupHistory(target);
  const query =
    target.kind === "shared"
      ? client()
          .from("payroll_shared_setup_history")
          .select("revision, saved_by, saved_at")
          .eq("shared_setup_id", target.id)
      : client()
          .from("payroll_company_setup_history")
          .select("revision, saved_by, saved_at")
          .eq("company_id", target.id);
  const { data, error } = await query
    .order("revision", { ascending: false })
    .range(0, HISTORY_PAGE - 1);
  if (error) throw error;
  return z.array(revisionSchema).parse(data);
}

/** One kept revision, body included. Null when there is no such revision for the caller. */
export async function fetchSetupRevision(
  viewer: Viewer,
  target: SetupTarget,
  revision: number,
): Promise<KeptSetupRevision | null> {
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchSetupRevision(target, revision);
  const query =
    target.kind === "shared"
      ? client()
          .from("payroll_shared_setup_history")
          .select("revision, saved_by, saved_at, body")
          .eq("shared_setup_id", target.id)
      : client()
          .from("payroll_company_setup_history")
          .select("revision, saved_by, saved_at, body, shared_setup_id")
          .eq("company_id", target.id);
  const { data, error } = await query.eq("revision", revision).maybeSingle();
  if (error) throw error;
  return keptRevisionSchema.nullable().parse(data);
}

// ---------- saving ----------

/**
 * Creates a shared setup or saves over it through `save_payroll_shared_setup`, with any
 * company setups that change in the same step. The database decides who may (an admin of
 * every attached company) and refuses an old revision (PH_STALE), never overwriting.
 */
export async function saveSharedSetup(
  viewer: Viewer,
  input: SharedSetupInput,
): Promise<SavedSharedSetup> {
  if (import.meta.env.DEV && viewer.isDemo) return demoSaveSharedSetup(input);
  const { data, error } = await client().rpc("save_payroll_shared_setup", {
    p_setup_id: input.setupId,
    p_name: input.name,
    p_body: input.body,
    p_expected_revision: input.expectedRevision,
    p_companies: input.companies.map((company) => ({
      company_id: company.companyId,
      body: company.body,
      expected_revision: company.expectedRevision,
    })),
  });
  if (error) throw error;
  return savedSharedSchema.parse(data);
}

/** Saves over a company's own setup through `save_payroll_company_setup`. */
export async function saveCompanySetup(
  viewer: Viewer,
  companyId: string,
  body: Record<string, unknown>,
  expectedRevision: number,
): Promise<SavedCompanySetup> {
  if (import.meta.env.DEV && viewer.isDemo) {
    return demoSaveCompanySetup(companyId, body, expectedRevision);
  }
  const { data, error } = await client().rpc("save_payroll_company_setup", {
    p_company_id: companyId,
    p_body: body,
    p_expected_revision: expectedRevision,
  });
  if (error) throw error;
  return savedCompanySchema.parse(data);
}

/** Attaches a company to a shared setup, with its own setup, through `attach_payroll_company`. */
export async function attachCompany(
  viewer: Viewer,
  companyId: string,
  setupId: string,
  body: Record<string, unknown>,
): Promise<SavedCompanySetup> {
  if (import.meta.env.DEV && viewer.isDemo)
    return demoAttachPayrollCompany(companyId, setupId, body);
  const { data, error } = await client().rpc("attach_payroll_company", {
    p_company_id: companyId,
    p_shared_setup_id: setupId,
    p_body: body,
  });
  if (error) throw error;
  return savedCompanySchema.parse(data);
}
