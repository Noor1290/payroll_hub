import { z } from "zod";
import { demoFetchDetails } from "@/lib/demo/demoCompanyData";
import { demoMemberships } from "@/lib/demo/demoData";
import { demoFetchMraCompanyDetails } from "@/lib/demo/demoMraReturns";
import { supabase } from "@/lib/supabase/client";
import {
  createDetail,
  updateCompanyCoreIfUnchanged,
  updateDetailValueIfUnchanged,
} from "@/lib/supabase/companyData";
import { classifyDataError, NotConfiguredError } from "@/lib/supabase/errors";
import { saveMraCompanyDetails } from "@/lib/supabase/mraReturns";
import type { Viewer } from "@/lib/supabase/queries";
import type { Membership } from "@/lib/supabase/schemas";

// The companies the user is ADMIN of, as they are in the dashboard now: for the template filled
// in with them, and for the preview of a file uploaded again (what would change). Then the
// update of one company, step by step, each step written only if what it changes is still what
// the preview showed. No React here.
//
// Sensitive details: only their labels are read, never their values, so they are never in the
// file; and the import never changes them.

/** One detail of the Company profile. A sensitive one comes without its value. */
export interface CurrentDetail {
  id: string;
  label: string;
  value: string | null;
  sensitive: boolean;
  sortOrder: number;
}

export interface CurrentMra {
  ern: string;
  telephone: string;
  mobile: string;
  declarant: string;
  revision: number;
}

/** A company the user is admin of, as it is in the dashboard now. */
export interface CurrentCompany {
  id: string;
  name: string;
  brn: string | null;
  address: string | null;
  vat: string | null;
  details: CurrentDetail[];
  /** Null when none are saved yet. */
  mra: CurrentMra | null;
}

/** Ids per request, so the address of a read stays short. */
const CHUNK = 100;
const chunks = <T>(items: readonly T[]): T[][] =>
  Array.from({ length: Math.ceil(items.length / CHUNK) }, (_, i) =>
    items.slice(i * CHUNK, i * CHUNK + CHUNK),
  );

const coreSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  address: z.string().nullable(),
  brn: z.string().nullable(),
  vat: z.string().nullable(),
});
const openDetailSchema = z.object({
  id: z.uuid(),
  company_id: z.uuid(),
  label: z.string(),
  value: z.string().nullable(),
  sort_order: z.number().int(),
});
const sensitiveDetailSchema = openDetailSchema.omit({ value: true });
const mraSchema = z.object({
  company_id: z.uuid(),
  ern: z.string(),
  telephone: z.string(),
  mobile: z.string(),
  declarant: z.string(),
  revision: z.number().int().min(1),
});

/**
 * The companies the user is admin of, read afresh, in the order of `memberships`. Companies the
 * user is only a member of, or not part of, are never asked for. Four reads per 100 companies.
 */
export async function fetchAdminCompanies(
  viewer: Viewer,
  memberships: readonly Membership[],
): Promise<CurrentCompany[]> {
  const ids = memberships.filter((m) => m.role === "admin").map((m) => m.company.id);
  if (ids.length === 0) return [];
  if (import.meta.env.DEV && viewer.isDemo) return demoAdminCompanies(ids);
  if (!supabase) throw new NotConfiguredError();
  const db = supabase;

  const cores: z.infer<typeof coreSchema>[] = [];
  const open: z.infer<typeof openDetailSchema>[] = [];
  const sensitive: z.infer<typeof sensitiveDetailSchema>[] = [];
  const mra: z.infer<typeof mraSchema>[] = [];
  for (const part of chunks(ids)) {
    const [c, o, s, m] = await Promise.all([
      db.from("companies").select("id, name, address, brn, vat").in("id", part),
      db
        .from("company_details")
        .select("id, company_id, label, value, sort_order")
        .in("company_id", part)
        .eq("is_sensitive", false),
      db
        .from("company_details")
        .select("id, company_id, label, sort_order")
        .in("company_id", part)
        .eq("is_sensitive", true),
      db
        .from("mra_company_details")
        .select("company_id, ern, telephone, mobile, declarant, revision")
        .in("company_id", part),
    ]);
    for (const result of [c, o, s, m]) if (result.error) throw result.error;
    cores.push(...z.array(coreSchema).parse(c.data));
    open.push(...z.array(openDetailSchema).parse(o.data));
    sensitive.push(...z.array(sensitiveDetailSchema).parse(s.data));
    mra.push(...z.array(mraSchema).parse(m.data));
  }

  const byId = new Map(cores.map((core) => [core.id, core]));
  return ids.flatMap((id) => {
    const core = byId.get(id);
    if (!core) return [];
    const details: CurrentDetail[] = [
      ...open
        .filter((d) => d.company_id === id)
        .map((d) => ({ ...detailOf(d), value: d.value, sensitive: false })),
      ...sensitive
        .filter((d) => d.company_id === id)
        .map((d) => ({ ...detailOf(d), value: null, sensitive: true })),
    ].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
    const saved = mra.find((m) => m.company_id === id);
    return [
      {
        id,
        name: core.name,
        brn: core.brn,
        address: core.address,
        vat: core.vat,
        details,
        mra: saved
          ? {
              ern: saved.ern,
              telephone: saved.telephone,
              mobile: saved.mobile,
              declarant: saved.declarant,
              revision: saved.revision,
            }
          : null,
      },
    ];
  });
}

