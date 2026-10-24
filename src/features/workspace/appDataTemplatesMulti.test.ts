import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearTransferLog, transferLog } from "@/features/transfer/transferLog";
import { bridge } from "@/lib/bridge/bridge";
import { runSessionCleanup } from "@/lib/sessionCleanup";
import type { Membership } from "@/lib/supabase/schemas";
import { lock } from "@/lib/unlock";
import { fake, type Answer, type Call } from "@/test/fakeClient";
import {
  answerTemplateRequest,
  CHECK_PAGE,
  describeCopies,
  describeTemplateSave,
  exchangeContext,
  saveTemplate,
  summariseCopies,
} from "./appData";

/**
 * Publishing a template to several companies, and the template used for the payslips
 * (migration 0018): the `check` request, the `publish-copy` and `use` saves, and
 * `in_use_version` on the list. The database is the fake client; the functions themselves are
 * tested in a real Postgres in templateInUse.db.test.ts.
 */

vi.mock("@/lib/supabase/client", async () => ({
  supabase: (await import("@/test/fakeClient")).fake.client,
}));
const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  loading: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));

// FAKE values only.
const ME = "00000000-0000-4000-8000-0000000000a1";
const ABC = "10000000-0000-4000-8000-000000000001";
const DEF = "10000000-0000-4000-8000-000000000003";
const XYZ = "10000000-0000-4000-8000-000000000002";
const NOBRN = "10000000-0000-4000-8000-000000000004";
const T1 = "20000000-0000-4000-8000-000000000001";
const T2 = "20000000-0000-4000-8000-000000000002";
const abc = { id: ABC, name: "ABC Co Ltd", address: "Mauritius", brn: "C1234567", vat: "12%" };
const def = { id: DEF, name: "DEF Ltd", address: null, brn: "C3333333", vat: null };
const xyz = { id: XYZ, name: "XYZ Trading Ltd", address: null, brn: "C2222222", vat: null };
const noBrn = { id: NOBRN, name: "Aaa No BRN Ltd", address: null, brn: null, vat: null };

/** company_members as the database returns them for the signed-in user. */
const MEMBERS = [
  { role: "admin", companies: def },
  { role: "admin", companies: abc },
  { role: "viewer", companies: xyz },
  { role: "admin", companies: noBrn },
];

const signIn = (role: Membership["role"] = "admin") =>
  exchangeContext.set({ viewer: { id: ME, isDemo: false }, membership: { role, company: abc } });

const BODY = { title: "Payslip", lines: [{ label: "Presence Bonus", column: "Presence Bonus" }] };
const table = (calls: Call[]) => fake.arg(calls, "from") as string | undefined;
const rpcName = (calls: Call[]) => fake.arg(calls, "rpc") as string | undefined;
const rpcArgs = (calls: Call[]) => fake.arg(calls, "rpc", 1) as Record<string, unknown>;
const eqValue = (calls: Call[], column: string) =>
  calls.find(([method, name]) => method === "eq" && name === column)?.[2];
const rpcs = () => fake.state.queries.filter((calls) => calls[0]![0] === "rpc");

const request = (params: Record<string, unknown>) =>
  answerTemplateRequest({ dataType: "payslip-template", params });
const save = (row: Record<string, unknown>) =>
  saveTemplate({ dataType: "payslip-template", rows: [row] });

/** A database where ABC has "Monthly payslip" (draft 4, published 2) and DEF has nothing. */
function database(more: (calls: Call[]) => Answer | undefined = () => undefined): void {
  fake.reset((calls) => {
    const found = more(calls);
    if (found) return found;
    const company = eqValue(calls, "company_id");
    switch (table(calls) ?? rpcName(calls)) {
      case "company_members":
        return { data: MEMBERS };
      case "payslip_templates":
        if (company !== ABC) return { data: [] };
        return {
          data: calls.some(([m]) => m === "maybeSingle")
            ? {
                id: T1,
                name: "Monthly payslip",
                draft_revision: 4,
                updated_by: ME,
                updated_at: "2026-09-01T09:00:00+04:00",
                draft_body: { changed: true },
              }
            : [
                {
                  id: T1,
                  name: "Monthly payslip",
                  draft_revision: 4,
                  updated_by: ME,
                  updated_at: "2026-09-01T09:00:00+04:00",
                },
              ],
        };
      case "payslip_template_versions":
        if (company !== ABC) return { data: [] };
        return calls.some(([m]) => m === "maybeSingle")
          ? {
              data: {
                template_id: T1,
                version: 2,
                name: "Monthly payslip",
                body: BODY,
                published_by: ME,
                published_at: "2026-09-02T09:00:00+04:00",
              },
            }
          : { data: [{ version: 2, published_at: "2026-09-02T09:00:00+04:00" }] };
      case "payroll_run_columns":
        return rpcArgs(calls).p_company_id === ABC
          ? {
              data: {
                period: "2026-09-01",
                employees: 12,
                keys: ["Presence Bonus", "employee_csg", "Date of Employment"],
              },
            }
          : { data: { period: null, employees: 0, keys: [] } };
      default:
        return { data: [] };
    }
  });
}

