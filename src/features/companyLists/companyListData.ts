import { z } from "zod";
import { COMPANY_LIST, getApp } from "@/config/apps.config";
import { registerDataType } from "@/lib/bridge/bridge";
import type { RequestDataPayload, ResponseDataPayload } from "@/lib/bridge/protocol";
import { registerSessionCleanup } from "@/lib/sessionCleanup";
import { createStore } from "@/lib/store";
import {
  COMPANY_LISTS_MIGRATION,
  fetchCompanyLists,
  type AppList,
} from "@/lib/supabase/companyLists";
import { fetchMemberships } from "@/lib/supabase/queries";
import {
  answerMeta,
  brnSchema,
  exchangeContextFor,
  invalidRefusal,
  refusalFor,
  refuse,
} from "@/features/workspace/appData";
import { answerRequest } from "@/features/workspace/deliver";

/**
 * Which companies an app is used for (docs/INTEGRATION.md, "company-list"; migration 0024).
 * Nothing per employee and no figure, so no question and no password gate. Every company the
 * user belongs to is listed, whatever their role, with the lists of THIS app it is switched on
 * in: an app only ever learns about its own lists.
 *
 *  - `companies`: the user's companies, read from the database each time, sorted by name.
 *    `selected` marks the company selected in the dashboard; `open` marks it once, right after
 *    the app asked to open it (below), so the app goes straight to that company's screen.
 *  - `open-picker`: shows the full-page company picker in the dashboard, over the app. The app
 *    is answered at once; when a change is saved with Done, the app's frame is reloaded so it
 *    starts again with the new list.
 *  - `open-company`: selects that company in the dashboard the usual way (asking first when an
 *    app holds unsaved changes); the apps then reload. Answers `switched: false` when it is
 *    already the selected company, and the app opens it itself. The month the app names
 *    (`period`) comes back with `open` as `open_period`.
 *
 * A convenience only: a company that is switched off still opens; nobody's access changes.
 */

/** The lists each app has. PDF Form Filler has none. */
export const APP_LISTS_BY_APP: Readonly<Record<string, readonly AppList[]>> = {
  payroll: ["payroll"],
  payslip: ["payslips"],
  "mra-returns": ["csg", "prgf"],
};

/** The most companies one answer lists (the data type's own limit). */
export const MAX_COMPANIES = 500;

/** How long an `open-company` waits for the app to come back and ask. */
const OPEN_WAIT_MS = 60_000;

const paramsSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("companies"), brn: brnSchema.optional() }),
  z.strictObject({ action: z.literal("open-picker"), brn: brnSchema.optional() }),
  z.strictObject({
    action: z.literal("open-company"),
    brn: brnSchema.optional(),
    company_id: z.uuid(),
    /** The month the app showed, "YYYY-MM": given back with `open` after the reload. */
    period: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .optional(),
  }),
]);

// ---------- the picker, shown by CompanyPickerHost ----------

export interface PickerRequest {
  appId: string;
  appName: string;
  lists: readonly AppList[];
}

/** The picker that is open, or null. One at a time: a new one replaces it. */
export const pickerRequest = createStore<PickerRequest | null>(null);

/** Bumped for an app when its frame should start again (after the picker saved a change). */
export const appReloads = createStore<Readonly<Record<string, number>>>({});

export function reloadApp(appId: string): void {
  appReloads.set((all) => ({ ...all, [appId]: (all[appId] ?? 0) + 1 }));
}

// ---------- opening a company, done by CompanyOpener ----------

type Opener = (companyId: string) => void;
let opener: Opener | null = null;

/** Registers the way to select a company; returns how to remove it. */
export function setCompanyOpener(next: Opener): () => void {
  opener = next;
  return () => {
    if (opener === next) opener = null;
  };
}

/** The company an app asked to open, until that app asks for its companies again. */
let pendingOpen: { appId: string; companyId: string; period?: string; until: number } | null = null;

/** Forgets what is pending and closes the picker. For tests, and on sign-out. */
export function forgetCompanyListState(): void {
  pendingOpen = null;
  pickerRequest.set(null);
}
registerSessionCleanup(forgetCompanyListState);

/** Answers an app's company-list requests. */
export async function answerCompanyListRequest(
  appId: string,
  payload: RequestDataPayload,
): Promise<ResponseDataPayload> {
  const params = paramsSchema.safeParse(payload.params ?? {});
  if (!params.success) return invalidRefusal(params.error);
  const lists = APP_LISTS_BY_APP[appId];
  if (!lists) return refuse("forbidden", "This app has no list of companies.");
  const current = exchangeContextFor(params.data.brn);
  if ("ok" in current) return current;
  const { viewer, membership } = current;
  const meta = answerMeta(membership);

  if (params.data.action === "open-picker") {
    pickerRequest.set({ appId, appName: getApp(appId)?.name ?? appId, lists });
    return { ok: true, dataType: COMPANY_LIST, rows: [], meta };
  }

  try {
    const memberships = (await fetchMemberships(viewer)).slice(0, MAX_COMPANIES);

    if (params.data.action === "open-company") {
      const wanted = params.data.company_id;
      if (!memberships.some((one) => one.company.id === wanted)) {
        return refuse("forbidden", "You are not a member of that company.");
      }
      if (wanted === membership.company.id) {
        return { ok: true, dataType: COMPANY_LIST, rows: [{ switched: false }], meta };
      }
      if (!opener) {
        return refuse("unavailable", "The dashboard cannot change company right now.");
      }
      pendingOpen = {
        appId,
        companyId: wanted,
        ...(params.data.period ? { period: params.data.period } : {}),
        until: Date.now() + OPEN_WAIT_MS,
      };
      const open = opener;
      // After the answer has left: selecting another company reloads the app's frame.
      setTimeout(() => open(wanted), 0);
      return { ok: true, dataType: COMPANY_LIST, rows: [{ switched: true }], meta };
    }

    const on = await fetchCompanyLists(
      viewer,
      memberships.map((one) => one.company.id),
    );
    const pending = pendingOpen;
    const opening =
      pending !== null &&
      pending.appId === appId &&
      pending.companyId === membership.company.id &&
      pending.until >= Date.now();
    if (pending?.appId === appId) pendingOpen = null;
    return {
      ok: true,
      dataType: COMPANY_LIST,
      rows: memberships.map(({ company, role }) => ({
        company_id: company.id,
        brn: company.brn ?? "",
        name: company.name.slice(0, 120),
        admin: role === "admin",
        selected: company.id === membership.company.id,
        lists: lists.filter((list) =>
          on.some((row) => row.company_id === company.id && row.list === list),
        ),
        ...(opening && company.id === membership.company.id
          ? { open: true, ...(pending.period ? { open_period: pending.period } : {}) }
          : {}),
      })),
      meta,
    };
  } catch (error) {
    return refusalFor(error, COMPANY_LISTS_MIGRATION);
  }
}

registerDataType(COMPANY_LIST, {
  request: (appId, payload) =>
    answerRequest(appId, COMPANY_LIST, () => answerCompanyListRequest(appId, payload)),
});
