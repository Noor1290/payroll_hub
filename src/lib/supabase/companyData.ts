import { z } from "zod";
import {
  demoCreateDetail,
  demoCreateLinks,
  demoDeleteDetail,
  demoDeleteLink,
  demoFetchDetails,
  demoFetchLinks,
  demoFetchSensitiveValues,
  demoSaveOrder,
  demoUpdateCompanyCore,
  demoUpdateDetail,
  demoUpdateLink,
} from "@/lib/demo/demoCompanyData";
import { isUnlocked } from "@/lib/unlock";
import { supabase } from "./client";
import { classifyDataError, isMissingTable, NotConfiguredError, type DataFailure } from "./errors";
import type { Viewer } from "./queries";
import { companySchema, type Company } from "./schemas";

/**
 * Reads and writes for the Company profile and Links screens (tables from migrations 0005 and
 * 0006). Row-level security decides what each account may read or change; this file only asks.
 * Every response is validated before it is used.
 */

const FIELD_TYPE = z.enum(["text", "link", "email", "phone", "date", "number"]);

const detailBase = {
  id: z.uuid(),
  company_id: z.uuid(),
  label: z.string().min(1),
  field_type: FIELD_TYPE,
  is_sensitive: z.boolean(),
  sort_order: z.number().int(),
  updated_at: z.string(),
};
const detailWithValueSchema = z.object({ ...detailBase, value: z.string().nullable() });
const detailWithoutValueSchema = z.object(detailBase);

export type CompanyDetail = z.infer<typeof detailWithValueSchema> & {
  /** False for a sensitive detail whose value has not been fetched (the gate is locked). */
  valueLoaded: boolean;
};

const linkSchema = z.object({
  id: z.uuid(),
  company_id: z.uuid(),
  title: z.string().min(1),
  // Anything that is not a plain web address is treated as unexpected data, never as a link.
  url: z.string().regex(/^https?:\/\//i),
  description: z.string().nullable(),
  category: z.string().nullable(),
  icon: z.string().nullable(),
  accent: z.string().nullable(),
  is_pinned: z.boolean(),
  sort_order: z.number().int(),
  updated_at: z.string(),
});
export type CompanyLink = z.infer<typeof linkSchema>;

const DETAIL_COLUMNS = "id, company_id, label, field_type, is_sensitive, sort_order, updated_at";
const LINK_COLUMNS =
  "id, company_id, title, url, description, category, icon, accent, is_pinned, sort_order, updated_at";

function client() {
  if (!supabase) throw new NotConfiguredError();
  return supabase;
}

/** RLS filters rows a user may not change instead of raising, so "nothing changed" means "not allowed". */
function expectChanged(rows: unknown[] | null): void {
  if (!rows || rows.length === 0) {
    throw Object.assign(new Error("Nothing was changed."), { code: "42501" });
  }
}

// ---------------------------------------------------------------- details

/**
 * A company's custom details, in order. Sensitive ones come back WITHOUT their value: only
 * the label is read here. (A viewer does not receive sensitive details at all; the database
 * hides those rows from them.)
 */
export async function fetchDetails(viewer: Viewer, companyId: string): Promise<CompanyDetail[]> {
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchDetails(companyId);
  const db = client();
  const [open, sensitive] = await Promise.all([
    db
      .from("company_details")
      .select(`${DETAIL_COLUMNS}, value`)
      .eq("company_id", companyId)
      .eq("is_sensitive", false),
    db
      .from("company_details")
      .select(DETAIL_COLUMNS)
      .eq("company_id", companyId)
      .eq("is_sensitive", true),
  ]);
  if (open.error) throw open.error;
  if (sensitive.error) throw sensitive.error;

  return [
    ...z
      .array(detailWithValueSchema)
      .parse(open.data)
      .map((row) => ({ ...row, valueLoaded: true })),
    ...z
      .array(detailWithoutValueSchema)
      .parse(sensitive.data)
      .map((row) => ({ ...row, value: null, valueLoaded: false })),
  ].sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id));
}

