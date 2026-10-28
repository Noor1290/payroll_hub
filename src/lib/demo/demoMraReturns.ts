import type {
  DetachedMraTemplate,
  KeptMraTemplate,
  MraCompanyDetails,
  MraDetailsInput,
  MraSettings,
  MraTemplate,
  MraTemplateAccess,
  MraTemplateInput,
  MraTemplateLink,
  MraTemplateRevision,
  SavedMraTemplate,
  SavedMraTemplateLink,
} from "@/lib/supabase/mraReturns";
import { demoMemberships } from "./demoData";

/**
 * FAKE MRA Returns data for dev-only demo mode and the dashboard's own tests. It follows the
 * rules of migration 0020_mra_returns.sql: a template is read by an admin of a company using it
 * and changed only by an admin of every company using it; each company's admin changes its own
 * values; a template is used by at least one company, and taken out of the last one it is
 * deleted with its history; names are unique per company whatever the capitals, 20 templates
 * per company; every save names the revision last seen. Details and the email are admins'.
 * Everything here is invented and lives in memory. Only reachable behind `import.meta.env.DEV`.
 */

const DEMO_USER_ID = "00000000-0000-4000-8000-000000000001";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message: string, code: string) => Object.assign(new Error(message), { code });
const notAdmin = () => fail("PH_NOT_ADMIN", "42501");
const stale = () => fail("PH_STALE", "P0001");
const notFound = () => fail("PH_NOT_FOUND", "P0002");
const copy = <T>(value: T): T => structuredClone(value);

type Kept = KeptMraTemplate & { template_id: string };

const templates: MraTemplate[] = [];
const links: MraTemplateLink[] = [];
const history: Kept[] = [];
const details: MraCompanyDetails[] = [];
let settings: MraSettings | null = null;

const isAdmin = (companyId: string) =>
  demoMemberships.some((m) => m.company.id === companyId && m.role === "admin");
const linksOf = (templateId: string) => links.filter((l) => l.template_id === templateId);
const canRead = (templateId: string) => linksOf(templateId).some((l) => isAdmin(l.company_id));
const canChange = (templateId: string) => {
  const using = linksOf(templateId);
  return using.length > 0 && using.every((l) => isAdmin(l.company_id));
};
const nameTaken = (companyId: string, name: string, except: string) =>
  links.some(
    (l) =>
      l.company_id === companyId &&
      l.template_id !== except &&
      templates.find((t) => t.id === l.template_id)?.name.toLowerCase() === name.toLowerCase(),
  );

/** Forgets everything. For tests. */
export function demoForgetMraReturns(): void {
  templates.length = 0;
  links.length = 0;
  history.length = 0;
  details.length = 0;
  settings = null;
}

export async function demoFetchMraTemplateLinks(companyIds: string[]): Promise<MraTemplateLink[]> {
  await pause(60);
  return copy(links.filter((l) => companyIds.includes(l.company_id) && isAdmin(l.company_id)));
}

