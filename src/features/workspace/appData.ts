import { z } from "zod";
import { PAYROLL_RESULT, PAYSLIP_TEMPLATE, STATUTORY_RATES } from "@/config/apps.config";
import { handleDataRequest, registerDataType } from "@/lib/bridge/bridge";
import {
  jsonBytes,
  TEMPLATE_BODY_BYTES,
  type ReceivedPayload,
  type Refusal,
  type RefusalCode,
  type RequestDataPayload,
  type ResponseDataPayload,
  type SendDataPayload,
} from "@/lib/bridge/protocol";
import { formatPeriod } from "@/lib/format";
import { registerSessionCleanup } from "@/lib/sessionCleanup";
import { createStore } from "@/lib/store";
import {
  classifyDataError,
  isMissingFunction,
  isMissingTable,
  NotConfiguredError,
} from "@/lib/supabase/errors";
import {
  fetchTemplateDraft,
  fetchTemplates,
  fetchTemplateVersion,
  publishTemplate,
  saveTemplateDraft,
  TEMPLATES_MIGRATION,
} from "@/lib/supabase/payslipTemplates";
import type { Viewer } from "@/lib/supabase/queries";
import type { Membership } from "@/lib/supabase/schemas";
import {
  fetchStatutoryRates,
  RATES_MIGRATION,
  saveStatutoryRates,
} from "@/lib/supabase/statutoryRates";
import { answerRequest, recordSave } from "./deliver";

/**
 * How the dashboard handles each data type an app may ask for or send. Importing this file
 * registers the handlers with the bridge; the shell does that once (BridgeDialogs).
 *
 *  - payroll-result: unchanged. The user is asked first and the password gate must be open
 *    (the dialog in BridgeDialogs). The only addition is a row in the transfer log.
 *  - statutory-rates and payslip-template: answered and saved WITHOUT a dialog and without the
 *    password gate. They are settings and layout, not anyone's pay: nothing in them is per
 *    employee. Every exchange is a row in the transfer log and every save shows a toast, so
 *    nothing happens unseen. The database decides who may read (members) and save (admins);
 *    this file only checks the shape and that the app is talking about the company the user
 *    has selected.
 *
 * The wire contract (what `params`, rows and results look like) is docs/INTEGRATION.md.
 */

/** Who is signed in and which company is selected, for handlers that run outside React. */
export interface ExchangeContext {
  viewer: Viewer;
  membership: Membership;
}
export const exchangeContext = createStore<ExchangeContext | null>(null);
registerSessionCleanup(() => exchangeContext.set(null));

// ---------- shared pieces ----------

const refuse = (code: RefusalCode, error: string): Refusal => ({ ok: false, code, error });

const normaliseBrn = (brn: string) => brn.trim().toUpperCase();

/** "YYYY-MM": every month on the wire is written this way. */
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const brnSchema = z.string().trim().min(1).max(50);

/**
 * The signed-in user and the selected company, or why there is nothing to work with.
 * When the app names a BRN it must be the selected company's: an app that still shows another
 * company must not read, and above all not save, into this one.
 */
function context(brn: string | undefined): ExchangeContext | Refusal {
  const current = exchangeContext.get();
  if (!current) {
    return refuse(
      "unavailable",
      "Nobody is signed in to the dashboard, or no company is selected.",
    );
  }
  if (brn !== undefined) {
    const selected = current.membership.company.brn;
    if (!selected || normaliseBrn(selected) !== normaliseBrn(brn)) {
      return refuse(
        "wrong-company",
        "The dashboard has a different company selected. Select the same company there, then try again.",
      );
    }
  }
  return current;
}

/** Names the first thing wrong with what the app sent. Field names only, never values. */
function invalid(error: z.ZodError): Refusal {
  const issue = error.issues[0];
  const where = issue?.path.join(".") || "the data";
  const unknown = issue?.code === "unrecognized_keys";
  return refuse(
    "invalid",
    unknown ? `Unexpected field in ${where}.` : `"${where}" is missing or not valid.`,
  );
}

