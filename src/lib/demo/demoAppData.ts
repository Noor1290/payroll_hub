import type {
  DraftInput,
  PublishedTemplate,
  SavedDraft,
  TemplateDraft,
  TemplateSummary,
  TemplateVersion,
} from "@/lib/supabase/payslipTemplates";
import type { RatesInput, RatesVersion, SavedRates } from "@/lib/supabase/statutoryRates";
import { demoMemberships } from "./demoData";

/**
 * FAKE statutory rates and payslip templates for dev-only demo mode, so the mock payslip app
 * has something to talk to. They follow the same rules as the database functions (admin only,
 * the revision the caller last saw must still be the latest, an identical correction or
 * publication is refused, names unique per company, 50 templates). Everything here is invented
 * and lives in memory. Only reachable behind `import.meta.env.DEV`.
 */

const ABC = "10000000-0000-4000-8000-000000000001";
const DEMO_USER_ID = "00000000-0000-4000-8000-000000000001";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message: string, code: string) => Object.assign(new Error(message), { code });

function requireAdmin(companyId: string) {
  const role = demoMemberships.find((m) => m.company.id === companyId)?.role;
  if (role !== "admin") throw fail("PH_NOT_ADMIN", "42501");
}

type StoredRates = RatesVersion & { company_id: string };

const rates: StoredRates[] = [
  {
    company_id: ABC,
    effective_from: "2025-07-01",
    revision: 1,
    nsf_employee_rate: 1,
    nsf_ceiling: 28570,
    nsf_exempt_at_60: true,
    csg_employee_rate_low: 1.5,
    csg_employee_rate_high: 3,
    csg_threshold: 50000,
    source_note: "Sample figures, not the real ones",
    created_by: DEMO_USER_ID,
    created_at: "2025-07-02T09:00:00+04:00",
  },
];

export async function demoFetchStatutoryRates(companyId: string): Promise<RatesVersion[]> {
  await pause(250);
  return rates
    .filter((row) => row.company_id === companyId)
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from) || b.revision - a.revision)
    .map((row) => {
      const copy: Partial<StoredRates> = { ...row };
      delete copy.company_id;
      return copy as RatesVersion;
    });
}

export async function demoSaveStatutoryRates(
  companyId: string,
  input: RatesInput,
): Promise<SavedRates> {
  await pause(400);
  requireAdmin(companyId);
  const sameMonth = rates.filter(
    (row) => row.company_id === companyId && row.effective_from === input.effectiveFrom,
  );
  const latest = sameMonth.reduce<StoredRates | null>(
    (best, row) => (best === null || row.revision > best.revision ? row : best),
    null,
  );
  if ((latest?.revision ?? 0) !== input.expectedRevision) throw fail("PH_STALE", "P0001");
  if (
    latest &&
    latest.nsf_employee_rate === input.nsfEmployeeRate &&
    latest.nsf_ceiling === input.nsfCeiling &&
    latest.nsf_exempt_at_60 === input.nsfExemptAt60 &&
    latest.csg_employee_rate_low === input.csgEmployeeRateLow &&
    latest.csg_employee_rate_high === input.csgEmployeeRateHigh &&
    latest.csg_threshold === input.csgThreshold &&
    latest.source_note === input.sourceNote
  ) {
    throw fail("PH_NO_CHANGE", "P0001");
  }
  const revision = (latest?.revision ?? 0) + 1;
  rates.push({
    company_id: companyId,
    effective_from: input.effectiveFrom,
    revision,
    nsf_employee_rate: input.nsfEmployeeRate,
    nsf_ceiling: input.nsfCeiling,
    nsf_exempt_at_60: input.nsfExemptAt60,
    csg_employee_rate_low: input.csgEmployeeRateLow,
    csg_employee_rate_high: input.csgEmployeeRateHigh,
    csg_threshold: input.csgThreshold,
    source_note: input.sourceNote,
    created_by: DEMO_USER_ID,
    created_at: new Date().toISOString(),
  });
  return { effective_from: input.effectiveFrom, revision };
}

// ---------- payslip templates ----------

type StoredTemplate = TemplateDraft & { company_id: string };
type StoredVersion = TemplateVersion & { company_id: string };

const SAMPLE_TEMPLATE = "20000000-0000-4000-8000-000000000001";
const sampleBody = {
  title: "Payslip",
  lines: [
    { label: "Basic salary", column: "Basic Salary" },
    { label: "Net pay", column: "Net Pay" },
  ],
};
const templates: StoredTemplate[] = [
  {
    company_id: ABC,
    id: SAMPLE_TEMPLATE,
    name: "Monthly payslip",
    draft_body: sampleBody,
    draft_revision: 1,
    updated_by: DEMO_USER_ID,
    updated_at: "2025-07-02T09:00:00+04:00",
  },
];
const versions: StoredVersion[] = [
  {
    company_id: ABC,
    template_id: SAMPLE_TEMPLATE,
    version: 1,
    name: "Monthly payslip",
    body: sampleBody,
    published_by: DEMO_USER_ID,
    published_at: "2025-07-02T09:05:00+04:00",
  },
];

