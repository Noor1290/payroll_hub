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
 *  - `ask` asks the user once, with the password gate open, naming the months (one month, or a
 *    range of up to 24) and every company chosen. Agreeing allows `load` for those companies and
 *    those months only, for 15 minutes, in memory only; it goes when the gate locks or on sign-out.
 *  - `load` answers ONE company: its saved months in the range (the employees exactly as the app
 *    saved them) and its column setup (the shared setup and its own, as the app saved them), so
 *    the app can work out the figures as it shows them. Refused at once when it was not allowed,
 *    when the gate is locked, or when the user is no longer its admin.
 *
 * `companies` (names and BRNs of the user's admin companies, and whether each has a column
 * setup) needs no dialog: nothing in it is per employee.
 */

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

/** The most companies one `ask` may name. */
export const EXPORT_MAX_COMPANIES = 200;
/** The most months one `ask` may cover, from `from` to `to`. */
export const EXPORT_MAX_MONTHS = 24;

/** Every month from `from` to `to`, both "YYYY-MM", oldest first. */
export function monthsInRange(from: string, to: string): string[] {
  const index = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
  const months: string[] = [];
  for (let i = index(from); i <= index(to); i++) {
    months.push(`${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`);
  }
  return months;
}

/** "from" and "to": the same month, or a later "to", at most EXPORT_MAX_MONTHS months in all. */
const rangeOk = ({ from, to }: { from: string; to: string }) =>
  from <= to && monthsInRange(from, to).length <= EXPORT_MAX_MONTHS;

const paramsSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("companies"), brn: brnSchema.optional() }),
  z
    .strictObject({
      action: z.literal("ask"),
      brn: brnSchema,
      from: monthSchema,
      to: monthSchema,
      /** The companies chosen, by BRN. Always named: the question lists every one of them. */
      companies: z.array(brnSchema).min(1).max(EXPORT_MAX_COMPANIES),
    })
    .refine(rangeOk, { path: ["to"] }),
  z
    .strictObject({
      action: z.literal("load"),
      brn: brnSchema,
      from: monthSchema,
      to: monthSchema,
      company_brn: brnSchema,
    })
    .refine(rangeOk, { path: ["to"] }),
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
  "That company and those months were not allowed in the dashboard for this app. Ask again.",
);

/** What a permission is for: one month, or a range of months. */
const rangeKey = (from: string, to: string) => `${from}/${to}`;

/** "October 2026", or "July 2026 to June 2027". */
const rangeLabel = (from: string, to: string) =>
  from === to
    ? formatPeriod(`${from}-01`)
    : `${formatPeriod(`${from}-01`)} to ${formatPeriod(`${to}-01`)}`;

/**
 * One company for the file: its column setup (null when there is none) and its saved months in
 * the range, oldest first (a month that is not saved is left out).
 */
async function loadCompany(
  viewer: Viewer,
  target: Membership,
  from: string,
  to: string,
): Promise<Record<string, unknown> | ResponseDataPayload> {
  const { company } = target;
  const own = await fetchCompanySetup(viewer, company.id);
  const shared = own ? await fetchSharedSetup(viewer, own.shared_setup_id) : null;
  const months = await gatedRead([company.id, "batch", from, to], () =>
    fetchMonths(
      viewer,
      company.id,
      monthsInRange(from, to).map((month) => `${month}-01`),
    ),
  );
  if ("ok" in months) return months;
  return {
    brn: company.brn,
    name: company.name.slice(0, 120),
    address: company.address,
    from,
    to,
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
    months: [...months]
      .sort((a, b) => a.period.localeCompare(b.period))
      .map((month) => ({
        period: month.period.slice(0, 7),
        revision: month.revision,
        shared_revision: month.shared_revision,
        company_revision: month.company_revision,
        employee_count: month.employee_count,
        employees: month.employees,
        updated_at: month.updated_at,
      })),
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
      const { from, to, companies: wanted } = params.data;
      const single = from === to;
      const admin = await adminCompanies(viewer, membership.company.id);
      const byBrn = new Map(admin.map((one) => [normaliseBrn(one.company.brn!), one]));
      const chosen = [...new Set(wanted.map(normaliseBrn))].map((brn) => byBrn.get(brn) ?? null);
      if (chosen.some((one) => one === null)) {
        return refuse("forbidden", "Only companies where you are an admin can be chosen.");
      }
      const names = (chosen as Membership[]).map((one) => one.company.name);
      return handleDataRequest(appId, payload, {
        what: `the ${rangeLabel(from, to)} payroll of ${countCompanies(names.length)}`,
        of: listNames(names),
        warning: `This sends each company's saved ${single ? "month" : "months"}, with national IDs and salaries, and its column setup, to the app, one company at a time, for the next 15 minutes, to make one Excel file.`,
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
            period: rangeKey(from, to),
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
            meta: { ...answerMeta(again.membership), ...(single ? { period: from } : {}) },
          };
        },
      });
    }

    const { from, to, company_brn: companyBrn } = params.data;
    const wanted = normaliseBrn(companyBrn);
    if (
      !permits.allows({
        appId,
        userId: viewer.id,
        selectedCompanyId: membership.company.id,
        period: rangeKey(from, to),
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
    const row = await loadCompany(viewer, target, from, to);
    if ("ok" in row) return row as ResponseDataPayload;
    // The gate may have locked while the database was answering: then nothing leaves.
    if (!isUnlocked()) return READ_LOCKED;
    return {
      ok: true,
      dataType: PAYROLL_BATCH,
      rows: [row],
      meta: meta(from === to ? from : undefined),
    };
  } catch (error) {
    if (params.data.action === "load" && !isUnlocked()) return READ_LOCKED;
    return refusalFor(error, PAYROLL_MONTHS_MIGRATION);
  }
}

registerDataType(PAYROLL_BATCH, {
  request: (appId, payload) =>
    answerRequest(appId, PAYROLL_BATCH, () => answerPayrollBatchRequest(appId, payload)),
});
