// The repo is public, so nothing that may name a real person or company belongs in it (payroll
// TODO A8). A surname that might have been a real person's was replaced with "PLACEHOLDER" on
// 8 October 2026 (its first names only in November), and a company of the live project was named
// in docs/MIGRATION_PLAN.md until November 2026. This test keeps them out of every text file of
// the repo. It holds only short SHA-256 digests, never the names themselves, so the test does not
// put them back into the repo.
import { describe, expect, it } from "vitest";

const files = import.meta.glob<string>(
  [
    "/*.{md,json,ts,js,mjs,html,yml}",
    "/{dev,docs,public,samples,scripts,src,supabase}/**/*.{md,json,ts,tsx,js,mjs,sql,html,css,snap,txt,yml}",
    "!**/node_modules/**",
    "!/package-lock.json",
  ],
  { query: "?raw", import: "default", eager: true },
);

/** Single words (lower case), and their lengths: only words that long are hashed. */
const OLD_WORDS = new Set(["489e998ef03be1d6"]);
const WORD_LENGTHS = new Set([7]);
/** Two words in a row (lower case, one space), and their lengths. */
const OLD_PAIRS = new Set(["7ef27052b44cb472", "5088b72f91a4df7a"]);
const PAIR_LENGTHS = new Set([5, 9]);

async function digest(text: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return [...bytes]
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

describe("no name that may be real, in any file of the repo (A8)", () => {
  it("reads the files of the repo", () => {
    const paths = Object.keys(files);
    expect(paths.length).toBeGreaterThan(300);
    expect(paths).toContain("/docs/MIGRATION_PLAN.md");
    expect(paths).toContain("/samples/ABC Co Ltd-pdf-fill-2026-09.json");
    expect(paths).toContain("/src/safety/outcome.ts");
    expect(paths).toContain("/README.md");
  });

  it("has none of the old names", async () => {
    // Every word and pair of words of those lengths, with the first file it is in.
    const firstFile = new Map<string, string>();
    for (const [path, text] of Object.entries(files)) {
      const words = text
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter(Boolean);
      for (const [i, word] of words.entries()) {
        if (WORD_LENGTHS.has(word.length) && !firstFile.has(word)) firstFile.set(word, path);
        const pair = i > 0 ? `${words[i - 1]} ${word}` : "";
        if (PAIR_LENGTHS.has(pair.length) && !firstFile.has(pair)) firstFile.set(pair, path);
      }
    }
    const items = [...firstFile.keys()];
    const hashes = await Promise.all(items.map(digest));
    const hits = items.flatMap((item, i) =>
      OLD_WORDS.has(hashes[i]!) || OLD_PAIRS.has(hashes[i]!) ? [firstFile.get(item)!] : [],
    );
    expect(hits).toEqual([]);
  });
});
