/**
 * Which date of employment wins when the payroll app sends one (a saved payroll file, or "Send to
 * dashboard"): the date kept per employee carries where it came from (migration 0017).
 *
 *   - From a month sent by the payroll app: replaced by a date sent for the SAME OR A NEWER month.
 *     Sending an older month again never overwrites a newer month's date.
 *   - Typed in the Data explorer: it counts as the newest until a month NEWER than the company's
 *     newest saved month at the time it was typed is sent.
 *   - Stored before migration 0017 (nothing recorded): treated as typed in the Data explorer,
 *     against the company's newest month saved before this import.
 *
 * Months are written as their first day, "YYYY-MM-01", so they compare as text.
 */

/** What the dashboard holds for one employee. */
export interface StoredEmploymentDate {
  /** "YYYY-MM-DD", or null when the employee has none. */
  date: string | null;
  /** "YYYY-MM-01": the month the date came from (or, typed, the newest month saved then). */
  month: string | null;
  /** True: typed in the Data explorer. False: sent by the payroll app. Null: not recorded. */
  typed: boolean | null;
}

/**
 *   store       the employee had no date: the sent one is stored
 *   replace     a different date from an older (or, sent, the same) month: the sent one replaces it
 *   same        the same date: nothing to change
 *   same-newer  the same date, now sent for a newer month: only where it came from is updated
 *   keep-newer  a different date from a newer month (or typed since): it is kept
 */
export type EmploymentDateDecision = "store" | "replace" | "same" | "same-newer" | "keep-newer";

/**
 * @param sentDate     the date in what was sent, "YYYY-MM-DD"
 * @param sentMonth    the month sent, "YYYY-MM-01"
 * @param newestBefore the company's newest saved month before this import, "YYYY-MM-01", or null
 */
export function decideEmploymentDate(
  stored: StoredEmploymentDate,
  sentDate: string,
  sentMonth: string,
  newestBefore: string | null,
): EmploymentDateDecision {
  if (stored.date === null) return "store";

  if (stored.typed === false) {
    const newer = stored.month === null || sentMonth > stored.month;
    if (stored.date === sentDate) return newer ? "same-newer" : "same";
    return newer || sentMonth === stored.month ? "replace" : "keep-newer";
  }

  // Typed in the Data explorer, or stored before migration 0017: only a newer month replaces it.
  const typedAgainst = stored.typed === true ? stored.month : newestBefore;
  const newer = typedAgainst === null || sentMonth > typedAgainst;
  if (stored.date === sentDate) return newer ? "same-newer" : "same";
  return newer ? "replace" : "keep-newer";
}
