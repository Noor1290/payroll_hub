import type { AppList, ListChange, ListRow } from "@/lib/supabase/companyLists";

/**
 * What the company picker holds while it is open: for each company, the lists of this app it is
 * switched on in. Nothing is saved until Done; then only what differs from what was loaded is
 * sent, and only for companies the user is an admin of (the others cannot be changed).
 */
export type Choice = ReadonlyMap<string, ReadonlySet<AppList>>;

export interface PickerCompany {
  id: string;
  name: string;
  brn: string;
  admin: boolean;
}

export type PickerFilter = "all" | "selected" | "not-selected";

/** The choice as loaded from the database. */
export function choiceFrom(rows: readonly ListRow[], lists: readonly AppList[]): Choice {
  const choice = new Map<string, Set<AppList>>();
  for (const row of rows) {
    if (!lists.includes(row.list)) continue;
    const set = choice.get(row.company_id) ?? new Set<AppList>();
    set.add(row.list);
    choice.set(row.company_id, set);
  }
  return choice;
}

const onIn = (choice: Choice, id: string) => choice.get(id) ?? new Set<AppList>();

/** Whether a company is selected: switched on in at least one of the app's lists. */
export const isSelected = (choice: Choice, id: string) => onIn(choice, id).size > 0;

export const isOn = (choice: Choice, id: string, list: AppList) => onIn(choice, id).has(list);

function withLists(choice: Choice, id: string, next: ReadonlySet<AppList>): Choice {
  const copy = new Map(choice);
  if (next.size === 0) copy.delete(id);
  else copy.set(id, next);
  return copy;
}

/** One list of one company on or off. */
export function toggleList(choice: Choice, id: string, list: AppList): Choice {
  const next = new Set(onIn(choice, id));
  if (next.has(list)) next.delete(list);
  else next.add(list);
  return withLists(choice, id, next);
}

/** The whole card: every list on, or, when any is on, every list off. */
export function toggleCompany(choice: Choice, id: string, lists: readonly AppList[]): Choice {
  return withLists(choice, id, isSelected(choice, id) ? new Set() : new Set(lists));
}

/** Select all / Clear: for the companies shown that the user may change. */
export function setAll(
  choice: Choice,
  companies: readonly PickerCompany[],
  lists: readonly AppList[],
  on: boolean,
): Choice {
  let next = choice;
  for (const company of companies) {
    if (company.admin) next = withLists(next, company.id, on ? new Set(lists) : new Set());
  }
  return next;
}

/** What to save: every list of every admin company that differs from what was loaded. */
export function changesBetween(
  loaded: Choice,
  chosen: Choice,
  companies: readonly PickerCompany[],
  lists: readonly AppList[],
): ListChange[] {
  const changes: ListChange[] = [];
  for (const company of companies) {
    if (!company.admin) continue;
    for (const list of lists) {
      const was = isOn(loaded, company.id, list);
      const now = isOn(chosen, company.id, list);
      if (was !== now) changes.push({ companyId: company.id, list, on: now });
    }
  }
  return changes;
}

/** The cards shown for a search and a filter chip. Name or BRN, any case, anywhere. */
export function shownCompanies(
  companies: readonly PickerCompany[],
  choice: Choice,
  search: string,
  filter: PickerFilter,
): PickerCompany[] {
  const wanted = search.trim().toLowerCase();
  return companies.filter((company) => {
    if (filter === "selected" && !isSelected(choice, company.id)) return false;
    if (filter === "not-selected" && isSelected(choice, company.id)) return false;
    if (wanted === "") return true;
    return (
      company.name.toLowerCase().includes(wanted) || company.brn.toLowerCase().includes(wanted)
    );
  });
}

/** How many companies are on in each list. */
export function countsOf(
  choice: Choice,
  companies: readonly PickerCompany[],
  lists: readonly AppList[],
): Record<AppList, number> {
  const counts = { payroll: 0, payslips: 0, csg: 0, prgf: 0 };
  for (const company of companies) {
    for (const list of lists) if (isOn(choice, company.id, list)) counts[list] += 1;
  }
  return counts;
}

/** "AB" from "ABC Co Ltd", "XT" from "XYZ Trading Ltd": the first letters of the first two words that count. */
export function initialsOf(name: string): string {
  const skip = new Set(["co", "ltd", "limited", "the", "and", "&", "of", "plc", "inc"]);
  const words = name
    .replace(/[().,]/g, " ")
    .split(/\s+/)
    .filter((word) => word !== "" && !skip.has(word.toLowerCase()));
  const kept = words.length > 0 ? words : [name.trim()];
  // One word: its first two letters ("ABC Co Ltd" is "AB").
  const letters =
    kept.length === 1
      ? [...kept[0]!].slice(0, 2).join("")
      : kept
          .slice(0, 2)
          .map((word) => [...word][0] ?? "")
          .join("");
  return letters.toUpperCase() || "?";
}

/** One of eight hues, the same every time for the same company. */
export function hueOf(key: string): number {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return [162, 200, 230, 262, 300, 340, 30, 75][hash % 8]!;
}
