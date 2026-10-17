// The keep-awake job (.github/workflows/keep-awake.yml): one small, real database request every
// two days, so the free Supabase project is not paused for inactivity.
//
// The request calls the database function is_company_member with the public anon key. Every
// function in this database is closed to anon (0001 revokes this one from public and anon), so
// Postgres itself answers "permission denied" (code 42501). That answer can only come from a
// running database that received and checked the request: it proves the project is awake, and
// it reads nothing. A paused or broken project answers differently (HTTP 540 or 5xx, a PGRST
// connection error, or nothing), and the job fails.
//
// If a ping function callable by anon is ever added (a migration), point PING_FUNCTION at it:
// an HTTP 200 answer is accepted as well.

export const PING_FUNCTION = "is_company_member";
export const PING_ARGS = { cid: "00000000-0000-0000-0000-000000000000" } as const;

export interface PingRequest {
  url: string;
  init: { method: "POST"; headers: Record<string, string>; body: string };
}

export function pingRequest(projectUrl: string, anonKey: string): PingRequest {
  return {
    url: `${projectUrl.replace(/\/+$/, "")}/rest/v1/rpc/${PING_FUNCTION}`,
    init: {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(PING_ARGS),
    },
  };
}

function postgresCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { code?: unknown };
    return typeof parsed.code === "string" ? parsed.code : null;
  } catch {
    return null;
  }
}

/** OK when the DATABASE answered: HTTP 200, or Postgres's own refusal (401/403 with code 42501).
 * Anything else (a paused project, a wrong key, a connection error) is a failure, with a reason. */
export function judgePing(status: number, body: string): { ok: boolean; reason: string } {
  const text = body.trim();
  if (status === 200) return { ok: true, reason: "the database answered" };
  if ((status === 401 || status === 403) && postgresCode(text) === "42501") {
    return { ok: true, reason: "the database answered (it refused the anon key, as it should)" };
  }
  const shown = text.length > 200 ? `${text.slice(0, 199)}…` : text;
  const hint =
    status === 540 || /paused/i.test(text)
      ? " The project looks PAUSED: restore it in the Supabase dashboard."
      : /PGRST00[0-3]/.test(text)
        ? " The API could not reach the database."
        : status === 401 || status === 403
          ? " The key itself was refused: check VITE_SUPABASE_ANON_KEY."
          : "";
  return { ok: false, reason: `HTTP ${status}: ${shown || "(empty answer)"}.${hint}` };
}

/** GitHub disables scheduled workflows in a public repository after 60 days without activity.
 * The job fails (and GitHub emails) from this many days on, while there is still time to act. */
export const STALE_AFTER_DAYS = 45;
export const GITHUB_LIMIT_DAYS = 60;

/** Days since the last commit, and whether to warn. */
export function judgeLastCommit(lastCommitIso: string, now: Date): { days: number; warn: boolean; reason: string } {
  const last = new Date(lastCommitIso);
  if (Number.isNaN(last.getTime())) return { days: NaN, warn: true, reason: "The date of the last commit could not be read." };
  const days = Math.floor((now.getTime() - last.getTime()) / 86_400_000);
  if (days < STALE_AFTER_DAYS) return { days, warn: false, reason: `last commit ${days} day(s) ago` };
  return {
    days,
    warn: true,
    reason:
      `The last commit was ${days} days ago. GitHub stops scheduled workflows in a public repository after ` +
      `${GITHUB_LIMIT_DAYS} days without activity, and this keep-awake job would stop with it. ` +
      `Push any commit to main (for example a one-line note in docs/) to reset the count.`,
  };
}
