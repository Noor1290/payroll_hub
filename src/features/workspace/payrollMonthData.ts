import { z } from "zod";
import { APPS, PAYROLL_MONTH } from "@/config/apps.config";
import { bridge, handleDataRequest, registerDataType } from "@/lib/bridge/bridge";
import {
  jsonBytes,
  MONTH_BYTES,
  MONTHS_PER_LOAD,
  SETUP_BODY_BYTES,
  type ReceivedPayload,
  type Refusal,
  type RequestDataPayload,
  type ResponseDataPayload,
  type SendDataPayload,
} from "@/lib/bridge/protocol";
import { formatPeriod } from "@/lib/format";
import { PAYROLL_MONTHS_KEY, queryClient } from "@/lib/queryClient";
import {
  fetchMonthHistory,
  fetchMonthList,
  fetchMonthRevision,
  fetchMonths,
  PAYROLL_MONTHS_MIGRATION,
  saveKeyChange,
  saveMonth,
  type KeyChangeInput,
} from "@/lib/supabase/payrollMonths";
import { fetchMemberships, type Viewer } from "@/lib/supabase/queries";
import type { Membership } from "@/lib/supabase/schemas";
import { isUnlocked, unlockState } from "@/lib/unlock";
import {
  answerMeta,
  brnSchema,
  exchangeContextFor,
  invalidRefusal,
  normaliseBrn,
  refusalFor,
  refuse,
} from "./appData";
import { answerRequest, recordSave } from "./deliver";

/**
 * The payroll app's months (docs/INTEGRATION.md, "Payroll app: months"): each company's
 * employees and the values typed for them, one month at a time.
 *
 * National IDs and salaries, so (decision D5 of docs/MIGRATION_PLAN.md):
 *  - admins only. The database lets nobody else read a month or count them;
 *  - the password gate must be open, to read and to save, with NO dialog on each read: the app
 *    saves by itself a moment after typing stops, and reads whenever a month is opened. While
 *    the gate is locked, everything is refused at once as `locked` and nothing is read or
 *    stored. The app keeps what was typed in its memory, shows it as NOT saved, covers the
 *    month's table, and saves it once the gate opens again;
 *  - the app is told when the gate opens or locks (a `gate` row sent to it), so it can cover
 *    its table without waiting for a refusal, and it may ask the user to unlock (`unlock`),
 *    which opens the password prompt here and nothing else.
 *
 * Every exchange is a row in the transfer log, with counts and the month, never a value. A
 * saved month has no toast (the app saves by itself every few seconds and shows "Saved"); a
 * refused one does. The employees are the app's own JSON, stored exactly as sent.
 *
 * A change of a column's key is one save here (`key-change`): the column setup that carries
 * the new key and every month the key reaches, all or nothing (migration 0014).
 */

const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const keySchema = z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]{0,99}$/);
const bodySchema = z.record(z.string(), z.unknown());
const employeeSchema = z.strictObject({
  id: z.string().min(1).max(100),
  values: z.record(z.string(), z.unknown()),
});

const paramsSchema = z.discriminatedUnion("action", [
  /** Whether the password gate is open now. Answered to any member, with no value in it. */
  z.strictObject({ action: z.literal("gate"), brn: brnSchema.optional() }),
  /** Asks the user to unlock the dashboard; answered once it is open. */
  z.strictObject({ action: z.literal("unlock"), brn: brnSchema }),
  /** Every saved month of a company, without its employees. */
  z.strictObject({
    action: z.literal("list"),
    brn: brnSchema,
    company_brn: brnSchema.optional(),
  }),
  /** These months, with their employees. Months that do not exist are left out. */
  z.strictObject({
    action: z.literal("load"),
    brn: brnSchema,
    company_brn: brnSchema.optional(),
    periods: z.array(periodSchema).min(1).max(MONTHS_PER_LOAD),
  }),
  /** The record of a month's saves, newest first. */
  z.strictObject({
    action: z.literal("history"),
    brn: brnSchema,
    company_brn: brnSchema.optional(),
    period: periodSchema,
  }),
  /** One revision of a month with its employees, when its content was kept. Reads only. */
  z.strictObject({
    action: z.literal("revision"),
    brn: brnSchema,
    company_brn: brnSchema.optional(),
    period: periodSchema,
    revision: z.number().int().min(1),
  }),
]);

