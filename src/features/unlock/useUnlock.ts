import { useCallback } from "react";
import { useAuth } from "@/features/auth/auth-context";
import { authFailure, type AuthFailure } from "@/features/auth/authErrors";
import { unlockMinutes } from "@/lib/preferences";
import { useStore } from "@/lib/store";
import { grantUnlock, lock, unlockState, type LockReason } from "@/lib/unlock";
import { verifyPassword, type GateUser } from "./verifyPassword";

/**
 * Verifies the password and, only if it is correct, opens the gate.
 * Resolves to null on success or to the failure to show; the gate stays locked on any failure.
 */
export async function attemptUnlock(
  user: GateUser | null,
  password: string,
  verify: typeof verifyPassword = verifyPassword,
): Promise<AuthFailure | null> {
  if (!user) return authFailure("unknown");
  const failure = await verify(user, password);
  if (failure === null) grantUnlock(unlockMinutes.get());
  return failure;
}

export interface Unlock {
  unlocked: boolean;
  /** Epoch milliseconds when it locks again; null while locked. */
  expiresAt: number | null;
  /** Why it locked last; null if it has not been unlocked yet. */
  lockedBy: LockReason | null;
  /** Resolves to null when the password was right, otherwise to what went wrong. */
  unlock: (password: string) => Promise<AuthFailure | null>;
  lock: () => void;
}

/**
 * The password gate, for any screen or action that should ask for the password first.
 * All users of this hook share one gate: unlocking in one place unlocks them all, for the
 * same fixed window. Use <PasswordGate> to protect a whole screen.
 */
export function useUnlock(): Unlock {
  const state = useStore(unlockState);
  const { user } = useAuth();
  const unlock = useCallback((password: string) => attemptUnlock(user, password), [user]);
  const lockNow = useCallback(() => lock("manual"), []);
  return { ...state, unlock, lock: lockNow };
}
