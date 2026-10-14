import { z } from "zod";
import { PAYROLL_SETUP } from "@/config/apps.config";
import { registerDataType } from "@/lib/bridge/bridge";
import {
  jsonBytes,
  SETUP_BODY_BYTES,
  type ReceivedPayload,
  type RequestDataPayload,
  type ResponseDataPayload,
  type SendDataPayload,
} from "@/lib/bridge/protocol";
import {
  attachCompany,
  fetchAttachedCompanySetups,
  fetchCompanySetup,
  fetchCompanySetupLinks,
  fetchSetupHistory,
  fetchSetupRevision,
  fetchSharedSetup,
  fetchSharedSetupAccess,
  PAYROLL_SETUPS_MIGRATION,
  saveCompanySetup,
  saveSharedSetup,
  type SetupTarget,
} from "@/lib/supabase/payrollSetups";
import { fetchMemberships, type Viewer } from "@/lib/supabase/queries";
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
import { answerRequest, recordSave } from "./deliver";

/**
 * The payroll app's column setup (docs/INTEGRATION.md, "Payroll app: column setup"):
 *
 *  - the shared setup: identity fields, the ID field and the Global columns, which several
 *    companies are attached to. A change reaches every one of them, so the database lets only
 *    an admin of every attached company make it;
 *  - each company's own setup: its own columns and company details.
 *
 * Nothing in either is per employee (the months stay in the app's browser storage until
 * Phase 3), so, like PDF templates, it is answered and saved WITHOUT a dialog and without the
 * password gate; every exchange is a row in the transfer log and every save shows a toast.
 * Both bodies are the app's own JSON, stored exactly as sent and never looked inside.
 *
 * Companies are named by BRN on the wire. Every message carries the BRN of the company
 * selected in the dashboard, which must match (an app still showing another company must not
 * save into this one). A save may name other companies of the user's (`company_brn`, and each
 * entry of `companies`): the import attaches several at once, and a change of a Global
 * column's key rewrites formulas in every attached company. The database decides whether the
 * user may change each of them.
 */

const setupIdSchema = z.uuid();
const setupNameSchema = z.string().trim().min(1).max(80);
const bodySchema = z.record(z.string(), z.unknown());
const targetSchema = z.enum(["shared", "company"]);

const paramsSchema = z.discriminatedUnion("action", [
  /** The shared setup of the selected company and every attached company the user can read. */
  z.strictObject({ action: z.literal("load"), brn: brnSchema.optional() }),
  /** The kept revisions of the shared setup or of a company's own setup, newest first. */
  z.strictObject({
    action: z.literal("history"),
    brn: brnSchema.optional(),
    target: targetSchema,
    company_brn: brnSchema.optional(),
  }),
  /** One kept revision, with its body. */
  z.strictObject({
    action: z.literal("revision"),
    brn: brnSchema.optional(),
    target: targetSchema,
    revision: z.number().int().min(1),
    company_brn: brnSchema.optional(),
  }),
  /** The companies the user is an admin of, and whether each has a setup: for the import. */
  z.strictObject({ action: z.literal("companies"), brn: brnSchema.optional() }),
]);

const saveSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("save-shared"),
    brn: brnSchema,
    /** Chosen by the app, for a new shared setup too. */
    shared_setup_id: setupIdSchema,
    name: setupNameSchema,
    body: bodySchema,
    /** The revision last seen; 0 for a new shared setup. */
    expected_revision: z.number().int().min(0),
    /** Attached companies whose own setups change in the same step, all or nothing. */
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
  }),
  z.strictObject({
    action: z.literal("save-company"),
    brn: brnSchema,
    /** Another of the user's companies; absent = the selected one. */
    company_brn: brnSchema.optional(),
    body: bodySchema,
    expected_revision: z.number().int().min(1),
  }),
  z.strictObject({
    action: z.literal("attach-company"),
    brn: brnSchema,
    company_brn: brnSchema.optional(),
    shared_setup_id: setupIdSchema,
    body: bodySchema,
  }),
]);

const TOO_LARGE = refuse(
  "too-large",
  "The column setup is larger than the dashboard accepts (250 KB).",
);
const NO_SUCH_COMPANY = refuse("not-found", "You have no company with that BRN in the dashboard.");
const NO_SETUP = refuse("not-found", "This company has no column setup in the dashboard yet.");