export async function demoFetchMraTemplate(ids: string[]): Promise<MraTemplate[]> {
  await pause(60);
  return copy(
    templates
      .filter((t) => ids.includes(t.id) && canRead(t.id))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
}

export async function demoFetchMraTemplateAccess(templateId: string): Promise<MraTemplateAccess> {
  await pause(30);
  if (!canRead(templateId)) return { can_change: false, companies: 0, admin_of: 0 };
  const using = linksOf(templateId);
  return {
    can_change: canChange(templateId),
    companies: using.length,
    admin_of: using.filter((l) => isAdmin(l.company_id)).length,
  };
}

export async function demoFetchMraTemplateHistory(
  templateId: string,
): Promise<MraTemplateRevision[]> {
  await pause(60);
  if (!canRead(templateId)) return [];
  return history
    .filter((h) => h.template_id === templateId)
    .sort((a, b) => b.revision - a.revision)
    .map(({ revision, name, saved_by, saved_at }) => ({ revision, name, saved_by, saved_at }));
}

export async function demoFetchMraTemplateRevision(
  templateId: string,
  revision: number,
): Promise<KeptMraTemplate | null> {
  await pause(60);
  if (!canRead(templateId)) return null;
  const kept = history.find((h) => h.template_id === templateId && h.revision === revision);
  if (!kept) return null;
  return {
    revision: kept.revision,
    name: kept.name,
    body: copy(kept.body),
    saved_by: kept.saved_by,
    saved_at: kept.saved_at,
  };
}

export async function demoFetchMraCompanyDetails(
  companyId: string,
): Promise<MraCompanyDetails | null> {
  await pause(40);
  if (!isAdmin(companyId)) return null;
  return copy(details.find((d) => d.company_id === companyId) ?? null);
}

export async function demoFetchMraSettings(): Promise<MraSettings | null> {
  await pause(40);
  return copy(settings);
}

export async function demoSaveMraTemplate(input: MraTemplateInput): Promise<SavedMraTemplate> {
  await pause(120);
  if (!isAdmin(input.companyId)) throw notAdmin();
  const name = input.name.trim();
  const at = new Date().toISOString();
  let template = templates.find((t) => t.id === input.templateId);
  if (!template) {
    if (input.expectedRevision !== 0) throw notFound();
    if (links.filter((l) => l.company_id === input.companyId).length >= 20) {
      throw fail("PH_LIMIT", "54000");
    }
    if (nameTaken(input.companyId, name, input.templateId))
      throw fail("PH_DUPLICATE_NAME", "23505");
    template = {
      id: input.templateId,
      name,
      body: copy(input.body),
      revision: 1,
      updated_by: DEMO_USER_ID,
      updated_at: at,
    };
    templates.push(template);
    links.push({
      template_id: template.id,
      company_id: input.companyId,
      own_values: {},
      revision: 1,
      updated_by: DEMO_USER_ID,
      updated_at: at,
    });
  } else {
    if (!links.some((l) => l.template_id === template!.id && l.company_id === input.companyId)) {
      throw notFound();
    }
    if (!canChange(template.id)) throw notAdmin();
    if (template.revision !== input.expectedRevision) throw stale();
    if (linksOf(template.id).some((l) => nameTaken(l.company_id, name, template!.id))) {
      throw fail("PH_DUPLICATE_NAME", "23505");
    }
    Object.assign(template, {
      name,
      body: copy(input.body),
      revision: template.revision + 1,
      updated_by: DEMO_USER_ID,
      updated_at: at,
    });
  }
  history.push({
    template_id: template.id,
    revision: template.revision,
    name: template.name,
    body: copy(template.body),
    saved_by: DEMO_USER_ID,
    saved_at: at,
  });
  return {
    template_id: template.id,
    name: template.name,
    revision: template.revision,
    updated_at: at,
  };
}

export async function demoSaveMraTemplateValues(
  templateId: string,
  companyId: string,
  values: Record<string, unknown>,
  expectedRevision: number,
): Promise<SavedMraTemplateLink> {
  await pause(80);
  if (!isAdmin(companyId)) throw notAdmin();
  const link = links.find((l) => l.template_id === templateId && l.company_id === companyId);
  if (!link) throw notFound();
  if (link.revision !== expectedRevision) throw stale();
  Object.assign(link, {
    own_values: copy(values),
    revision: link.revision + 1,
    updated_by: DEMO_USER_ID,
    updated_at: new Date().toISOString(),
  });
  return {
    template_id: templateId,
    company_id: companyId,
    revision: link.revision,
    updated_at: link.updated_at,
  };
}

export async function demoAttachMraTemplate(
  templateId: string,
  companyId: string,
  values: Record<string, unknown>,
): Promise<SavedMraTemplateLink> {
  await pause(80);
  if (!isAdmin(companyId)) throw notAdmin();
  const template = templates.find((t) => t.id === templateId);
  if (!template || !canRead(templateId)) throw notFound();
  if (!canChange(templateId)) throw notAdmin();
  if (links.some((l) => l.template_id === templateId && l.company_id === companyId)) {
    throw fail("PH_ALREADY_ATTACHED", "23505");
  }
  if (links.filter((l) => l.company_id === companyId).length >= 20) throw fail("PH_LIMIT", "54000");
  if (nameTaken(companyId, template.name, templateId)) throw fail("PH_DUPLICATE_NAME", "23505");
  const at = new Date().toISOString();
  links.push({
    template_id: templateId,
    company_id: companyId,
    own_values: copy(values),
    revision: 1,
    updated_by: DEMO_USER_ID,
    updated_at: at,
  });
  return { template_id: templateId, company_id: companyId, revision: 1, updated_at: at };
}

export async function demoDetachMraTemplate(
  templateId: string,
  companyId: string,
  expectedRevision: number,
): Promise<DetachedMraTemplate> {
  await pause(80);
  if (!isAdmin(companyId)) throw notAdmin();
  const template = templates.find((t) => t.id === templateId);
  if (!template) throw notFound();
  const index = links.findIndex((l) => l.template_id === templateId && l.company_id === companyId);
  if (index < 0) throw notFound();
  if (template.revision !== expectedRevision) throw stale();
  links.splice(index, 1);
  const deleted = linksOf(templateId).length === 0;
  if (deleted) {
    templates.splice(templates.indexOf(template), 1);
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (history[i]!.template_id === templateId) history.splice(i, 1);
    }
  }
  return { template_id: templateId, name: template.name, deleted };
}

