import type { CompanyDetail, CompanyLink } from "@/lib/supabase/companyData";
import { demoMemberships } from "./demoData";

/**
 * FAKE company details and links for dev-only demo mode. Everything here is invented.
 * It follows the same rules as the database: viewers never receive sensitive details, and
 * only admins can change anything. Only reachable behind `import.meta.env.DEV`.
 */

const ABC = "10000000-0000-4000-8000-000000000001";
const XYZ = "10000000-0000-4000-8000-000000000002";
const NOW = "2026-09-01T09:00:00+04:00";

let nextId = 1;
const newId = (kind: number) =>
  `${kind}0000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;
const pause = (ms: number) => {
  ensureSeeded();
  return new Promise((resolve) => setTimeout(resolve, ms));
};
const fail = (message: string, code: string) => Object.assign(new Error(message), { code });

const inOrder = (a: { sort_order: number; id: string }, b: { sort_order: number; id: string }) =>
  a.sort_order - b.sort_order || a.id.localeCompare(b.id);

const roleIn = (companyId: string) =>
  demoMemberships.find((m) => m.company.id === companyId)?.role ?? null;

function requireAdmin(companyId: string) {
  if (roleIn(companyId) !== "admin") {
    throw fail("new row violates row-level security policy", "42501");
  }
}

const detail = (
  companyId: string,
  label: string,
  value: string,
  field_type: CompanyDetail["field_type"],
  is_sensitive: boolean,
  sort_order: number,
): CompanyDetail => ({
  id: newId(5),
  company_id: companyId,
  label,
  value,
  field_type,
  is_sensitive,
  sort_order,
  updated_at: NOW,
  valueLoaded: true,
});

const details: CompanyDetail[] = [];
const seedDetails = (): CompanyDetail[] => [
  detail(ABC, "Tax office", "Port Louis (sample)", "text", false, 0),
  detail(ABC, "Payroll contact", "payroll@example.com", "email", false, 1),
  detail(ABC, "Office phone", "+230 5555 0100", "phone", false, 2),
  detail(ABC, "Year end", "2026-06-30", "date", false, 3),
  detail(ABC, "Tax account reference", "FAKE-TAN-0001", "text", true, 4),
  detail(ABC, "Bank reference", "FAKE-IBAN-0000-0000", "text", true, 5),
  detail(XYZ, "Payroll contact", "accounts@example.org", "email", false, 0),
  detail(XYZ, "Tax account reference", "FAKE-TAN-0002", "text", true, 1),
];

const link = (
  companyId: string,
  title: string,
  url: string,
  category: string | null,
  icon: string,
  accent: string,
  is_pinned: boolean,
  sort_order: number,
  description: string | null = null,
): CompanyLink => ({
  id: newId(6),
  company_id: companyId,
  title,
  url,
  description,
  category,
  icon,
  accent,
  is_pinned,
  sort_order,
  updated_at: NOW,
});

const links: CompanyLink[] = [];
const seedLinks = (): CompanyLink[] => [
  link(
    ABC,
    "Tax portal",
    "https://example.org/tax",
    "Government",
    "landmark",
    "teal",
    true,
    0,
    "Monthly returns and payments",
  ),
  link(
    ABC,
    "Company registry",
    "https://example.org/registry",
    "Government",
    "building",
    "violet",
    false,
    1,
  ),
  link(
    ABC,
    "Online banking",
    "https://example.com/bank",
    "Banking",
    "banknote",
    "amber",
    true,
    2,
    "Salary transfers",
  ),
  link(
    ABC,
    "Shared payroll folder",
    "https://example.net/files/payroll",
    "Documents",
    "folder",
    "sky",
    false,
    3,
  ),
  link(ABC, "Leave calendar", "https://example.net/calendar", null, "calendar", "rose", false, 4),
  link(XYZ, "Tax portal", "https://example.org/tax", "Government", "landmark", "teal", true, 0),
  link(
    XYZ,
    "Pension scheme",
    "https://example.org/pension",
    "Government",
    "shield",
    "slate",
    false,
    1,
  ),
  link(
    XYZ,
    "Supplier portal",
    "https://example.com/suppliers",
    "Purchasing",
    "cart",
    "amber",
    false,
    2,
  ),
];

let seeded = false;
/** Fills the fake tables the first time demo mode touches them. */
function ensureSeeded() {
  if (seeded) return;
  seeded = true;
  details.push(...seedDetails());
  links.push(...seedLinks());
}

// ---------------------------------------------------------------- details

export async function demoFetchDetails(companyId: string): Promise<CompanyDetail[]> {
  await pause(300);
  const admin = roleIn(companyId) === "admin";
  if (!roleIn(companyId)) return [];
  return (
    details
      .filter((d) => d.company_id === companyId && (admin || !d.is_sensitive))
      // Like the real read: a sensitive value is not sent until it is asked for separately.
      .map((d) => (d.is_sensitive ? { ...d, value: null, valueLoaded: false } : { ...d }))
      .sort(inOrder)
  );
}

export async function demoFetchSensitiveValues(
  companyId: string,
): Promise<Record<string, string | null>> {
  await pause(250);
  if (roleIn(companyId) !== "admin") return {};
  return Object.fromEntries(
    details.filter((d) => d.company_id === companyId && d.is_sensitive).map((d) => [d.id, d.value]),
  );
}

type DetailFields = Pick<CompanyDetail, "label" | "value" | "field_type" | "is_sensitive">;

function refuseDuplicateLabel(companyId: string, label: string, exceptId?: string) {
  if (details.some((d) => d.company_id === companyId && d.label === label && d.id !== exceptId)) {
    throw fail(
      'duplicate key value violates unique constraint "company_details_company_id_label_key"',
      "23505",
    );
  }
}

export async function demoCreateDetail(companyId: string, input: DetailFields, sortOrder: number) {
  await pause(350);
  requireAdmin(companyId);
  refuseDuplicateLabel(companyId, input.label);
  details.push({
    ...input,
    id: newId(5),
    company_id: companyId,
    sort_order: sortOrder,
    updated_at: new Date().toISOString(),
    valueLoaded: true,
  });
}

export async function demoUpdateDetail(id: string, input: DetailFields) {
  await pause(350);
  const existing = details.find((d) => d.id === id);
  if (!existing) throw fail("no rows", "42501");
  requireAdmin(existing.company_id);
  refuseDuplicateLabel(existing.company_id, input.label, id);
  Object.assign(existing, input, { updated_at: new Date().toISOString() });
}

export async function demoDeleteDetail(id: string) {
  await pause(300);
  const index = details.findIndex((d) => d.id === id);
  if (index < 0) throw fail("no rows", "42501");
  requireAdmin(details[index]!.company_id);
  details.splice(index, 1);
}

export async function demoSaveOrder(
  table: "details" | "links",
  changes: readonly { id: string; sort_order: number }[],
) {
  await pause(200);
  const rows: { id: string; company_id: string; sort_order: number }[] =
    table === "details" ? details : links;
  for (const change of changes) {
    const row = rows.find((r) => r.id === change.id);
    if (!row) continue;
    requireAdmin(row.company_id);
    row.sort_order = change.sort_order;
  }
}

export async function demoUpdateCompanyCore(
  companyId: string,
  input: { name: string; address: string | null; vat: string | null },
) {
  await pause(350);
  requireAdmin(companyId);
  const index = demoMemberships.findIndex((m) => m.company.id === companyId);
  const membership = demoMemberships[index]!;
  // A new object, as a real read would give: the cached one must not change underneath the screen.
  const company = { ...membership.company, ...input };
  demoMemberships[index] = { ...membership, company };
  return company;
}

// ---------------------------------------------------------------- links

export async function demoFetchLinks(companyId: string): Promise<CompanyLink[]> {
  await pause(300);
  if (!roleIn(companyId)) return [];
  return links
    .filter((l) => l.company_id === companyId)
    .map((l) => ({ ...l }))
    .sort(inOrder);
}

type LinkFields = Pick<
  CompanyLink,
  "title" | "url" | "description" | "category" | "icon" | "accent" | "is_pinned"
>;

function refuseDuplicateUrl(companyId: string, url: string, exceptId?: string) {
  if (links.some((l) => l.company_id === companyId && l.url === url && l.id !== exceptId)) {
    throw fail(
      'duplicate key value violates unique constraint "company_links_company_id_url_key"',
      "23505",
    );
  }
}

export async function demoCreateLinks(
  companyId: string,
  inputs: readonly LinkFields[],
  firstSortOrder: number,
): Promise<number> {
  await pause(400);
  requireAdmin(companyId);
  // One statement in the real database: either every row goes in, or none does.
  const seen = new Set<string>();
  for (const input of inputs) {
    refuseDuplicateUrl(companyId, input.url);
    if (seen.has(input.url)) throw fail("duplicate key value", "23505");
    seen.add(input.url);
  }
  inputs.forEach((input, i) =>
    links.push({
      ...input,
      id: newId(6),
      company_id: companyId,
      sort_order: firstSortOrder + i,
      updated_at: new Date().toISOString(),
    }),
  );
  return inputs.length;
}

export async function demoUpdateLink(id: string, patch: Partial<LinkFields>) {
  await pause(300);
  const existing = links.find((l) => l.id === id);
  if (!existing) throw fail("no rows", "42501");
  requireAdmin(existing.company_id);
  if (patch.url) refuseDuplicateUrl(existing.company_id, patch.url, id);
  Object.assign(existing, patch, { updated_at: new Date().toISOString() });
}

export async function demoDeleteLink(id: string) {
  await pause(300);
  const index = links.findIndex((l) => l.id === id);
  if (index < 0) throw fail("no rows", "42501");
  requireAdmin(links[index]!.company_id);
  links.splice(index, 1);
}

/** For the Database page and the delete-company preview. */
export function demoCompanyDataRows(table: "company_details" | "company_links", companyId: string) {
  ensureSeeded();
  const admin = roleIn(companyId) === "admin";
  if (table === "company_links") {
    return links.filter((l) => l.company_id === companyId).map((l) => ({ ...l, created_at: NOW }));
  }
  return details
    .filter((d) => d.company_id === companyId && (admin || !d.is_sensitive))
    .map((d) => {
      const row: Record<string, unknown> = { ...d, created_at: NOW };
      delete row.valueLoaded;
      return row;
    });
}

/** When a demo company is deleted, its details and links go with it (the cascade). */
export function demoForgetCompanyData(companyId: string) {
  ensureSeeded();
  for (const list of [details, links] as { company_id: string }[][]) {
    for (let i = list.length - 1; i >= 0; i--)
      if (list[i]!.company_id === companyId) list.splice(i, 1);
  }
}
