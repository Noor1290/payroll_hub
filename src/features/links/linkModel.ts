import { z } from "zod";

/** Same limits as the database (migration 0006), so the form catches them first. */
export const LINK_LIMITS = { title: 80, url: 2000, description: 200, category: 40 } as const;

/** The fixed accent palette. A link stores the key; the colour comes from a design token. */
export const ACCENTS = [
  { key: "teal", label: "Teal", color: "var(--accent)" },
  { key: "violet", label: "Violet", color: "var(--glow)" },
  { key: "sky", label: "Blue", color: "var(--sky)" },
  { key: "amber", label: "Amber", color: "var(--warn)" },
  { key: "rose", label: "Rose", color: "var(--danger)" },
  { key: "slate", label: "Grey", color: "var(--muted)" },
] as const;
export type AccentKey = (typeof ACCENTS)[number]["key"];
export const DEFAULT_ACCENT: AccentKey = "teal";

/** The colour for a stored accent. Anything unrecognised gets the default: stored text is never used as CSS. */
export function accentColor(key: string | null | undefined): string {
  return (ACCENTS.find((accent) => accent.key === key) ?? ACCENTS[0]).color;
}

export type UrlResult = { ok: true; url: string } | { ok: false; why: string };

/**
 * Tidies a web address so that near-duplicates become identical: trims it, lower-cases the
 * scheme and host, and drops trailing slashes from the path. Only http and https are accepted,
 * so "javascript:", "data:" and the like can never be saved or opened.
 */
export function normaliseUrl(input: string): UrlResult {
  const text = input.trim();
  if (text === "") return { ok: false, why: "Enter the web address." };
  if (text.length > LINK_LIMITS.url) {
    return { ok: false, why: `The address can be at most ${LINK_LIMITS.url} characters.` };
  }
  if (!/^https?:\/\//i.test(text)) {
    return { ok: false, why: "The address must start with https:// or http://." };
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, why: "That doesn't look like a complete web address." };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, why: "The address must start with https:// or http://." };
  }
  if (!parsed.hostname) return { ok: false, why: "That doesn't look like a complete web address." };
  if (parsed.username || parsed.password) {
    return { ok: false, why: "Remove the user name and password from the address." };
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  // `host` is already lower-cased by the URL parser and keeps a non-default port.
  return {
    ok: true,
    url: `${parsed.protocol}//${parsed.host}${path}${parsed.search}${parsed.hash}`,
  };
}

/** The address to put in an href, or null if the stored value is not a plain http(s) URL. */
export function safeHref(url: string | null | undefined): string | null {
  const result = normaliseUrl(url ?? "");
  return result.ok ? result.url : null;
}

/** "https://www.example.org/tax" -> "example.org", for showing where a card leads. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const optionalText = (max: number, what: string) =>
  z
    .string()
    .trim()
    .max(max, `${what} can be at most ${max} characters.`)
    .transform((value) => (value === "" ? null : value));

/** What the add/edit link form accepts. The URL comes out normalised. */
export const linkFormSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "Enter a title.")
    .max(LINK_LIMITS.title, `The title can be at most ${LINK_LIMITS.title} characters.`),
  url: z.string().transform((value, ctx) => {
    const result = normaliseUrl(value);
    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: result.why });
      return z.NEVER;
    }
    return result.url;
  }),
  description: optionalText(LINK_LIMITS.description, "The description"),
  category: optionalText(LINK_LIMITS.category, "The category"),
  icon: z.string().max(40),
  accent: z.string().max(20),
  is_pinned: z.boolean(),
});
export type LinkInput = z.infer<typeof linkFormSchema>;
export type LinkField = keyof LinkInput;

/** One message per field that failed, for showing next to that field. */
export function fieldErrors<T extends string>(error: z.ZodError): Partial<Record<T, string>> {
  const errors: Partial<Record<T, string>> = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0]) as T;
    errors[field] ??= issue.message;
  }
  return errors;
}