beforeEach(() => {
  signIn();
  database();
  toast.success.mockClear();
  toast.error.mockClear();
  toast.warning.mockClear();
});
afterEach(() => {
  runSessionCleanup();
  clearTransferLog();
  lock();
});

describe("payslip-template: list says which version is used for the payslips", () => {
  it("names the version of the template in use, and null on the others", async () => {
    fake.reset((calls) => {
      if (table(calls) === "payslip_templates") {
        return {
          data: [T1, T2].map((id, n) => ({
            id,
            name: `Template ${n + 1}`,
            draft_revision: 1,
            updated_by: ME,
            updated_at: "2026-09-01T09:00:00+04:00",
          })),
        };
      }
      if (table(calls) === "payslip_template_in_use")
        return { data: [{ template_id: T2, version: 3 }] };
      return { data: [{ version: 3, published_at: "2026-09-02T09:00:00+04:00" }] };
    });
    const answer = await request({ action: "list" });
    expect(answer).toMatchObject({
      ok: true,
      rows: [
        { template_id: T1, in_use_version: null },
        { template_id: T2, in_use_version: 3 },
      ],
    });
    const read = fake.state.queries.find((calls) => table(calls) === "payslip_template_in_use")!;
    expect(eqValue(read, "company_id")).toBe(ABC);
  });

  it("still lists the templates before migration 0018 is run: nothing is in use", async () => {
    fake.reset((calls) =>
      table(calls) === "payslip_template_in_use"
        ? { error: { code: "PGRST205", message: "not found" } }
        : table(calls) === "payslip_templates"
          ? {
              data: [
                {
                  id: T1,
                  name: "T",
                  draft_revision: 1,
                  updated_by: ME,
                  updated_at: "2026-09-01T09:00:00+04:00",
                },
              ],
            }
          : { data: [] },
    );
    expect(await request({ action: "list" })).toMatchObject({
      ok: true,
      rows: [{ template_id: T1, in_use_version: null }],
    });
  });
});

