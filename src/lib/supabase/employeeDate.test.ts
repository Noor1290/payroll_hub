import { beforeEach, describe, expect, it, vi } from "vitest";
import { NUMERIC_COLUMNS } from "@/config/payrollFields";
import { fake, type Call } from "@/test/fakeClient";
import {
  classifyEmployeeDateError,
  fetchRunEntries,
  resetSchemaKnowledge,
  setEmployeeDate,
} from "./payroll";

vi.mock("@/lib/supabase/client", async () => ({
  supabase: (await import("@/test/fakeClient")).fake.client,
}));

// FAKE values only.
const viewer = { id: "00000000-0000-4000-8000-0000000000a1", isDemo: false };
const RUN = "20000000-0000-4000-8000-000000000001";
const EMPLOYEE = "30000000-0000-4000-8000-000000000001";
const entry = (employee: Record<string, unknown>) => ({
  id: "40000000-0000-4000-8000-000000000001",
  age_60_plus: false,
  extra: {},
  ...Object.fromEntries(NUMERIC_COLUMNS.map((column) => [column, 100.5])),
  employees: {
    id: EMPLOYEE,
    national_id: "X0000000000001",
    surname: "DOE",
    other_names: "JANE",
    employment_type: "Full Time",
    ...employee,
  },
});
const selected = (calls: Call[]) => String(fake.arg(calls, "select"));

beforeEach(() => {
  resetSchemaKnowledge();
  fake.reset();
});

describe("fetchRunEntries and the date of employment", () => {
  it("reads the date with each employee, keeping the entry's own id as the row id", async () => {
    fake.reset(() => ({ data: [entry({ date_of_employment: "2019-03-04" })] }));
    const rows = await fetchRunEntries(viewer, RUN);
    expect(selected(fake.state.queries[0]!)).toContain("date_of_employment");
    expect(rows[0]).toMatchObject({
      id: "40000000-0000-4000-8000-000000000001",
      employee_id: EMPLOYEE,
      surname: "DOE",
      date_of_employment: "2019-03-04",
    });
  });

  it("keeps an unset date as null (known, and empty)", async () => {
    fake.reset(() => ({ data: [entry({ date_of_employment: null })] }));
    expect((await fetchRunEntries(viewer, RUN))[0]!.date_of_employment).toBeNull();
  });

  it.each(["42703", "PGRST204"])(
    "still reads the run from a database without the column (%s), with no date on the rows",
    async (code) => {
      fake.reset((calls) =>
        selected(calls).includes("date_of_employment")
          ? { error: { code, message: "column employees_1.date_of_employment does not exist" } }
          : { data: [entry({})] },
      );
      const rows = await fetchRunEntries(viewer, RUN);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ surname: "DOE", employee_id: EMPLOYEE, net_pay: 100.5 });
      expect("date_of_employment" in rows[0]!).toBe(false);

      // It does not ask for the column again in this session.
      fake.reset(() => ({ data: [entry({})] }));
      await fetchRunEntries(viewer, RUN);
      expect(fake.state.queries).toHaveLength(1);
      expect(selected(fake.state.queries[0]!)).not.toContain("date_of_employment");
    },
  );

  it("does not hide any other error behind that fallback", async () => {
    fake.reset(() => ({ error: { code: "42501", message: "permission denied" } }));
    await expect(fetchRunEntries(viewer, RUN)).rejects.toMatchObject({ code: "42501" });
    expect(fake.state.queries).toHaveLength(1);
  });
});

describe("setEmployeeDate", () => {
  it("updates that one employee and nothing else", async () => {
    fake.reset(() => ({ data: [{ id: EMPLOYEE }] }));
    await setEmployeeDate(viewer, EMPLOYEE, "2019-03-04");
    expect(fake.state.queries).toEqual([
      [
        ["from", "employees"],
        ["update", { date_of_employment: "2019-03-04" }],
        ["eq", "id", EMPLOYEE],
        ["select", "id"],
      ],
    ]);
  });

  it("clears the date with null", async () => {
    fake.reset(() => ({ data: [{ id: EMPLOYEE }] }));
    await setEmployeeDate(viewer, EMPLOYEE, null);
    expect(fake.arg(fake.state.queries[0]!, "update")).toEqual({ date_of_employment: null });
  });

  it.each(["0206-01-01", "2026-02-30", "04/03/2019", "2019-3-4", "2101-01-01", ""])(
    "refuses %j without contacting the database",
    async (value) => {
      await expect(setEmployeeDate(viewer, EMPLOYEE, value)).rejects.toMatchObject({
        code: "22023",
      });
      expect(fake.state.queries).toHaveLength(0);
    },
  );

  it("reports a change that touched no row (a viewer, or a missing employee) as not allowed", async () => {
    fake.reset(() => ({ data: [] }));
    const error = await setEmployeeDate(viewer, EMPLOYEE, "2019-03-04").catch((e: unknown) => e);
    expect(classifyEmployeeDateError(error).title).toBe("Only admins can change this");
  });

  it("names the migration to run when the column is not there", () => {
    const failure = classifyEmployeeDateError({ code: "PGRST204", message: "no such column" });
    expect(failure.message).toContain("0008_employee_date_of_employment.sql");
    expect(failure.message).toContain("Nothing was changed");
  });
});

describe("setEmployeeDate in demo mode", () => {
  const demo = { id: "00000000-0000-4000-8000-000000000001", isDemo: true };

  it("lets an admin set a date, which the run's rows then show, and refuses a viewer", async () => {
    const { demoFetchRuns, demoMemberships } = await import("@/lib/demo/demoData");
    const company = (role: string) => demoMemberships.find((m) => m.role === role)!.company.id;

    const run = (await demoFetchRuns(company("admin")))[0]!;
    const before = (await fetchRunEntries(demo, run.id))[0]!;
    await setEmployeeDate(demo, before.employee_id!, "2001-02-03");
    const after = (await fetchRunEntries(demo, run.id)).find((row) => row.id === before.id)!;
    expect(after.date_of_employment).toBe("2001-02-03");

    const viewerRun = (await demoFetchRuns(company("viewer")))[0]!;
    const theirs = (await fetchRunEntries(demo, viewerRun.id))[0]!;
    await expect(setEmployeeDate(demo, theirs.employee_id!, "2001-02-03")).rejects.toMatchObject({
      code: "42501",
    });
    expect(fake.state.queries).toHaveLength(0);
  });
});