/** The part of a link that grouping, search and ordering need. */
export interface LinkLike {
  id: string;
  title: string;
  url: string;
  description: string | null;
  category: string | null;
  is_pinned: boolean;
  sort_order: number;
}

export interface LinkGroup<T> {
  /** Stable key: "pinned", "category:<name>" or "other". */
  key: string;
  title: string;
  links: T[];
}

export const bySortOrder = <T extends { sort_order: number; id: string }>(a: T, b: T) =>
  a.sort_order - b.sort_order || a.id.localeCompare(b.id);

/**
 * Cards in display order: pinned links first (whatever their category), then one group per
 * category in alphabetical order, then links without a category. A search narrows by title,
 * address, description and category.
 */
export function groupLinks<T extends LinkLike>(links: readonly T[], search = ""): LinkGroup<T>[] {
  const needle = search.trim().toLowerCase();
  const shown = [...links]
    .filter(
      (link) =>
        !needle ||
        [link.title, link.url, link.description ?? "", link.category ?? ""].some((text) =>
          text.toLowerCase().includes(needle),
        ),
    )
    .sort(bySortOrder);

  const groups: LinkGroup<T>[] = [];
  const pinned = shown.filter((link) => link.is_pinned);
  if (pinned.length > 0) groups.push({ key: "pinned", title: "Pinned", links: pinned });

  const rest = shown.filter((link) => !link.is_pinned);
  const categories = [
    ...new Set(rest.map((link) => link.category).filter((c): c is string => !!c)),
  ];
  categories.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  for (const category of categories) {
    groups.push({
      key: `category:${category}`,
      title: category,
      links: rest.filter((link) => link.category === category),
    });
  }
  const other = rest.filter((link) => !link.category);
  if (other.length > 0) {
    groups.push({ key: "other", title: categories.length > 0 ? "Other" : "Links", links: other });
  }
  return groups;
}

/**
 * Works out the new sort_order values after some items were rearranged among themselves
 * (a group of cards, or a whole list). The rearranged items keep the slots their group
 * already occupied, so everything outside the group stays where it was. Returns only the
 * rows whose sort_order actually changes.
 */
export function reorderWithin<T extends { id: string; sort_order: number }>(
  all: readonly T[],
  rearranged: readonly string[],
): { id: string; sort_order: number }[] {
  const ordered = [...all].sort(bySortOrder);
  const moving = new Set(rearranged);
  const queue = [...rearranged];
  const next = ordered.map((item) => (moving.has(item.id) ? queue.shift()! : item.id));
  const current = new Map(ordered.map((item) => [item.id, item.sort_order]));
  return next
    .map((id, index) => ({ id, sort_order: index }))
    .filter((change) => current.get(change.id) !== change.sort_order);
}

/** Moves one id up or down within a list of ids; returns the same list if it cannot move. */
export function moveBy(ids: readonly string[], id: string, step: -1 | 1): string[] {
  const from = ids.indexOf(id);
  const to = from + step;
  if (from < 0 || to < 0 || to >= ids.length) return [...ids];
  const next = [...ids];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}

/**
 * Splits another company's links into the ones worth copying and the ones this company
 * already has. Two links are the same when their tidied addresses are equal. A URL that is
 * repeated in the source, or is not a valid http(s) address, is skipped too.
 */
export function planCopy<T extends { url: string }>(
  source: readonly T[],
  existing: readonly { url: string }[],
): { toCopy: T[]; skipped: T[] } {
  const taken = new Set(existing.map((link) => safeHref(link.url)).filter(Boolean));
  const toCopy: T[] = [];
  const skipped: T[] = [];
  for (const link of source) {
    const key = safeHref(link.url);
    if (key === null || taken.has(key)) skipped.push(link);
    else {
      taken.add(key);
      toCopy.push(link);
    }
  }
  return { toCopy, skipped };
}