describe("payslip-template: check before publishing to several companies", () => {
  it("answers one row per company the user is an ADMIN of (read from the database), this company first", async () => {
    const answer = await request({ action: "check", brn: "C1234567", name: "monthly PAYSLIP" });
    expect(answer).toEqual({
      ok: true,
      dataType: "payslip-template",
      meta: { label: "ABC Co Ltd", brn: "C1234567", role: "admin" },
      rows: [
        {
          brn: "C1234567",
          company: "ABC Co Ltd",
          selected: true,
          templates: 1,
          template: {
            template_id: T1,
            name: "Monthly payslip",
            draft_revision: 4,
            published_version: 2,
            // The draft is not what version 2 holds.
            unpublished_changes: true,
            // Version 2 is not the draft being published.
            latest_is_same: false,
          },
          payroll: {
            period: "2026-09",
            employees: 12,
            columns: expect.arrayContaining([
              "Basic Salary",
              "Net Pay",
              "Employee CSG",
              "Presence Bonus",
            ]),
          },
        },
        {
          brn: "C3333333",
          company: "DEF Ltd",
          selected: false,
          templates: 0,
          template: null,
          payroll: null,
        },
      ],
    });
    // Not the company where the user is only a viewer, and not one without a BRN.
    expect(JSON.stringify(answer)).not.toContain("XYZ");
    expect(JSON.stringify(answer)).not.toContain("No BRN");
    // The hub-owned date is never listed as a payroll column, and "Employee NSF" is not there:
    // no entry stores it.
    const columns = (answer as unknown as { rows: { payroll: { columns: string[] } | null }[] })
      .rows[0]!.payroll!.columns;
    expect(columns).not.toContain("Date of Employment");
    expect(columns).not.toContain("Employee NSF");
    // The memberships were read from the database for this check.
    expect(fake.state.queries.some((calls) => table(calls) === "company_members")).toBe(true);
    // The column names come from the database function, for admin companies only.
    expect(
      rpcs()
        .map((calls) => rpcArgs(calls).p_company_id)
        .sort(),
    ).toEqual([ABC, DEF]);
  });

  it("says when a draft holds nothing unpublished", async () => {
    database((calls) =>
      table(calls) === "payslip_templates" && calls.some(([m]) => m === "maybeSingle")
        ? {
            data: {
              id: T1,
              name: "Monthly payslip",
              draft_revision: 4,
              updated_by: ME,
              updated_at: "2026-09-01T09:00:00+04:00",
              draft_body: { lines: BODY.lines, title: "Payslip" },
            },
          }
        : undefined,
    );
    const answer = await request({ action: "check", brn: "C1234567", name: "Monthly payslip" });
    expect(answer).toMatchObject({
      ok: true,
      // The draft is exactly version 2: publishing it adds no version, and the answer says so.
      rows: [{ template: { unpublished_changes: false, latest_is_same: true } }, {}],
    });
  });

  it("is refused to a member who is not an admin of the selected company, before anything is read", async () => {
    signIn("viewer");
    const answer = await request({ action: "check", brn: "C1234567", name: "Monthly payslip" });
    expect(answer).toMatchObject({ ok: false, code: "forbidden" });
    expect(fake.state.queries).toHaveLength(0);
  });

  it("needs the selected company's BRN and a name", async () => {
    expect(
      await request({ action: "check", brn: "C2222222", name: "Monthly payslip" }),
    ).toMatchObject({
      ok: false,
      code: "wrong-company",
    });
    expect(await request({ action: "check", name: "Monthly payslip" })).toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(await request({ action: "check", brn: "C1234567", name: " " })).toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(
      await request({ action: "check", brn: "C1234567", name: "T", companies: ["C2222222"] }),
    ).toMatchObject({ ok: false, code: "invalid" });
  });

  it(`comes ${CHECK_PAGE} companies at a time, so any number of companies can be checked`, async () => {
    const many = Array.from({ length: 2 * CHECK_PAGE + 7 }, (_, n) => ({
      role: "admin",
      companies: {
        id: `10000000-0000-4000-8000-${String(100 + n).padStart(12, "0")}`,
        name: `Company ${String(n).padStart(3, "0")}`,
        address: null,
        brn: `B${n}`,
        vat: null,
      },
    }));
    database((calls) =>
      table(calls) === "company_members"
        ? { data: [...many, { role: "admin", companies: abc }] }
        : undefined,
    );
    const page = async (n?: number) => {
      const answer = await request({
        action: "check",
        brn: "C1234567",
        name: "Monthly payslip",
        ...(n === undefined ? {} : { page: n }),
      });
      expect(answer).toMatchObject({ ok: true });
      return (answer as unknown as { rows: { brn: string; selected: boolean }[] }).rows;
    };
    const [first, second, third, past] = [
      await page(),
      await page(1),
      await page(2),
      await page(3),
    ];
    expect([first.length, second.length, third.length, past.length]).toEqual([
      CHECK_PAGE,
      CHECK_PAGE,
      8,
      0,
    ]);
    // This company first, on the first page only; every company exactly once.
    expect(first[0]).toMatchObject({ brn: "C1234567", selected: true });
    const all = [...first, ...second, ...third].map((row) => row.brn);
    expect(new Set(all).size).toBe(2 * CHECK_PAGE + 8);
    expect([...second, ...third].some((row) => row.selected)).toBe(false);
    // Each page reads the column names of its own companies only.
    database((calls) =>
      table(calls) === "company_members"
        ? { data: [...many, { role: "admin", companies: abc }] }
        : undefined,
    );
    await page(2);
    expect(rpcs()).toHaveLength(8);
  });

  it("says on every page whether a company already has the version being published", async () => {
    const other = { id: DEF, name: "Zed Ltd", address: null, brn: "C3333333", vat: null };
    const many = Array.from({ length: CHECK_PAGE - 1 }, (_, n) => ({
      role: "admin",
      companies: {
        id: `10000000-0000-4000-8000-${String(100 + n).padStart(12, "0")}`,
        name: `Co ${String(n).padStart(2, "0")}`,
        address: null,
        brn: `B${n}`,
        vat: null,
      },
    }));
    // DEF (renamed Zed so it lands on page 1) has the template; its version 2 is ABC's draft.
    database((calls) => {
      if (table(calls) === "company_members") {
        return {
          data: [{ role: "admin", companies: abc }, ...many, { role: "admin", companies: other }],
        };
      }
      const company = eqValue(calls, "company_id");
      if (company === DEF && table(calls) === "payslip_templates") {
        return calls.some(([m]) => m === "maybeSingle")
          ? {
              data: {
                id: T2,
                name: "Monthly payslip",
                draft_revision: 1,
                updated_by: ME,
                updated_at: "t",
                draft_body: BODY,
              },
            }
          : {
              data: [
                {
                  id: T2,
                  name: "Monthly payslip",
                  draft_revision: 1,
                  updated_by: ME,
                  updated_at: "t",
                },
              ],
            };
      }
      if (company === DEF && table(calls) === "payslip_template_versions") {
        return calls.some(([m]) => m === "maybeSingle")
          ? {
              data: {
                template_id: T2,
                version: 2,
                name: "Monthly payslip",
                body: { changed: true },
                published_by: ME,
                published_at: "t",
              },
            }
          : { data: [{ version: 2, published_at: "t" }] };
      }
      return undefined;
    });
    const answer = await request({
      action: "check",
      brn: "C1234567",
      name: "Monthly payslip",
      page: 1,
    });
    expect(answer).toMatchObject({
      ok: true,
      rows: [{ brn: "C3333333", template: { latest_is_same: true } }],
    });
  });

  it("names the migration to run when the column function is not there yet", async () => {
    database((calls) =>
      rpcName(calls) === "payroll_run_columns"
        ? { error: { code: "PGRST202", message: "Could not find the function" } }
        : undefined,
    );
    const answer = await request({ action: "check", brn: "C1234567", name: "T" });
    expect(answer).toMatchObject({ ok: false, code: "unavailable" });
    expect((answer as { error: string }).error).toContain("0018_payslip_template_in_use.sql");
  });
});

