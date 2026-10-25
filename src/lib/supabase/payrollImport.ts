import { z } from "zod";
import { supabase } from "./client";
import { NotConfiguredError } from "./errors";
import type { Viewer } from "./queries";

/**
 * Importing one company of a "Several companies" Excel file (migration 0019): the company (new
 * or existing), its column setup when it has none yet, and its months, in ONE call that stores
 * all of it or nothing.
 */
export const PAYROLL_IMPORT_MIGRATION = "0019_import_payroll_company.sql";

const importedSchema = z.object({
  company_id: z.uuid(),
  brn: z.string().nullable(),
  name: z.string(),
  created: z.boolean(),
  shared_setup_id: z.uuid(),
  shared_created: z.boolean(),
  attached: z.boolean(),
  shared_revision: z.number().int().min(1),
  company_revision: z.number().int().min(1),
  months: z.array(
    z.object({
      period: z.string(),
      revision: z.number().int().min(1),
      employee_count: z.number().int().min(0),
      replaced: z.boolean(),
    }),
  ),
});
export type ImportedCompany = z.infer<typeof importedSchema>;

export interface ImportInput {
  /** An existing company; null for a new one. */
  companyId: string | null;
  newCompany: { name: string; brn: string; address: string | null } | null;
  /** Only for a company with no column setup yet. */
  setup: {
    shared_setup_id: string;
    create: boolean;
    name?: string;
    shared_body?: Record<string, unknown>;
    company_body: Record<string, unknown>;
  } | null;
  /** Only for a company that has a column setup: the revisions the file was checked against. */
  expected: { shared_revision: number; company_revision: number } | null;
  months: {
    /** "YYYY-MM-01" */
    period: string;
    employees: Record<string, unknown>[];
    expected_revision: number;
    replace: boolean;
  }[];
}

function client() {
  if (!supabase) throw new NotConfiguredError();
  return supabase;
}

/** Imports one company, all or nothing. The demo workspace has no database to do it in. */
export async function importPayrollCompany(
  viewer: Viewer,
  input: ImportInput,
): Promise<ImportedCompany> {
  if (import.meta.env.DEV && viewer.isDemo) throw new NotConfiguredError();
  const { data, error } = await client().rpc("import_payroll_company", {
    p_company_id: input.companyId,
    p_new_company: input.newCompany,
    p_setup: input.setup,
    p_expected: input.expected,
    p_months: input.months,
  });
  if (error) throw error;
  return importedSchema.parse(data);
}
