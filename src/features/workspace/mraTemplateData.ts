import { z } from "zod";
import { MRA_TEMPLATE } from "@/config/apps.config";
import { registerDataType } from "@/lib/bridge/bridge";
import {
  jsonBytes,
  MRA_TEMPLATE_BODY_BYTES,
  MRA_VALUES_BYTES,
  type ReceivedPayload,
  type RequestDataPayload,
  type ResponseDataPayload,
  type SendDataPayload,
} from "@/lib/bridge/protocol";
import {
  attachMraTemplate,
  detachMraTemplate,
  fetchMraTemplateAccess,
  fetchMraTemplateHistory,
  fetchMraTemplateLinks,
  fetchMraTemplateRevision,
  fetchMraTemplates,
  MRA_MIGRATION,
  saveMraTemplate,
  saveMraTemplateValues,
  type MraTemplateLink,
} from "@/lib/supabase/mraReturns";
import type { Viewer } from "@/lib/supabase/queries";
import type { Membership } from "@/lib/supabase/schemas";
import {
  answerMeta,
  brnSchema,
  exchangeContextFor,
  invalidRefusal,
  normaliseBrn,
  refusalFor,
  refuse,
} from "./appData";
import { adminCompanies } from "./batchAccess";
import { answerRequest, recordSave } from "./deliver";

/**
 * The MRA Returns app's templates of a return file (docs/INTEGRATION.md, "mra-template"),
 * migration 0020_mra_returns.sql:
 *
 *  - a template is shared by the companies using it, as the payroll app's Global columns are:
 *    an admin of any of them reads it, and only an admin of EVERY one of them changes it;
 *  - each company has its own values for it (a fixed value "for this company only"), changed by
 *    that company's admins.
 *
 * MRA returns are made by admins only, so a member is refused at once. A template holds the
 * layout of a file and fixed values, never an employee or a figure (the app keeps the copied
 * rows only), so, like the column setup, it is answered and saved WITHOUT a dialog and without
 * the password gate; every exchange is a row in the transfer log and every save shows a toast.
 * The body and the values are the app's own JSON, stored exactly as sent and never looked
 * inside. Every message is about the company selected in the dashboard (`brn`); `attach` also
 * names the company the template is to be used in (`company_brn`), one of the user's admin
 * companies.
 */

const templateIdSchema = z.uuid();
const nameSchema = z.string().trim().min(1).max(80);
const objectSchema = z.record(z.string(), z.unknown());

const paramsSchema = z.discriminatedUnion("action", [
  /** The templates the selected company uses, without their bodies. */
  z.strictObject({ action: z.literal("list"), brn: brnSchema.optional() }),
  /** One template, with its body and this company's own values. */
  z.strictObject({
    action: z.literal("load"),
    brn: brnSchema.optional(),
    template_id: templateIdSchema,
  }),
  /** Its kept revisions, newest first. */
  z.strictObject({
    action: z.literal("history"),
    brn: brnSchema.optional(),
    template_id: templateIdSchema,
  }),
  /** One kept revision, with its body. */
  z.strictObject({
    action: z.literal("revision"),
    brn: brnSchema.optional(),
    template_id: templateIdSchema,
    revision: z.number().int().min(1),
  }),
  /** The user's admin companies, and whether each uses this template. */
  z.strictObject({
    action: z.literal("companies"),
    brn: brnSchema.optional(),
    template_id: templateIdSchema,
  }),
]);

const saveSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("save"),
    brn: brnSchema,
    /** Chosen by the app, for a new template too. */
    template_id: templateIdSchema,
    name: nameSchema,
    body: objectSchema,
    /** The revision last seen; 0 for a new template, made for the selected company. */
    expected_revision: z.number().int().min(0),
  }),
  z.strictObject({
    action: z.literal("values"),
    brn: brnSchema,
    template_id: templateIdSchema,
    own_values: objectSchema,
    expected_revision: z.number().int().min(1),
  }),
  z.strictObject({
    action: z.literal("attach"),
    brn: brnSchema,
    template_id: templateIdSchema,
    company_brn: brnSchema,
    own_values: objectSchema.optional(),
  }),
  z.strictObject({
    action: z.literal("detach"),
    brn: brnSchema,
    template_id: templateIdSchema,
    /** The template's revision last seen: what the user decided to take out is what is stored. */
    expected_revision: z.number().int().min(1),
  }),
]);