/**
 * Turns a failed read or save into the refusal the app is told. The database's own PH_ codes
 * map one to one; a table or function that is not there names the file the owner must run.
 */
export function refusalFor(error: unknown, migration: string): Refusal {
  const { code, message } = (typeof error === "object" && error !== null ? error : {}) as {
    code?: unknown;
    message?: unknown;
  };
  const text = typeof message === "string" ? message : "";

  if (isMissingTable(error) || isMissingFunction(error)) {
    return refuse(
      "unavailable",
      `The dashboard's database is not set up for this yet. The owner needs to run supabase/migrations/${migration}.`,
    );
  }
  if (error instanceof NotConfiguredError) {
    return refuse("unavailable", "The dashboard is not connected to a database.");
  }
  if (text.includes("PH_STALE")) {
    return refuse(
      "stale",
      "It was saved by someone else since you loaded it. Reload, then make the change again.",
    );
  }
  if (text.includes("PH_NO_CHANGE")) {
    return refuse("no-change", "Nothing was saved: this is the same as what is already stored.");
  }
  if (text.includes("PH_NOT_FOUND")) return refuse("not-found", "The dashboard has no such item.");
  if (text.includes("PH_TOO_LARGE")) return refuse("too-large", "It is too large to store.");
  if (text.includes("PH_LIMIT")) {
    return refuse("too-large", "The company has reached the limit for this kind of data.");
  }
  if (text.includes("PH_DUPLICATE_NAME")) {
    return refuse("invalid", "This company already has one with that name.");
  }
  if (text.includes("PH_INVALID_INPUT")) {
    // The database's own wording after the colon: fixed text, no values.
    const detail = text.replace(/^.*PH_INVALID_INPUT:?\s*/, "").slice(0, 200);
    return refuse("invalid", detail ? `Not valid: ${detail}.` : "The data is not valid.");
  }
  if (text.includes("PH_NOT_ADMIN") || text.includes("PH_NOT_SIGNED_IN") || code === "42501") {
    return refuse("forbidden", "Only an admin of this company can do this.");
  }
  return refuse("unavailable", `${classifyDataError(error).title}.`);
}

const meta = (company: Membership["company"]) => ({
  label: company.name.slice(0, 120),
  ...(company.brn ? { brn: company.brn } : {}),
});

// ---------- statutory-rates ----------

/** At most `places` decimals, allowing for how a decimal is held as a floating-point number. */
const decimals = (places: number) => (value: number) => {
  const scaled = value * 10 ** places;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
};
/** A percentage: 1.5 means 1.5 %. */
const rateSchema = z.number().min(0).max(100).refine(decimals(4));
/** Rupees a month. */
const amountSchema = z.number().min(0).max(9_999_999_999.99).refine(decimals(2));

const ratesParamsSchema = z.strictObject({ brn: brnSchema.optional() }).optional();

const ratesSaveSchema = z.strictObject({
  brn: brnSchema,
  effective_from: monthSchema,
  expected_revision: z.number().int().min(0),
  nsf_employee_rate: rateSchema,
  nsf_ceiling: amountSchema,
  nsf_exempt_at_60: z.boolean(),
  csg_employee_rate_low: rateSchema,
  csg_employee_rate_high: rateSchema,
  csg_threshold: amountSchema,
  source_note: z.string().trim().max(300).nullish(),
});

/** Every version of the selected company's rates. May be none. */
export async function answerRatesRequest(
  payload: RequestDataPayload,
): Promise<ResponseDataPayload> {
  const params = ratesParamsSchema.safeParse(payload.params);
  if (!params.success) return invalid(params.error);
  const current = context(params.data?.brn);
  if ("ok" in current) return current;

  const { company } = current.membership;
  try {
    const versions = await fetchStatutoryRates(current.viewer, company.id);
    return {
      ok: true,
      dataType: STATUTORY_RATES,
      rows: versions.map(({ created_by, effective_from, ...row }) => ({
        effective_from: effective_from.slice(0, 7),
        ...row,
        // Not the user's id: only whether it was the person now signed in.
        created_by_you: created_by !== null && created_by === current.viewer.id,
      })),
      meta: meta(company),
    };
  } catch (error) {
    return refusalFor(error, RATES_MIGRATION);
  }
}

