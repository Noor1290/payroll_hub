import { z } from "zod";
import {
  demoAddMember,
  demoFetchMemberChanges,
  demoFetchMembers,
  demoRemoveMember,
  demoSetMemberRole,
} from "@/lib/demo/demoMembers";
import { supabase } from "./client";
import { NotConfiguredError } from "./errors";
import type { Viewer } from "./queries";

/**
 * Who belongs to a company, and every change to that (migration 0021_company_members.sql). Admins
 * of that company only, checked in the database: company_members has no write grant, so every
 * change goes through a function, and each function records it in company_member_history.
 */

/** The file the owner runs to set this up; named in messages when it has not been run. */
export const MEMBERS_MIGRATION = "0021_company_members.sql";

/** How many changes the card lists, newest first. All are kept in the database. */
const CHANGES_SHOWN = 100;

export const MEMBER_ROLES = ["admin", "viewer"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

const roleSchema = z.enum(MEMBER_ROLES);

const memberSchema = z.object({
  user_id: z.uuid(),
  email: z.string(),
  role: roleSchema,
  added_at: z.string(),
});
export type Member = z.infer<typeof memberSchema>;

const changeSchema = z.object({
  id: z.number().int(),
  action: z.enum(["added", "role-changed", "removed"]),
  member_email: z.string(),
  old_role: roleSchema.nullable(),
  new_role: roleSchema.nullable(),
  changed_by_email: z.string(),
  changed_at: z.string(),
});
export type MemberChange = z.infer<typeof changeSchema>;

function client() {
  if (!supabase) throw new NotConfiguredError();
  return supabase;
}

export async function fetchMembers(viewer: Viewer, companyId: string): Promise<Member[]> {
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchMembers(companyId);
  const { data, error } = await client().rpc("list_company_members", { p_company_id: companyId });
  if (error) throw error;
  return z.array(memberSchema).parse(data);
}

/** The newest changes to a company's members. Row level security: its admins only. */
export async function fetchMemberChanges(
  viewer: Viewer,
  companyId: string,
): Promise<MemberChange[]> {
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchMemberChanges(companyId);
  const { data, error } = await client()
    .from("company_member_history")
    .select("id, action, member_email, old_role, new_role, changed_by_email, changed_at")
    .eq("company_id", companyId)
    .order("id", { ascending: false })
    .limit(CHANGES_SHOWN);
  if (error) throw error;
  return z.array(changeSchema).parse(data);
}

export async function addMember(
  viewer: Viewer,
  companyId: string,
  email: string,
  role: MemberRole,
): Promise<void> {
  if (import.meta.env.DEV && viewer.isDemo) return demoAddMember(companyId, email, role);
  const { error } = await client().rpc("add_company_member", {
    p_company_id: companyId,
    p_email: email,
    p_role: role,
  });
  if (error) throw error;
}

export async function setMemberRole(
  viewer: Viewer,
  companyId: string,
  userId: string,
  role: MemberRole,
): Promise<void> {
  if (import.meta.env.DEV && viewer.isDemo) return demoSetMemberRole(companyId, userId, role);
  const { error } = await client().rpc("set_company_member_role", {
    p_company_id: companyId,
    p_user_id: userId,
    p_role: role,
  });
  if (error) throw error;
}

export async function removeMember(
  viewer: Viewer,
  companyId: string,
  userId: string,
): Promise<void> {
  if (import.meta.env.DEV && viewer.isDemo) return demoRemoveMember(companyId, userId);
  const { error } = await client().rpc("remove_company_member", {
    p_company_id: companyId,
    p_user_id: userId,
  });
  if (error) throw error;
}
