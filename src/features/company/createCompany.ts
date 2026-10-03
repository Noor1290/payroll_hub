import { z } from "zod";
import { demoCreateCompany } from "@/lib/demo/demoData";
import { supabase } from "@/lib/supabase/client";
import { classifyDataError, NotConfiguredError, type DataFailure } from "@/lib/supabase/errors";
import type { Viewer } from "@/lib/supabase/queries";
import { companySchema, type Company } from "@/lib/supabase/schemas";
import { createStore } from "@/lib/store";

/** Same limits as the database function (migration 0003), so the form catches them first. */
export const COMPANY_LIMITS = { name: 200, address: 500, brn: 50, vat: 50 } as const;

const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} can be at most ${max} characters.`)
    .transform((value) => (value === "" ? null : value));

/** What the "Add company" form accepts. Strings are trimmed; empty optional fields become null. */
export const newCompanySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Enter the company's name.")
    .max(COMPANY_LIMITS.name, `The name can be at most ${COMPANY_LIMITS.name} characters.`),
  address: optionalText(COMPANY_LIMITS.address, "The address"),
  brn: z
    .string()
    .trim()
    .min(1, "Enter the BRN.")
    .max(COMPANY_LIMITS.brn, `The BRN can be at most ${COMPANY_LIMITS.brn} characters.`),
  vat: optionalText(COMPANY_LIMITS.vat, "The VAT value"),
});
export type NewCompany = z.infer<typeof newCompanySchema>;
export type NewCompanyField = keyof NewCompany;

/** One message per field that failed, for showing next to that field. */
export function fieldErrors(error: z.ZodError): Partial<Record<NewCompanyField, string>> {
  const errors: Partial<Record<NewCompanyField, string>> = {};
  for (const issue of error.issues) {
    const field = issue.path[0] as NewCompanyField;
    errors[field] ??= issue.message;
  }
  return errors;
}

/**
 * Creates a company through the database function `create_company` (migration 0003), which
 * also makes the caller its admin, in one step. There is no other way to create one: the
 * tables themselves accept no inserts from the dashboard.
 */
export async function createCompany(viewer: Viewer, input: NewCompany): Promise<Company> {
  if (import.meta.env.DEV && viewer.isDemo) return demoCreateCompany(input);
  if (!supabase) throw new NotConfiguredError();

  const { data, error } = await supabase.rpc("create_company", {
    p_name: input.name,
    p_address: input.address,
    p_brn: input.brn,
    p_vat: input.vat,
  });
  if (error) throw error;
  return companySchema.parse(data);
}

export interface CreateCompanyFailure extends DataFailure {
  /** The form field the problem belongs to, when there is one. */
  field?: NewCompanyField;
}

const failure = (
  title: string,
  message: string,
  more: Partial<CreateCompanyFailure> = {},
): CreateCompanyFailure => ({ kind: "unknown", title, message, retryable: false, ...more });

/** Explains why a company could not be created. In every case nothing was created. */
export function classifyCreateCompanyError(error: unknown): CreateCompanyFailure {
  const { code, message } = (typeof error === "object" && error !== null ? error : {}) as {
    code?: unknown;
    message?: unknown;
  };
  const text = typeof message === "string" ? message : "";

  // PGRST202: the Data API cannot find the function (42883 is Postgres's own "no such function").
  if (code === "PGRST202" || code === "42883") {
    return failure(
      "Adding companies isn't set up in the database yet",
      "The owner needs to run supabase/migrations/0003_create_company.sql once in the Supabase SQL editor. Nothing was created.",
    );
  }
  if (text.includes("PH_DUPLICATE_BRN") || code === "23505") {
    return failure(
      "A company with this BRN already exists",
      "Each BRN can belong to one company only. Check the BRN; if it is right, the company already exists and the owner can give you access to it. Nothing was created.",
      { field: "brn" },
    );
  }
  if (text.includes("PH_NOT_ADMIN") || text.includes("PH_NOT_SIGNED_IN")) {
    return failure(
      "You're not allowed to add companies",
      "Only someone who is already an admin of a company can add another one. Ask the owner. Nothing was created.",
    );
  }
  if (text.includes("PH_INVALID_INPUT")) {
    const detail = text.replace(/^.*PH_INVALID_INPUT:\s*/, "");
    return failure(
      "The database rejected these details",
      `${detail.charAt(0).toUpperCase()}${detail.slice(1)}. Nothing was created.`,
    );
  }

  const general = classifyDataError(error);
  return { ...general, message: `${general.message} Nothing was created.` };
}

/** Whether the "Add company" dialog is open. Opened from the company switcher and the command palette. */
export const addCompanyOpen = createStore(false);