const MEMBER = refuse(
  "forbidden",
  "Only an admin of this company can see or change its MRA templates.",
);
const NOT_USED = refuse(
  "not-found",
  "This company does not use that MRA template. Reload the list.",
);
const TOO_LARGE = refuse(
  "too-large",
  "The MRA template is larger than the dashboard accepts (250 KB).",
);
const VALUES_TOO_LARGE = refuse(
  "too-large",
  "This company's values for the template are larger than the dashboard accepts (64 KB).",
);

/** The selected company's use of a template, or null when it does not use it. */
async function linkOf(
  viewer: Viewer,
  membership: Membership,
  templateId: string,
): Promise<MraTemplateLink | null> {
  const links = await fetchMraTemplateLinks(viewer, [membership.company.id]);
  return links.find((link) => link.template_id === templateId) ?? null;
}

/** The refusal for a failed read or save; three database codes get MRA wording. */
function mraRefusal(error: unknown) {
  const message = (error as { message?: unknown } | null)?.message;
  const text = typeof message === "string" ? message : "";
  if (text.includes("PH_ALREADY_ATTACHED")) {
    return refuse("stale", "That company already uses this MRA template. Reload, then try again.");
  }
  if (text.includes("PH_DUPLICATE_NAME")) {
    return refuse(
      "invalid",
      "A company using this template already has another MRA template with that name.",
    );
  }
  if (text.includes("PH_LIMIT")) {
    return refuse("too-large", "A company can use at most 20 MRA templates.");
  }
  return refusalFor(error, MRA_MIGRATION);
}

/** Answers the MRA Returns app's questions about its templates. */
export async function answerMraTemplateRequest(
  payload: RequestDataPayload,
): Promise<ResponseDataPayload> {
  const params = paramsSchema.safeParse(payload.params ?? {});
  if (!params.success) return invalidRefusal(params.error);
  const current = exchangeContextFor(params.data.brn);
  if ("ok" in current) return current;
  const { viewer, membership } = current;
  if (membership.role !== "admin") return MEMBER;
  // Not anyone's user id: only whether it was the person now signed in.
  const you = (id: string | null) => id !== null && id === viewer.id;
  const answer = (rows: Record<string, unknown>[]): ResponseDataPayload => ({
    ok: true,
    dataType: MRA_TEMPLATE,
    rows,
    meta: answerMeta(membership),
  });

  try {
    if (params.data.action === "list") {
      const links = await fetchMraTemplateLinks(viewer, [membership.company.id]);
      const templates = await fetchMraTemplates(
        viewer,
        links.map((link) => link.template_id),
      );
      const rows = await Promise.all(
        templates.map(async (template) => {
          const link = links.find((one) => one.template_id === template.id)!;
          const access = await fetchMraTemplateAccess(viewer, template.id);
          return {
            template_id: template.id,
            name: template.name,
            revision: template.revision,
            updated_at: template.updated_at,
            updated_by_you: you(template.updated_by),
            ...access,
            values_revision: link.revision,
          };
        }),
      );
      return answer(rows);
    }

    const { template_id: templateId } = params.data;
    const link = await linkOf(viewer, membership, templateId);
    if (!link) return NOT_USED;

    switch (params.data.action) {
      case "load": {
        const [template] = await fetchMraTemplates(viewer, [templateId]);
        if (!template) return NOT_USED;
        const access = await fetchMraTemplateAccess(viewer, templateId);
        return answer([
          {
            template_id: template.id,
            name: template.name,
            revision: template.revision,
            body: template.body,
            updated_at: template.updated_at,
            updated_by_you: you(template.updated_by),
            ...access,
            own_values: link.own_values,
            values_revision: link.revision,
          },
        ]);
      }
      case "history": {
        const revisions = await fetchMraTemplateHistory(viewer, templateId);
        return answer(
          revisions.map(({ saved_by, ...revision }) => ({
            ...revision,
            saved_by_you: you(saved_by),
          })),
        );
      }
      case "revision": {
        const kept = await fetchMraTemplateRevision(viewer, templateId, params.data.revision);
        if (!kept) return refuse("not-found", "This MRA template has no such revision.");
        const { saved_by, ...revision } = kept;
        return answer([{ template_id: templateId, ...revision, saved_by_you: you(saved_by) }]);
      }
      case "companies": {
        const admin = await adminCompanies(viewer, membership.company.id);
        const using = new Set(
          (
            await fetchMraTemplateLinks(
              viewer,
              admin.map((one) => one.company.id),
            )
          )
            .filter((one) => one.template_id === templateId)
            .map((one) => one.company_id),
        );
        return answer(
          admin.map(({ company }) => ({
            brn: company.brn,
            name: company.name.slice(0, 120),
            selected: company.id === membership.company.id,
            uses: using.has(company.id),
          })),
        );
      }
    }
  } catch (error) {
    return mraRefusal(error);
  }
}

