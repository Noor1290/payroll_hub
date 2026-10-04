import { describe, expect, it } from "vitest";
import {
  accentColor,
  groupLinks,
  linkFormSchema,
  moveBy,
  normaliseUrl,
  planCopy,
  reorderWithin,
  safeHref,
} from "./linkModel";
import { linkIcon, LINK_ICONS } from "./icons";

const form = (url: string) =>
  linkFormSchema.safeParse({
    title: " Tax portal ",
    url,
    description: "",
    category: " Government ",
    icon: "landmark",
    accent: "teal",
    is_pinned: false,
  });

describe("normaliseUrl", () => {
  it("accepts only http and https", () => {
    for (const bad of [
      "javascript:alert(1)",
      " JaVaScRiPt:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "ftp://example.org/file",
      "file:///C:/payroll.json",
      "//example.org",
      "example.org",
      "mailto:someone@example.com",
      "",
      "   ",
      "https://",
    ]) {
      expect(normaliseUrl(bad).ok, bad).toBe(false);
      expect(safeHref(bad), bad).toBeNull();
    }
    expect(normaliseUrl("http://example.org")).toEqual({ ok: true, url: "http://example.org" });
    expect(normaliseUrl("https://example.org")).toEqual({ ok: true, url: "https://example.org" });
  });

  it("refuses an address that carries a user name or password", () => {
    expect(normaliseUrl("https://user:secret@example.org/").ok).toBe(false);
  });

  it("trims, lower-cases the host and drops a trailing slash, so near-duplicates become equal", () => {
    const expected = "https://example.org/tax";
    for (const variant of [
      "https://example.org/tax",
      "  https://example.org/tax  ",
      "https://EXAMPLE.org/tax",
      "HTTPS://Example.Org/tax/",
      "https://example.org/tax//",
    ]) {
      expect(normaliseUrl(variant)).toEqual({ ok: true, url: expected });
    }
    expect(normaliseUrl("https://Example.org/")).toEqual({ ok: true, url: "https://example.org" });
  });

  it("leaves the path, query and port as typed", () => {
    expect(normaliseUrl("https://Example.org:8443/Tax/Forms?Year=2026#Top")).toEqual({
      ok: true,
      url: "https://example.org:8443/Tax/Forms?Year=2026#Top",
    });
  });

  it("refuses an address that is too long", () => {
    expect(normaliseUrl(`https://example.org/${"a".repeat(2000)}`).ok).toBe(false);
  });
});

describe("the link form", () => {
  it("rejects javascript: and data: addresses", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,hello"]) {
      const result = form(bad);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(["url"]);
    }
  });

  it("trims every text field and stores the tidied address", () => {
    const result = form(" https://EXAMPLE.org/tax/ ");
    expect(result.data).toMatchObject({
      title: "Tax portal",
      url: "https://example.org/tax",
      description: null,
      category: "Government",
    });
  });

  it("requires a title and enforces the length limits", () => {
    expect(
      linkFormSchema.safeParse({ ...form("https://example.org").data, title: "  " }).success,
    ).toBe(false);
    expect(
      linkFormSchema.safeParse({ ...form("https://example.org").data, title: "x".repeat(81) })
        .success,
    ).toBe(false);
    expect(
      linkFormSchema.safeParse({
        ...form("https://example.org").data,
        description: "x".repeat(201),
      }).success,
    ).toBe(false);
  });
});

describe("icons and colours", () => {
  it("falls back to defaults for anything unrecognised: stored text is never used as CSS or markup", () => {
    expect(linkIcon("nope")).toBe(LINK_ICONS.link!.icon);
    expect(linkIcon(null)).toBe(LINK_ICONS.link!.icon);
    expect(accentColor("red; background:url(https://example.org/x)")).toBe("var(--accent)");
    expect(accentColor("violet")).toBe("var(--glow)");
  });
});

const link = (id: string, sort_order: number, more: Record<string, unknown> = {}) => ({
  id,
  title: id,
  url: `https://example.org/${id}`,
  description: null as string | null,
  category: null as string | null,
  is_pinned: false,
  sort_order,
  ...more,
});

describe("groupLinks", () => {
  const links = [
    link("bank", 0, { category: "Banking" }),
    link("tax", 1, { category: "Government", is_pinned: true }),
    link("calendar", 2),
    link("registry", 3, { category: "Government", description: "Company filings" }),
    link("audit", 4, { category: "accounting" }),
  ];

  it("puts pinned links first, then categories A to Z, then the rest", () => {
    const groups = groupLinks(links);
    expect(groups.map((group) => group.title)).toEqual([
      "Pinned",
      "accounting",
      "Banking",
      "Government",
      "Other",
    ]);
    expect(groups[0]!.links.map((l) => l.id)).toEqual(["tax"]);
    // A pinned link is shown once, under Pinned.
    expect(groups[3]!.links.map((l) => l.id)).toEqual(["registry"]);
  });

  it("searches titles, addresses, descriptions and categories", () => {
    const ids = (search: string) =>
      groupLinks(links, search).flatMap((group) => group.links.map((l) => l.id));
    expect(ids("REGIS")).toEqual(["registry"]);
    expect(ids("filings")).toEqual(["registry"]);
    expect(ids("government")).toEqual(["tax", "registry"]);
    expect(ids("example.org/bank")).toEqual(["bank"]);
    expect(ids("nothing like this")).toEqual([]);
  });
});

describe("reordering", () => {
  const all = [link("a", 0), link("b", 1), link("c", 2), link("d", 3)];

  it("returns only the rows whose position changed", () => {
    expect(reorderWithin(all, ["a", "b", "c", "d"])).toEqual([]);
    expect(reorderWithin(all, ["a", "c", "b", "d"])).toEqual([
      { id: "c", sort_order: 1 },
      { id: "b", sort_order: 2 },
    ]);
  });

  it("rearranges a group inside the slots it already had, leaving the others in place", () => {
    // b and d are one group; swapping them must not move a or c.
    expect(reorderWithin(all, ["d", "b"])).toEqual([
      { id: "d", sort_order: 1 },
      { id: "b", sort_order: 3 },
    ]);
  });

  it("moves one step up or down, and stays put at the ends", () => {
    expect(moveBy(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveBy(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
    expect(moveBy(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
    expect(moveBy(["a", "b", "c"], "c", 1)).toEqual(["a", "b", "c"]);
  });
});

describe("planCopy", () => {
  it("skips addresses the company already has, comparing tidied addresses", () => {
    const existing = [{ url: "https://example.org/tax" }];
    const source = [
      { url: "https://EXAMPLE.org/tax/", title: "Tax (same site)" },
      { url: "https://example.org/pension", title: "Pension" },
    ];
    const plan = planCopy(source, existing);
    expect(plan.toCopy.map((l) => l.title)).toEqual(["Pension"]);
    expect(plan.skipped.map((l) => l.title)).toEqual(["Tax (same site)"]);
  });

  it("skips an address repeated in the source, and anything that is not a web address", () => {
    const plan = planCopy(
      [
        { url: "https://example.org/a" },
        { url: "https://example.org/a/" },
        { url: "javascript:alert(1)" },
        { url: "https://example.org/b" },
      ],
      [],
    );
    expect(plan.toCopy.map((l) => l.url)).toEqual([
      "https://example.org/a",
      "https://example.org/b",
    ]);
    expect(plan.skipped).toHaveLength(2);
  });

  it("copies nothing when everything is already there", () => {
    const same = [{ url: "https://example.org/a" }];
    expect(planCopy(same, same)).toEqual({ toCopy: [], skipped: same });
  });
});
