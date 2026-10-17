// Sign-up check: with only the public anon key, try to create an account (a fake address on
// example.com) and to sign in anonymously. Both must be refused because sign-ups are off.
//
//   node scripts/check-signup.mjs
//
// Reads VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY from the environment or the local .env.
// Exit code 0: both refused. 1: an account was created (delete it: Authentication > Users).
// 2: refused for another reason (read the message). 3: not started (settings).
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { fakeAddress, judgeSignup } from "../src/safety/signupCheck.ts";
import { loadSettings, NO_STORAGE, requireProject } from "./lib/settings.mjs";

const settings = loadSettings();
requireProject(settings);
const client = createClient(settings.url, settings.anonKey, NO_STORAGE);

const email = fakeAddress(Date.now(), randomBytes(4).toString("hex"));
const signUp = await client.auth.signUp({ email, password: `${randomBytes(18).toString("base64url")}-Aa1!` });
const anonymous = await client.auth.signInAnonymously();

const results = [
  { what: `sign up with ${email}`, ...judgeSignup({ userId: signUp.data?.user?.id, error: signUp.error }) },
  { what: "anonymous sign-in", ...judgeSignup({ userId: anonymous.data?.user?.id, error: anonymous.error }) },
];
for (const result of results) console.log(`${result.status.padEnd(7)} ${result.what}: ${result.result}`);
await client.auth.signOut({ scope: "local" });

// The exit code is set, not forced: on Windows, process.exit() while a connection is closing
// can crash Node.
if (results.some((result) => result.status === "FAIL")) {
  console.log("\nSTOP: an account was created. Delete it in Supabase > Authentication > Users, then switch sign-ups off.");
  process.exitCode = 1;
} else if (results.some((result) => result.status === "UNCLEAR")) {
  process.exitCode = 2;
} else {
  console.log("\nSign-ups are off: nobody can create an account with the public key.");
}
