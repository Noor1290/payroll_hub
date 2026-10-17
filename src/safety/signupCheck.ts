// The sign-up check: with only the public anon key, can a stranger make an account?
// Sign-ups are switched off in Supabase, so both attempts below must be refused.

import type { ApiError, Status } from "./outcome.ts";

export interface SignupAnswer {
  /** The account Supabase answered with, if any (only its presence matters). */
  userId?: string | null;
  error?: ApiError | null;
}

export interface SignupVerdict {
  status: Status;
  result: string;
}

/** Supabase's answers when sign-ups (or this kind of sign-in) are switched off. */
const OFF_CODES = new Set(["signup_disabled", "email_provider_disabled", "anonymous_provider_disabled"]);
const OFF_TEXT = /signups? not allowed|signups? (are )?disabled|anonymous sign-ins are disabled/i;

/** PASS only when Supabase says sign-ups are off. An account in the answer is a FAIL; any other
 * refusal (a bad address, a rate limit) does not prove that sign-ups are off, so it is UNCLEAR. */
export function judgeSignup(answer: SignupAnswer): SignupVerdict {
  if (answer.userId) {
    return { status: "FAIL", result: "AN ACCOUNT WAS CREATED: sign-ups are on. Delete it in Supabase (Authentication > Users)." };
  }
  const error = answer.error;
  if (!error) return { status: "UNCLEAR", result: "no account and no error: the answer is not understood" };
  if ((error.code && OFF_CODES.has(error.code)) || OFF_TEXT.test(error.message ?? "")) {
    return { status: "PASS", result: `refused (${error.code ?? error.message})` };
  }
  return {
    status: "UNCLEAR",
    result: `refused, but not because sign-ups are off (${error.code ?? "?"}: ${error.message ?? ""}). Check Authentication settings.`,
  };
}

/** A fake address on a domain reserved for examples (it can never reach a real person). */
export function fakeAddress(now: number, random: string): string {
  return `safety-check-${now}-${random}@example.com`;
}
