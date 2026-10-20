import { beforeEach, describe, expect, it, vi } from "vitest";
import { NUMERIC_COLUMNS } from "@/config/payrollFields";
import { fake, type Call } from "@/test/fakeClient";
import {
  classifyEmployeeDateError,
  fetchRunEntries,
  newestRunMonth,
  resetSchemaKnowledge,
  setEmployeeDate,
  storeEmploymentDates,
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

describe("setEmployeeDate (typed in the Data explorer)", () => {
  const COMPANY = "10000000-0000-4000-8000-000000000001";
  // The employee's company, then its newest saved month, then the update.
  const answers = (calls: Call[]) => {
    if (calls[0]![1] === "payroll_runs") return { data: [{ period: "2026-10-01" }] };
    if (calls.some(([m]) => m === "update")) return { data: [{ id: EMPLOYEE }] };
    return { data: [{ company_id: COMPANY }] };
  };

  it("updates that one employee, recorded as typed against the company's newest saved month", async () => {
    fake.reset(answers);
    await setEmployeeDate(viewer, EMPLOYEE, "2019-03-04");
    expect(fake.state.queries).toEqual([
      [
        ["from", "employees"],
        ["select", "company_id"],
        ["eq", "id", EMPLOYEE],
      ],
      [
        ["from", "payroll_runs"],
        ["select", "period"],
        ["eq", "company_id", COMPANY],
        ["is", "deleted_at", null],
        ["order", "period", { ascending: false }],
        ["limit", 1],
      ],
      [
        ["from", "employees"],
        [
          "update",
          {
            date_of_employment: "2019-03-04",
            date_of_employment_month: "2026-10-01",
            date_of_employment_typed: true,
          },
        ],
        ["eq", "id", EMPLOYEE],
        ["select", "id"],
      ],
    ]);
  });

  it("clears the date with null, and where it came from with it", async () => {
    fake.reset(() => ({ data: [{ id: EMPLOYEE }] }));
    await setEmployeeDate(viewer, EMPLOYEE, null);
    expect(fake.state.queries).toHaveLength(1);
    expect(fake.arg(fake.state.queries[0]!, "update")).toEqual({
      date_of_employment: null,
      date_of_employment_month: null,
      date_of_employment_typed: null,
    });
  });

  it.each(["42703", "PGRST204"])(
    "against a database without migration 0017 (%s), saves the date alone, as before",
    async (code) => {
      fake.reset((calls) => {
        const update = fake.arg(calls, "update") as Record<string, unknown> | undefined;
        if (update && "date_of_employment_typed" in update) {
          return { error: { code, message: "column date_of_employment_typed does not exist" } };
        }
        return answers(calls);
      });
      await setEmployeeDate(viewer, EMPLOYEE, "2019-03-04");
      expect(fake.arg(fake.state.queries.at(-1)!, "update")).toEqual({ date_of_employment: "2019-03-04" });
      // It does not try the columns again in this session.
      fake.reset(answers);
      await setEmployeeDate(viewer, EMPLOYEE, "2019-03-05");
      expect(fake.state.queries).toHaveLength(1);
    },
  );

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

describe("storeEmploymentDates (rehearsal fix F6; the newer month wins since migration 0017)", () => {
  const COMPANY = "10000000-0000-4000-8000-000000000001";
  const SEP = "2026-09-01";
  const OCT = "2026-10-01";
  const NOV = "2026-11-01";
  const E = (n: number) => `30000000-0000-4000-8000-00000000000${n}`;
  // October is sent; the company's newest saved month before it was September.
  const source = { period: OCT, newestBefore: SEP };
  const dates = {
    X1: "2019-03-15",
    X2: "2020-05-05",
    X3: "2001-06-01",
    X4: "2010-10-10",
    X5: "2012-12-12",
    X6: "2013-01-01",
    X7: "2014-02-02",
    X9: "2015-01-01",
  };
  const row = (n: number, date: string | null, month: string | null, typed: boolean | null) => ({
    id: E(n),
    national_id: `X${n}`,
    date_of_employment: date,
    date_of_employment_month: month,
    date_of_employment_typed: typed,
  });

  it("fills an empty date; replaces one from an older month; keeps one from a newer month or typed since; every update guarded by what was read", async () => {
    fake.reset((calls) => {
      if (calls.some(([m]) => m === "update")) {
        // X7's date was typed in the Data explorer between the read and the update.
        const id = fake.arg(calls, "eq", 1);
        return { data: id === E(7) ? [] : [{ id }] };
      }
      return {
        data: [
          row(1, null, null, null),
          row(2, "2018-01-01", SEP, false), // sent for September: October replaces it
          row(3, "2000-01-01", NOV, false), // sent for November: October is older, kept
          row(4, "2000-01-01", OCT, true), // typed when October was the newest: kept
          row(5, "2000-01-01", null, null), // stored before 0017, newest before was September: replaced
          row(6, "2013-01-01", SEP, false), // the same date, now from October: only the month is noted
          row(7, null, null, null), // changed meanwhile: kept
        ],
      };
    });
    expect(await storeEmploymentDates(viewer, COMPANY, dates, source)).toEqual({
      stored: 1,
      changed: 2,
      kept: 2,
      keptNewer: 2,
    });

    const [lookup, ...updates] = fake.state.queries;
    expect(lookup).toEqual([
      ["from", "employees"],
      ["select", "id, national_id, date_of_employment, date_of_employment_month, date_of_employment_typed"],
      ["eq", "company_id", COMPANY],
      ["is", "deleted_at", null],
      ["in", "national_id", ["X1", "X2", "X3", "X4", "X5", "X6", "X7", "X9"]],
    ]);
    const set = (date: string) => ["update", { date_of_employment: date, date_of_employment_month: OCT, date_of_employment_typed: false }];
    // X3 and X4 are kept without being asked.
    expect(updates).toEqual([
      [["from", "employees"], set("2019-03-15"), ["eq", "id", E(1)], ["is", "date_of_employment", null], ["is", "date_of_employment_month", null], ["is", "date_of_employment_typed", null], ["select", "id"]],
      [["from", "employees"], set("2020-05-05"), ["eq", "id", E(2)], ["eq", "date_of_employment", "2018-01-01"], ["eq", "date_of_employment_month", SEP], ["eq", "date_of_employment_typed", false], ["select", "id"]],
      [["from", "employees"], set("2012-12-12"), ["eq", "id", E(5)], ["eq", "date_of_employment", "2000-01-01"], ["is", "date_of_employment_month", null], ["is", "date_of_employment_typed", null], ["select", "id"]],
      [["from", "employees"], set("2013-01-01"), ["eq", "id", E(6)], ["eq", "date_of_employment", "2013-01-01"], ["eq", "date_of_employment_month", SEP], ["eq", "date_of_employment_typed", false], ["select", "id"]],
      [["from", "employees"], set("2014-02-02"), ["eq", "id", E(7)], ["is", "date_of_employment", null], ["is", "date_of_employment_month", null], ["is", "date_of_employment_typed", null], ["select", "id"]],
    ]);
  });

  it.each(["42703", "PGRST204"])(
    "against a database without migration 0017 (%s): fills an empty date, keeps one already set, as before",
    async (code) => {
      fake.reset((calls) => {
        if (String(fake.arg(calls, "select")).includes("date_of_employment_month")) {
          return { error: { code, message: "column employees.date_of_employment_month does not exist" } };
        }
        if (calls.some(([m]) => m === "update")) return { data: [{ id: fake.arg(calls, "eq", 1) }] };
        return { data: [{ id: E(1), national_id: "X1", date_of_employment: null }, { id: E(2), national_id: "X2", date_of_employment: "2018-01-01" }] };
      });
      expect(await storeEmploymentDates(viewer, COMPANY, { X1: "2019-03-15", X2: "2020-05-05" }, source)).toEqual({
        stored: 1,
        changed: 0,
        kept: 1,
        keptNewer: 0,
      });
      expect(fake.state.queries.at(-1)).toEqual([
        ["from", "employees"],
        ["update", { date_of_employment: "2019-03-15" }],
        ["eq", "id", E(1)],
        ["is", "date_of_employment", null],
        ["select", "id"],
      ]);
    },
  );

  it("does nothing without a valid date, and passes a database error on", async () => {
    expect(await storeEmploymentDates(viewer, COMPANY, { X1: "01/08/2026" }, source)).toEqual({
      stored: 0,
      changed: 0,
      kept: 0,
      keptNewer: 0,
    });
    expect(fake.state.queries).toHaveLength(0);
    fake.reset(() => ({ error: { code: "42501", message: "permission denied" } }));
    await expect(
      storeEmploymentDates(viewer, COMPANY, { X1: "2019-03-15" }, source),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("in demo mode: a newer month overwrites, an older one does not, and a Data explorer date is kept until a newer month arrives", async () => {
    const demo = { id: "00000000-0000-4000-8000-000000000001", isDemo: true };
    const { demoFetchRuns, demoMemberships } = await import("@/lib/demo/demoData");
    const company = demoMemberships.find((m) => m.role === "admin")!.company.id;
    const run = (await demoFetchRuns(company))[0]!;
    const row = (await fetchRunEntries(demo, run.id))[0]!;
    const send = (date: string, period: string) =>
      storeEmploymentDates(demo, company, { [row.national_id]: date }, { period, newestBefore: period });
    const stored = async () => (await fetchRunEntries(demo, run.id)).find((r) => r.id === row.id)!.date_of_employment;

    await setEmployeeDate(demo, row.employee_id!, null);
    expect(await send("2005-06-07", "2030-10-01")).toMatchObject({ stored: 1 });
    // A newer month overwrites.
    expect(await send("2006-07-08", "2030-11-01")).toMatchObject({ changed: 1, keptNewer: 0 });
    // The older month sent again does not.
    expect(await send("2005-06-07", "2030-10-01")).toMatchObject({ changed: 0, keptNewer: 1 });
    expect(await stored()).toBe("2006-07-08");

    // Typed in the Data explorer: kept until a month newer than the newest saved now is sent.
    const newest = await newestRunMonth(demo, company);
    await setEmployeeDate(demo, row.employee_id!, "2001-02-03");
    expect(await send("2005-06-07", newest!)).toMatchObject({ changed: 0, keptNewer: 1 });
    expect(await stored()).toBe("2001-02-03");
    const next = `${Number(newest!.slice(0, 4)) + 1}${newest!.slice(4)}`;
    expect(await send("2005-06-07", next)).toMatchObject({ changed: 1, keptNewer: 0 });
    expect(await stored()).toBe("2005-06-07");
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
