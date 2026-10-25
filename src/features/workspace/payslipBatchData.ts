import { z } from "zod";
import { PAYSLIP_BATCH } from "@/config/apps.config";
import { toExportRow } from "@/config/payrollFields";
import { handleDataRequest, registerDataType } from "@/lib/bridge/bridge";
import type { RequestDataPayload, ResponseDataPayload } from "@/lib/bridge/protocol";
import { formatPeriod } from "@/lib/format";
import { registerSessionCleanup } from "@/lib/sessionCleanup";
import { fetchIssuedPayslips } from "@/lib/supabase/issuedPayslips";
import { fetchRunEntries, fetchRuns } from "@/lib/supabase/payroll";
import {
  fetchTemplateInUse,
  fetchTemplates,
  fetchTemplateVersion,
  IN_USE_MIGRATION,
} from "@/lib/supabase/payslipTemplates";
import type { Viewer } from "@/lib/supabase/queries";
import type { Membership } from "@/lib/supabase/schemas";
import { fetchStatutoryRates } from "@/lib/supabase/statutoryRates";
import { isUnlocked, registerLockCleanup } from "@/lib/unlock";
import {
  answerMeta,
  brnSchema,
  exchangeContextFor,
  invalidRefusal,
  normaliseBrn,
  refusalFor,
  refuse,
} from "./appData";
import {
  adminCompanies,
  BATCH_ALLOWED_MS,
  batchPermits,
  countCompanies as companies,
  listNames,
} from "./batchAccess";
import { answerRequest } from "./deliver";

export { BATCH_ALLOWED_MS };

/**
 * Payslips for several companies at once (docs/INTEGRATION.md, "payslip-batch"). Download only:
 * nothing is saved through this data type. Per-employee data (national IDs and pay), so:
 *
 *  - Only companies the user is an ADMIN of, read from the database each time.
 *  - `ask` asks the user once, in the same dialog as a saved run, with the password gate open:
 *    which month and how many companies. Agreeing allows `load` for those companies and that
 *    month only, for this app, user and selected company, for 15 minutes, while the gate stays
 *    open. The permission is kept in memory only and goes when the gate locks or on sign-out.
 *  - `load` answers ONE company at a time: its saved run of that month (the rows "Get from
 *    dashboard" gives), the template its payslips use, and its statutory rates. Refused at once
 *    when it was not allowed, when the gate is locked, or when the user is no longer its admin.
 *
 * `companies` (names and BRNs of the user's admin companies) needs no dialog: nothing in it is
 * per employee. Everything else stays scoped to the selected company, as before.
 */

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

/** The most companies an `ask` may name; for more, it asks for all of the user's companies. */
export const ASK_MAX_COMPANIES = 100;

const paramsSchema = z.discriminatedUnion("action", [
  // The BRN is optional here, as on other lists: the answer says which company is selected.
  z.strictObject({ action: z.literal("companies"), brn: brnSchema.optional() }),
  z
    .strictObject({
      action: z.literal("ask"),
      brn: brnSchema,
      period: monthSchema,
      /** The companies chosen, by BRN; or `all: true` for every company the user is an admin of. */
      companies: z.array(brnSchema).min(1).max(ASK_MAX_COMPANIES).optional(),
      all: z.literal(true).optional(),
    })
    .refine((params) => (params.companies === undefined) !== (params.all === undefined), {
      path: ["companies"],
    }),
  z.strictObject({
    action: z.literal("load"),
    brn: brnSchema,
    period: monthSchema,
    company_brn: brnSchema,
  }),
]);

/** What the user allowed in the dialog (batchAccess.ts). One at a time; a new ask replaces it. */
const permits = batchPermits();

/** Forgets what was allowed. For tests, and when the gate locks or the user signs out. */
export function forgetBatchAllowed(): void {
  permits.forget();
}
registerSessionCleanup(forgetBatchAllowed);
registerLockCleanup(forgetBatchAllowed);

const READ_LOCKED = refuse(
  "locked",
  "The dashboard is locked. Confirm your password there to unlock it, then ask again.",
);
const NOT_ALLOWED = refuse(
  "denied",
  "That company and month were not allowed in the dashboard for this app. Ask again.",
);

/** "ABC Co Ltd, DEF Ltd and GHI Ltd" or "ABC Co Ltd, DEF Ltd, GHI Ltd and 7 more". */
const someNames = (names: readonly string[]) => listNames(names, 3);

/**
 * The template a company's payslips use, by the owner's rule: the version chosen in the dashboard
 * (migration 0018); otherwise its one published template; none or several is no template.
 */
async function templateOf(viewer: Viewer, companyId: string) {
  const inUse = await fetchTemplateInUse(viewer, companyId);
  if (inUse) {
    const chosen = await fetchTemplateVersion(viewer, companyId, inUse.template_id, inUse.version);
    if (chosen) return { template: chosen, reason: null };
  }
  const published = (await fetchTemplates(viewer, companyId)).filter((item) => item.published);
  if (published.length !== 1) {
    return { template: null, reason: published.length === 0 ? "none" : "several" } as const;
  }
  const [only] = published;
  const latest = await fetchTemplateVersion(viewer, companyId, only!.id, only!.published!.version);
  return latest ? { template: latest, reason: null } : { template: null, reason: "none" as const };
}

/**
 * One company for the batch: its run of the month, its template, its rates, and the payslips
 * already issued for that month (the latest revision of each), so that one issued and unchanged
 * is downloaded exactly as it was issued.
 */
