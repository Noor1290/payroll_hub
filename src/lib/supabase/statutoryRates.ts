import { z } from "zod";
import { demoFetchStatutoryRates, demoSaveStatutoryRates } from "@/lib/demo/demoAppData";
import { supabase } from "./client";
import { NotConfiguredError } from "./errors";
import type { Viewer } from "./queries";
import { moneySchema } from "./schemas";

/**
 * Statutory rates (migration 0009_statutory_rates.sql): the employee-side NSF and CSG settings
 * of a company from a given month. Rows are never changed: a correction is a new revision.
 * Members read; admins add a revision, only through the database function.
 */

/** The file the owner runs to set this up; named in messages when the table is not there. */
export const RATES_MIGRATION = "0009_statutory_rates.sql";

const versionSchema = z.object({
  /** The first day of the first month these values apply to, "YYYY-MM-DD". */
  effective_from: z.string().regex(/^\d{4}-\d{2}-01$/),
  revision: z.number().int().min(1),
  // numeric columns: the same "number, or a numeric string" tolerance as the money columns.
  nsf_employee_rate: moneySchema,
  nsf_ceiling: moneySchema,
  nsf_exempt_at_60: z.boolean(),
  csg_employee_rate_low: moneySchema,
  csg_employee_rate_high: moneySchema,
  csg_threshold: moneySchema,
  source_note: z.string().nullable(),
  created_by: z.uuid().nullable(),
  created_at: z.string(),
});
export type RatesVersion = z.infer<typeof versionSchema>;

const COLUMNS =
  "effective_from, revision, nsf_employee_rate, nsf_ceiling, nsf_exempt_at_60, csg_employee_rate_low, csg_employee_rate_high, csg_threshold, source_note, created_by, created_at";

/** The table never holds more than this per company (the function refuses the next one). */
const MAX_VERSIONS = 1000;

export interface RatesInput {
  /** First day of the month, "YYYY-MM-01". */
  effectiveFrom: string;
  /** The latest revision the caller has seen for that month; 0 when there is none. */
  expectedRevision: number;
  nsfEmployeeRate: number;
  nsfCeiling: number;
  nsfExemptAt60: boolean;
  csgEmployeeRateLow: number;
  csgEmployeeRateHigh: number;
  csgThreshold: number;
  sourceNote: string | null;
}

const savedSchema = z.object({
  effective_from: z.string().regex(/^\d{4}-\d{2}-01$/),
  revision: z.number().int().min(1),
});
export type SavedRates = z.infer<typeof savedSchema>;

/** Every version of a company's rates, newest month first, then newest revision first. */
export async function fetchStatutoryRates(
  viewer: Viewer,
  companyId: string,
): Promise<RatesVersion[]> {
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchStatutoryRates(companyId);
  if (!supabase) throw new NotConfiguredError();

  const { data, error } = await supabase
    .from("statutory_rates")
    .select(COLUMNS)
    .eq("company_id", companyId)
    .order("effective_from", { ascending: false })
    .order("revision", { ascending: false })
    .range(0, MAX_VERSIONS - 1);
  if (error) throw error;
  return z.array(versionSchema).parse(data);
}

/**
 * Adds one revision through \`save_statutory_rates\`. The database decides: admin of that
 * company, values in range and not more precise than it stores, and \`expectedRevision\` still
 * the latest. It refuses (PH_STALE, PH_NO_CHANGE, ...) instead of storing a second copy.
 */
export async function saveStatutoryRates(
  viewer: Viewer,
  companyId: string,
  input: RatesInput,
): Promise<SavedRates> {
  if (import.meta.env.DEV && viewer.isDemo) return demoSaveStatutoryRates(companyId, input);
  if (!supabase) throw new NotConfiguredError();

  const { data, error } = await supabase.rpc("save_statutory_rates", {
    p_company_id: companyId,
    p_effective_from: input.effectiveFrom,
    p_expected_revision: input.expectedRevision,
    p_nsf_employee_rate: input.nsfEmployeeRate,
    p_nsf_ceiling: input.nsfCeiling,
    p_nsf_exempt_at_60: input.nsfExemptAt60,
    p_csg_employee_rate_low: input.csgEmployeeRateLow,
    p_csg_employee_rate_high: input.csgEmployeeRateHigh,
    p_csg_threshold: input.csgThreshold,
    p_source_note: input.sourceNote,
  });
  if (error) throw error;
  return savedSchema.parse(data);
}
