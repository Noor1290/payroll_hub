// The keep-awake job (.github/workflows/keep-awake.yml): one small, real database request every
// two days, so the free Supabase project is not paused for inactivity.
//
// The request calls public.keep_awake() (migration 0015) with the public anon key. The function
// reads no table and answers true. It is the only function open to anon: every other one is
// closed to it. A paused or broken project, a wrong key or a missing 0015 answers anything but
// HTTP 200 with true, and the job fails.

export const PING_FUNCTION = "keep_awake";
export const PING_MIGRATION = "0015_keep_awake.sql";

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
      body: "{}",
    },
  };
}

/** OK only for HTTP 200 answering true: the database ran the function. Anything else (a paused
 * project, a wrong key, a missing migration) is a failure, with a short reason. */
export function judgePing(status: number, body: string): { ok: boolean; reason: string } {
  const text = body.trim();
  if (status === 200 && text === "true") return { ok: true, reason: "the database answered" };
  const shown = text.length > 200 ? `${text.slice(0, 199)}…` : text;
  const hint =
    status === 540 || /paused/i.test(text)
      ? " The project looks PAUSED: restore it in the Supabase dashboard."
      : /PGRST202/.test(text)
        ? ` The function is missing: run supabase/migrations/${PING_MIGRATION} in the SQL editor.`
        : /PGRST00[0-3]/.test(text)
          ? " The API could not reach the database."
          : status === 401 || status === 403
            ? " The key was refused, or anon may no longer call keep_awake(): check VITE_SUPABASE_ANON_KEY and 0015."
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