/** The user's membership of the company with this BRN, or null. */
function membershipFor(memberships: Membership[], brn: string): Membership | null {
  const wanted = normaliseBrn(brn);
  return memberships.find((m) => m.company.brn && normaliseBrn(m.company.brn) === wanted) ?? null;
}

/** Which company a request is about: the selected one, or another of the user's by BRN. */
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

/** Answers the payroll app's questions about its column setup. */
export async function answerPayrollSetupRequest(
  payload: RequestDataPayload,
): Promise<ResponseDataPayload> {
  const params = paramsSchema.safeParse(payload.params ?? {});
  if (!params.success) return invalidRefusal(params.error);
  const current = exchangeContextFor(params.data.brn);
  if ("ok" in current) return current;
  const { viewer, membership } = current;
  // Not anyone's user id: only whether it was the person now signed in.
  const you = (id: string | null) => id !== null && id === viewer.id;
  const answer = (rows: Record<string, unknown>[]): ResponseDataPayload => ({
    ok: true,
    dataType: PAYROLL_SETUP,
    rows,
    meta: answerMeta(membership),
  });

  try {
    switch (params.data.action) {
      case "load": {
        const own = await fetchCompanySetup(viewer, membership.company.id);
        // Not attached yet: nothing to load. The app offers its import, or to start one.
        if (!own) return answer([]);
        const setup = await fetchSharedSetup(viewer, own.shared_setup_id);
        if (!setup) return NO_SETUP;
        const [access, attached, memberships] = await Promise.all([
          fetchSharedSetupAccess(viewer, setup.id),
          fetchAttachedCompanySetups(viewer, setup.id),
          fetchMemberships(viewer),
        ]);
        const byId = new Map(memberships.map((m) => [m.company.id, m]));
        const companies = attached.flatMap((company) => {
          const member = byId.get(company.company_id);
          // A company without a BRN cannot be named on the wire, so it cannot be worked on here.
          if (!member?.company.brn) return [];
          return [
            {
              kind: "company",
              brn: member.company.brn,
              name: member.company.name,
              address: member.company.address,
              role: member.role === "admin" ? "admin" : "member",
              selected: company.company_id === membership.company.id,
              shared_setup_id: company.shared_setup_id,
              body: company.body,
              revision: company.revision,
              updated_at: company.updated_at,
              updated_by_you: you(company.updated_by),
            },
          ];
        });
        return answer([
          {
            kind: "shared",
            shared_setup_id: setup.id,
            name: setup.name,
            body: setup.body,
            revision: setup.revision,
            updated_at: setup.updated_at,
            updated_by_you: you(setup.updated_by),
            can_change: access.can_change,
            companies: access.companies,
            admin_of: access.admin_of,
          },
          ...companies,
        ]);
      }
      case "history":
      case "revision": {
        const company = await companyFor(viewer, membership, params.data.company_brn);
        if (!company) return NO_SUCH_COMPANY;
        const own = await fetchCompanySetup(viewer, company.company.id);
        if (!own) return NO_SETUP;
        const target: SetupTarget =
          params.data.target === "shared"
            ? { kind: "shared", id: own.shared_setup_id }
            : { kind: "company", id: company.company.id };
        if (params.data.action === "history") {
          const revisions = await fetchSetupHistory(viewer, target);
          return answer(
            revisions.map(({ saved_by, ...revision }) => ({
              ...revision,
              saved_by_you: you(saved_by),
            })),
          );
        }
        const kept = await fetchSetupRevision(viewer, target, params.data.revision);
        if (!kept) return refuse("not-found", "This setup has no such revision.");
        const { saved_by, ...revision } = kept;
        return answer([{ ...revision, saved_by_you: you(saved_by) }]);
      }
      case "companies": {
        const admin = (await fetchMemberships(viewer)).filter(
          (m) => m.role === "admin" && m.company.brn,
        );
        const links = new Map(
          (
            await fetchCompanySetupLinks(
              viewer,
              admin.map((m) => m.company.id),
            )
          ).map((link) => [link.company_id, link.shared_setup_id]),
        );
        return answer(
          admin.map((m) => ({
            brn: m.company.brn,
            name: m.company.name,
            address: m.company.address,
            has_setup: links.has(m.company.id),
            shared_setup_id: links.get(m.company.id) ?? null,
            selected: m.company.id === membership.company.id,
          })),
        );
      }
    }
  } catch (error) {
    return refusalFor(error, PAYROLL_SETUPS_MIGRATION);
  }
}

