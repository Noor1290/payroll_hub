import type { Member, MemberChange, MemberRole } from "@/lib/supabase/members";
import { demoMemberships } from "./demoData";

/**
 * FAKE members for dev-only demo mode. It follows the rules of migration
 * 0021_company_members.sql: an existing user only, the last admin stays, an admin cannot remove
 * or demote themselves, and every change is recorded. Everything here is invented and lives in
 * memory. Only reachable behind `import.meta.env.DEV`.
 */

const DEMO_USER_ID = "00000000-0000-4000-8000-000000000001";
const DEMO_EMAIL = "demo@example.com";
/** The accounts that exist, besides the demo user's. */
const ACCOUNTS: Record<string, string> = {
  "viewer@example.com": "00000000-0000-4000-8000-0000000000b1",
  "second@example.com": "00000000-0000-4000-8000-0000000000b2",
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message: string, code: string) => Object.assign(new Error(message), { code });

const members = new Map<string, Member[]>();
const changes: (MemberChange & { company_id: string })[] = [];

function membersOf(companyId: string): Member[] {
  let list = members.get(companyId);
  if (!list) {
    const mine = demoMemberships.find((m) => m.company.id === companyId);
    list = mine
      ? [
          {
            user_id: DEMO_USER_ID,
            email: DEMO_EMAIL,
            role: mine.role === "admin" ? "admin" : "viewer",
            added_at: "2026-01-05T09:00:00.000Z",
          },
        ]
      : [];
    members.set(companyId, list);
  }
  return list;
}

function record(companyId: string, change: Omit<MemberChange, "id" | "changed_by_email" | "changed_at">) {
  changes.unshift({
    ...change,
    company_id: companyId,
    id: changes.length + 1,
    changed_by_email: DEMO_EMAIL,
    changed_at: new Date().toISOString(),
  });
}

function refuseChange(list: Member[], member: Member) {
  if (member.role === "admin" && list.filter((one) => one.role === "admin").length === 1) {
    throw fail("PH_LAST_ADMIN", "P0001");
  }
  if (member.user_id === DEMO_USER_ID) throw fail("PH_NOT_YOURSELF", "P0001");
}

const find = (list: Member[], userId: string) => {
  const member = list.find((one) => one.user_id === userId);
  if (!member) throw fail("PH_NOT_FOUND", "P0002");
  return member;
};

export async function demoFetchMembers(companyId: string): Promise<Member[]> {
  await pause(150);
  return structuredClone(membersOf(companyId));
}

export async function demoFetchMemberChanges(companyId: string): Promise<MemberChange[]> {
  await pause(150);
  return structuredClone(changes.filter((one) => one.company_id === companyId));
}

export async function demoAddMember(
  companyId: string,
  email: string,
  role: MemberRole,
): Promise<void> {
  await pause(200);
  const wanted = email.trim().toLowerCase();
  const userId = wanted === DEMO_EMAIL ? DEMO_USER_ID : ACCOUNTS[wanted];
  if (!userId) throw fail("PH_NO_ACCOUNT", "P0002");
  const list = membersOf(companyId);
  if (list.some((one) => one.user_id === userId)) throw fail("PH_ALREADY_MEMBER", "23505");
  list.push({ user_id: userId, email: wanted, role, added_at: new Date().toISOString() });
  record(companyId, { action: "added", member_email: wanted, old_role: null, new_role: role });
}

export async function demoSetMemberRole(
  companyId: string,
  userId: string,
  role: MemberRole,
): Promise<void> {
  await pause(200);
  const list = membersOf(companyId);
  const member = find(list, userId);
  if (member.role === role) throw fail("PH_SAME_ROLE", "P0001");
  if (member.role === "admin") refuseChange(list, member);
  record(companyId, {
    action: "role-changed",
    member_email: member.email,
    old_role: member.role,
    new_role: role,
  });
  member.role = role;
}

export async function demoRemoveMember(companyId: string, userId: string): Promise<void> {
  await pause(200);
  const list = membersOf(companyId);
  const member = find(list, userId);
  refuseChange(list, member);
  list.splice(list.indexOf(member), 1);
  record(companyId, {
    action: "removed",
    member_email: member.email,
    old_role: member.role,
    new_role: null,
  });
}
