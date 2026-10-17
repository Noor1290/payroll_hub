// Settings for the safety-check scripts: where they come from and what is refused. Values are
// never printed; only whether each one was found.

/** Reads KEY=VALUE lines (the format of .env). Comments and blank lines are skipped; one pair of
 * surrounding quotes is removed. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** The Supabase project URL: https, and a host on supabase.co (or supabase.in). */
export function checkProjectUrl(url: string | undefined): string | null {
  if (!url) return "The project URL is missing (VITE_SUPABASE_URL).";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "The project URL is not a valid address (VITE_SUPABASE_URL).";
  }
  if (parsed.protocol !== "https:") return "The project URL must start with https:// (VITE_SUPABASE_URL).";
  if (!/\.supabase\.(co|in)$/.test(parsed.hostname)) {
    return "The project URL is not a supabase.co address (VITE_SUPABASE_URL).";
  }
  return null;
}

function jwtRole(token: string): string | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { role?: unknown };
    return typeof json.role === "string" ? json.role : null;
  } catch {
    return null;
  }
}

/**
 * The PUBLIC anon key, and nothing else. A service-role or secret key would bypass every
 * security rule, so a script given one refuses to start (and says so without printing it).
 */
export function checkAnonKey(key: string | undefined): string | null {
  if (!key) return "The public anon key is missing (VITE_SUPABASE_ANON_KEY).";
  if (key.startsWith("sb_secret_")) return "That is a SECRET key, not the public anon key. Refusing to run.";
  if (key.startsWith("sb_publishable_")) return null;
  const role = jwtRole(key);
  if (role === "anon") return null;
  if (role) return `That key has the role "${role}", not "anon". Refusing to run.`;
  return "The anon key is not in a recognised format (VITE_SUPABASE_ANON_KEY).";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The two TEST companies' ids, comma-separated: exactly two different UUIDs. */
export function parseTestCompanyIds(value: string | undefined): { ids: [string, string] } | { problem: string } {
  const parts = (value ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length !== 2) {
    return { problem: "TEST_COMPANY_IDS must hold the ids of exactly two companies, separated by a comma." };
  }
  if (!parts.every((part) => UUID.test(part))) return { problem: "TEST_COMPANY_IDS must hold two company ids (UUIDs)." };
  if (parts[0] === parts[1]) return { problem: "TEST_COMPANY_IDS names the same company twice." };
  return { ids: [parts[0]!, parts[1]!] };
}
