import { toast } from "sonner";
import { z } from "zod";
import { getApp, PAYROLL_IMPORT } from "@/config/apps.config";
import { registerDataType } from "@/lib/bridge/bridge";
import {
  jsonBytes,
  MONTH_BYTES,
  SETUP_BODY_BYTES,
  type ReceivedPayload,
  type RequestDataPayload,
  type ResponseDataPayload,
  type SendDataPayload,
} from "@/lib/bridge/protocol";
import { formatCount } from "@/lib/format";
import { queryClient } from "@/lib/queryClient";
import { fetchRuns } from "@/lib/supabase/payroll";
import {
  importPayrollCompany,
  PAYROLL_IMPORT_MIGRATION,
  type ImportInput,
} from "@/lib/supabase/payrollImport";
import { fetchMonthList } from "@/lib/supabase/payrollMonths";
import { fetchCompanySetup, fetchSharedSetup } from "@/lib/supabase/payrollSetups";
import { fetchMemberships } from "@/lib/supabase/queries";
import { isUnlocked } from "@/lib/unlock";
import {
  answerMeta,
  brnSchema,
  exchangeContextFor,
  invalidRefusal,
  normaliseBrn,
  refusalFor,
  refuse,
} from "./appData";
import { countCompanies } from "./batchAccess";
import { answerRequest, recordSave } from "./deliver";
import { EXPORT_MAX_COMPANIES, EXPORT_MAX_MONTHS, monthsInRange } from "./payrollBatchData";
import { gatedRead } from "./payrollMonthData";

/**
 * Importing a "Several companies" Excel file in the payroll app (docs/INTEGRATION.md,
 * "payroll-import"). National IDs and salaries, so: admins only, with the password gate open,
 * and NO dialog: the preview the user confirms in the app is the confirmation (the owner's
 * decision for this import).
 *
 *  - `check` (request): for each BRN of the file, whether the user is an admin of that company,
 *    only a member, or has no company with that BRN; for an admin, its column setup and which
 *    months of the range are saved (revisions and counts, never an employee) and which have an
 *    approved run. Nothing is stored.
 *  - `company` (save): ONE company of the file, all of it or nothing (migration 0019): a new
 *    company, or one the user is an admin of; its column setup when it has none; its months.
 *    An approved month is never replaced: the database refuses it.
 *  - `summary` (save): the app's counts at the end, for ONE toast. Stores nothing.
 *
 * Each company is a row in the Transfer log, without a toast of its own.
 */

const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const bodySchema = z.record(z.string(), z.unknown());
const employeeSchema = z.strictObject({
  id: z.string().min(1).max(100),
  values: z.record(z.string(), z.unknown()),
});

const paramsSchema = z
  .strictObject({
    action: z.literal("check"),
    brn: brnSchema,
    from: periodSchema,
    to: periodSchema,
    companies: z.array(brnSchema).min(1).max(EXPORT_MAX_COMPANIES),
  })
  .refine(({ from, to }) => from <= to && monthsInRange(from, to).length <= EXPORT_MAX_MONTHS, {
    path: ["to"],
  });

const count = z.number().int().min(0).max(100_000);
const saveSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("company"),
    brn: brnSchema,
    company_brn: brnSchema,
    /** Only for a company that is not in the dashboard yet. */
    new_company: z
      .strictObject({
        name: z.string().trim().min(1).max(200),
        address: z.string().trim().max(500).nullable(),
      })
      .optional(),
    /** Only for a company with no column setup yet. */
    setup: z
      .strictObject({
        shared_setup_id: z.uuid(),
        create: z.boolean(),
        name: z.string().trim().min(1).max(80).optional(),
        shared_body: bodySchema.optional(),
        company_body: bodySchema,
      })
      .refine((setup) => !setup.create || (setup.name && setup.shared_body), {
        path: ["shared_body"],
      })
      .optional(),
    /** Only for a company that has a column setup: the revisions the file was checked against. */
    expected: z
      .strictObject({
        shared_revision: z.number().int().min(1),
        company_revision: z.number().int().min(1),
      })
      .optional(),
    months: z
      .array(
        z.strictObject({
          period: periodSchema,
          employees: z.array(employeeSchema).max(5000),
          expected_revision: z.number().int().min(0),
          replace: z.boolean(),
        }),
      )
      .min(1)
      .max(EXPORT_MAX_MONTHS)
      .refine((months) => new Set(months.map((m) => m.period)).size === months.length, {
        message: "A month is named twice.",
      }),
  }),
  z.strictObject({
    action: z.literal("summary"),
    brn: brnSchema,
    created: count,
    added: count,
    replaced: count,
    skipped: count,
    failed: count,
  }),
]);