/** Saves the shared setup, a company's own setup, or attaches a company. Bodies are stored exactly as sent. */
export async function savePayrollSetupFromApp(payload: SendDataPayload): Promise<ReceivedPayload> {
  const row = saveSchema.safeParse(payload.rows[0]);
  if (!row.success) return invalidRefusal(row.error);
  const current = exchangeContextFor(row.data.brn);
  if ("ok" in current) return current;
  const { viewer, membership } = current;
  const command = row.data;

  try {
    switch (command.action) {
      case "save-shared": {
        const companies = command.companies ?? [];
        if (
          [command.body, ...companies.map((c) => c.body)].some(
            (b) => jsonBytes(b) > SETUP_BODY_BYTES,
          )
        ) {
          return TOO_LARGE;
        }
        const memberships = companies.length > 0 ? await fetchMemberships(viewer) : [];
        const resolved: {
          companyId: string;
          brn: string;
          body: Record<string, unknown>;
          expectedRevision: number;
        }[] = [];
        for (const company of companies) {
          const member = membershipFor(memberships, company.company_brn);
          if (!member) return NO_SUCH_COMPANY;
          resolved.push({
            companyId: member.company.id,
            brn: member.company.brn!,
            body: company.body,
            expectedRevision: company.expected_revision,
          });
        }
        if (new Set(resolved.map((c) => c.companyId)).size !== resolved.length) {
          return refuse("invalid", "A company is named twice.");
        }
        const saved = await saveSharedSetup(viewer, {
          setupId: command.shared_setup_id,
          name: command.name,
          body: command.body,
          expectedRevision: command.expected_revision,
          companies: resolved,
        });
        const brnOf = new Map(resolved.map((c) => [c.companyId, c.brn]));
        return {
          ok: true,
          result: {
            action: "save-shared",
            shared_setup_id: saved.shared_setup_id,
            name: saved.name,
            revision: saved.revision,
            updated_at: saved.updated_at,
            companies: saved.companies.map((c) => ({
              brn: brnOf.get(c.company_id),
              revision: c.revision,
            })),
          },
        };
      }
      case "save-company":
      case "attach-company": {
        if (jsonBytes(command.body) > SETUP_BODY_BYTES) return TOO_LARGE;
        const company = await companyFor(viewer, membership, command.company_brn);
        if (!company) return NO_SUCH_COMPANY;
        if (company.role !== "admin") {
          return refuse("forbidden", "Only an admin of this company can change its columns.");
        }
        const saved =
          command.action === "save-company"
            ? await saveCompanySetup(
                viewer,
                company.company.id,
                command.body,
                command.expected_revision,
              )
            : await attachCompany(
                viewer,
                company.company.id,
                command.shared_setup_id,
                command.body,
              );
        return {
          ok: true,
          result: {
            action: command.action,
            brn: company.company.brn,
            company: company.company.name,
            shared_setup_id: saved.shared_setup_id,
            revision: saved.revision,
            updated_at: saved.updated_at,
          },
        };
      }
    }
  } catch (error) {
    return refusalFor(error, PAYROLL_SETUPS_MIGRATION);
  }
}

/** The toast for a setup save. Names and numbers only. */
export function describePayrollSetupSave(result: Record<string, unknown>): string {
  switch (result.action) {
    case "attach-company":
      return `${String(result.company)} now uses the shared payroll columns`;
    case "save-company":
      return `Payroll columns of ${String(result.company)} saved (revision ${String(result.revision)})`;
    default: {
      const companies = Array.isArray(result.companies) ? result.companies.length : 0;
      const also =
        companies > 0
          ? `, with the columns of ${companies} ${companies === 1 ? "company" : "companies"}`
          : "";
      return `Shared payroll columns saved (revision ${String(result.revision)})${also}`;
    }
  }
}

/** How many setups a save stored, for the transfer log. */
const savedCount = (result: Record<string, unknown>) =>
  1 + (Array.isArray(result.companies) ? result.companies.length : 0);

registerDataType(PAYROLL_SETUP, {
  request: (appId, payload) =>
    answerRequest(appId, PAYROLL_SETUP, () => answerPayrollSetupRequest(payload)),
  save: (appId, payload) =>
    recordSave(
      appId,
      PAYROLL_SETUP,
      "the payroll columns",
      () => savePayrollSetupFromApp(payload),
      describePayrollSetupSave,
      savedCount,
    ),
});
