import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { DEMO_MODE } from "@/config/env";
import { startIdleWatcher } from "@/lib/idle";
import { IDLE_SIGN_OUT_ENABLED, idleMinutes } from "@/lib/preferences";
import { runSessionCleanup } from "@/lib/sessionCleanup";
import { sessionScopedStorage } from "@/lib/storage";
import { useStore } from "@/lib/store";
import { supabase } from "@/lib/supabase/client";
import {
  AuthContext,
  type AuthContextValue,
  type AuthStatus,
  type AuthUser,
  type SignOutNotice,
} from "./auth-context";
import { authFailure, classifyAuthError } from "./authErrors";

const DEMO_SESSION_KEY = "demo-session";
const DEMO_USER: AuthUser = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "demo@payroll-hub.example",
  isDemo: true,
};

function hasDemoSession(): boolean {
  return import.meta.env.DEV && DEMO_MODE && sessionScopedStorage.getItem(DEMO_SESSION_KEY) === "1";
}

function userFromSession(session: Session | null): AuthUser | null {
  if (!session) return null;
  return { id: session.user.id, email: session.user.email ?? "Signed in", isDemo: false };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // The demo flag and a missing client are known synchronously; only a real session needs a check.
  const [user, setUser] = useState<AuthUser | null>(() =>
    import.meta.env.DEV && hasDemoSession() ? DEMO_USER : null,
  );
  const [status, setStatus] = useState<AuthStatus>(() =>
    hasDemoSession() ? "signed-in" : supabase ? "loading" : "signed-out",
  );
  const [notice, setNotice] = useState<SignOutNotice | null>(null);
  // True while a sign-out we started ourselves is in flight, so the auth listener
  // can tell it apart from a session that expired underneath the user.
  const expectedSignOut = useRef(false);
  const hadSession = useRef(false);
  useEffect(() => {
    hadSession.current = user !== null;
  }, [user]);

  const applySignedOut = useCallback((why: SignOutNotice | null) => {
    runSessionCleanup();
    setUser(null);
    setStatus("signed-out");
    if (why) setNotice(why);
  }, []);

  useEffect(() => {
    if (!supabase || hasDemoSession()) return;

    let active = true;
    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!active) return;
        const next = userFromSession(data.session);
        setUser(next);
        setStatus(next ? "signed-in" : "signed-out");
      })
      .catch(() => {
        if (active) setStatus("signed-out");
      });

    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      if (event === "SIGNED_OUT") {
        // Our own sign-outs are finished by endSession; anything else means the
        // session expired or was revoked underneath the user.
        if (!expectedSignOut.current) applySignedOut(hadSession.current ? "expired" : null);
        return;
      }
      if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED" || event === "USER_UPDATED") {
        const next = userFromSession(session);
        if (next) {
          setUser(next);
          setStatus("signed-in");
        }
      }
    });

    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [applySignedOut]);

  const endSession = useCallback(
    async (why: SignOutNotice | null) => {
      if (DEMO_MODE) sessionScopedStorage.removeItem(DEMO_SESSION_KEY);
      if (supabase) {
        expectedSignOut.current = true;
        try {
          // "local" clears this browser's session even when the server is unreachable.
          await supabase.auth.signOut({ scope: "local" });
        } catch {
          // The local session is dropped below regardless.
        }
        expectedSignOut.current = false;
      }
      applySignedOut(why);
    },
    [applySignedOut],
  );

  const signedIn = status === "signed-in";
  const idleTimeout = useStore(idleMinutes);
  useEffect(() => {
    if (!signedIn) return;
    return startIdleWatcher({
      timeoutMs: IDLE_SIGN_OUT_ENABLED ? idleTimeout * 60_000 : 0,
      onIdle: () => void endSession("idle"),
    });
  }, [signedIn, endSession, idleTimeout]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      notice,
      async signIn(email, password) {
        if (!supabase) return authFailure("not-configured");
        try {
          const { data, error } = await supabase.auth.signInWithPassword({ email, password });
          if (error) return classifyAuthError(error);
          const next = userFromSession(data.session);
          if (!next) return authFailure("unknown");
          setNotice(null);
          setUser(next);
          setStatus("signed-in");
          return null;
        } catch (error) {
          return classifyAuthError(error);
        }
      },
      signInDemo:
        import.meta.env.DEV && DEMO_MODE
          ? () => {
              sessionScopedStorage.setItem(DEMO_SESSION_KEY, "1");
              setNotice(null);
              setUser(DEMO_USER);
              setStatus("signed-in");
            }
          : null,
      signOut: () => endSession(null),
      clearNotice: () => setNotice(null),
    }),
    [status, user, notice, endSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
