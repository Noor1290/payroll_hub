import type {
  CompanySetup,
  CompanySetupLink,
  KeptSetupRevision,
  SavedCompanySetup,
  SavedSharedSetup,
  SetupRevision,
  SetupTarget,
  SharedSetup,
  SharedSetupAccess,
  SharedSetupInput,
} from "@/lib/supabase/payrollSetups";
import { demoMemberships } from "./demoData";

/**
 * FAKE payroll column setups for dev-only demo mode and the dashboard's own tests. They follow
 * the same rules as migration 0013_payroll_setups.sql: a shared setup is read by members of
 * an attached company and changed only by an admin of every attached company (before any is
 * attached: only its creator); a company's own setup is read by members and saved by admins;
 * every save names the revision last seen; a company is attached once; every revision is
 * kept. Everything here is invented and lives in memory. Only reachable behind
 * `import.meta.env.DEV`.
 */

const DEMO_USER_ID = "00000000-0000-4000-8000-000000000001";
/** Someone other than the demo user, for setups created "by another admin" in tests. */
export const DEMO_OTHER_USER_ID = "00000000-0000-4000-8000-0000000000ff";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message: string, code: string) => Object.assign(new Error(message), { code });

type StoredShared = SharedSetup & { created_by: string };
type Kept = SetupRevision & {
  body: Record<string, unknown>;
  key: string;
  shared_setup_id?: string;
};

const shared: StoredShared[] = [];
const companies: CompanySetup[] = [];
const history: Kept[] = [];

const roleIn = (companyId: string) =>
  demoMemberships.find((m) => m.company.id === companyId)?.role ?? null;
const attachedTo = (setupId: string) => companies.filter((c) => c.shared_setup_id === setupId);
const keyOf = (target: SetupTarget) => `${target.kind}:${target.id}`;
const copy = <T>(value: T): T => structuredClone(value);

/** A copy of a row without the columns an answer leaves out. */
function without<T extends object, K extends keyof T>(row: T, ...keys: K[]): Omit<T, K> {
  const out = copy(row);
  for (const key of keys) delete out[key];
  return out;
}

function canRead(setupId: string): boolean {
  const setup = shared.find((s) => s.id === setupId);
  if (!setup) return false;
  const attached = attachedTo(setupId);
  if (attached.length === 0) return setup.created_by === DEMO_USER_ID;
  return attached.some((c) => roleIn(c.company_id) !== null);
}

function canChange(setupId: string): boolean {
  const setup = shared.find((s) => s.id === setupId);
  if (!setup) return false;
  const attached = attachedTo(setupId);
  if (attached.length === 0) return setup.created_by === DEMO_USER_ID;
  return attached.every((c) => roleIn(c.company_id) === "admin");
}

function keep(
  target: SetupTarget,
  revision: number,
  body: Record<string, unknown>,
  at: string,
  sharedSetupId?: string,
) {
  history.push({
    key: keyOf(target),
    revision,
    body: copy(body),
    saved_by: DEMO_USER_ID,
    saved_at: at,
    ...(sharedSetupId ? { shared_setup_id: sharedSetupId } : {}),
  });
}

const tooLarge = (body: unknown) => new TextEncoder().encode(JSON.stringify(body)).length > 262_144;

// ---------- reading ----------

export async function demoFetchCompanySetup(companyId: string): Promise<CompanySetup | null> {
  await pause(30);
  if (roleIn(companyId) === null) return null;
  const found = companies.find((c) => c.company_id === companyId);
  return found ? copy(found) : null;
}

export async function demoFetchCompanySetupLinks(
  companyIds: string[],
): Promise<CompanySetupLink[]> {
  await pause(30);
  return companies
    .filter((c) => companyIds.includes(c.company_id) && roleIn(c.company_id) !== null)
    .map(({ company_id, shared_setup_id }) => ({ company_id, shared_setup_id }));
}

export async function demoFetchSharedSetup(setupId: string): Promise<SharedSetup | null> {
  await pause(30);
  const found = shared.find((s) => s.id === setupId);
  if (!found || !canRead(setupId)) return null;
  return without(found, "created_by");
}