const READ_LOCKED = refuse(
  "locked",
  "The dashboard is locked. Unlock it there to see the employees' figures.",
);
const SAVE_LOCKED = refuse(
  "locked",
  "The dashboard is locked, so this was NOT saved. Unlock it there, and it is saved then.",
);
const NOT_ADMIN = refuse("forbidden", "Only an admin of that company can import its months.");

/** For each BRN of the file: what the dashboard has, for the preview. */
export async function answerPayrollImportRequest(
  payload: RequestDataPayload,
): Promise<ResponseDataPayload> {
  const params = paramsSchema.safeParse(payload.params ?? {});
  if (!params.success) return invalidRefusal(params.error);
  const current = exchangeContextFor(params.data.brn);
  if ("ok" in current) return current;
  const { viewer, membership } = current;
  if (!isUnlocked()) return READ_LOCKED;
  const { from, to } = params.data;
  const wanted = new Set(monthsInRange(from, to));

  try {
    const memberships = await fetchMemberships(viewer);
    const byBrn = new Map(
      memberships
        .filter((m) => m.company.brn)
        .map((m) => [normaliseBrn(m.company.brn!), m] as const),
    );
    const rows: Record<string, unknown>[] = [];
    for (const brn of [...new Set(params.data.companies.map(normaliseBrn))]) {
      const found = byBrn.get(brn);
      if (!found) {
        rows.push({ brn, status: "absent" });
        continue;
      }
      const { company } = found;
      if (found.role !== "admin") {
        rows.push({ brn: company.brn, status: "member", name: company.name.slice(0, 120) });
        continue;
      }
      const own = await fetchCompanySetup(viewer, company.id);
      const shared = own ? await fetchSharedSetup(viewer, own.shared_setup_id) : null;
      const months = await gatedRead([company.id, "import-check"], () =>
        fetchMonthList(viewer, company.id),
      );
      if ("ok" in months) return months;
      const runs = await fetchRuns(viewer, company.id);
      rows.push({
        brn: company.brn,
        status: "admin",
        name: company.name.slice(0, 120),
        address: company.address,
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
        months: months
          .map((m) => ({
            period: m.period.slice(0, 7),
            revision: m.revision,
            employee_count: m.employee_count,
          }))
          .filter((m) => wanted.has(m.period)),
        approved: runs
          .filter((run) => run.status === "approved" && wanted.has(run.period.slice(0, 7)))
          .map((run) => run.period.slice(0, 7)),
      });
    }
    // The gate may have locked while the database was answering: then nothing leaves.
    if (!isUnlocked()) return READ_LOCKED;
    return { ok: true, dataType: PAYROLL_IMPORT, rows, meta: answerMeta(membership) };
  } catch (error) {
    if (!isUnlocked()) return READ_LOCKED;
    return refusalFor(error, PAYROLL_IMPORT_MIGRATION);
  }
}

