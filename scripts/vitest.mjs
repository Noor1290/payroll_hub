// Runs Vitest with a normalised working directory.
//
// On Windows, a terminal can start in "c:\..." (lowercase drive letter; VS Code does this).
// Vitest then loads its own runner twice, under two spellings of the same path, and every
// test file fails before running with "Cannot read properties of undefined (reading 'config')".
// Upper-casing the drive letter before Vitest starts avoids that.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (process.platform === "win32") {
  const cwd = process.cwd();
  if (/^[a-z]:/.test(cwd)) process.chdir(cwd[0].toUpperCase() + cwd.slice(1));
}

// Loaded by absolute path from the corrected directory, so Vitest sees one spelling throughout.
await import(pathToFileURL(resolve(process.cwd(), "node_modules/vitest/vitest.mjs")).href);
