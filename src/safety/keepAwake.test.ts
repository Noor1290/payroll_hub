import { describe, expect, it } from "vitest";
import workflow from "../../.github/workflows/keep-awake.yml?raw";
import { judgeLastCommit, judgePing, PING_FUNCTION, pingRequest, STALE_AFTER_DAYS } from "./keepAwake.ts";

const migrations = import.meta.glob<string>("../../supabase/migrations/*.sql", { query: "?raw", import: "default", eager: true });
const sql = Object.values(migrations)
  .join("\n")
  .replace(/\r\n/g, "\n")
  .replace(/--.*$/gm, "");

describe("the request", () => {
  it("calls is_company_member with the anon key and an id that belongs to no company", () => {
    const request = pingRequest("https://abcdefgh.supabase.co/", "anon-key");
    expect(request.url).toBe("https://abcdefgh.supabase.co/rest/v1/rpc/is_company_member");
    expect(request.init.headers).toMatchObject({ apikey: "anon-key", Authorization: "Bearer anon-key" });
    expect(JSON.parse(request.init.body)).toEqual({ cid: "00000000-0000-0000-0000-000000000000" });
  });

  it("calls a function that exists and is closed to anon, so Postgres itself must answer", () => {
    expect(sql).toMatch(new RegExp(`create or replace function public\\.${PING_FUNCTION}\\(`));
    expect(sql).toMatch(new RegExp(`revoke all on function public\\.${PING_FUNCTION}\\(uuid\\) from public, anon;`));
  });
});

describe("judgePing", () => {
  const refused = JSON.stringify({ code: "42501", message: "permission denied for function is_company_member" });

  it("is OK when the database answered: a 200, or Postgres's own refusal of the anon key", () => {
    expect(judgePing(200, "true").ok).toBe(true);
    expect(judgePing(401, refused).ok).toBe(true);
    expect(judgePing(403, refused).ok).toBe(true);
  });

  it("fails when the answer did not come from the database", () => {
    expect(judgePing(540, "Project paused").reason).toMatch(/PAUSED/);
    expect(judgePing(503, JSON.stringify({ code: "PGRST002", message: "Could not query the database" })).reason).toMatch(
      /could not reach the database/,
    );
    expect(judgePing(401, '{"message":"Invalid API key"}').reason).toMatch(/key itself was refused/);
    expect(judgePing(401, '{"code":"PGRST301","message":"JWT expired"}').ok).toBe(false);
    expect(judgePing(503, "").reason).toBe("HTTP 503: (empty answer).");
  });
});

describe("judgeLastCommit", () => {
  const now = new Date("2026-12-31T12:00:00Z");

  it("is quiet until 45 days after the last commit", () => {
    expect(judgeLastCommit("2026-11-20T12:00:00Z", now)).toMatchObject({ days: 41, warn: false });
  });

  it("warns from 45 days on, before GitHub's 60-day limit, saying what to do", () => {
    const verdict = judgeLastCommit("2026-11-16T12:00:00Z", now);
    expect(verdict).toMatchObject({ days: STALE_AFTER_DAYS, warn: true });
    expect(verdict.reason).toMatch(/60 days.*Push any commit/);
  });

  it("warns when the date cannot be read", () => {
    expect(judgeLastCommit("", now).warn).toBe(true);
  });
});

describe("the workflow", () => {
  const text = workflow.replace(/\r\n/g, "\n");

  it("runs on a schedule never more than 2 days apart, and by hand", () => {
    const cron = text.match(/cron:\s*"([^"]+)"/)?.[1];
    expect(cron).toBe("17 5 */2 * *");
    expect(text).toMatch(/^\s*workflow_dispatch:/m);
  });

  it("reads only the public URL and anon key, under the deploy workflow's names", () => {
    expect(text).toContain("VITE_SUPABASE_URL: ${{ vars.VITE_SUPABASE_URL || secrets.VITE_SUPABASE_URL }}");
    expect(text).toContain("VITE_SUPABASE_ANON_KEY: ${{ vars.VITE_SUPABASE_ANON_KEY || secrets.VITE_SUPABASE_ANON_KEY }}");
    expect(text).not.toMatch(/service_role|SERVICE_ROLE|sb_secret/);
  });

  it("asks for read access only", () => {
    expect(text).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(text).not.toMatch(/: write/);
  });

  it("fails visibly: no step may swallow an error", () => {
    expect(text).not.toMatch(/continue-on-error|\|\| true/);
    expect(text).toContain("run: node scripts/keep-awake.mjs");
  });

  it("checks the 60-day rule even when the database request failed", () => {
    expect(text).toMatch(/Warn before GitHub's 60-day rule[\s\S]*?if: always\(\)/);
  });
});