const COPY = {
  action: "publish-copy",
  brn: "C1234567",
  company_brn: "C3333333",
  name: "Monthly payslip",
  body: BODY,
  expected_revision: 0,
};

describe("payslip-template: publish-copy", () => {
  const published = {
    template_id: T2,
    name: "Monthly payslip",
    version: 1,
    draft_revision: 1,
    created: true,
    published: true,
    published_at: "2026-10-24T09:00:00+04:00",
  };

  it("publishes to another company the user is an admin of, through the database function", async () => {
    database((calls) =>
      rpcName(calls) === "publish_payslip_template_copy" ? { data: published } : undefined,
    );
    const saved = await save(COPY);
    expect(saved).toEqual({
      ok: true,
      result: { action: "publish-copy", brn: "C3333333", company: "DEF Ltd", ...published },
    });
    expect(rpcs()).toHaveLength(1);
    expect(rpcArgs(rpcs()[0]!)).toEqual({
      p_company_id: DEF,
      p_name: "Monthly payslip",
      p_body: BODY,
      p_expected_revision: 0,
    });
  });

  it("may name the selected company itself", async () => {
    database((calls) =>
      rpcName(calls) === "publish_payslip_template_copy" ? { data: published } : undefined,
    );
    await save({ ...COPY, company_brn: " c1234567 ", expected_revision: 4 });
    expect(rpcArgs(rpcs()[0]!)).toMatchObject({ p_company_id: ABC, p_expected_revision: 4 });
  });

  it("refuses a company where the user is only a member, or not a member, without calling the database function", async () => {
    for (const brn of ["C2222222", "C9999999"]) {
      database();
      expect(await save({ ...COPY, company_brn: brn })).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      expect(rpcs()).toHaveLength(0);
    }
  });

  it("refuses when the user is not an admin of the selected company", async () => {
    signIn("viewer");
    expect(await save(COPY)).toMatchObject({ ok: false, code: "forbidden" });
    expect(fake.state.queries).toHaveLength(0);
  });

  it("refuses a save for another company than the selected one, and images in the body", async () => {
    expect(await save({ ...COPY, brn: "C3333333" })).toMatchObject({
      ok: false,
      code: "wrong-company",
    });
    expect(await save({ ...COPY, body: { logo: "data:image/png;base64,AAAA" } })).toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(fake.state.queries).toHaveLength(0);
  });

  it("turns the database's refusal of a template changed since the check into a clear sentence", async () => {
    database((calls) =>
      rpcName(calls) === "publish_payslip_template_copy"
        ? { error: { code: "P0001", message: "PH_STALE" } }
        : undefined,
    );
    const refused = await save(COPY);
    expect(refused).toEqual({
      ok: false,
      code: "stale",
      error:
        "That company's template was changed since it was checked. Nothing was published there. Check again.",
    });
  });

  it("passes on the database's own admin check", async () => {
    database((calls) =>
      rpcName(calls) === "publish_payslip_template_copy"
        ? { error: { code: "42501", message: "PH_NOT_ADMIN" } }
        : undefined,
    );
    expect(await save(COPY)).toMatchObject({ ok: false, code: "forbidden" });
  });
});