export async function demoFetchAttachedCompanySetups(setupId: string): Promise<CompanySetup[]> {
  await pause(30);
  return attachedTo(setupId)
    .filter((c) => roleIn(c.company_id) !== null)
    .map(copy)
    .sort((a, b) => a.company_id.localeCompare(b.company_id));
}

export async function demoFetchSharedSetupAccess(setupId: string): Promise<SharedSetupAccess> {
  await pause(30);
  if (!canRead(setupId)) return { can_change: false, companies: 0, admin_of: 0 };
  const attached = attachedTo(setupId);
  return {
    can_change: canChange(setupId),
    companies: attached.length,
    admin_of: attached.filter((c) => roleIn(c.company_id) === "admin").length,
  };
}

function readable(target: SetupTarget): boolean {
  return target.kind === "shared" ? canRead(target.id) : roleIn(target.id) !== null;
}

export async function demoFetchSetupHistory(target: SetupTarget): Promise<SetupRevision[]> {
  await pause(30);
  if (!readable(target)) return [];
  return history
    .filter((h) => h.key === keyOf(target))
    .sort((a, b) => b.revision - a.revision)
    .slice(0, 200)
    .map(({ revision, saved_by, saved_at }) => ({ revision, saved_by, saved_at }));
}

export async function demoFetchSetupRevision(
  target: SetupTarget,
  revision: number,
): Promise<KeptSetupRevision | null> {
  await pause(30);
  if (!readable(target)) return null;
  const found = history.find((h) => h.key === keyOf(target) && h.revision === revision);
  if (!found) return null;
  return without(found, "key");
}

// ---------- saving ----------

export async function demoSaveSharedSetup(input: SharedSetupInput): Promise<SavedSharedSetup> {
  await pause(80);
  const name = input.name.trim();
  if (name === "" || name.length > 80) throw fail("PH_INVALID_INPUT: the setup name", "22023");
  if (tooLarge(input.body) || input.companies.some((c) => tooLarge(c.body))) {
    throw fail("PH_TOO_LARGE", "54000");
  }
  const now = new Date().toISOString();
  const found = shared.find((s) => s.id === input.setupId);

  if (!found) {
    if (input.expectedRevision !== 0) throw fail("PH_NOT_FOUND", "P0002");
    if (input.companies.length > 0)
      throw fail("PH_INVALID_INPUT: a new setup has no companies yet", "22023");
    const setup: StoredShared = {
      id: input.setupId,
      name,
      body: copy(input.body),
      revision: 1,
      created_by: DEMO_USER_ID,
      updated_by: DEMO_USER_ID,
      updated_at: now,
    };
    shared.push(setup);
    keep({ kind: "shared", id: setup.id }, 1, setup.body, now);
    return { shared_setup_id: setup.id, name, revision: 1, updated_at: now, companies: [] };
  }

  if (!canRead(found.id)) throw fail("PH_NOT_FOUND", "P0002");
  if (!canChange(found.id)) throw fail("PH_NOT_ADMIN", "42501");
  if (found.revision !== input.expectedRevision) throw fail("PH_STALE", "P0001");
  // All or nothing: every company is checked before anything changes.
  const targets = input.companies.map((change) => {
    const company = companies.find(
      (c) => c.company_id === change.companyId && c.shared_setup_id === found.id,
    );
    if (!company) throw fail("PH_NOT_FOUND", "P0002");
    if (company.revision !== change.expectedRevision) throw fail("PH_STALE", "P0001");
    return { company, body: change.body };
  });

  found.name = name;
  found.body = copy(input.body);
  found.revision += 1;
  found.updated_by = DEMO_USER_ID;
  found.updated_at = now;
  const saved = targets.map(({ company, body }) => {
    company.body = copy(body);
    company.revision += 1;
    company.updated_by = DEMO_USER_ID;
    company.updated_at = now;
    keep(
      { kind: "company", id: company.company_id },
      company.revision,
      company.body,
      now,
      company.shared_setup_id,
    );
    return { company_id: company.company_id, revision: company.revision };
  });
  keep({ kind: "shared", id: found.id }, found.revision, found.body, now);
  return {
    shared_setup_id: found.id,
    name,
    revision: found.revision,
    updated_at: now,
    companies: saved,
  };
}

