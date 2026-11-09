import { fetchCompanySetup, fetchSharedSetup } from "@/lib/supabase/payrollSetups";
import { importPayrollCompany, PAYROLL_IMPORT_MIGRATION } from "@/lib/supabase/payrollImport";
import { classifyDataError } from "@/lib/supabase/errors";
import type { Viewer } from "@/lib/supabase/queries";
import type { XlsxSheet } from "@/lib/xlsx/writeXlsx";
import {
  isEmployeeTickable,
  monthName,
  type CompanyEmployees,
  type EmployeeChange,
  type EmployeeContext,
  type EmployeePreview,
  type EmployeesPreview,
} from "./employeeImport";
import type { SetupFields } from "./employeeSheet";

// Saving the ticked employees of the import (EMPLOYEES_IMPORT_PLAN.md, Stage 3), company by
// company, each in ONE call of import_payroll_company (migration 0019): that company's month is
// saved all of it or nothing, as a new revision whose previous content is kept (History > Restore
// undoes it). The database refuses an approved month, a company the user is not admin of, and a
// month or setup saved by someone else after the preview. Nothing is ever deleted: the month is
// the saved one, with the ticked changes applied and the ticked new employees at the end.

type Employee = Record<string, unknown>;

/** The month as it will be saved: the saved employees with the ticked changes, then the new ones. */
export function monthContent(
  company: CompanyEmployees,
  saved: readonly Employee[],
  ticked: (item: EmployeePreview) => boolean,
): { employees: Employee[]; added: EmployeePreview[]; updated: EmployeePreview[] } {
  const chosen = company.rows.filter((item) => isEmployeeTickable(item) && ticked(item));
  const updated = chosen.filter((item) => item.status === "update");
  const added = chosen.filter((item) => item.status === "new");
  const patches = new Map(updated.map((item) => [item.employeeId, item.values]));
  const employees = saved.map((employee) => {
    const patch = patches.get(String(employee.id));
    if (!patch) return employee;
    const values = (employee.values ?? {}) as Record<string, unknown>;
    return { ...employee, values: { ...values, ...patch } };
  });
  for (const item of added) employees.push(structuredClone(item.values));
  return { employees, added, updated };
}

export type EmployeeResult = "Added" | "Updated" | "Skipped" | "Problem";

export interface EmployeeReportLine {
  line: number;
  brn: string;
  company: string;
  surname: string;
  result: EmployeeResult;
  what: string;
  /** One change per line; an ID or a figure is never written: "(not shown)". */
  before: string;
  after: string;
}

export const NOT_SHOWN = "(not shown)";
const STALE =
  "Not changed: the month was saved by someone else after the preview. Upload the file again.";
const NOT_CREATED = "Not added: its company was not created.";

/** The ID and every figure are sensitive; the other identity fields are not. */
function isSensitive(fields: SetupFields | null, heading: string): boolean {
  const field = fields?.fields.find((f) => f.heading === heading);
  return !field || field.isId || field.kind === "input";
}

function beforeAfter(
  fields: SetupFields | null,
  item: EmployeePreview,
): { before: string; after: string } {
  const list = (which: keyof Omit<EmployeeChange, "heading">) =>
    item.changes
      .map((c) => `${c.heading}: ${isSensitive(fields, c.heading) ? NOT_SHOWN : c[which]}`)
      .join("\n");
  return item.status === "new"
    ? { before: "", after: list("after") }
    : { before: list("before"), after: list("after") };
}

/** Why a company's employees were not saved, from the database's answer. */
export function employeeFailure(error: unknown, period: string): string {
  const { code, message } = (typeof error === "object" && error !== null ? error : {}) as {
    code?: unknown;
    message?: unknown;
  };
  const text = typeof message === "string" ? message : "";
  if (text.includes("PH_STALE")) return STALE;
  if (text.includes("PH_MONTH_APPROVED")) {
    return `Not changed: ${monthName(period)} was approved after the preview, so it can't be changed.`;
  }
  if (text.includes("PH_NOT_ADMIN") || text.includes("PH_NOT_SIGNED_IN")) {
    return "Not changed: you are no longer an admin of this company.";
  }
  if (code === "PGRST202" || code === "42883") {
    return `Not changed: saving employees isn't set up in the database yet: the owner needs to run supabase/migrations/${PAYROLL_IMPORT_MIGRATION}.`;
  }
  if (text.includes("PH_TOO_LARGE")) {
    return "Not changed: the month would be larger than the dashboard accepts (5000 employees or 1 MB).";
  }
  return `Not changed: ${classifyDataError(error).title}.`.replace(/\.\.$/, ".");
}

/** The line of a row that was not saved, from what the preview said of it. */
function previewLine(company: CompanyEmployees, item: EmployeePreview): EmployeeReportLine {
  const base = {
    line: item.row.line,
    brn: company.brn || item.row.brnTyped,
    company: company.name,
    surname: item.surname,
    before: "",
    after: "",
  };
  if (item.status === "problem") {
    const why = item.problems.length > 0 ? item.problems.join(" ") : (company.problem ?? "");
    return { ...base, result: "Problem", what: `Problem: ${why}` };
  }
  if (item.status === "same") return { ...base, result: "Skipped", what: "No changes." };
  return { ...base, result: "Skipped", what: "Not ticked." };
}

