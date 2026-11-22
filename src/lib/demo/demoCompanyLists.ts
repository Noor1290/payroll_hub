import type { ListChange, ListRow, SavedLists } from "@/lib/supabase/companyLists";
import { demoMemberships } from "./demoData";

/**
 * FAKE company lists for dev-only demo mode and the dashboard's own tests. It follows the rules
 * of migration 0024: every company starts switched off; a save is all or nothing and needs an
 * admin of every company it names. Everything here lives in memory. Only reachable behind
 * `import.meta.env.DEV`.
 */

let rows: ListRow[] = [];

const pause = () => new Promise((resolve) => setTimeout(resolve, 120));
const isAdmin = (companyId: string) =>
  demoMemberships.some((m) => m.company.id === companyId && m.role === "admin");
const isMember = (companyId: string) => demoMemberships.some((m) => m.company.id === companyId);

/** Forgets every list. For tests. */
export function resetDemoCompanyLists(): void {
  rows = [];
}

export async function demoFetchCompanyLists(companyIds: string[]): Promise<ListRow[]> {
  await pause();
  const wanted = new Set(companyIds.filter(isMember));
  return rows.filter((row) => wanted.has(row.company_id)).map((row) => ({ ...row }));
}

export async function demoSaveCompanyLists(changes: readonly ListChange[]): Promise<SavedLists> {
  await pause();
  if (changes.some((one) => !isAdmin(one.companyId))) {
    throw Object.assign(new Error("PH_NOT_ADMIN"), { code: "42501" });
  }
  const key = (companyId: string, list: string) => `${companyId}/${list}`;
  if (new Set(changes.map((one) => key(one.companyId, one.list))).size !== changes.length) {
    throw Object.assign(new Error("PH_INVALID_INPUT"), { code: "22023" });
  }
  let added = 0;
  let removed = 0;
  for (const one of changes) {
    const at = rows.findIndex((row) => row.company_id === one.companyId && row.list === one.list);
    if (one.on && at === -1) {
      rows.push({ company_id: one.companyId, list: one.list });
      added += 1;
    } else if (!one.on && at !== -1) {
      rows.splice(at, 1);
      removed += 1;
    }
  }
  return { added, removed };
}