/** Adds one revision. The values are passed on exactly as sent: nothing is rounded here. */
export async function saveRates(payload: SendDataPayload): Promise<ReceivedPayload> {
  const row = ratesSaveSchema.safeParse(payload.rows[0]);
  if (!row.success) return invalid(row.error);
  const current = context(row.data.brn);
  if ("ok" in current) return current;
  if (current.membership.role !== "admin") {
    return refuse("forbidden", "Only an admin of this company can save statutory rates.");
  }

  try {
    const saved = await saveStatutoryRates(current.viewer, current.membership.company.id, {
      effectiveFrom: `${row.data.effective_from}-01`,
      expectedRevision: row.data.expected_revision,
      nsfEmployeeRate: row.data.nsf_employee_rate,
      nsfCeiling: row.data.nsf_ceiling,
      nsfExemptAt60: row.data.nsf_exempt_at_60,
      csgEmployeeRateLow: row.data.csg_employee_rate_low,
      csgEmployeeRateHigh: row.data.csg_employee_rate_high,
      csgThreshold: row.data.csg_threshold,
      sourceNote: row.data.source_note || null,
    });
    return {
      ok: true,
      result: { effective_from: saved.effective_from.slice(0, 7), revision: saved.revision },
    };
  } catch (error) {
    return refusalFor(error, RATES_MIGRATION);
  }
}

// ---------- payslip-template ----------

const templateIdSchema = z.uuid();
/** The same limits as the database: 1 to 80 characters once trimmed. */
const templateNameSchema = z.string().trim().min(1).max(80);

/** What a request may ask for. `version` absent = the draft. */
const templateParamsSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("list"), brn: brnSchema.optional() }),
  z.strictObject({
    action: z.literal("load"),
    brn: brnSchema.optional(),
    template_id: templateIdSchema,
    version: z.number().int().min(1).optional(),
  }),
]);

/** What a save may ask for: one command per row. */
const templateSaveSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("save-draft"),
    brn: brnSchema,
    /** Absent or null for a new template. */
    template_id: templateIdSchema.nullish(),
    name: templateNameSchema,
    body: z.record(z.string(), z.unknown()),
    /** The draft revision last seen; 0 for a new template. */
    expected_revision: z.number().int().min(0),
  }),
  z.strictObject({
    action: z.literal("publish"),
    brn: brnSchema,
    template_id: templateIdSchema,
    expected_revision: z.number().int().min(1),
  }),
]);

/** A `data:` URI anywhere in a text: an image or another file embedded in the body. */
const EMBEDDED_FILE = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+/i;

/** True when any name or text in the body embeds a file. Walks without recursion. */
export function hasEmbeddedFile(body: unknown): boolean {
  const pending: unknown[] = [body];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      if (EMBEDDED_FILE.test(value)) return true;
    } else if (Array.isArray(value)) {
      for (const inner of value as unknown[]) pending.push(inner);
    } else if (typeof value === "object" && value !== null) {
      for (const [key, inner] of Object.entries(value)) pending.push(key, inner);
    }
  }
  return false;
}