/** Saves a template, this company's values, or uses or takes a template out of a company. */
export async function saveMraTemplateFromApp(payload: SendDataPayload): Promise<ReceivedPayload> {
  const row = saveSchema.safeParse(payload.rows[0]);
  if (!row.success) return invalidRefusal(row.error);
  const current = exchangeContextFor(row.data.brn);
  if ("ok" in current) return current;
  const { viewer, membership } = current;
  if (membership.role !== "admin") return MEMBER;
  const command = row.data;
  const company = membership.company;

  try {
    switch (command.action) {
      case "save": {
        if (jsonBytes(command.body) > MRA_TEMPLATE_BODY_BYTES) return TOO_LARGE;
        const saved = await saveMraTemplate(viewer, {
          templateId: command.template_id,
          companyId: company.id,
          name: command.name,
          body: command.body,
          expectedRevision: command.expected_revision,
        });
        return {
          ok: true,
          result: {
            action: "save",
            template_id: saved.template_id,
            name: saved.name,
            revision: saved.revision,
            updated_at: saved.updated_at,
          },
        };
      }
      case "values": {
        if (jsonBytes(command.own_values) > MRA_VALUES_BYTES) return VALUES_TOO_LARGE;
        const [template] = await fetchMraTemplates(viewer, [command.template_id]);
        if (!template) return NOT_USED;
        const saved = await saveMraTemplateValues(
          viewer,
          command.template_id,
          company.id,
          command.own_values,
          command.expected_revision,
        );
        return {
          ok: true,
          result: {
            action: "values",
            template_id: saved.template_id,
            name: template.name,
            company: company.name,
            values_revision: saved.revision,
            updated_at: saved.updated_at,
          },
        };
      }
      case "attach": {
        const values = command.own_values ?? {};
        if (jsonBytes(values) > MRA_VALUES_BYTES) return VALUES_TOO_LARGE;
        if (!(await linkOf(viewer, membership, command.template_id))) return NOT_USED;
        const target = (await adminCompanies(viewer, company.id)).find(
          (one) => normaliseBrn(one.company.brn!) === normaliseBrn(command.company_brn),
        );
        if (!target) {
          return refuse(
            "forbidden",
            "Only a company where you are an admin can use this template.",
          );
        }
        const [template] = await fetchMraTemplates(viewer, [command.template_id]);
        if (!template) return NOT_USED;
        const saved = await attachMraTemplate(
          viewer,
          command.template_id,
          target.company.id,
          values,
        );
        return {
          ok: true,
          result: {
            action: "attach",
            template_id: saved.template_id,
            name: template.name,
            brn: target.company.brn,
            company: target.company.name,
            values_revision: saved.revision,
          },
        };
      }
      case "detach": {
        const done = await detachMraTemplate(
          viewer,
          command.template_id,
          company.id,
          command.expected_revision,
        );
        return {
          ok: true,
          result: {
            action: "detach",
            template_id: done.template_id,
            name: done.name,
            company: company.name,
            deleted: done.deleted,
          },
        };
      }
    }
  } catch (error) {
    return mraRefusal(error);
  }
}

/** The toast for a save. Names and numbers only. */
export function describeMraTemplateSave(result: Record<string, unknown>): string {
  const name = `"${String(result.name)}"`;
  switch (result.action) {
    case "values":
      return `${String(result.company)}'s own values for MRA template ${name} saved`;
    case "attach":
      return `MRA template ${name} is now also used by ${String(result.company)}`;
    case "detach":
      return result.deleted
        ? `MRA template ${name} deleted, with its history`
        : `MRA template ${name} removed from ${String(result.company)}`;
    default:
      return `MRA template ${name} saved (revision ${String(result.revision)})`;
  }
}

registerDataType(MRA_TEMPLATE, {
  request: (appId, payload) =>
    answerRequest(appId, MRA_TEMPLATE, () => answerMraTemplateRequest(payload)),
  save: (appId, payload) =>
    recordSave(
      appId,
      MRA_TEMPLATE,
      "the MRA template",
      () => saveMraTemplateFromApp(payload),
      describeMraTemplateSave,
    ),
});
