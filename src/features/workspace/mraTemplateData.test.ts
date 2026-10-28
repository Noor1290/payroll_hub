import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getApp } from "@/config/apps.config";
import { clearTransferLog, transferLog } from "@/features/transfer/transferLog";
import { DATA_RULES } from "@/lib/bridge/protocol";
import { demoMemberships } from "@/lib/demo/demoData";
import { demoForgetMraReturns } from "@/lib/demo/demoMraReturns";
import { runSessionCleanup } from "@/lib/sessionCleanup";
import type { Membership } from "@/lib/supabase/schemas";
import { exchangeContext } from "./appData";
import { recordSave } from "./deliver";
import {
  answerMraTemplateRequest,
  describeMraTemplateSave,
  saveMraTemplateFromApp,
} from "./mraTemplateData";

/**
 * The MRA Returns app's templates (mra-template), on the dashboard's side: what the app sends is
 * checked here and carried out by the demo store, which follows the rules of migration 0020
 * (src/lib/demo/demoMraReturns.ts). The same rules in the real database are tested in
 * mraReturns.db.test.ts. FAKE values only.
 */
const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  loading: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));

const ME = "00000000-0000-4000-8000-000000000001";
const membershipOf = (brn: string) => demoMemberships.find((m) => m.company.brn === brn)!;
const ABC = membershipOf("C1234567"); // admin
const XYZ = membershipOf("C7654321"); // viewer
const NEW = membershipOf("C0000001"); // admin
const signIn = (membership: Membership = ABC) =>
  exchangeContext.set({ viewer: { id: ME, isDemo: true }, membership });

const T1 = "60000000-0000-4000-8000-000000000001";
const T2 = "60000000-0000-4000-8000-000000000002";
const BODY = {
  format: "mra-returns-template",
  version: 1,
  rows: [{ kind: "copy", cells: ["MRA", "PACO", "V1.0"] }],
};
const OTHER = { ...BODY, rows: [{ kind: "copy", cells: ["MRA", "PRGF", "V1.0"] }] };

const request = (params: Record<string, unknown>) =>
  answerMraTemplateRequest({ dataType: "mra-template", params });
const send = (row: Record<string, unknown>) =>
  saveMraTemplateFromApp({ dataType: "mra-template", rows: [row] });
const create = (more: Record<string, unknown> = {}) =>
  send({
    action: "save",
    brn: "C1234567",
    template_id: T1,
    name: "MRA CSG (PACO)",
    body: BODY,
    expected_revision: 0,
    ...more,
  });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  demoForgetMraReturns();
  signIn();
  toast.success.mockClear();
  toast.error.mockClear();
});
afterEach(() => {
  runSessionCleanup();
  clearTransferLog();
  vi.useRealTimers();
});

describe("the data type", () => {
  it("is the MRA Returns app's only, to ask for and to send, one command per message", () => {
    expect(getApp("mra-returns")).toMatchObject({
      accepts: ["mra-batch", "mra-template"],
      produces: ["mra-template"],
    });
    expect(DATA_RULES["mra-template"]).toMatchObject({ sendRows: 1, sendBytes: 270_000 });
  });
});

