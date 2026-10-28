import { z } from "zod";
import { MRA_BATCH } from "@/config/apps.config";
import { toExportRow } from "@/config/payrollFields";
import { handleDataRequest, registerDataType } from "@/lib/bridge/bridge";
import type { RequestDataPayload, ResponseDataPayload } from "@/lib/bridge/protocol";
import { formatPeriod } from "@/lib/format";
import { registerSessionCleanup } from "@/lib/sessionCleanup";
import {
  fetchMraCompanyDetails,
  fetchMraSettings,
  fetchMraTemplateLinks,
  MRA_MIGRATION,
} from "@/lib/supabase/mraReturns";
import { fetchRunEntries, fetchRuns } from "@/lib/supabase/payroll";
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

/**
 * The MRA return files of one or several companies (docs/INTEGRATION.md, "mra-batch"). Read
 * only: nothing is saved through this data type, and the files the app makes are never stored.
 * National IDs and pay, so it works as payslip-batch and payroll-batch do (batchAccess.ts):
 *
 *  - Only companies the user is an ADMIN of, read from the database each time.
 *  - `ask` asks the user once, with the password gate open, naming the month and EVERY company
 *    chosen (one company too: the app makes one company's files the same way). Agreeing allows
 *    `load` for those companies and that month only, for 15 minutes, in memory only; it goes
 *    when the gate locks or on sign-out.
 *  - `load` answers ONE company: its saved run of the month, the rows exactly as "Get from
 *    dashboard" gives them, or `run: false` when that month was never sent to the dashboard;
 *    with its MRA details (ERN, telephone, mobile, declarant: migration 0020), the user's email
 *    for the returns, and its own values for the MRA templates it uses. Refused at once when it was not allowed, when the gate is locked, or when the user is no
 *    longer its admin.
 *
 * `companies` (names and BRNs of the user's admin companies) needs no dialog: nothing in it is
 * per employee.
 */

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

/** The most companies one `ask` may name. */
export const MRA_MAX_COMPANIES = 200;

/** Saved runs are in the first migration; a database without it is not set up at all. */
const RUNS_MIGRATION = "0001_initial_schema.sql";

const paramsSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("companies"), brn: brnSchema.optional() }),
  z.strictObject({
    action: z.literal("ask"),
    brn: brnSchema,
    period: monthSchema,
    /** The companies chosen, by BRN. Always named: the question lists every one of them. */
    companies: z.array(brnSchema).min(1).max(MRA_MAX_COMPANIES),
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
export function forgetMraBatchAllowed(): void {
  permits.forget();
}
registerSessionCleanup(forgetMraBatchAllowed);
registerLockCleanup(forgetMraBatchAllowed);

const READ_LOCKED = refuse(
  "locked",
  "The dashboard is locked. Confirm your password there to unlock it, then ask again.",
);
const NOT_ALLOWED = refuse(
  "denied",
  "That company and month were not allowed in the dashboard for this app. Ask again.",
);

/**
 * One company: its saved run of the month, if that month was sent to the dashboard, with what
 * the return files need besides: its MRA details, the user's email, its own template values.
 */
async function loadCompany(
  viewer: Viewer,
  target: Membership,
  period: string,
): Promise<Record<string, unknown>> {
  const { company } = target;
  const [runs, details, settings, links] = await Promise.all([
    fetchRuns(viewer, company.id),
    fetchMraCompanyDetails(viewer, company.id),
    fetchMraSettings(viewer),
    fetchMraTemplateLinks(viewer, [company.id]),
  ]);
  const run = runs.find((found) => found.period === `${period}-01`);
  const entries = run ? await fetchRunEntries(viewer, run.id) : [];
  return {
    brn: company.brn,
    name: company.name.slice(0, 120),
    address: company.address,
    period,
    run: run !== undefined,
    employees: entries.map((row) => toExportRow(row, company)),
    // Empty texts until an admin fills them in on the Company profile.
    mra: {
      ern: details?.ern ?? "",
      telephone: details?.telephone ?? "",
      mobile: details?.mobile ?? "",
      declarant: details?.declarant ?? "",
    },
    email: settings?.email ?? "",
    templates: links.map((link) => ({
      template_id: link.template_id,
      own_values: link.own_values,
      values_revision: link.revision,
    })),
  };
}

/** Answers the MRA Returns app's requests. */
export async function answerMraBatchRequest(
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
        dataType: MRA_BATCH,
        rows: admin.map(({ company }) => ({
          brn: company.brn,
          name: company.name.slice(0, 120),
          selected: company.id === membership.company.id,
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
      return handleDataRequest(appId, payload, {
        what: `the ${formatPeriod(`${period}-01`)} payroll of ${countCompanies(names.length)}`,
        of: listNames(names),
        warning:
          "This sends each company's saved run for that month, with national IDs and pay, to the app, one company at a time, for the next 15 minutes, to make its MRA return files.",
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
            dataType: MRA_BATCH,
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
      return refuse("forbidden", "Only an admin of that company can make its MRA returns.");
    }
    const row = await loadCompany(viewer, target, period);
    // The gate may have locked while the database was answering: then nothing leaves.
    if (!isUnlocked()) return READ_LOCKED;
    return { ok: true, dataType: MRA_BATCH, rows: [row], meta: meta(period) };
  } catch (error) {
    if (params.data.action === "load" && !isUnlocked()) return READ_LOCKED;
    // The saved runs are in the first migration: a missing table in a load is one of 0020's.
    return refusalFor(error, params.data.action === "load" ? MRA_MIGRATION : RUNS_MIGRATION);
  }
}

registerDataType(MRA_BATCH, {
  request: (appId, payload) =>
    answerRequest(appId, MRA_BATCH, () => answerMraBatchRequest(appId, payload)),
});
