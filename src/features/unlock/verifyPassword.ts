import { createClient } from "@supabase/supabase-js";
import { env } from "@/config/env";
import { authFailure, classifyAuthError, type AuthFailure } from "@/features/auth/authErrors";
import { storageKey } from "@/lib/storage";

export interface GateUser {
  id: string;
  email: string;
  isDemo: boolean;
}

const WRONG_PASSWORD: AuthFailure = {
  kind: "invalid-credentials",
  title: "That password isn't right",
  message: "Try again. You are still signed in; only this area stays locked.",
};

/** Holds the throwaway session in memory, so the check never writes to browser storage. */
function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

let attempt = 0;

/**
 * Checks the signed-in user's password. Resolves to null when it is correct, or to a failure
 * to show. Never throws.
 *
 * It signs in again on a separate, throwaway Supabase client that keeps nothing: no persisted
 * session, no token refresh, its own in-memory storage and its own storage key. The main
 * client and its session are never touched. The extra session this creates on the server is
 * signed out straight away with scope "local", which ends ONLY that session (the default
 * scope would sign the user out everywhere, including here).
 *
 * The password is passed straight through to Supabase. It is never stored, logged or kept.
 */
export async function verifyPassword(
  user: GateUser,
  password: string,
): Promise<AuthFailure | null> {
  if (password === "") return WRONG_PASSWORD;

  // Dev-only demo account: there is no real password, so the word "demo" stands in for one.
  if (import.meta.env.DEV && user.isDemo) return password === "demo" ? null : WRONG_PASSWORD;

  if (!env.supabase) return authFailure("not-configured");
  if (!user.email.includes("@")) return authFailure("unknown");

  const temporary = createClient(env.supabase.url, env.supabase.anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storage: memoryStorage(),
      // A key of its own, so it can never read, overwrite or broadcast to the main session.
      storageKey: storageKey(`reauth-${++attempt}`),
    },
  });

  try {
    const { data, error } = await temporary.auth.signInWithPassword({
      email: user.email,
      password,
    });
    if (error) {
      const failure = classifyAuthError(error);
      return failure.kind === "invalid-credentials" ? WRONG_PASSWORD : failure;
    }

    const sameUser = data.user?.id === user.id;
    try {
      await temporary.auth.signOut({ scope: "local" });
    } catch {
      // The throwaway session will simply expire; the password check itself still stands.
    }
    return sameUser ? null : authFailure("unknown");
  } catch (error) {
    return classifyAuthError(error);
  }
}