const moveSchema = z.strictObject({
  old_key: keySchema,
  new_key: keySchema,
  /** null = every company attached to the shared setup (a Global column or an identity field). */
  company_brn: brnSchema.nullable(),
});

const saveSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("save"),
    brn: brnSchema,
    /** Another of the user's companies (the import); absent = the selected one. */
    company_brn: brnSchema.optional(),
    period: periodSchema,
    employees: z.array(employeeSchema).max(5_000),
    /** The revision last seen; 0 for a month that does not exist yet. */
    expected_revision: z.number().int().min(0),
    /** The column setup revisions the month was worked out with. */
    shared_revision: z.number().int().min(1),
    company_revision: z.number().int().min(1),
    /** Keep what is there now in the month's history before replacing it. */
    keep_previous: z.boolean().optional(),
    /** The earlier revision these employees are a restore of ("Restore this version"). */
    restored_from: z.number().int().min(1).optional(),
  }),
  z
    .strictObject({
      action: z.literal("key-change"),
      brn: brnSchema,
      moves: z.array(moveSchema).min(1).max(20),
      shared: z
        .strictObject({
          shared_setup_id: z.uuid(),
          name: z.string().trim().min(1).max(80),
          body: bodySchema,
          expected_revision: z.number().int().min(1),
          companies: z
            .array(
              z.strictObject({
                company_brn: brnSchema,
                body: bodySchema,
                expected_revision: z.number().int().min(1),
              }),
            )
            .max(200)
            .optional(),
        })
        .optional(),
      company: z
        .strictObject({
          company_brn: brnSchema.optional(),
          body: bodySchema,
          expected_revision: z.number().int().min(1),
        })
        .optional(),
    })
    .refine((save) => (save.shared === undefined) !== (save.company === undefined), {
      path: ["shared"],
      message: "Give either the shared setup or the company setup.",
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
const NO_SUCH_COMPANY = refuse("not-found", "You have no company with that BRN in the dashboard.");
const REVISION_NOT_KEPT = refuse(
  "not-found",
  "This revision's content was not kept: the dashboard has only the record of that save.",
);
const TOO_LARGE = refuse(
  "too-large",
  "The month is larger than the dashboard accepts (1 MB). Nothing was saved.",
);
const notAdmin = (name: string) =>
  refuse("forbidden", `Only an admin of ${name} can see or change its employees' figures.`);

/** The user's membership of the company with this BRN, or null. */
function membershipFor(memberships: Membership[], brn: string): Membership | null {
  const wanted = normaliseBrn(brn);
  return memberships.find((m) => m.company.brn && normaliseBrn(m.company.brn) === wanted) ?? null;
}

/** Which company a message is about: the selected one, or another of the user's by BRN. */
async function companyFor(
  viewer: Viewer,
  selected: Membership,
  companyBrn: string | undefined,
): Promise<Membership | null> {
  if (companyBrn === undefined) return selected;
  if (selected.company.brn && normaliseBrn(selected.company.brn) === normaliseBrn(companyBrn)) {
    return selected;
  }
  return membershipFor(await fetchMemberships(viewer), companyBrn);
}

const toWire = (period: string) => period.slice(0, 7);
const toDate = (period: string) => `${period}-01`;

/**
 * Reads through the query cache under a gated key, so locking cancels a read in flight and
 * drops what it read; nothing is kept once the app has its answer.
 */
export async function gatedRead<T>(key: unknown[], read: () => Promise<T>): Promise<T | Refusal> {
  const queryKey = [PAYROLL_MONTHS_KEY, ...key];
  try {
    const value = await queryClient.fetchQuery({
      queryKey,
      queryFn: read,
      staleTime: 0,
      gcTime: 0,
      retry: false,
    });
    // The gate may have locked while the database was answering: then nothing leaves.
    return isUnlocked() ? value : READ_LOCKED;
  } catch (error) {
    if (!isUnlocked()) return READ_LOCKED;
    throw error;
  } finally {
    queryClient.removeQueries({ queryKey });
  }
}

/** Answers the payroll app's questions about its months. */
export async function answerPayrollMonthRequest(
  appId: string,
  payload: RequestDataPayload,
): Promise<ResponseDataPayload> {
  const params = paramsSchema.safeParse(payload.params ?? {});
  if (!params.success) return invalidRefusal(params.error);
  const current = exchangeContextFor(params.data.brn);
  if ("ok" in current) return current;
  const { viewer, membership } = current;
  const you = (id: string | null) => id !== null && id === viewer.id;
  const answer = (rows: Record<string, unknown>[], period?: string): ResponseDataPayload => ({
    ok: true,
    dataType: PAYROLL_MONTH,
    rows,
    meta: { ...answerMeta(membership), ...(period ? { period } : {}) },
  });
  const command = params.data;

  if (command.action === "gate") return answer([{ unlocked: isUnlocked() }]);
  if (membership.role !== "admin") return notAdmin(membership.company.name);
  if (command.action === "unlock") {
    if (isUnlocked()) return answer([{ unlocked: true }]);
    return handleDataRequest(appId, payload, {
      what: "the employees' figures",
      warning: "Unlocking sends nothing by itself.",
      unlockOnly: true,
      answer: async () => (isUnlocked() ? answer([{ unlocked: true }]) : READ_LOCKED),
    });
  }
  if (!isUnlocked()) return READ_LOCKED;

  try {
    const company = await companyFor(viewer, membership, command.company_brn);
    if (!company) return NO_SUCH_COMPANY;
    if (company.role !== "admin") return notAdmin(company.company.name);
    const companyId = company.company.id;

    switch (command.action) {
      case "list": {
        const list = await gatedRead([companyId, "list"], () => fetchMonthList(viewer, companyId));
        if ("ok" in list) return list;
        return answer(
          list.map(({ updated_by, period, ...month }) => ({
            ...month,
            period: toWire(period),
            updated_by_you: you(updated_by),
          })),
        );
      }
      case "load": {
        const periods = [...new Set(command.periods)];
        const months = await gatedRead([companyId, "load", ...periods], () =>
          fetchMonths(viewer, companyId, periods.map(toDate)),
        );
        if ("ok" in months) return months;
        return answer(
          months.map(({ updated_by, period, ...month }) => ({
            ...month,
            period: toWire(period),
            updated_by_you: you(updated_by),
          })),
          periods.length === 1 ? periods[0] : undefined,
        );
      }
      case "history": {
        const history = await gatedRead([companyId, "history", command.period], () =>
          fetchMonthHistory(viewer, companyId, toDate(command.period)),
        );
        if ("ok" in history) return history;
        return answer(
          history.map(({ saved_by, ...revision }) => ({
            ...revision,
            saved_by_you: you(saved_by),
          })),
          command.period,
        );
      }
      case "revision": {
        const kept = await gatedRead(
          [companyId, "revision", command.period, command.revision],
          () => fetchMonthRevision(viewer, companyId, toDate(command.period), command.revision),
        );
        if (kept !== null && "ok" in kept) return kept;
        if (kept === null) return REVISION_NOT_KEPT;
        const { saved_by, ...revision } = kept;
        return answer(
          [{ period: command.period, ...revision, saved_by_you: you(saved_by) }],
          command.period,
        );
      }
    }
  } catch (error) {
    if (!isUnlocked()) return READ_LOCKED;
    return refusalFor(error, PAYROLL_MONTHS_MIGRATION);
  }
}

/** Saves a month, or a change of key with the setup it comes with. */
export async function savePayrollMonthFromApp(payload: SendDataPayload): Promise<ReceivedPayload> {
  const row = saveSchema.safeParse(payload.rows[0]);
  if (!row.success) {
    const big = payload.rows[0] as { employees?: unknown } | undefined;
    if (Array.isArray(big?.employees) && big.employees.length > 5_000) return TOO_LARGE;
    return invalidRefusal(row.error);
  }
  const current = exchangeContextFor(row.data.brn);
  if ("ok" in current) return current;
  const { viewer, membership } = current;
  const command = row.data;
  if (membership.role !== "admin") return notAdmin(membership.company.name);
  if (!isUnlocked()) return SAVE_LOCKED;

  try {
    if (command.action === "save") {
      if (jsonBytes(command.employees) > MONTH_BYTES) return TOO_LARGE;
      const company = await companyFor(viewer, membership, command.company_brn);
      if (!company) return NO_SUCH_COMPANY;
      if (company.role !== "admin") return notAdmin(company.company.name);
      const saved = await saveMonth(viewer, company.company.id, {
        period: toDate(command.period),
        employees: command.employees,
        expectedRevision: command.expected_revision,
        sharedRevision: command.shared_revision,
        companyRevision: command.company_revision,
        keepPrevious: command.keep_previous ?? false,
      });
      return {
        ok: true,
        result: {
          action: "save",
          brn: company.company.brn,
          company: company.company.name,
          period: toWire(saved.period),
          revision: saved.revision,
          employee_count: saved.employee_count,
          updated_at: saved.updated_at,
          ...(command.restored_from !== undefined ? { restored_from: command.restored_from } : {}),
        },
      };
    }

    // ---------- key-change ----------
    const bodies = [
      command.shared?.body,
      ...(command.shared?.companies ?? []).map((c) => c.body),
      command.company?.body,
    ].filter((body) => body !== undefined);
    if (bodies.some((body) => jsonBytes(body) > SETUP_BODY_BYTES)) {
      return refuse("too-large", "The column setup is larger than the dashboard accepts (250 KB).");
    }
    const memberships = await fetchMemberships(viewer);
    const byBrn = (brn: string) =>
      normaliseBrn(brn) === normaliseBrn(membership.company.brn ?? "")
        ? membership
        : membershipFor(memberships, brn);
    const idOf = (brn: string) => byBrn(brn)?.company.id ?? null;

    const moves: KeyChangeInput["moves"] = [];
    for (const move of command.moves) {
      const companyId = move.company_brn === null ? null : idOf(move.company_brn);
      if (move.company_brn !== null && !companyId) return NO_SUCH_COMPANY;
      moves.push({ oldKey: move.old_key, newKey: move.new_key, companyId });
    }
    let input: KeyChangeInput;
    if (command.shared) {
      const companies: NonNullable<KeyChangeInput["shared"]>["companies"] = [];
      for (const company of command.shared.companies ?? []) {
        const companyId = idOf(company.company_brn);
        if (!companyId) return NO_SUCH_COMPANY;
        companies.push({
          companyId,
          body: company.body,
          expectedRevision: company.expected_revision,
        });
      }
      if (new Set(companies.map((c) => c.companyId)).size !== companies.length) {
        return refuse("invalid", "A company is named twice.");
      }
      input = {
        moves,
        shared: {
          setupId: command.shared.shared_setup_id,
          name: command.shared.name,
          body: command.shared.body,
          expectedRevision: command.shared.expected_revision,
          companies,
        },
        company: null,
      };
    } else {
      const own = command.company!;
      const company = own.company_brn === undefined ? membership : byBrn(own.company_brn);
      if (!company) return NO_SUCH_COMPANY;
      if (company.role !== "admin") return notAdmin(company.company.name);
      input = {
        moves,
        shared: null,
        company: {
          companyId: company.company.id,
          body: own.body,
          expectedRevision: own.expected_revision,
        },
      };
    }

    const saved = await saveKeyChange(viewer, input);
    const brnOf = (companyId: string) =>
      [membership, ...memberships].find((m) => m.company.id === companyId)?.company.brn ?? null;
    return {
      ok: true,
      result: {
        action: "key-change",
        setup: {
          shared_setup_id: saved.setup.shared_setup_id,
          revision: saved.setup.revision,
          ...(saved.setup.company_id ? { brn: brnOf(saved.setup.company_id) } : {}),
          companies: (saved.setup.companies ?? []).map((c) => ({
            brn: brnOf(c.company_id),
            revision: c.revision,
          })),
        },
        months: saved.months.map((m) => ({
          brn: brnOf(m.company_id),
          period: toWire(m.period),
          revision: m.revision,
        })),
      },
    };
  } catch (error) {
    const refusal = refusalFor(error, PAYROLL_MONTHS_MIGRATION);
    if (refusal.code === "stale") {
      return {
        ...refusal,
        error:
          command.action === "save"
            ? "Someone else saved this month in the dashboard since it was opened here. Nothing was saved."
            : "Someone else changed the column setup or a month in the dashboard since it was opened here. Nothing was saved.",
      };
    }
    return refusal;
  }
}

/** The toast for a change of key; a month's own save has none (see above). Counts only. */
export function describePayrollMonthSave(result: Record<string, unknown>): string {
  if (result.action === "key-change") {
    const months = Array.isArray(result.months) ? result.months.length : 0;
    return `Payroll column key changed, with its values in ${months} ${months === 1 ? "month" : "months"}`;
  }
  const month = `${String(result.company)}: ${formatPeriod(`${String(result.period)}-01`)}`;
  if (typeof result.restored_from === "number") {
    return `${month} restored from revision ${result.restored_from} (revision ${String(result.revision)})`;
  }
  return `${month} saved (revision ${String(result.revision)})`;
}

/**
 * A month saved by itself as the user types has no toast; a restore ("Restore this version")
 * and a change of key do.
 */
export function isQuietMonthSave(payload: SendDataPayload): boolean {
  const row = payload.rows[0] as { action?: unknown; restored_from?: unknown } | undefined;
  return row?.action === "save" && row.restored_from === undefined;
}

/** How many rows a save stored, for the transfer log: the month, or the setup and each month moved. */
const savedCount = (result: Record<string, unknown>) =>
  result.action === "key-change"
    ? 1 + (Array.isArray(result.months) ? result.months.length : 0)
    : 1;

// ---------- telling the app when the gate opens or locks ----------

/** The apps that work with months, and so are told. */
const MONTH_APPS = APPS.filter((app) => app.accepts.includes(PAYROLL_MONTH)).map((app) => app.id);

let toldUnlocked = unlockState.get().unlocked;
unlockState.subscribe(() => {
  const { unlocked } = unlockState.get();
  if (unlocked === toldUnlocked) return;
  toldUnlocked = unlocked;
  // Whether it is open: nothing else. An app that is not open, or does not listen, is not
  // waited for; an app that opens later asks (`gate`).
  for (const appId of MONTH_APPS) {
    void bridge.send(appId, { dataType: PAYROLL_MONTH, rows: [{ action: "gate", unlocked }] });
  }
});

registerDataType(PAYROLL_MONTH, {
  request: (appId, payload) =>
    answerRequest(appId, PAYROLL_MONTH, () => answerPayrollMonthRequest(appId, payload)),
  save: (appId, payload) =>
    recordSave(
      appId,
      PAYROLL_MONTH,
      "the payroll month",
      () => savePayrollMonthFromApp(payload),
      describePayrollMonthSave,
      savedCount,
      { quiet: isQuietMonthSave(payload) },
    ),
});
