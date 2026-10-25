import { z } from "zod";
import { PAYROLL_BATCH } from "@/config/apps.config";
import { handleDataRequest, registerDataType } from "@/lib/bridge/bridge";
import type { RequestDataPayload, ResponseDataPayload } from "@/lib/bridge/protocol";
import { formatPeriod } from "@/lib/format";
import { registerSessionCleanup } from "@/lib/sessionCleanup";
import { fetchMonths, PAYROLL_MONTHS_MIGRATION } from "@/lib/supabase/payrollMonths";
import {
  fetchCompanySetup,
  fetchCompanySetupLinks,
  fetchSharedSetup,
} from "@/lib/supabase/payrollSetups";
import type { Viewer } from "@/lib/supabase/queries";
import type { Membership } from "@/lib/supabase/schemas";
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
  countCompanies,
  listNames,
} from "./batchAccess";
import { answerRequest } from "./deliver";
import { gatedRead } from "./payrollMonthData";

/**
 * The payroll app's months of several companies at once, for one Excel file
 * (docs/INTEGRATION.md, "payroll-batch"). Read only: nothing is saved through this data type.
 * National IDs and salaries, so it works as payslip-batch does (batchAccess.ts):
 *
 *  - Only companies the user is an ADMIN of, read from the database each time.
 *  - `ask` asks the user once, with the password gate open, naming the month and every company
 *    chosen. Agreeing allows `load` for those companies and that month only, for 15 minutes,
 *    in memory only; it goes when the gate locks or on sign-out.
 *  - `load` answers ONE company: its saved month (the employees exactly as the app saved them)
 *    and its column setup (the shared setup and its own, as the app saved them), so the app can
 *    work out the figures as it shows them. Refused at once when it was not allowed, when the
 *    gate is locked, or when the user is no longer its admin.
 *
 * `companies` (names and BRNs of the user's admin companies, and whether each has a column
 * setup) needs no dialog: nothing in it is per employee.
 */

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

/** The most companies one `ask` may name. */
export const EXPORT_MAX_COMPANIES = 200;

const paramsSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("companies"), brn: brnSchema.optional() }),
  z.strictObject({
    action: z.literal("ask"),
    brn: brnSchema,
    period: monthSchema,
    /** The companies chosen, by BRN. Always named: the question lists every one of them. */
    companies: z.array(brnSchema).min(1).max(EXPORT_MAX_COMPANIES),
  }),
  z.strictObject({
    action: z.literal("load"),
    brn: brnSchema,
    period: monthSchema,
    company_brn: brnSchema,
  }),
]);

/** What the user allowed in the dialog. One at a time; a new ask replaces it. */
const permits = batchPermits();

/** Forgets what was allowed. For tests, and when the gate locks or the user signs out. */
export function forgetPayrollBatchAllowed(): void {
  permits.forget();
}
registerSessionCleanup(forgetPayrollBatchAllowed);
registerLockCleanup(forgetPayrollBatchAllowed);

const READ_LOCKED = refuse(
  "locked",
  "The dashboard is locked. Confirm your password there to unlock it, then ask again.",
);
const NOT_ALLOWED = refuse(
  "denied",
  "That company and month were not allowed in the dashboard for this app. Ask again.",
);

/** One company for the file: its month and its column setup, each null when there is none. */
async function loadCompany(
  viewer: Viewer,
  target: Membership,
  period: string,
): Promise<Record<string, unknown> | ResponseDataPayload> {
  const { company } = target;
  const own = await fetchCompanySetup(viewer, company.id);
  const shared = own ? await fetchSharedSetup(viewer, own.shared_setup_id) : null;
  const months = await gatedRead([company.id, "batch", period], () =>
    fetchMonths(viewer, company.id, [`${period}-01`]),
  );
  if ("ok" in months) return months;
  const month = months[0];
  return {
    brn: company.brn,
    name: company.name.slice(0, 120),
    address: company.address,
    period,
    setup:
      own && shared
        ? {
            shared_setup_id: shared.id,
            shared_name: shared.name,
            shared_body: shared.body,
            shared_revision: shared.revision,
            company_body: own.body,
            company_revision: own.revision,
          }
        : null,
    month: month
      ? {
          revision: month.revision,
          shared_revision: month.shared_revision,
          company_revision: month.company_revision,
          employee_count: month.employee_count,
          employees: month.employees,
          updated_at: month.updated_at,
        }
      : null,
  };
}

/** Answers the payroll app's requests for several companies. */
export async function answerPayrollBatchRequest(
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
      const linked = new Set(
        (
          await fetchCompanySetupLinks(
            viewer,
            admin.map((one) => one.company.id),
          )
        ).map((link) => link.company_id),
      );
      return {
        ok: true,
        dataType: PAYROLL_BATCH,
        rows: admin.map(({ company }) => ({
          brn: company.brn,
          name: company.name.slice(0, 120),
          selected: company.id === membership.company.id,
          has_setup: linked.has(company.id),
        })),
        meta: meta(),
      };
    }

    if (params.data.action === "ask") {
      const { period, companies: wanted } = params.data;
      const admin = await adminCompanies(viewer, membership.company.id);
      const byBrn = new Map(admin.map((one) => [normaliseBrn(one.company.brn!), one]));
      const chosen = [...new Set(wanted.map(normaliseBrn))].map((brn) => byBrn.get(brn) ?? null);
      if (chosen.some((one) => one === null)) {
        return refuse("forbidden", "Only companies where you are an admin can be chosen.");
      }
      const names = (chosen as Membership[]).map((one) => one.company.name);
      const month = formatPeriod(`${period}-01`);
      return handleDataRequest(appId, payload, {
        what: `the ${month} payroll of ${countCompanies(names.length)}`,
        of: listNames(names),
        warning:
          "This sends each company's saved month, with national IDs and salaries, and its column setup, to the app, one company at a time, for the next 15 minutes, to make one Excel file.",
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
            dataType: PAYROLL_BATCH,
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
    if (!target) {
      return refuse(
        "forbidden",
        "Only an admin of that company can export its employees' figures.",
      );
    }
    const row = await loadCompany(viewer, target, period);
    if ("ok" in row) return row as ResponseDataPayload;
    // The gate may have locked while the database was answering: then nothing leaves.
    if (!isUnlocked()) return READ_LOCKED;
    return { ok: true, dataType: PAYROLL_BATCH, rows: [row], meta: meta(period) };
  } catch (error) {
    if (params.data.action === "load" && !isUnlocked()) return READ_LOCKED;
    return refusalFor(error, PAYROLL_MONTHS_MIGRATION);
  }
}

registerDataType(PAYROLL_BATCH, {
  request: (appId, payload) =>
    answerRequest(appId, PAYROLL_BATCH, () => answerPayrollBatchRequest(appId, payload)),
});