describe("mra-template: making, reading and saving", () => {
  it("lists nothing at first, with the company and the role", async () => {
    expect(await request({ action: "list" })).toEqual({
      ok: true,
      dataType: "mra-template",
      rows: [],
      meta: { label: "ABC Co Ltd", brn: "C1234567", role: "admin" },
    });
  });

  it("makes a template for the selected company and gives it back exactly", async () => {
    expect(await create({ name: "  MRA CSG (PACO) " })).toEqual({
      ok: true,
      result: {
        action: "save",
        template_id: T1,
        name: "MRA CSG (PACO)",
        revision: 1,
        updated_at: expect.any(String),
      },
    });
    const list = await request({ action: "list", brn: "C1234567" });
    expect(list).toMatchObject({
      ok: true,
      rows: [
        {
          template_id: T1,
          name: "MRA CSG (PACO)",
          revision: 1,
          updated_by_you: true,
          can_change: true,
          companies: 1,
          admin_of: 1,
          values_revision: 1,
        },
      ],
    });
    expect((list as { rows: Record<string, unknown>[] }).rows[0]).not.toHaveProperty("body");
    const loaded = await request({ action: "load", template_id: T1 });
    expect(loaded).toMatchObject({
      ok: true,
      rows: [{ template_id: T1, body: BODY, own_values: {}, values_revision: 1, can_change: true }],
    });
    expect(JSON.stringify(loaded)).not.toContain(ME);
  });

  it("keeps every revision: history newest first, and each one with its body", async () => {
    await create();
    await send({
      action: "save",
      brn: "C1234567",
      template_id: T1,
      name: "MRA CSG",
      body: OTHER,
      expected_revision: 1,
    });
    expect(await request({ action: "history", template_id: T1 })).toMatchObject({
      rows: [
        { revision: 2, name: "MRA CSG", saved_by_you: true },
        { revision: 1, name: "MRA CSG (PACO)", saved_by_you: true },
      ],
    });
    expect(await request({ action: "revision", template_id: T1, revision: 1 })).toMatchObject({
      rows: [{ template_id: T1, revision: 1, name: "MRA CSG (PACO)", body: BODY }],
    });
    expect(await request({ action: "revision", template_id: T1, revision: 9 })).toMatchObject({
      ok: false,
      code: "not-found",
    });
  });

  it("refuses an old revision as stale, and the same new template sent twice makes one", async () => {
    await create();
    expect(await create()).toMatchObject({ ok: false, code: "stale" });
    expect(
      await send({
        action: "save",
        brn: "C1234567",
        template_id: T1,
        name: "X",
        body: OTHER,
        expected_revision: 3,
      }),
    ).toMatchObject({ ok: false, code: "stale" });
    expect(((await request({ action: "list" })) as { rows: unknown[] }).rows).toHaveLength(1);
  });

  it("refuses a second template with the same name in the company, whatever the capitals", async () => {
    await create();
    expect(await create({ template_id: T2, name: "mra csg (paco)" })).toMatchObject({
      ok: false,
      code: "invalid",
      error: "A company using this template already has another MRA template with that name.",
    });
  });

  it("saves this company's own values, with their own revision", async () => {
    await create();
    const values = { values: { c7: "returns@example.org" } };
    expect(
      await send({
        action: "values",
        brn: "C1234567",
        template_id: T1,
        own_values: values,
        expected_revision: 1,
      }),
    ).toMatchObject({
      ok: true,
      result: {
        action: "values",
        name: "MRA CSG (PACO)",
        company: "ABC Co Ltd",
        values_revision: 2,
      },
    });
    expect(await request({ action: "load", template_id: T1 })).toMatchObject({
      rows: [{ own_values: values, values_revision: 2, revision: 1 }],
    });
    expect(
      await send({
        action: "values",
        brn: "C1234567",
        template_id: T1,
        own_values: {},
        expected_revision: 1,
      }),
    ).toMatchObject({ ok: false, code: "stale" });
  });

  it("uses a template in another admin company, which then sees it too", async () => {
    await create();
    expect(await request({ action: "companies", template_id: T1 })).toMatchObject({
      rows: [
        { brn: "C1234567", name: "ABC Co Ltd", selected: true, uses: true },
        { brn: "C0000002", uses: false },
        { brn: "C0000001", name: "New Venture Ltd", selected: false, uses: false },
      ],
    });
    expect(
      await send({ action: "attach", brn: "C1234567", template_id: T1, company_brn: "C0000001" }),
    ).toMatchObject({
      ok: true,
      result: {
        action: "attach",
        name: "MRA CSG (PACO)",
        brn: "C0000001",
        company: "New Venture Ltd",
        values_revision: 1,
      },
    });
    expect(
      await send({ action: "attach", brn: "C1234567", template_id: T1, company_brn: "C0000001" }),
    ).toMatchObject({
      ok: false,
      code: "stale",
      error: "That company already uses this MRA template. Reload, then try again.",
    });
    // A company where the user is only a viewer cannot be chosen.
    expect(
      await send({ action: "attach", brn: "C1234567", template_id: T1, company_brn: "C7654321" }),
    ).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    signIn(NEW);
    expect(await request({ action: "list" })).toMatchObject({
      rows: [{ template_id: T1, companies: 2, admin_of: 2 }],
    });
  });

  it("takes a template out of a company, and deletes it from the last one", async () => {
    await create();
    await send({ action: "attach", brn: "C1234567", template_id: T1, company_brn: "C0000001" });
    expect(
      await send({ action: "detach", brn: "C1234567", template_id: T1, expected_revision: 1 }),
    ).toEqual({
      ok: true,
      result: {
        action: "detach",
        template_id: T1,
        name: "MRA CSG (PACO)",
        company: "ABC Co Ltd",
        deleted: false,
      },
    });
    expect(await request({ action: "load", template_id: T1 })).toMatchObject({
      ok: false,
      code: "not-found",
    });
    signIn(NEW);
    expect(
      await send({ action: "detach", brn: "C0000001", template_id: T1, expected_revision: 2 }),
    ).toMatchObject({
      ok: false,
      code: "stale",
    });
    expect(
      await send({ action: "detach", brn: "C0000001", template_id: T1, expected_revision: 1 }),
    ).toMatchObject({
      ok: true,
      result: { deleted: true },
    });
    expect(await request({ action: "list" })).toMatchObject({ rows: [] });
  });
});