/** The values of the sensitive details, by id. Refused unless the password gate is open. */
export async function fetchSensitiveValues(
  viewer: Viewer,
  companyId: string,
): Promise<Record<string, string | null>> {
  if (!isUnlocked()) throw new Error("The password gate is locked.");
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchSensitiveValues(companyId);

  const { data, error } = await client()
    .from("company_details")
    .select("id, value")
    .eq("company_id", companyId)
    .eq("is_sensitive", true);
  if (error) throw error;
  const rows = z.array(z.object({ id: z.uuid(), value: z.string().nullable() })).parse(data);
  return Object.fromEntries(rows.map((row) => [row.id, row.value]));
}

export type DetailFields = Pick<CompanyDetail, "label" | "value" | "field_type" | "is_sensitive">;

export async function createDetail(
  viewer: Viewer,
  companyId: string,
  input: DetailFields,
  sortOrder: number,
): Promise<void> {
  if (import.meta.env.DEV && viewer.isDemo) return demoCreateDetail(companyId, input, sortOrder);
  const { data, error } = await client()
    .from("company_details")
    .insert({ ...input, company_id: companyId, sort_order: sortOrder })
    .select("id");
  if (error) throw error;
  expectChanged(data);
}

export async function updateDetail(viewer: Viewer, id: string, input: DetailFields): Promise<void> {
  if (import.meta.env.DEV && viewer.isDemo) return demoUpdateDetail(id, input);
  const { data, error } = await client()
    .from("company_details")
    .update(input)
    .eq("id", id)
    .select("id");
  if (error) throw error;
  expectChanged(data);
}

export async function deleteDetail(viewer: Viewer, id: string): Promise<void> {
  if (import.meta.env.DEV && viewer.isDemo) return demoDeleteDetail(id);
  const { data, error } = await client().from("company_details").delete().eq("id", id).select("id");
  if (error) throw error;
  expectChanged(data);
}

/** Saves new positions. Only the rows that moved are written. */
export async function saveOrder(
  viewer: Viewer,
  table: "company_details" | "company_links",
  changes: readonly { id: string; sort_order: number }[],
): Promise<void> {
  if (changes.length === 0) return;
  if (import.meta.env.DEV && viewer.isDemo)
    return demoSaveOrder(table === "company_details" ? "details" : "links", changes);
  const db = client();
  const results = await Promise.all(
    changes.map((change) =>
      db.from(table).update({ sort_order: change.sort_order }).eq("id", change.id).select("id"),
    ),
  );
  for (const result of results) {
    if (result.error) throw result.error;
    expectChanged(result.data);
  }
}

/** Changes a company's name, address and VAT. The database does not allow the BRN to be changed here. */
export async function updateCompanyCore(
  viewer: Viewer,
  companyId: string,
  input: { name: string; address: string | null; vat: string | null },
): Promise<Company> {
  if (import.meta.env.DEV && viewer.isDemo) return demoUpdateCompanyCore(companyId, input);
  const { data, error } = await client()
    .from("companies")
    .update({ name: input.name, address: input.address, vat: input.vat })
    .eq("id", companyId)
    .select("id, name, address, brn, vat");
  if (error) throw error;
  expectChanged(data);
  return companySchema.parse(data![0]);
}

// ---------------------------------------------------------------- links

export async function fetchLinks(viewer: Viewer, companyId: string): Promise<CompanyLink[]> {
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchLinks(companyId);
  const { data, error } = await client()
    .from("company_links")
    .select(LINK_COLUMNS)
    .eq("company_id", companyId)
    .order("sort_order")
    .order("id");
  if (error) throw error;
  return z.array(linkSchema).parse(data);
}

export type LinkFields = Pick<
  CompanyLink,
  "title" | "url" | "description" | "category" | "icon" | "accent" | "is_pinned"
