// Non-member security check: every table, database function and storage bucket the dashboard
// uses, tried first by an anonymous visitor (anon key only), then by a signed-in user who belongs
// to NO company. Reads must return nothing; writes must be refused. Writes are aimed only at the
// two TEST companies. The list of what is tried, and why each attempt is safe, is in
// src/safety/nonmemberChecks.ts.
//
// In one terminal (PowerShell: $env:NAME = "value"; bash: export NAME=value), never in a file:
//   NONMEMBER_EMAIL     the account that is a member of no company
//   NONMEMBER_PASSWORD  its password
//   TEST_COMPANY_IDS    the ids of "TEST Co Ltd" and "TEST Co 2 Ltd", comma-separated
// then: node scripts/check-nonmember.mjs
//
// The project URL and anon key come from the environment or the local .env.
// Exit code 0: all PASS. 1: a FAIL (cleanup SQL is printed). 2: UNCLEAR only. 3: not started.
import { createClient } from "@supabase/supabase-js";
import { exitCode, formatTable, tally } from "../src/safety/outcome.ts";
import { preflight, runChecks } from "../src/safety/nonmemberChecks.ts";
import { parseTestCompanyIds } from "../src/safety/settings.ts";
import { loadSettings, NO_STORAGE, requireProject } from "./lib/settings.mjs";
import { supabaseApi } from "./lib/supabaseApi.mjs";

const settings = loadSettings();
requireProject(settings);
const parsed = parseTestCompanyIds(settings.testCompanyIds);
if ("problem" in parsed) {
  console.error(`Not started: ${parsed.problem}`);
  process.exit(3);
}
if (!settings.email || !settings.password) {
  console.error("Not started: set NONMEMBER_EMAIL and NONMEMBER_PASSWORD in this terminal (never in a file).");
  process.exit(3);
}
const test = { a: parsed.ids[0], b: parsed.ids[1] };
const progress = (row) => process.stdout.write(row.status === "PASS" ? "." : row.status[0]);

// ---------- 1. an anonymous visitor ----------
console.log("Anonymous visitor (anon key only)");
const anonClient = createClient(settings.url, settings.anonKey, NO_STORAGE);
const anonRows = await runChecks({ api: supabaseApi(anonClient), who: "anon", test, self: null }, { onRow: progress });
console.log("");

// ---------- 2. a signed-in user who belongs to no company ----------
console.log("Signed-in user who belongs to no company");
const userClient = createClient(settings.url, settings.anonKey, NO_STORAGE);
const signIn = await userClient.auth.signInWithPassword({ email: settings.email, password: settings.password });
if (signIn.error || !signIn.data.user) {
  console.error(`\nNot started: the sign-in was refused (${signIn.error?.message ?? "no user"}). The anonymous checks are below.`);
  console.log(formatTable(anonRows));
  process.exit(3);
}
const userApi = supabaseApi(userClient);
const unsafe = await preflight(userApi, test);
if (unsafe) {
  console.error(`\nSTOPPED before any write: ${unsafe}`);
  await userClient.auth.signOut({ scope: "local" });
  process.exit(3);
}
const userRows = await runChecks({ api: userApi, who: "non-member", test, self: signIn.data.user.id }, { onRow: progress });
// Ends this script's session only; the account's other sessions are left alone.
await userClient.auth.signOut({ scope: "local" });
console.log("\n");

// ---------- the report ----------
const rows = [...anonRows, ...userRows];
console.log(formatTable(rows));
const counts = tally(rows);
console.log(`\n${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts.UNCLEAR} UNCLEAR, ${counts.SKIP} SKIP`);

const failed = rows.filter((row) => row.status === "FAIL");
if (failed.length > 0) {
  console.log("\nSTOP: something a non-member must not do went through. Do not import real data.");
  console.log("Cleanup (run nothing until you have read the preview):\n");
  for (const row of failed) console.log(`- ${row.who} / ${row.object} / ${row.action}\n${row.cleanup ?? "(no cleanup needed: nothing was stored)"}\n`);
}
const unclear = rows.filter((row) => row.status === "UNCLEAR");
if (unclear.length > 0) {
  console.log("\nUNCLEAR rows were refused, but not in a way that proves the protection. Send this output to Claude.");
}
process.exit(exitCode(rows));
