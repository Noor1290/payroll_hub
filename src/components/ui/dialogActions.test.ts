import { describe, expect, it } from "vitest";

// Hotfix 4 (24 November 2026): a dialog's buttons never leave the window. The rule is one class,
// `dialog-actions`, in src/styles/index.css; every dialog's button row uses it.
const sources = import.meta.glob<string>(["/src/**/*.tsx", "!/src/**/*.test.tsx"], {
  query: "?raw",
  import: "default",
  eager: true,
});

// The stylesheet as text, read from disk: the test set-up empties any import of a CSS file. The
// tests run from the repository's folder.
const fsModule = "node:fs";
const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
  readFileSync: (path: string, encoding: "utf8") => string;
};
const css = readFileSync("src/styles/index.css", "utf8");

describe("the dialogs' button row", () => {
  it("wraps, lets a long label wrap, and stacks on a phone, outside any layer so it wins", () => {
    const rule = (selector: string) => {
      const at = css.indexOf(`${selector} {`);
      expect(at, selector).toBeGreaterThan(-1);
      return css.slice(at, css.indexOf("}", at));
    };
    expect(rule(".dialog-actions")).toMatch(/flex-wrap: wrap/);
    expect(rule(".dialog-actions > button,\n.dialog-actions > a")).toMatch(/white-space: normal/);
    expect(css).toMatch(
      /@media \(max-width: 639px\) \{\s*\.dialog-actions \{\s*flex-direction: column-reverse;/,
    );
    // Not inside an @layer block: the last one starts before it.
    expect(css.lastIndexOf("@layer")).toBeLessThan(css.indexOf(".dialog-actions {"));
  });

  it("is used by every dialog: no row of buttons is right-aligned without wrapping", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    const offenders = Object.entries(sources)
      .filter(([, text]) => /className="[^"]*\bflex justify-end gap-2\b[^"]*"/.test(text))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});
