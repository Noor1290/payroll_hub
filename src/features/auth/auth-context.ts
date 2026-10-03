import { createContext, useContext } from "react";
import type { AuthFailure } from "./authErrors";

export interface AuthUser {
  id: string;
  email: string;
  isDemo: boolean;
}

export type AuthStatus = "loading" | "signed-in" | "signed-out";

/** Why the last session ended, when the user did not ask for it. */
export type SignOutNotice = "idle" | "expired";

export interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  notice: SignOutNotice | null;
  /** Resolves to null on success, or a failure to show. */
  signIn: (email: string, password: string) => Promise<AuthFailure | null>;
  /** Only defined in dev demo mode. */
  signInDemo: (() => void) | null;
  signOut: () => Promise<void>;
  clearNotice: () => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside <AuthProvider>.");
  return value;
}