export async function demoSaveCompanySetup(
  companyId: string,
  body: Record<string, unknown>,
  expectedRevision: number,
): Promise<SavedCompanySetup> {
  await pause(80);
  if (roleIn(companyId) !== "admin") throw fail("PH_NOT_ADMIN", "42501");
  if (tooLarge(body)) throw fail("PH_TOO_LARGE", "54000");
  const company = companies.find((c) => c.company_id === companyId);
  if (!company) throw fail("PH_NOT_FOUND", "P0002");
  if (company.revision !== expectedRevision) throw fail("PH_STALE", "P0001");
  const now = new Date().toISOString();
  company.body = copy(body);
  company.revision += 1;
  company.updated_by = DEMO_USER_ID;
  company.updated_at = now;
  keep(
    { kind: "company", id: companyId },
    company.revision,
    company.body,
    now,
    company.shared_setup_id,
  );
  return {
    company_id: companyId,
    shared_setup_id: company.shared_setup_id,
    revision: company.revision,
    updated_at: now,
  };
}

export async function demoAttachPayrollCompany(
  companyId: string,
  setupId: string,
  body: Record<string, unknown>,
): Promise<SavedCompanySetup> {
  await pause(80);
  if (roleIn(companyId) !== "admin") throw fail("PH_NOT_ADMIN", "42501");
  if (tooLarge(body)) throw fail("PH_TOO_LARGE", "54000");
  if (!canRead(setupId)) throw fail("PH_NOT_FOUND", "P0002");
  if (!canChange(setupId)) throw fail("PH_NOT_ADMIN", "42501");
  if (companies.some((c) => c.company_id === companyId)) throw fail("PH_ALREADY_ATTACHED", "23505");
  const now = new Date().toISOString();
  const company: CompanySetup = {
    company_id: companyId,
    shared_setup_id: setupId,
    body: copy(body),
    revision: 1,
    updated_by: DEMO_USER_ID,
    updated_at: now,
  };
  companies.push(company);
  keep({ kind: "company", id: companyId }, 1, company.body, now, setupId);
  return { company_id: companyId, shared_setup_id: setupId, revision: 1, updated_at: now };
}

// ---------- for tests and delete_company ----------

/**
 * Puts a company in a shared setup directly, as another admin would have done, whatever the
 * demo user's role there. For tests only (e.g. a viewer's company attached to a shared setup).
 */
export function demoSeedAttachedCompany(
  companyId: string,
  setupId: string,
  body: Record<string, unknown>,
) {
  const now = new Date().toISOString();
  companies.push({
    company_id: companyId,
    shared_setup_id: setupId,
    body: copy(body),
    revision: 1,
    updated_by: DEMO_OTHER_USER_ID,
    updated_at: now,
  });
  keep({ kind: "company", id: companyId }, 1, body, now, setupId);
}

/** What deleting a company would remove: for the delete preview. */
export function demoPayrollSetupCounts(companyId: string) {
  return {
    payrollSetups: companies.filter((c) => c.company_id === companyId).length,
    payrollSetupRevisions: history.filter((h) => h.key === `company:${companyId}`).length,
  };
}

/** As delete_company (migration 0013): the company's setup goes, and an unused shared setup too. */
export function demoForgetPayrollSetups(companyId?: string): void {
  if (companyId === undefined) {
    shared.length = 0;
    companies.length = 0;
    history.length = 0;
    return;
  }
  const index = companies.findIndex((c) => c.company_id === companyId);
  if (index < 0) return;
  const [gone] = companies.splice(index, 1);
  const forget = (key: string) => {
    for (let i = history.length - 1; i >= 0; i--) if (history[i]!.key === key) history.splice(i, 1);
  };
  forget(`company:${companyId}`);
  if (attachedTo(gone!.shared_setup_id).length === 0) {
    const setupIndex = shared.findIndex((s) => s.id === gone!.shared_setup_id);
    if (setupIndex >= 0) shared.splice(setupIndex, 1);
    forget(`shared:${gone!.shared_setup_id}`);
  }
}
