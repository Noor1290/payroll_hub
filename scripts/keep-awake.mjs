// Keep-awake: one small, real database request, so the free Supabase project is not paused for
// inactivity. Run every two days by .github/workflows/keep-awake.yml; can be run by hand too:
//
//   node scripts/keep-awake.mjs
//
// Reads VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY from the environment (or the local .env).
// Tries up to 3 times, 20 seconds apart. Exit code 0: the database answered. 1: it did not (the
// workflow run then fails, and GitHub emails). 3: not started (settings). No dependency: only
// Node and the code in src/safety/keepAwake.ts.
//
// The exit code is set, not forced with process.exit(): on Windows, exiting while fetch is still
// closing its connection crashes Node (a libuv assertion) and turns a success into exit code 127.
import { judgePing, pingRequest } from "../src/safety/keepAwake.ts";
import { loadSettings, requireProject } from "./lib/settings.mjs";

async function ping(request) {
  let last = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(request.url, { ...request.init, signal: AbortSignal.timeout(30_000) });
      const verdict = judgePing(response.status, await response.text());
      if (verdict.ok) {
        console.log(`OK: ${verdict.reason} (attempt ${attempt}).`);
        return true;
      }
      last = verdict.reason;
    } catch (error) {
      last = `The request failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    console.log(`Attempt ${attempt} failed: ${last}`);
    if (attempt < 3) await new Promise((wait) => setTimeout(wait, 20_000));
  }
  console.error(`FAILED: the database did not answer. ${last}`);
  return false;
}

const settings = loadSettings();
requireProject(settings);
process.exitCode = (await ping(pingRequest(settings.url, settings.anonKey))) ? 0 : 1;
