import {
  DATE_OF_EMPLOYMENT,
  exportColumns,
  isHubOwnedKey,
  normaliseKey,
  PAYROLL_FIELDS,
  RESERVED_EXTRA_KEYS,
} from "@/config/payrollFields";
import type { RunColumns } from "@/lib/supabase/payslipTemplates";

/**
 * The names of a company's identity fields and payroll columns, for the lists of the MRA Returns
 * app's templates (mra-batch `overview`, docs/INTEGRATION.md). NAMES only: no employee and no
 * value is read.
 *
 *  - Its column setup, when it has one, is the list: the identity fields, then the Global
 *    columns and the company's own columns, under the names Payroll System sends them with.
 *    Only the names are read from the payroll app's JSON; anything else in it is left alone.
 *  - The newest saved run adds the columns stored with it that the setup does not name: a name
 *    shared by two fields is sent with its category ("CSG (Employer Contribution)"), so it is
 *    taken from the run as it was sent.
 *  - With no setup, the newest run's columns are the list, as "Get from dashboard" gives them.
 *  - "Date of Employment" is always an identity field, under that name: the dashboard keeps the
 *    date per employee whatever the payroll app called it ("Date of employment", an identity
 *    field or an older text column) and adds it to the rows of a run under that name only. A
 *    setup name that is the same whatever the capitals is listed as the rows name it.
 */

export interface SetupBodies {
  shared: Record<string, unknown>;
  company: Record<string, unknown> | null;
}

export interface MraFields {
  identity: string[];
  columns: string[];
  /** Whether the lists come from a column setup. */
  setup: boolean;
  /** "YYYY-MM" of the newest saved run, or null when there is none. */
  runPeriod: string | null;
}

const COMPANY_KEYS = PAYROLL_FIELDS.filter((field) => field.target === "company").map(
  (field) => field.jsonKey,
);
/** The identity fields of every saved run: ID, Surname, Other names. */
const RUN_IDENTITY = PAYROLL_FIELDS.filter(
  (field) => field.target === "employee" && field.column !== "employment_type",
).map((field) => field.jsonKey);

/** The `name` (or `label`) of each entry of a list in the payroll app's JSON; others are skipped. */
function namesOf(list: unknown, property: "name" | "label"): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list as unknown[]) {
    const value =
      typeof item === "object" && item !== null
        ? (item as Record<string, unknown>)[property]
        : undefined;
    if (typeof value === "string" && value.trim() !== "") out.push(value);
  }
  return out;
}

export function mraFields(setup: SetupBodies | null, run: RunColumns): MraFields {
  const identity: string[] = [];
  const columns: string[] = [];
  const listed = new Set<string>();
  const add = (list: string[], wanted: string) => {
    const name = isHubOwnedKey(wanted) ? DATE_OF_EMPLOYMENT : wanted;
    if (list === columns && name === DATE_OF_EMPLOYMENT) return add(identity, name);
    const key = normaliseKey(name);
    if (listed.has(key)) return;
    listed.add(key);
    list.push(name);
  };
  // Company details travel on every row of a run, but are not the payroll's.
  const details = new Set(COMPANY_KEYS.map(normaliseKey));

  if (setup) {
    const ids = namesOf(setup.shared.identityFields, "name");
    const own = [
      ...namesOf(setup.shared.globalColumns, "name"),
      ...namesOf(setup.company?.columns, "name"),
    ];
    const uses = new Map<string, number>();
    for (const name of [...ids, ...own]) {
      uses.set(normaliseKey(name), (uses.get(normaliseKey(name)) ?? 0) + 1);
    }
    const once = (name: string) => uses.get(normaliseKey(name)) === 1;
    for (const name of ids.filter(once)) add(identity, name);
    for (const name of own.filter(once)) add(columns, name);
    for (const label of namesOf(setup.company?.customFields, "label")) {
      details.add(normaliseKey(label));
      details.add(normaliseKey(`Company: ${label}`));
    }
  } else {
    for (const name of RUN_IDENTITY) add(identity, name);
    if (run.period) {
      for (const name of exportColumns(run.keys)) {
        if (!details.has(normaliseKey(name))) add(columns, name);
      }
    }
  }
  add(identity, DATE_OF_EMPLOYMENT);
  for (const key of run.keys) {
    if (RESERVED_EXTRA_KEYS.has(key) || isHubOwnedKey(key) || details.has(normaliseKey(key))) {
      continue;
    }
    add(columns, key);
  }
  return {
    identity,
    columns,
    setup: setup !== null,
    runPeriod: run.period ? run.period.slice(0, 7) : null,
  };
}