const detailOf = (d: { id: string; label: string; sort_order: number }) => ({
  id: d.id,
  label: d.label,
  sortOrder: d.sort_order,
});

async function demoAdminCompanies(ids: string[]): Promise<CurrentCompany[]> {
  const out: CurrentCompany[] = [];
  for (const id of ids) {
    const membership = demoMemberships.find((m) => m.company.id === id && m.role === "admin");
    if (!membership) continue;
    const [details, mra] = await Promise.all([
      demoFetchDetails(id),
      demoFetchMraCompanyDetails(id),
    ]);
    const { name, brn, address, vat } = membership.company;
    out.push({
      id,
      name,
      brn,
      address,
      vat,
      details: details.map((d) => ({
        id: d.id,
        label: d.label,
        value: d.is_sensitive ? null : d.value,
        sensitive: d.is_sensitive,
        sortOrder: d.sort_order,
      })),
      mra: mra
        ? {
            ern: mra.ern,
            telephone: mra.telephone,
            mobile: mra.mobile,
            declarant: mra.declarant,
            revision: mra.revision,
          }
        : null,
    });
  }
  return out;
}

// ---------- what a row of the file would change ----------

export type CoreField = "name" | "address" | "vat";
export type MraField = "ern" | "telephone" | "mobile" | "declarant";

/** One value to change. `before` null: empty, or (for a detail) not there yet. */
export type Change =
  | { kind: "core"; field: CoreField; label: string; before: string | null; after: string }
  | {
      kind: "detail";
      /** Null: a new detail with this label. */
      id: string | null;
      label: string;
      before: string | null;
      after: string;
    }
  | { kind: "mra"; field: MraField; label: string; before: string | null; after: string };

export interface Comparison {
  changes: Change[];
  /** Labels of values the file leaves empty: left as they are. */
  leftAsIs: string[];
  /** Labels of sensitive details the file has a value for: never changed here. */
  sensitive: string[];
}

const CORE_LABELS: Record<CoreField, string> = { name: "Name", address: "Address", vat: "VAT" };
export const MRA_LABELS: Record<MraField, string> = {
  ern: "ERN",
  telephone: "Telephone",
  mobile: "Mobile",
  declarant: "Name of declarant",
};

/** A value as compared: spaces at the ends ignored, Windows line breaks the same as others. */
export const sameText = (a: string | null | undefined, b: string | null | undefined) =>
  norm(a) === norm(b);
const norm = (text: string | null | undefined) => (text ?? "").replace(/\r\n?/g, "\n").trim();

/** What one row of the file would change in a company the user is admin of. */
export function compareRow(
  row: {
    name: string;
    address: string | null;
    vat: string | null;
    details: { label: string; value: string }[];
    emptyDetails: string[];
    mra: Record<MraField, string>;
  },
  company: CurrentCompany,
): Comparison {
  const changes: Change[] = [];
  const leftAsIs: string[] = [];
  const sensitive: string[] = [];

  const core = (field: CoreField, value: string | null) => {
    const before = company[field];
    if (value === null || value === "") {
      if (norm(before) !== "") leftAsIs.push(CORE_LABELS[field]);
    } else if (!sameText(before, value)) {
      changes.push({ kind: "core", field, label: CORE_LABELS[field], before, after: value });
    }
  };
  core("name", row.name);
  core("address", row.address);
  core("vat", row.vat);

  const detailNamed = (label: string) =>
    company.details.find((d) => d.label.toLowerCase() === label.toLowerCase());
  for (const { label, value } of row.details) {
    const existing = detailNamed(label);
    if (existing?.sensitive) sensitive.push(existing.label);
    else if (!existing)
      changes.push({ kind: "detail", id: null, label, before: null, after: value });
    else if (!sameText(existing.value, value)) {
      changes.push({
        kind: "detail",
        id: existing.id,
        label: existing.label,
        before: existing.value,
        after: value,
      });
    }
  }
  for (const label of row.emptyDetails) {
    const existing = detailNamed(label);
    if (existing && !existing.sensitive && norm(existing.value) !== "")
      leftAsIs.push(existing.label);
  }

  for (const field of ["ern", "telephone", "mobile", "declarant"] as const) {
    const before = company.mra?.[field] ?? null;
    const value = row.mra[field];
    if (value === "") {
      if (norm(before) !== "") leftAsIs.push(MRA_LABELS[field]);
    } else if (!sameText(before, value)) {
      changes.push({ kind: "mra", field, label: MRA_LABELS[field], before, after: value });
    }
  }
  return { changes, leftAsIs, sensitive };
}

