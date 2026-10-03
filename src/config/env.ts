// First, so the validator is configured before this module validates the environment below.
import "@/zodConfig";
import { z } from "zod";

export const DEFAULT_IDLE_TIMEOUT_MINUTES = 15;

const blankToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const envSchema = z.object({
  VITE_SUPABASE_URL: z.preprocess(blankToUndefined, z.url().optional()),
  VITE_SUPABASE_ANON_KEY: z.preprocess(blankToUndefined, z.string().trim().min(20).optional()),
  VITE_IDLE_TIMEOUT_MINUTES: z.preprocess(
    blankToUndefined,
    z.coerce.number().min(0).max(1440).optional(),
  ),
});

export interface AppEnv {
  /** Present only when both the URL and the public anon key are set and well-formed. */
  supabase: { url: string; anonKey: string } | null;
  /** 0 disables idle sign-out. */
  idleTimeoutMinutes: number;
  /** Human-readable problems with the env vars, safe to show on the login screen. */
  problems: string[];
}

export function parseEnv(raw: Record<string, unknown>): AppEnv {
  const problems: string[] = [];
  const parsed = envSchema.safeParse(raw);

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      problems.push(`${issue.path.join(".")} is not valid.`);
    }
    return { supabase: null, idleTimeoutMinutes: DEFAULT_IDLE_TIMEOUT_MINUTES, problems };
  }

  const { VITE_SUPABASE_URL: url, VITE_SUPABASE_ANON_KEY: anonKey } = parsed.data;
  if (!url) problems.push("VITE_SUPABASE_URL is not set.");
  if (!anonKey) problems.push("VITE_SUPABASE_ANON_KEY is not set.");

  return {
    supabase: url && anonKey ? { url, anonKey } : null,
    idleTimeoutMinutes: parsed.data.VITE_IDLE_TIMEOUT_MINUTES ?? DEFAULT_IDLE_TIMEOUT_MINUTES,
    problems,
  };
}

export const env: AppEnv = parseEnv(import.meta.env);

/**
 * Demo mode: fake data and a fake sign-in for exploring the UI without Supabase.
 * `import.meta.env.DEV` is replaced with the literal `false` in production builds, so this
 * constant is always false there and every demo branch is removed as dead code.
 */
export const DEMO_MODE: boolean = import.meta.env.DEV && import.meta.env.VITE_DEMO_MODE === "true";