/** The company's templates (no bodies), or one draft or published version with its body. */
export async function answerTemplateRequest(
  payload: RequestDataPayload,
): Promise<ResponseDataPayload> {
  const params = templateParamsSchema.safeParse(payload.params ?? {});
  if (!params.success) return invalid(params.error);
  const current = context(params.data.brn);
  if ("ok" in current) return current;

  const { viewer } = current;
  const { company } = current.membership;
  // Not anyone's user id: only whether it was the person now signed in.
  const you = (id: string | null) => id !== null && id === viewer.id;
  const answer = (rows: Record<string, unknown>[]): ResponseDataPayload => ({
    ok: true,
    dataType: PAYSLIP_TEMPLATE,
    rows,
    meta: meta(company),
  });

  try {
    if (params.data.action === "list") {
      const templates = await fetchTemplates(viewer, company.id);
      return answer(
        templates.map((template) => ({
          template_id: template.id,
          name: template.name,
          draft_revision: template.draft_revision,
          updated_at: template.updated_at,
          updated_by_you: you(template.updated_by),
          published_version: template.published?.version ?? null,
          published_at: template.published?.published_at ?? null,
        })),
      );
    }

    const { template_id: templateId, version } = params.data;
    if (version === undefined) {
      const draft = await fetchTemplateDraft(viewer, company.id, templateId);
      if (!draft) return refuse("not-found", "This company has no such payslip template.");
      return answer([
        {
          template_id: draft.id,
          name: draft.name,
          draft_revision: draft.draft_revision,
          body: draft.draft_body,
          updated_at: draft.updated_at,
          updated_by_you: you(draft.updated_by),
        },
      ]);
    }
    const published = await fetchTemplateVersion(viewer, company.id, templateId, version);
    if (!published) return refuse("not-found", "This payslip template has no such version.");
    return answer([
      {
        template_id: published.template_id,
        name: published.name,
        version: published.version,
        body: published.body,
        published_at: published.published_at,
        published_by_you: you(published.published_by),
      },
    ]);
  } catch (error) {
    return refusalFor(error, TEMPLATES_MIGRATION);
  }
}

/** Saves a draft (new or existing) or publishes one. The body is stored exactly as sent. */
export async function saveTemplate(payload: SendDataPayload): Promise<ReceivedPayload> {
  const row = templateSaveSchema.safeParse(payload.rows[0]);
  if (!row.success) return invalid(row.error);
  const current = context(row.data.brn);
  if ("ok" in current) return current;
  if (current.membership.role !== "admin") {
    return refuse("forbidden", "Only an admin of this company can save or publish a template.");
  }
  const companyId = current.membership.company.id;

  try {
    if (row.data.action === "publish") {
      const published = await publishTemplate(
        current.viewer,
        companyId,
        row.data.template_id,
        row.data.expected_revision,
      );
      return { ok: true, result: published };
    }

    if (jsonBytes(row.data.body) > TEMPLATE_BODY_BYTES) {
      return refuse("too-large", "The template is larger than the dashboard accepts (150 KB).");
    }
    if (hasEmbeddedFile(row.data.body)) {
      return refuse("invalid", "A template cannot contain images or other embedded files.");
    }
    const saved = await saveTemplateDraft(current.viewer, companyId, {
      templateId: row.data.template_id ?? null,
      name: row.data.name,
      body: row.data.body,
      expectedRevision: row.data.expected_revision,
    });
    return { ok: true, result: saved };
  } catch (error) {
    return refusalFor(error, TEMPLATES_MIGRATION);
  }
}

/** The toast for a saved draft or a publication. A name and numbers only. */
export function describeTemplateSave(result: Record<string, unknown>): string {
  return "version" in result
    ? `Payslip template published (version ${String(result.version)})`
    : `Payslip template "${String(result.name)}" saved as a draft (revision ${String(result.draft_revision)})`;
}

// ---------- registration ----------

registerDataType(PAYROLL_RESULT, {
  request: (appId, payload) =>
    answerRequest(appId, PAYROLL_RESULT, () => handleDataRequest(appId, payload)),
});

registerDataType(STATUTORY_RATES, {
  request: (appId, payload) =>
    answerRequest(appId, STATUTORY_RATES, () => answerRatesRequest(payload)),
  save: (appId, payload) =>
    recordSave(
      appId,
      STATUTORY_RATES,
      "the statutory rates",
      () => saveRates(payload),
      (result) =>
        `Statutory rates saved for ${formatPeriod(`${String(result.effective_from)}-01`)} (revision ${String(result.revision)})`,
    ),
});

registerDataType(PAYSLIP_TEMPLATE, {
  request: (appId, payload) =>
    answerRequest(appId, PAYSLIP_TEMPLATE, () => answerTemplateRequest(payload)),
  save: (appId, payload) =>
    recordSave(
      appId,
      PAYSLIP_TEMPLATE,
      "the payslip template",
      () => saveTemplate(payload),
      describeTemplateSave,
    ),
});
