import { formatCount } from "@/lib/format";
import type { AppList } from "@/lib/supabase/companyLists";
import { classifyDataError } from "@/lib/supabase/errors";

/** The picker's words that are not inside a component. */

/** How each list is named on the cards and in the counter. */
export const LIST_LABELS: Record<AppList, string> = {
  payroll: "Payroll",
  payslips: "Payslips",
  csg: "CSG",
  prgf: "PRGF",
};

/** The app's short name in the title ("Payslip", not "Payslip Automation"). */
export const SHORT_APP_NAMES: Record<string, string> = {
  payroll: "Payroll System",
  payslip: "Payslip",
  "mra-returns": "MRA Returns",
};

/** Wording for the toast after a save: "Payslip list saved: 8 companies." */
export function savedText(
  appId: string,
  lists: readonly AppList[],
  counts: Record<AppList, number>,
): string {
  const name = SHORT_APP_NAMES[appId] ?? appId;
  if (lists.length > 1) {
    return `${name} lists saved: ${lists.map((list) => `${LIST_LABELS[list]} ${formatCount(counts[list])}`).join(", ")}.`;
  }
  const count = counts[lists[0]!];
  return `${name} list saved: ${formatCount(count)} ${count === 1 ? "company" : "companies"}.`;
}

/** Why a save of the lists was refused, in the words shown to the user. */
export function saveFailureText(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === "string" && message.includes("PH_NOT_ADMIN")) {
    return "The list wasn't saved: you're not an admin of every company you changed.";
  }
  const failure = classifyDataError(error);
  return `The list wasn't saved. ${failure.title}.`;
}