/** "Address: 1 Old Street → 2 New Street; TAN: 0012 → 0013" (an empty value as "(empty)"). */
export function changesText(changes: readonly Change[]): string {
  const shown = (value: string | null) => {
    const text = norm(value).replace(/\n+/g, ", ");
    return text === "" ? "(empty)" : text;
  };
  return changes
    .map((change) => `${change.label}: ${shown(change.before)} → ${shown(change.after)}`)
    .join("; ");
}

// ---------- updating one company ----------

export interface UpdateOutcome {
  /** The changes written. */
  saved: Change[];
  /** The changes not written, with why; empty when all were written. */
  notSaved: Change[];
  /** Why the first of `notSaved` was not written (and the rest not tried). */
  why: string | null;
  /** True when it stopped because the company was changed after the preview. */
  stale: boolean;
}

/** Thrown inside `updateCompany` when a value is no longer what the preview showed. */
class Stale extends Error {}

/**
 * Writes the changes of one company in three steps: its name, address and VAT (one statement);
 * then each detail; then its MRA details. Each write happens only if what it changes is still
 * what the preview showed. It stops at the first refusal, and says what was written and what was
 * not.
 */
export async function updateCompany(
  viewer: Viewer,
  company: CurrentCompany,
  changes: readonly Change[],
): Promise<UpdateOutcome> {
  const steps: { changes: Change[]; run: () => Promise<void> }[] = [];

  const core = changes.filter((c): c is Extract<Change, { kind: "core" }> => c.kind === "core");
  if (core.length > 0) {
    const before = { name: company.name, address: company.address, vat: company.vat };
    const after = { ...before };
    for (const change of core) after[change.field] = change.after;
    steps.push({
      changes: core,
      run: async () => {
        if (!(await updateCompanyCoreIfUnchanged(viewer, company.id, before, after)))
          throw new Stale();
      },
    });
  }

  let nextOrder = Math.max(-1, ...company.details.map((d) => d.sortOrder)) + 1;
  for (const change of changes) {
    if (change.kind !== "detail") continue;
    const id = change.id;
    const order = id === null ? nextOrder++ : 0;
    steps.push({
      changes: [change],
      run: async () => {
        if (id !== null) {
          if (!(await updateDetailValueIfUnchanged(viewer, id, change.before, change.after)))
            throw new Stale();
          return;
        }
        try {
          await createDetail(
            viewer,
            company.id,
            { label: change.label, value: change.after, field_type: "text", is_sensitive: false },
            order,
          );
        } catch (error) {
          // A detail with this label was added after the preview.
          if ((error as { code?: unknown } | null)?.code === "23505") throw new Stale();
          throw error;
        }
      },
    });
  }

  const mra = changes.filter((c): c is Extract<Change, { kind: "mra" }> => c.kind === "mra");
  if (mra.length > 0) {
    const values = {
      ern: company.mra?.ern ?? "",
      telephone: company.mra?.telephone ?? "",
      mobile: company.mra?.mobile ?? "",
      declarant: company.mra?.declarant ?? "",
    };
    for (const change of mra) values[change.field] = change.after;
    steps.push({
      changes: mra,
      run: async () => {
        try {
          await saveMraCompanyDetails(viewer, company.id, {
            ...values,
            expectedRevision: company.mra?.revision ?? 0,
          });
        } catch (error) {
          if (String((error as { message?: unknown } | null)?.message ?? "").includes("PH_STALE"))
            throw new Stale();
          throw error;
        }
      },
    });
  }

  const saved: Change[] = [];
  for (const [index, step] of steps.entries()) {
    try {
      await step.run();
      saved.push(...step.changes);
    } catch (error) {
      const notSaved = steps.slice(index).flatMap((s) => s.changes);
      if (error instanceof Stale) return { saved, notSaved, why: null, stale: true };
      return { saved, notSaved, why: updateFailureReason(error), stale: false };
    }
  }
  return { saved, notSaved: [], why: null, stale: false };
}

/** Why a value was not written, in a few words. */
export function updateFailureReason(error: unknown): string {
  const { code, message } = (typeof error === "object" && error !== null ? error : {}) as {
    code?: unknown;
    message?: unknown;
  };
  const text = typeof message === "string" ? message : "";
  if (text.includes("PH_NOT_ADMIN") || code === "42501") return "you are no longer its admin";
  if (text.includes("PH_INVALID_INPUT")) {
    const detail = text.replace(/^.*PH_INVALID_INPUT:?\s*/, "").slice(0, 200);
    return `the database refused the value${detail ? `: ${detail}` : ""}`;
  }
  const { title } = classifyDataError(error);
  return title.charAt(0).toLowerCase() + title.slice(1).replace(/\.$/, "");
}