/** Where a company's employees go: its id and the setup revisions the save is checked against. */
async function targetOf(
  viewer: Viewer,
  company: CompanyEmployees,
  context: EmployeeContext,
  created: ReadonlyMap<string, string>,
): Promise<
  | { ok: true; companyId: string; expected: { shared_revision: number; company_revision: number } }
  | { ok: false; why: string }
> {
  const existing = context.existing.get(company.brn);
  if (existing) {
    if (!existing.setupRevisions) return { ok: false, why: STALE };
    return {
      ok: true,
      companyId: existing.id,
      expected: {
        shared_revision: existing.setupRevisions.shared,
        company_revision: existing.setupRevisions.company,
      },
    };
  }
  // A company created by this import: its setup as it was just made.
  const companyId = created.get(company.brn);
  if (!companyId) return { ok: false, why: NOT_CREATED };
  const own = await fetchCompanySetup(viewer, companyId);
  const shared = own ? await fetchSharedSetup(viewer, own.shared_setup_id) : null;
  if (!own || !shared) {
    return { ok: false, why: "Not added: its company has no column setup in Payroll System." };
  }
  return {
    ok: true,
    companyId,
    expected: { shared_revision: shared.revision, company_revision: own.revision },
  };
}

/**
 * Saves the ticked employees, one company at a time; one failing does not stop the others.
 * `created`: the companies this import has just created, by BRN (capitals, no spaces).
 * Returns a line for every employee row of the file, in the file's order.
 */
export async function runEmployeeImport(
  viewer: Viewer,
  preview: EmployeesPreview,
  context: EmployeeContext,
  created: ReadonlyMap<string, string>,
  ticked: (item: EmployeePreview) => boolean,
  onProgress: (done: number, total: number) => void = () => {},
): Promise<EmployeeReportLine[]> {
  const lines = new Map<EmployeePreview, EmployeeReportLine>();
  const toSave = preview.companies.filter(
    (company) =>
      company.period !== null &&
      company.rows.some((item) => isEmployeeTickable(item) && ticked(item)),
  );
  let done = 0;
  onProgress(done, toSave.length);
  for (const company of toSave) {
    const period = company.period!;
    const existing = context.existing.get(company.brn);
    const fields = existing ? existing.fields : context.newSetup;
    const newest = existing?.newest ?? null;
    const content = monthContent(company, newest?.employees ?? [], ticked);
    const chosen = [...content.added, ...content.updated];
    const fail = (why: string) => {
      for (const item of chosen) {
        lines.set(item, {
          ...previewLine(company, item),
          result: "Problem",
          what: why,
        });
      }
    };
    try {
      const target = await targetOf(viewer, company, context, created);
      if (!target.ok) fail(target.why);
      else {
        await importPayrollCompany(viewer, {
          companyId: target.companyId,
          newCompany: null,
          setup: null,
          expected: target.expected,
          months: [
            {
              period,
              employees: content.employees,
              expected_revision: newest?.revision ?? 0,
              replace: newest !== null,
            },
          ],
        });
        const month = monthName(period);
        for (const item of chosen) {
          lines.set(item, {
            ...previewLine(company, item),
            result: item.status === "new" ? "Added" : "Updated",
            what: item.status === "new" ? `Added to ${month}` : `Updated in ${month}`,
            ...beforeAfter(fields, item),
          });
        }
      }
    } catch (error) {
      fail(employeeFailure(error, period));
    }
    done += 1;
    onProgress(done, toSave.length);
  }
  return preview.companies
    .flatMap((company) => company.rows.map((item) => lines.get(item) ?? previewLine(company, item)))
    .sort((a, b) => a.line - b.line);
}

/** "3 employees added, 2 updated, 1 not saved". */
export function employeesDone(lines: readonly EmployeeReportLine[]): string {
  const count = (result: EmployeeResult) => lines.filter((line) => line.result === result).length;
  const added = count("Added");
  const notSaved = lines.filter(
    (line) => line.result === "Problem" && line.what.startsWith("Not "),
  ).length;
  const parts = [
    `${added === 1 ? "1 employee" : `${added} employees`} added`,
    `${count("Updated")} updated`,
  ];
  if (notSaved > 0) parts.push(`${notSaved} not saved`);
  return parts.join(", ");
}

/** The report's "Employees" sheet. The ID is never in it, nor any figure. */
export function employeesReportSheet(lines: readonly EmployeeReportLine[]): XlsxSheet {
  return {
    name: "Employees",
    columns: [
      { width: 14, text: true },
      { width: 28 },
      { width: 8 },
      { width: 14 },
      { width: 22 },
      { width: 60, wrap: true },
      { width: 36, wrap: true },
      { width: 36, wrap: true },
    ],
    boldRows: [0],
    freezeFirstRow: true,
    rows: [
      ["BRN", "Company", "Row", "ID", "Surname", "What happened", "Before", "After"],
      ...lines.map((line) => [
        line.brn,
        line.company,
        String(line.line),
        NOT_SHOWN,
        line.surname,
        line.what,
        line.before,
        line.after,
      ]),
    ],
  };
}
