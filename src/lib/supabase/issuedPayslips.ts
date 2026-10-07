import { z } from "zod";
import { demoFetchIssuedPayslips, demoIssuePayslips } from "@/lib/demo/demoAppData";
import { supabase } from "./client";
import { NotConfiguredError } from "./errors";
import type { Viewer } from "./queries";

/**
 * Issued payslips (migration 0011_issued_payslips.sql): what was issued to each employee for a
 * month, one immutable row per revision. They hold salaries and national IDs: only an admin of
 * the company can read them, and rows are added only through the database function, a whole
 * month's selection at a time (all of it, or none).
 */

/** The file the owner runs to set this up; named in messages when the table is not there. */
export const ISSUED_MIGRATION = "0011_issued_payslips.sql";

const objectSchema = z.record(z.string(), z.unknown());
const monthStartSchema = z.string().regex(/^\d{4}-\d{2}-01$/);

/** One payslip of a month to issue, in the words the database function reads. */
export interface PayslipInput {
  national_id: string;
  /** The revision the caller last saw for this employee and month; 0 for none. */
  expected_revision: number;
  template_id: string;
  template_version: number;
  /** The statutory rates the figures were cross-checked against; null = not cross-checked. */
  rates: Record<string, unknown> | null;
  lines: Record<string, unknown>[];
  accepted_differences: Record<string, unknown>[];
}

const issuedSchema = z.object({
  national_id: z.string(),
  revision: z.number().int().min(1),
  template_id: z.uuid(),
  template_version: z.number().int().min(1),
  rates: objectSchema.nullable(),
  lines: z.array(objectSchema),
  accepted_differences: z.array(objectSchema),
  /** A user id: it must not leave the dashboard. The handler turns it into "was it you". */
  issued_by: z.uuid().nullable(),
  issued_at: z.string(),
});
export type IssuedPayslip = z.infer<typeof issuedSchema>;

const issuedMonthSchema = z.object({
  period: monthStartSchema,
  issued: z.number().int().min(1),
  issued_at: z.string(),
  payslips: z.array(z.object({ national_id: z.string(), revision: z.number().int().min(1) })),
});
export type IssuedMonth = z.infer<typeof issuedMonthSchema>;

/**
 * A month's issued payslips: the latest revision of each employee, by national ID. Read with
 * the user's own permissions through `issued_payslips_for_month`; anyone who is not an admin
 * of the company gets an empty list from the database.
 *
 * `period` is the first day of the month, "YYYY-MM-01".
 */
export async function fetchIssuedPayslips(
  viewer: Viewer,
  companyId: string,
  period: string,
): Promise<IssuedPayslip[]> {
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchIssuedPayslips(companyId, period);
  if (!supabase) throw new NotConfiguredError();

  const { data, error } = await supabase.rpc("issued_payslips_for_month", {
    p_company_id: companyId,
    p_period: period,
  });
  if (error) throw error;
  return z.array(issuedSchema).parse(data);
}

/**
 * Issues a month's selection through `issue_payslips`: every payslip is stored at its next
 * revision, or none is. The database decides: admin of that company, each employee and
 * template version belongs to it, and each `expected_revision` is still the latest (PH_STALE
 * otherwise). A refusal about one payslip says which by its position ("payslip 3").
 */
export async function issuePayslips(
  viewer: Viewer,
  companyId: string,
  period: string,
  payslips: PayslipInput[],
): Promise<IssuedMonth> {
  if (import.meta.env.DEV && viewer.isDemo) return demoIssuePayslips(companyId, period, payslips);
  if (!supabase) throw new NotConfiguredError();

  const { data, error } = await supabase.rpc("issue_payslips", {
    p_company_id: companyId,
    p_period: period,
    p_payslips: payslips,
  });
  if (error) throw error;
  return issuedMonthSchema.parse(data);
}