const latestVersion = (templateId: string) =>
  versions
    .filter((row) => row.template_id === templateId)
    .reduce<StoredVersion | null>(
      (best, row) => (best === null || row.version > best.version ? row : best),
      null,
    );
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export async function demoFetchTemplates(companyId: string): Promise<TemplateSummary[]> {
  await pause(250);
  return templates
    .filter((row) => row.company_id === companyId)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ id, name, draft_revision, updated_by, updated_at }) => {
      const latest = latestVersion(id);
      return {
        id,
        name,
        draft_revision,
        updated_by,
        updated_at,
        published: latest ? { version: latest.version, published_at: latest.published_at } : null,
      };
    });
}

export async function demoFetchTemplateDraft(
  companyId: string,
  templateId: string,
): Promise<TemplateDraft | null> {
  await pause(250);
  const found = templates.find((row) => row.company_id === companyId && row.id === templateId);
  if (!found) return null;
  const { company_id: _company, ...draft } = found;
  void _company;
  return draft;
}

export async function demoFetchTemplateVersion(
  companyId: string,
  templateId: string,
  version: number,
): Promise<TemplateVersion | null> {
  await pause(250);
  const found = versions.find(
    (row) =>
      row.company_id === companyId && row.template_id === templateId && row.version === version,
  );
  if (!found) return null;
  const { company_id: _company, ...published } = found;
  void _company;
  return published;
}

export async function demoSaveTemplateDraft(
  companyId: string,
  input: DraftInput,
): Promise<SavedDraft> {
  await pause(400);
  requireAdmin(companyId);
  const own = templates.filter((row) => row.company_id === companyId);
  const taken = (exceptId: string | null) =>
    own.some((row) => row.id !== exceptId && row.name.toLowerCase() === input.name.toLowerCase());
  const updated_at = new Date().toISOString();

  if (input.templateId === null) {
    if (input.expectedRevision !== 0) throw fail("PH_INVALID_INPUT", "22023");
    if (own.length >= 50) throw fail("PH_LIMIT", "54000");
    if (taken(null)) throw fail("PH_DUPLICATE_NAME", "23505");
    const created: StoredTemplate = {
      company_id: companyId,
      id: crypto.randomUUID(),
      name: input.name,
      draft_body: input.body,
      draft_revision: 1,
      updated_by: DEMO_USER_ID,
      updated_at,
    };
    templates.push(created);
    return { template_id: created.id, name: created.name, draft_revision: 1, updated_at };
  }

  const found = own.find((row) => row.id === input.templateId);
  if (!found) throw fail("PH_NOT_FOUND", "P0002");
  if (found.draft_revision !== input.expectedRevision) throw fail("PH_STALE", "P0001");
  if (taken(found.id)) throw fail("PH_DUPLICATE_NAME", "23505");
  found.name = input.name;
  found.draft_body = input.body;
  found.draft_revision += 1;
  found.updated_at = updated_at;
  return {
    template_id: found.id,
    name: found.name,
    draft_revision: found.draft_revision,
    updated_at,
  };
}

export async function demoPublishTemplate(
  companyId: string,
  templateId: string,
  expectedRevision: number,
): Promise<PublishedTemplate> {
  await pause(400);
  requireAdmin(companyId);
  const found = templates.find((row) => row.company_id === companyId && row.id === templateId);
  if (!found) throw fail("PH_NOT_FOUND", "P0002");
  if (found.draft_revision !== expectedRevision) throw fail("PH_STALE", "P0001");
  const latest = latestVersion(found.id);
  if (latest && latest.name === found.name && sameJson(latest.body, found.draft_body)) {
    throw fail("PH_NO_CHANGE", "P0001");
  }
  const published: StoredVersion = {
    company_id: companyId,
    template_id: found.id,
    version: (latest?.version ?? 0) + 1,
    name: found.name,
    body: found.draft_body,
    published_by: DEMO_USER_ID,
    published_at: new Date().toISOString(),
  };
  versions.push(published);
  return {
    template_id: found.id,
    version: published.version,
    draft_revision: found.draft_revision,
    published_at: published.published_at,
  };
}

/** Rows the demo company has here, for the delete-company preview. */
export function demoAppDataCounts(companyId: string) {
  return { rates: rates.filter((row) => row.company_id === companyId).length };
}

/** Removes everything a deleted demo company had here. */
export function demoForgetAppData(companyId: string): void {
  for (const rows of [rates, templates, versions]) {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i]!.company_id === companyId) rows.splice(i, 1);
    }
  }
}