export async function demoSaveMraCompanyDetails(
  companyId: string,
  input: MraDetailsInput,
): Promise<MraCompanyDetails> {
  await pause(80);
  if (!isAdmin(companyId)) throw notAdmin();
  const values = {
    ern: input.ern.trim(),
    telephone: input.telephone.trim(),
    mobile: input.mobile.trim(),
    declarant: input.declarant.trim(),
  };
  if (!/^[0-9A-Za-z]{0,20}$/.test(values.ern)) {
    throw fail("PH_INVALID_INPUT: the ERN must be letters and digits only, at most 20", "22023");
  }
  if (![values.telephone, values.mobile].every((phone) => /^[0-9 +()-]{0,30}$/.test(phone))) {
    throw fail(
      "PH_INVALID_INPUT: a phone number must be digits, spaces and + - ( ) only, at most 30",
      "22023",
    );
  }
  if (values.declarant.length > 120) {
    throw fail(
      "PH_INVALID_INPUT: the name of the declarant must be at most 120 characters",
      "22023",
    );
  }
  const at = new Date().toISOString();
  const existing = details.find((d) => d.company_id === companyId);
  if ((existing?.revision ?? 0) !== input.expectedRevision) throw stale();
  if (existing) {
    Object.assign(existing, values, { revision: existing.revision + 1, updated_at: at });
    return copy(existing);
  }
  const row = { company_id: companyId, ...values, revision: 1, updated_at: at };
  details.push(row);
  return copy(row);
}

export async function demoSaveMraSettings(
  email: string,
  expectedRevision: number,
): Promise<MraSettings> {
  await pause(60);
  if (!demoMemberships.some((m) => m.role === "admin")) throw notAdmin();
  const value = email.trim();
  if (value !== "" && (value.length > 254 || !/^[^@\s,;]+@[^@\s,;]+$/.test(value))) {
    throw fail("PH_INVALID_INPUT: the email address is not valid", "22023");
  }
  if ((settings?.revision ?? 0) !== expectedRevision) throw stale();
  settings = {
    email: value,
    revision: (settings?.revision ?? 0) + 1,
    updated_at: new Date().toISOString(),
  };
  return copy(settings);
}

/** What deleting a company would remove: for the delete preview. */
export function demoMraCounts(companyId: string) {
  return {
    mraTemplates: links.filter((l) => l.company_id === companyId).length,
    mraDetails: details.filter((d) => d.company_id === companyId).length,
  };
}

/** As delete_company (migration 0020): its details, its links, and the templates nobody else uses. */
export function demoForgetMraCompany(companyId: string): void {
  const used = links.filter((l) => l.company_id === companyId).map((l) => l.template_id);
  for (let i = links.length - 1; i >= 0; i -= 1) {
    if (links[i]!.company_id === companyId) links.splice(i, 1);
  }
  for (const id of used.filter((one) => linksOf(one).length === 0)) {
    templates.splice(
      templates.findIndex((t) => t.id === id),
      1,
    );
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (history[i]!.template_id === id) history.splice(i, 1);
    }
  }
  for (let i = details.length - 1; i >= 0; i -= 1) {
    if (details[i]!.company_id === companyId) details.splice(i, 1);
  }
}