describe("payslip-template: use", () => {
  it("names the version used for the selected company's payslips, or clears it", async () => {
    database((calls) =>
      rpcName(calls) === "set_payslip_template_in_use"
        ? { data: { template_id: rpcArgs(calls).p_template_id, version: rpcArgs(calls).p_version } }
        : undefined,
    );
    expect(await save({ action: "use", brn: "C1234567", template_id: T1, version: 2 })).toEqual({
      ok: true,
      result: { action: "use", template_id: T1, version: 2 },
    });
    expect(rpcArgs(rpcs()[0]!)).toEqual({ p_company_id: ABC, p_template_id: T1, p_version: 2 });
    expect(
      await save({ action: "use", brn: "C1234567", template_id: null, version: null }),
    ).toEqual({
      ok: true,
      result: { action: "use", template_id: null, version: null },
    });
  });

  it("refuses half a choice, another company, and a member", async () => {
    expect(await save({ action: "use", brn: "C1234567", template_id: T1, version: null })).toEqual({
      ok: false,
      code: "invalid",
      error:
        "The template choice couldn't be saved because the request was incomplete. Nothing was changed.",
    });
    expect(
      await save({ action: "use", brn: "C3333333", template_id: T1, version: 1 }),
    ).toMatchObject({
      ok: false,
      code: "wrong-company",
    });
    signIn("viewer");
    expect(
      await save({ action: "use", brn: "C1234567", template_id: T1, version: 1 }),
    ).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    expect(rpcs()).toHaveLength(0);
  });
});

describe("the toasts", () => {
  it("say what was published where, and which version is used now", () => {
    expect(
      describeTemplateSave({
        action: "publish-copy",
        name: "Monthly payslip",
        company: "DEF Ltd",
        version: 3,
        published: true,
      }),
    ).toBe('Payslip template "Monthly payslip" published to DEF Ltd (version 3)');
    expect(
      describeTemplateSave({
        action: "publish-copy",
        name: "Monthly payslip",
        company: "DEF Ltd",
        version: 3,
        published: false,
      }),
    ).toBe(
      'Payslip template "Monthly payslip" (version 3) is now used for the payslips of DEF Ltd',
    );
    expect(describeTemplateSave({ action: "use", template_id: T1, version: 2 })).toBe(
      "Payslip template version 2 is now used for the payslips",
    );
    expect(describeTemplateSave({ action: "use", template_id: null, version: null })).toBe(
      "The payslips now use the built-in template",
    );
  });
});

const SUMMARY = {
  action: "publish-summary",
  brn: "C1234567",
  name: "Monthly payslip",
  published: 4,
  skipped: 2,
  failed: 1,
  unconfirmed: 0,
};

