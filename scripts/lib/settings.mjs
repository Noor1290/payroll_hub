// Reads the settings the safety-check scripts need. A value set in the environment wins; the
// project URL and anon key may otherwise come from the local .env (gitignored). Nothing is ever
// printed but whether a value was found.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkAnonKey, checkProjectUrl, parseDotEnv } from "../../src/safety/settings.ts";

export function loadSettings() {
  const file = resolve(process.cwd(), ".env");
  const fromFile = existsSync(file) ? parseDotEnv(readFileSync(file, "utf8")) : {};
  const pick = (name) => process.env[name] || fromFile[name] || undefined;
  return {
    url: pick("VITE_SUPABASE_URL"),
    anonKey: pick("VITE_SUPABASE_ANON_KEY"),
    // Never read from a file: only from the environment of this one terminal.
    email: process.env.NONMEMBER_EMAIL || undefined,
    password: process.env.NONMEMBER_PASSWORD || undefined,
    testCompanyIds: process.env.TEST_COMPANY_IDS || undefined,
  };
}

/** Stops with a plain message (exit code 3) when the project URL or key is missing or wrong. */
export function requireProject(settings) {
  const problem = checkProjectUrl(settings.url) ?? checkAnonKey(settings.anonKey);
  if (problem) {
    console.error(`Not started: ${problem}`);
    process.exit(3);
  }
}

/** Options for a Supabase client that keeps nothing: no stored session, no refresh. */
export const NO_STORAGE = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
};