>;

/**
 * Adds one or more links in a single statement: if any of them is refused (for example a URL
 * the company already has), none is added. Returns how many were added.
 */
export async function createLinks(
  viewer: Viewer,
  companyId: string,
  inputs: readonly LinkFields[],
  firstSortOrder: number,
): Promise<number> {
  if (inputs.length === 0) return 0;
  if (import.meta.env.DEV && viewer.isDemo)
    return demoCreateLinks(companyId, inputs, firstSortOrder);
  const { data, error } = await client()
    .from("company_links")
    .insert(
      inputs.map((input, index) => ({
        title: input.title,
        url: input.url,
        description: input.description,
        category: input.category,
        icon: input.icon,
        accent: input.accent,
        is_pinned: input.is_pinned,
        company_id: companyId,
        sort_order: firstSortOrder + index,
      })),
    )
    .select("id");
  if (error) throw error;
  expectChanged(data);
  return data!.length;
}

export async function updateLink(
  viewer: Viewer,
  id: string,
  patch: Partial<LinkFields>,
): Promise<void> {
  if (import.meta.env.DEV && viewer.isDemo) return demoUpdateLink(id, patch);
  const { data, error } = await client()
    .from("company_links")
    .update(patch)
    .eq("id", id)
    .select("id");
  if (error) throw error;
  expectChanged(data);
}

export async function deleteLink(viewer: Viewer, id: string): Promise<void> {
  if (import.meta.env.DEV && viewer.isDemo) return demoDeleteLink(id);
  const { data, error } = await client().from("company_links").delete().eq("id", id).select("id");
  if (error) throw error;
  expectChanged(data);
}

// ---------------------------------------------------------------- errors

export interface CompanyDataFailure extends DataFailure {
  /** The form field the problem belongs to, when there is one. */
  field?: string;
}

const MIGRATION = {
  details: "0005_company_details.sql",
  links: "0006_company_links.sql",
  company: "0005_company_details.sql",
} as const;

/** Explains a failed read or write on the Company profile or Links screens. */
export function classifyCompanyDataError(
  error: unknown,
  what: keyof typeof MIGRATION,
): CompanyDataFailure {
  const { code, message } = (typeof error === "object" && error !== null ? error : {}) as {
    code?: unknown;
    message?: unknown;
  };
  const text = typeof message === "string" ? message : "";

  if (isMissingTable(error)) {
    return {
      kind: "not-set-up",
      title:
        what === "links"
          ? "Links aren't set up in the database yet"
          : "Company details aren't set up in the database yet",
      message: `The owner needs to run supabase/migrations/${MIGRATION[what]} once in the Supabase SQL editor. Nothing is wrong with your account.`,
      retryable: false,
    };
  }
  if (code === "23505") {
    return what === "links"
      ? {
          kind: "unknown",
          title: "This company already has a link to that address",
          message: "Each address can be added once per company. Edit the existing link instead.",
          retryable: false,
          field: "url",
        }
      : {
          kind: "unknown",
          title: "This company already has a detail with that label",
          message:
            "Each label can be used once per company. Choose a different label, or edit the existing one.",
          retryable: false,
          field: "label",
        };
  }
  if (code === "23514") {
    return {
      kind: "unknown",
      title: "The database rejected these values",
      message:
        "One of them is too long or not in the expected form. Check each field and try again.",
      retryable: false,
    };
  }
  if (code === "42501" && what === "company" && /\bbrn\b/i.test(text)) {
    return {
      kind: "forbidden",
      title: "The BRN can't be changed here",
      message: "Change it in the Supabase SQL editor.",
      retryable: false,
    };
  }
  const general = classifyDataError(error);
  return general.kind === "forbidden"
    ? {
        ...general,
        message: "Only an admin of this company can change this. Ask the owner to check your role.",
      }
    : general;
}