describe("publishing to several companies: ONE toast for the whole batch", () => {
  it("words the toast from the counts, leaving out what is zero", () => {
    const say = (more: Partial<typeof SUMMARY>) => describeCopies({ ...SUMMARY, ...more } as never);
    expect(say({})).toBe(
      'Payslip template "Monthly payslip" published to 4 companies; 2 skipped, 1 not published.',
    );
    expect(say({ published: 5, skipped: 0, failed: 0 })).toBe(
      'Payslip template "Monthly payslip" published to 5 companies.',
    );
    expect(say({ published: 1, skipped: 0, failed: 0, unconfirmed: 1 })).toBe(
      'Payslip template "Monthly payslip" published to 1 company; 1 not confirmed.',
    );
    expect(say({ published: 0, skipped: 2, failed: 3 })).toBe(
      'Payslip template "Monthly payslip" was not published to any company; 2 skipped, 3 not published.',
    );
  });

  it("shows a success toast when nothing failed, a warning otherwise, and stores nothing", () => {
    expect(
      summariseCopies("payslip", {
        dataType: "payslip-template",
        rows: [{ ...SUMMARY, failed: 0 }],
      }),
    ).toEqual({
      ok: true,
      result: { action: "publish-summary" },
    });
    expect(toast.success).toHaveBeenCalledWith(
      'Payslip template "Monthly payslip" published to 4 companies; 2 skipped.',
      {
        description: "From Payslip Automation. Each company is a row in the Transfer log.",
      },
    );
    summariseCopies("payslip", { dataType: "payslip-template", rows: [SUMMARY] });
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(fake.state.queries).toHaveLength(0);
  });

  it("refuses a summary for another company, one with unknown fields, or one about no company", () => {
    const run = (row: Record<string, unknown>) =>
      summariseCopies("payslip", { dataType: "payslip-template", rows: [row] });
    expect(run({ ...SUMMARY, brn: "C3333333" })).toMatchObject({
      ok: false,
      code: "wrong-company",
    });
    expect(run({ ...SUMMARY, extra: 1 })).toMatchObject({ ok: false, code: "invalid" });
    expect(run({ ...SUMMARY, published: 0, skipped: 0, failed: 0, unconfirmed: 0 })).toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(run({ ...SUMMARY, published: 1.5 })).toMatchObject({ ok: false, code: "invalid" });
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  describe("over the bridge", () => {
    const ORIGIN = "https://noor1290.github.io";
    function connect() {
      const iframe = document.createElement("iframe");
      document.body.appendChild(iframe);
      const win = iframe.contentWindow!;
      const post = vi.fn();
      win.postMessage = post as unknown as Window["postMessage"];
      const say = (type: string, id: string, payload: unknown = {}) =>
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { type, from: "payslip", to: "dashboard", version: 1, id, payload },
            origin: ORIGIN,
            source: win,
          }),
        );
      bridge.start();
      bridge.attachFrame("payslip", () => win);
      bridge.frameLoaded("payslip");
      say("ready", "ready-0000001");
      const received = () =>
        (post.mock.calls as [{ type: string; payload: Record<string, unknown> }, string][])
          .filter(([m]) => m.type === "received")
          .map(([m]) => m.payload);
      return { say, received };
    }
    afterEach(() => {
      bridge.stop();
      document.body.innerHTML = "";
    });

    it("logs each company published to, with no toast of its own, refused or not; the summary is the one toast", async () => {
      let call = 0;
      database((calls) =>
        rpcName(calls) === "publish_payslip_template_copy"
          ? ++call === 1
            ? {
                data: {
                  template_id: T2,
                  name: "Monthly payslip",
                  version: 1,
                  draft_revision: 1,
                  created: true,
                  published: true,
                  published_at: "t",
                },
              }
            : { error: { code: "42501", message: "PH_NOT_ADMIN" } }
          : undefined,
      );
      const app = connect();
      app.say("send-data", "copy-00000001", { dataType: "payslip-template", rows: [COPY] });
      app.say("send-data", "copy-00000002", {
        dataType: "payslip-template",
        rows: [{ ...COPY, company_brn: "C1234567" }],
      });
      await vi.waitFor(() => expect(app.received()).toHaveLength(2));
      expect(app.received().map((reply) => reply.ok)).toEqual([true, false]);
      expect(transferLog.get().map((row) => row.status)).toEqual(["failed", "delivered"]);
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();

      app.say("send-data", "summary-00001", {
        dataType: "payslip-template",
        rows: [{ ...SUMMARY, published: 1, skipped: 0, failed: 1 }],
      });
      await vi.waitFor(() => expect(app.received()).toHaveLength(3));
      expect(toast.warning).toHaveBeenCalledTimes(1);
      expect(toast.warning).toHaveBeenCalledWith(
        'Payslip template "Monthly payslip" published to 1 company; 1 not published.',
        expect.anything(),
      );
      // The summary adds no row: each company already has its own.
      expect(transferLog.get()).toHaveLength(2);
    });

    it("keeps the toast of a publish to this company only", async () => {
      database((calls) =>
        rpcName(calls) === "publish_payslip_template"
          ? { data: { template_id: T1, version: 3, draft_revision: 4, published_at: "t" } }
          : undefined,
      );
      const app = connect();
      app.say("send-data", "publish-00001", {
        dataType: "payslip-template",
        rows: [{ action: "publish", brn: "C1234567", template_id: T1, expected_revision: 4 }],
      });
      await vi.waitFor(() => expect(app.received()).toHaveLength(1));
      expect(toast.success).toHaveBeenCalledWith("Payslip template published (version 3)", {
        description: "Saved from Payslip Automation.",
      });
    });
  });
});
