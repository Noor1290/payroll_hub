import { describe, expect, it } from "vitest";
import type { PayslipInput } from "@/lib/supabase/issuedPayslips";
import { demoFetchIssuedPayslips, demoFetchTemplates, demoIssuePayslips } from "./demoAppData";
import { demoFetchDeletePreview } from "./demoData";

/**
 * The demo store behind the mock payslip app mirrors issue_payslips (migration 0011): all of a
 * month or none of it, a refusal that names the payslip by its position, numbered revisions.
 * The database's own behaviour is tested in payslipMigrations.db.test.ts. FAKE values only.
 */
const ABC = "10000000-0000-4000-8000-000000000001";
const XYZ = "10000000-0000-4000-8000-000000000002"; // the demo user is a viewer here
const PERIOD = "2026-09-01";
const NIC_1 = "X0000000000001";
const NIC_2 = "X0000000000002";

const settle = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value, error: null }),
    (error: Error) => ({ value: null, error }),
  );

async function slip(more: Partial<PayslipInput> = {}): Promise<PayslipInput> {
  const [template] = await demoFetchTemplates(ABC);
  return {
    national_id: NIC_1,
    expected_revision: 0,
    template_id: template!.id,
    template_version: template!.published!.version,
    rates: null,
    lines: [{ label: "Net pay", amount: 100 }],
    accepted_differences: [],
    ...more,
  };
}

describe("demo issued payslips", () => {
  it("starts with none", async () => {
    expect(await demoFetchIssuedPayslips(ABC, PERIOD)).toEqual([]);
  });

  it.each([
    ["an unknown employee", { national_id: "NOBODY" }, "PH_UNKNOWN_EMPLOYEE: payslip 2"],
    ["a version never published", { template_version: 99 }, "PH_UNKNOWN_TEMPLATE: payslip 2"],
    ["a revision that is ahead", { expected_revision: 3 }, "PH_STALE: payslip 2"],
    ["the same employee twice", { national_id: NIC_1 }, /^PH_INVALID_INPUT: payslip 2: /],
  ])(
    "refuses a month because of %s, names the payslip, and stores none of it",
    async (_what, more, message) => {
      const second = await slip({ national_id: NIC_2, ...more });
      const { error } = await settle(demoIssuePayslips(ABC, PERIOD, [await slip(), second]));
      expect(error?.message).toMatch(message);
      expect(await demoFetchIssuedPayslips(ABC, PERIOD)).toEqual([]);
    },
  );

  it("refuses a viewer", async () => {
    const { error } = await settle(demoIssuePayslips(XYZ, PERIOD, [await slip()]));
    expect(error?.message).toBe("PH_NOT_ADMIN");
  });

  it("issues a month at revision 1, then a re-issue at revision 2, and reads the latest of each", async () => {
    const first = await demoIssuePayslips(ABC, PERIOD, [
      await slip(),
      await slip({ national_id: NIC_2 }),
    ]);
    expect(first).toMatchObject({
      period: PERIOD,
      issued: 2,
      payslips: [
        { national_id: NIC_1, revision: 1 },
        { national_id: NIC_2, revision: 1 },
      ],
    });
    // The same save again: refused, as when its first answer was lost.
    const again = await settle(demoIssuePayslips(ABC, PERIOD, [await slip()]));
    expect(again.error?.message).toBe("PH_STALE: payslip 1");

    const next = await demoIssuePayslips(ABC, PERIOD, [
      await slip({ expected_revision: 1, lines: [{ label: "Net pay", amount: 200 }] }),
    ]);
    expect(next.payslips).toEqual([{ national_id: NIC_1, revision: 2 }]);

    const month = await demoFetchIssuedPayslips(ABC, PERIOD);
    expect(month.map(({ national_id, revision }) => [national_id, revision])).toEqual([
      [NIC_1, 2],
      [NIC_2, 1],
    ]);
    expect(month[0]!.lines).toEqual([{ label: "Net pay", amount: 200 }]);
    expect(await demoFetchIssuedPayslips(ABC, "2026-10-01")).toEqual([]);
    expect(await demoFetchIssuedPayslips(XYZ, PERIOD)).toEqual([]);
  });

  it("counts every revision in the delete-company preview", async () => {
    expect(await demoFetchDeletePreview(ABC)).toMatchObject({ issuedPayslips: 3 });
  });
});
