import { z } from "zod";
import { demoFetchCompanyLists, demoSaveCompanyLists } from "@/lib/demo/demoCompanyLists";
import { supabase } from "./client";
import { NotConfiguredError } from "./errors";
import type { Viewer } from "./queries";

/**
 * Which app each company is used in (migration 0024_company_lists_and_status.sql):
 * public.company_app_lists holds one row per company and list it is switched ON in; no row is
 * off. Read by the company's members; changed only through set_company_app_lists, all or
 * nothing, by an admin of every company it names. A convenience only: it hides a company from
 * an app's list and changes nobody's access.
 */

/** The file the owner runs to set this up; named in messages when it has not been run. */
export const COMPANY_LISTS_MIGRATION = "0024_company_lists_and_status.sql";

export const APP_LISTS = ["payroll", "payslips", "csg", "prgf"] as const;
export type AppList = (typeof APP_LISTS)[number];
export const appListSchema = z.enum(APP_LISTS);

/** At most this many changes in one save (the database's own limit). */
export const MAX_LIST_CHANGES = 2000;

/** One company switched on or off in one list. */
export interface ListChange {
  companyId: string;
  list: AppList;
  on: boolean;
}

const rowSchema = z.object({ company_id: z.uuid(), list: appListSchema });
export type ListRow = z.infer<typeof rowSchema>;

const savedSchema = z.object({
  added: z.number().int().min(0),
  removed: z.number().int().min(0),
});
export type SavedLists = z.infer<typeof savedSchema>;

function client() {
  if (!supabase) throw new NotConfiguredError();
  return supabase;
}

/** The lists these companies are switched on in. Members only (RLS): others come back empty. */
export async function fetchCompanyLists(viewer: Viewer, companyIds: string[]): Promise<ListRow[]> {
  if (companyIds.length === 0) return [];
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchCompanyLists(companyIds);
  const { data, error } = await client()
    .from("company_app_lists")
    .select("company_id, list")
    .in("company_id", companyIds)
    .order("company_id", { ascending: true })
    .range(0, 4 * companyIds.length);
  if (error) throw error;
  return z.array(rowSchema).parse(data);
}

/** Saves every change or none. The database refuses it unless the caller is admin of them all. */
export async function saveCompanyLists(
  viewer: Viewer,
  changes: readonly ListChange[],
): Promise<SavedLists> {
  if (changes.length === 0) return { added: 0, removed: 0 };
  if (changes.length > MAX_LIST_CHANGES) throw new Error("PH_TOO_LARGE");
  if (import.meta.env.DEV && viewer.isDemo) return demoSaveCompanyLists(changes);
  const { data, error } = await client().rpc("set_company_app_lists", {
    p_changes: changes.map((one) => ({ company_id: one.companyId, list: one.list, on: one.on })),
  });
  if (error) throw error;
  return savedSchema.parse(data);
}
