import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/config/env";
import { sessionScopedStorage, storageKey } from "@/lib/storage";

/**
 * The single Supabase client, created with the PUBLIC anon key only.
 * Row Level Security on the server decides what a signed-in user can see or change.
 *
 * The session lives in sessionStorage (namespaced), so it ends with the browser session and
 * is not left behind in localStorage, which every site on this origin shares.
 */
export const supabase: SupabaseClient | null = env.supabase
  ? createClient(env.supabase.url, env.supabase.anonKey, {
      auth: {
        storage: sessionScopedStorage,
        storageKey: storageKey("auth"),
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    })
  : null;