/** Imports one company of the file, all of it or nothing. */
export async function savePayrollImportFromApp(payload: SendDataPayload): Promise<ReceivedPayload> {
  const row = saveSchema.safeParse(payload.rows[0]);
  if (!row.success) return invalidRefusal(row.error);
  const current = exchangeContextFor(row.data.brn);
  if ("ok" in current) return current;
  const command = row.data;
  if (command.action === "summary") return { ok: true, result: command };
  const { viewer } = current;
  if (!isUnlocked()) return SAVE_LOCKED;

  if (command.months.some((m) => jsonBytes(m.employees) > MONTH_BYTES)) {
    return refuse("too-large", "A month is larger than the dashboard accepts (1 MB).");
  }
  if (
    command.setup &&
    [command.setup.company_body, command.setup.shared_body].some(
      (body) => body && jsonBytes(body) > SETUP_BODY_BYTES,
    )
  ) {
    return refuse("too-large", "The column setup is larger than the dashboard accepts (250 KB).");
  }

  try {
    const wanted = normaliseBrn(command.company_brn);
    const found = (await fetchMemberships(viewer)).find(
      (m) => m.company.brn && normaliseBrn(m.company.brn) === wanted,
    );
    if (found && found.role !== "admin") return NOT_ADMIN;
    if (found && command.new_company) {
      return refuse("stale", "That company is already in the dashboard. Check the file again.");
    }
    if (!found && !command.new_company) {
      return refuse("not-found", "You have no company with that BRN in the dashboard.");
    }
    const input: ImportInput = {
      companyId: found ? found.company.id : null,
      newCompany: command.new_company
        ? {
            name: command.new_company.name,
            brn: command.company_brn.trim(),
            address: command.new_company.address,
          }
        : null,
      setup: command.setup ?? null,
      expected: command.expected ?? null,
      months: command.months.map((m) => ({
        period: `${m.period}-01`,
        employees: m.employees,
        expected_revision: m.expected_revision,
        replace: m.replace,
      })),
    };
    const saved = await importPayrollCompany(viewer, input);
    // A company made here is one more in the company list.
    if (saved.created) void queryClient.invalidateQueries({ queryKey: ["memberships"] });
    return {
      ok: true,
      result: {
        action: "company",
        brn: saved.brn,
        company: saved.name,
        created: saved.created,
        attached: saved.attached,
        shared_created: saved.shared_created,
        shared_setup_id: saved.shared_setup_id,
        months: saved.months.map((m) => ({ ...m, period: m.period.slice(0, 7) })),
      },
    };
  } catch (error) {
    const message = (error as { message?: unknown } | null)?.message;
    const text = typeof message === "string" ? message : "";
    const approved = /PH_MONTH_APPROVED:\s*(\d{4}-\d{2})/.exec(text);
    if (approved) {
      return refuse(
        "forbidden",
        `The month ${approved[1]} has an approved run in the dashboard, so it is never replaced. Nothing of this company was saved.`,
      );
    }
    if (text.includes("PH_DUPLICATE_BRN")) {
      return refuse(
        "invalid",
        "A company with this BRN is already in the dashboard, and you are not a member of it. It was not added.",
      );
    }
    return refusalFor(error, PAYROLL_IMPORT_MIGRATION);
  }
}

const months = (n: number) => `${formatCount(n)} ${n === 1 ? "month" : "months"}`;

/** The one toast at the end of an import: counts only. */
export function describeImport(summary: {
  created: number;
  added: number;
  replaced: number;
  skipped: number;
  failed: number;
}): string {
  const done = [
    summary.created > 0 ? `${countCompanies(summary.created)} added to the dashboard` : null,
    summary.added > 0 ? `${months(summary.added)} added` : null,
    summary.replaced > 0 ? `${months(summary.replaced)} replaced` : null,
  ].filter(Boolean);
  const rest = [
    summary.skipped > 0 ? `${months(summary.skipped)} skipped` : null,
    summary.failed > 0 ? `${countCompanies(summary.failed)} not imported` : null,
  ].filter(Boolean);
  const head =
    done.length > 0
      ? `Payroll imported from Excel: ${done.join(", ")}`
      : "Nothing was imported from Excel";
  return rest.length > 0 ? `${head}; ${rest.join(", ")}.` : `${head}.`;
}

function summarise(appId: string, payload: SendDataPayload): ReceivedPayload {
  const row = saveSchema.safeParse(payload.rows[0]);
  if (!row.success || row.data.action !== "summary") {
    return row.success ? refuse("invalid", "Not a summary.") : invalidRefusal(row.error);
  }
  const current = exchangeContextFor(row.data.brn);
  if ("ok" in current) return current;
  const text = describeImport(row.data);
  const description = `From ${getApp(appId)?.name ?? appId}. Each company is a row in the Transfer log.`;
  if (row.data.failed > 0) toast.warning(text, { description });
  else toast.success(text, { description });
  return { ok: true, result: { action: "summary" } };
}

/** How many months a company's import stored, for the transfer log. */
const savedCount = (result: Record<string, unknown>) =>
  Array.isArray(result.months) ? result.months.length : 1;

registerDataType(PAYROLL_IMPORT, {
  request: (appId, payload) =>
    answerRequest(appId, PAYROLL_IMPORT, () => answerPayrollImportRequest(payload)),
  save: (appId, payload) =>
    payload.rows[0]?.action === "summary"
      ? Promise.resolve(summarise(appId, payload))
      : recordSave(
          appId,
          PAYROLL_IMPORT,
          "a company from the Excel file",
          () => savePayrollImportFromApp(payload),
          () => "",
          savedCount,
          { silent: true },
        ),
});