async function loadCompany(
  viewer: Viewer,
  target: Membership,
  period: string,
): Promise<Record<string, unknown>> {
  const { company } = target;
  const [runs, chosen, rates, issued] = await Promise.all([
    fetchRuns(viewer, company.id),
    templateOf(viewer, company.id),
    fetchStatutoryRates(viewer, company.id),
    fetchIssuedPayslips(viewer, company.id, `${period}-01`),
  ]);
  const run = runs.find((found) => found.period === `${period}-01`);
  const entries = run ? await fetchRunEntries(viewer, run.id) : [];
  return {
    brn: company.brn,
    company: company.name.slice(0, 120),
    period,
    run: run !== undefined,
    employees: entries.map((row) => toExportRow(row, company)),
    template: chosen.template && {
      template_id: chosen.template.template_id,
      name: chosen.template.name,
      version: chosen.template.version,
      body: chosen.template.body,
    },
    template_reason: chosen.reason,
    rates: rates.map(({ created_by, effective_from, ...row }) => ({
      effective_from: effective_from.slice(0, 7),
      ...row,
      // Not the user's id: only whether it was the person now signed in.
      created_by_you: created_by !== null && created_by === viewer.id,
    })),
    issued: issued.map(({ issued_by, ...row }) => ({
      ...row,
      // Not the user's id: only whether it was the person now signed in.
      issued_by_you: issued_by !== null && issued_by === viewer.id,
    })),
  };
}

/** Answers the payslip app's requests for several companies. */
export async function answerBatchRequest(
  appId: string,
  payload: RequestDataPayload,
): Promise<ResponseDataPayload> {
  const params = paramsSchema.safeParse(payload.params ?? {});
  if (!params.success) return invalidRefusal(params.error);
  const current = exchangeContextFor(params.data.brn);
  if ("ok" in current) return current;
  const { viewer, membership } = current;
  const meta = (period?: string) => ({ ...answerMeta(membership), ...(period ? { period } : {}) });

  try {
    if (params.data.action === "companies") {
      const admin = await adminCompanies(viewer, membership.company.id);
      return {
        ok: true,
        dataType: PAYSLIP_BATCH,
        rows: admin.map(({ company }) => ({
          brn: company.brn,
          name: company.name.slice(0, 120),
          selected: company.id === membership.company.id,
        })),
        meta: meta(),
      };
    }

    if (params.data.action === "ask") {
      const { period, companies: wanted, all } = params.data;
      const admin = await adminCompanies(viewer, membership.company.id);
      const byBrn = new Map(admin.map((one) => [normaliseBrn(one.company.brn!), one]));
      const chosen = all
        ? admin
        : [...new Set(wanted!.map(normaliseBrn))].map((brn) => byBrn.get(brn) ?? null);
      if (chosen.some((one) => one === null) || chosen.length === 0) {
        return refuse("forbidden", "Only companies where you are an admin can be chosen.");
      }
      const names = (chosen as Membership[]).map((one) => one.company.name);
      const month = formatPeriod(`${period}-01`);
      return handleDataRequest(appId, payload, {
        what: all
          ? `the ${month} payroll of all your ${companies(names.length)}`
          : `the ${month} payroll of ${companies(names.length)}`,
        of: all ? undefined : someNames(names),
        warning:
          "This sends each company's saved run for that month, with national IDs and pay, with its payslip template, its rates and the payslips already issued for that month, to the app, one company at a time, for the next 15 minutes.",
        answer: async () => {
          // Asked again: the dialog may have been open for a while.
          const again = exchangeContextFor(params.data.brn);
          if ("ok" in again) return again;
          if (!isUnlocked()) return READ_LOCKED;
          const still = await adminCompanies(again.viewer, again.membership.company.id);
          const stillBrns = new Set(still.map((one) => normaliseBrn(one.company.brn!)));
          const granted = (chosen as Membership[]).filter((one) =>
            stillBrns.has(normaliseBrn(one.company.brn!)),
          );
          permits.allow({
            appId,
            userId: again.viewer.id,
            selectedCompanyId: again.membership.company.id,
            period,
            brns: new Set(granted.map((one) => normaliseBrn(one.company.brn!))),
            until: Date.now() + BATCH_ALLOWED_MS,
          });
          return {
            ok: true,
            dataType: PAYSLIP_BATCH,
            rows: granted.map(({ company }) => ({
              brn: company.brn,
              name: company.name.slice(0, 120),
            })),
            meta: { ...answerMeta(again.membership), period },
          };
        },
      });
    }

    const { period, company_brn: companyBrn } = params.data;
    const wanted = normaliseBrn(companyBrn);
    if (
      !permits.allows({
        appId,
        userId: viewer.id,
        selectedCompanyId: membership.company.id,
        period,
        brn: wanted,
      })
    ) {
      return NOT_ALLOWED;
    }
    if (!isUnlocked()) return READ_LOCKED;
    const target = (await adminCompanies(viewer, membership.company.id)).find(
      (one) => normaliseBrn(one.company.brn!) === wanted,
    );
    if (!target) return refuse("forbidden", "Only an admin of that company can make its payslips.");
    const row = await loadCompany(viewer, target, period);
    // The gate may have locked while the database was answering: then nothing leaves.
    if (!isUnlocked()) return READ_LOCKED;
    return { ok: true, dataType: PAYSLIP_BATCH, rows: [row], meta: meta(period) };
  } catch (error) {
    if (params.data.action === "load" && !isUnlocked()) return READ_LOCKED;
    return refusalFor(error, IN_USE_MIGRATION);
  }
}

registerDataType(PAYSLIP_BATCH, {
  request: (appId, payload) =>
    answerRequest(appId, PAYSLIP_BATCH, () => answerBatchRequest(appId, payload)),
});
