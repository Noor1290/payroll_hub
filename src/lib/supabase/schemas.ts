import { z } from "zod";

/**
 * Shapes of what the dashboard reads from Supabase. Every response is parsed with these
 * before the UI touches it, so a schema change on the server fails loudly instead of
 * rendering wrong numbers.
 */

export const roleSchema = z.enum(["admin", "viewer"]);
export type Role = z.infer<typeof roleSchema>;

export const companySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  address: z.string().nullable(),
  brn: z.string().nullable(),
  vat: z.string().nullable(),
});
export type Company = z.infer<typeof companySchema>;

/** One row of company_members with its company embedded. */
export const membershipRowSchema = z.object({
  role: roleSchema,
  companies: companySchema,
});

export interface Membership {
  company: Company;
  role: Role;
}

export const runStatusSchema = z.enum(["draft", "approved"]);
export type RunStatus = z.infer<typeof runStatusSchema>;

/** `period` is always the first day of a month, as YYYY-MM-DD. */
const periodSchema = z.string().regex(/^\d{4}-\d{2}-01$/);

export const runSummaryRowSchema = z.object({
  id: z.uuid(),
  period: periodSchema,
  status: runStatusSchema,
  created_by: z.uuid().nullable(),
  created_at: z.string(),
  // PostgREST returns an embedded count as [{ count: n }].
  payroll_entries: z.array(z.object({ count: z.number().int().nonnegative() })),
});

export interface RunSummary {
  id: string;
  period: string;
  status: RunStatus;
  createdBy: string | null;
  createdAt: string;
  entryCount: number;
}

export function toRunSummary(row: z.infer<typeof runSummaryRowSchema>): RunSummary {
  return {
    id: row.id,
    period: row.period,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    entryCount: row.payroll_entries[0]?.count ?? 0,
  };
}

/** numeric(12,2) columns arrive as JSON numbers; tolerate numeric strings too. */
export const moneySchema = z
  .union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)])
  .transform(Number)
  .refine(Number.isFinite);

export const netPayRowSchema = z.object({ net_pay: moneySchema });

/** What import_payroll_run (migration 0002) returns. */
export const importResultSchema = z
  .object({
    run_id: z.uuid(),
    outcome: z.enum(["created", "replaced", "revived"]),
    entries: z.number().int().nonnegative(),
    entries_removed: z.number().int().nonnegative(),
    employees_new: z.number().int().nonnegative(),
    employees_existing: z.number().int().nonnegative(),
  })
  .transform((row) => ({
    runId: row.run_id,
    outcome: row.outcome,
    entries: row.entries,
    entriesRemoved: row.entries_removed,
    employeesNew: row.employees_new,
    employeesExisting: row.employees_existing,
  }));
export type ImportResult = z.infer<typeof importResultSchema>;

export const existingEmployeeSchema = z.object({
  national_id: z.string(),
  surname: z.string(),
  other_names: z.string().nullable(),
  employment_type: z.string().nullable(),
  deleted_at: z.string().nullable(),
});

export const existingRunSchema = z.object({
  id: z.uuid(),
  status: runStatusSchema,
  deleted_at: z.string().nullable(),
});
