import { z } from "zod";
import { demoFetchMemberships, demoFetchOverview } from "@/lib/demo/demoData";
import { sumMoney } from "@/lib/format";
import { supabase } from "./client";
import { NotConfiguredError } from "./errors";
import { fetchAllRows } from "./paginate";
import {
  membershipRowSchema,
  netPayRowSchema,
  runSummaryRowSchema,
  toRunSummary,
  type Membership,
  type RunSummary,
} from "./schemas";

/** Who is asking. Demo users (dev only) are answered from fake data and never reach Supabase. */
export interface Viewer {
  id: string;
  isDemo: boolean;
}

function client() {
  if (!supabase) throw new NotConfiguredError();
  return supabase;
}

export const RECENT_RUNS_LIMIT = 5;

/** The companies the signed-in user belongs to, with their role in each, sorted by name. */
export async function fetchMemberships(viewer: Viewer): Promise<Membership[]> {
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchMemberships();

  // Admins can also see their colleagues' membership rows, so filter to our own.
  const { data, error } = await client()
    .from("company_members")
    .select("role, companies(id, name, address, brn, vat)")
    .eq("user_id", viewer.id);
  if (error) throw error;

  return z
    .array(membershipRowSchema)
    .parse(data)
    .map((row) => ({ company: row.companies, role: row.role }))
    .sort((a, b) => a.company.name.localeCompare(b.company.name));
}

export interface Overview {
  employeeCount: number;
  runCount: number;
  /** Newest first, at most RECENT_RUNS_LIMIT. */
  recentRuns: RunSummary[];
  /** Sum of net pay across the newest run's entries; null when there are no runs. */
  latestRunNetPay: number | null;
}

async function fetchRunNetPayTotal(runId: string): Promise<number> {
  const rows = await fetchAllRows(async (from, to) => {
    const { data, error } = await client()
      .from("payroll_entries")
      .select("net_pay")
      .eq("run_id", runId)
      .order("id")
      .range(from, to);
    if (error) throw error;
    return z.array(netPayRowSchema).parse(data);
  });
  return sumMoney(rows.map((row) => row.net_pay));
}

export async function fetchOverview(viewer: Viewer, companyId: string): Promise<Overview> {
  if (import.meta.env.DEV && viewer.isDemo) return demoFetchOverview(companyId);

  const db = client();
  const [employees, runs] = await Promise.all([
    db
      .from("employees")
      .select("id", { count: "exact", head: true })
      .eq("company_id", companyId)
      .is("deleted_at", null),
    db
      .from("payroll_runs")
      .select("id, period, status, created_by, created_at, payroll_entries(count)", {
        count: "exact",
      })
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .order("period", { ascending: false })
      .limit(RECENT_RUNS_LIMIT),
  ]);
  if (employees.error) throw employees.error;
  if (runs.error) throw runs.error;

  const recentRuns = z.array(runSummaryRowSchema).parse(runs.data).map(toRunSummary);
  const latest = recentRuns[0];

  return {
    employeeCount: z.number().int().nonnegative().parse(employees.count),
    runCount: z.number().int().nonnegative().parse(runs.count),
    recentRuns,
    latestRunNetPay: latest ? await fetchRunNetPayTotal(latest.id) : null,
  };
}