describe("mra-template: refusals", () => {
  it("refuses a member at once, to read and to save", async () => {
    signIn(XYZ);
    const refusal = {
      ok: false,
      code: "forbidden",
      error: "Only an admin of this company can see or change its MRA templates.",
    };
    expect(await request({ action: "list" })).toEqual(refusal);
    expect(
      await send({
        action: "save",
        brn: "C7654321",
        template_id: T1,
        name: "X",
        body: BODY,
        expected_revision: 0,
      }),
    ).toEqual(refusal);
  });

  it("refuses another company's BRN, a template this company does not use, unknown fields and a large body", async () => {
    await create();
    expect(await request({ action: "list", brn: "C0000001" })).toMatchObject({
      ok: false,
      code: "wrong-company",
    });
    expect(await request({ action: "load", template_id: T2 })).toMatchObject({
      ok: false,
      code: "not-found",
    });
    expect(await request({ action: "list", extra: 1 })).toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(
      await create({ template_id: T2, name: "Big", body: { text: "x".repeat(250_001) } }),
    ).toMatchObject({
      ok: false,
      code: "too-large",
    });
    expect(
      await send({
        action: "values",
        brn: "C1234567",
        template_id: T1,
        own_values: { text: "x".repeat(64_001) },
        expected_revision: 1,
      }),
    ).toMatchObject({ ok: false, code: "too-large" });
  });
});

describe("mra-template: the log and the toasts", () => {
  it("logs each save without the name or the body, and shows one toast naming the template", async () => {
    await recordSave(
      "mra-returns",
      "mra-template",
      "the MRA template",
      () => create(),
      describeMraTemplateSave,
    );
    expect(toast.success).toHaveBeenCalledWith(
      'MRA template "MRA CSG (PACO)" saved (revision 1)',
      expect.anything(),
    );
    const logged = JSON.stringify(transferLog.get());
    expect(logged).not.toContain("MRA CSG");
    expect(logged).not.toContain("PACO");
  });

  it("describes each kind of save", () => {
    expect(
      describeMraTemplateSave({ action: "values", name: "MRA PRGF", company: "ABC Co Ltd" }),
    ).toBe(`ABC Co Ltd's own values for MRA template "MRA PRGF" saved`);
    expect(
      describeMraTemplateSave({ action: "attach", name: "MRA PRGF", company: "DEF Ltd" }),
    ).toBe('MRA template "MRA PRGF" is now also used by DEF Ltd');
    expect(
      describeMraTemplateSave({
        action: "detach",
        name: "MRA PRGF",
        company: "ABC Co Ltd",
        deleted: false,
      }),
    ).toBe('MRA template "MRA PRGF" removed from ABC Co Ltd');
    expect(describeMraTemplateSave({ action: "detach", name: "MRA PRGF", deleted: true })).toBe(
      'MRA template "MRA PRGF" deleted, with its history',
    );
  });
});
