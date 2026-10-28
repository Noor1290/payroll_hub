import { z } from "zod";
import { classifyDataError, isMissingTable } from "@/lib/supabase/errors";
import { MRA_MIGRATION } from "@/lib/supabase/mraReturns";

// The MRA details form on the Company profile (MraCard.tsx): its rules and its failure wording.

const phone = z
  .string()
  .trim()
  .regex(/^[0-9 +()-]{0,30}$/, "Use digits, spaces and + - ( ) only, at most 30.");

/** The same rules as the database's own checks, so a value it would refuse is caught here first. */
export const mraFormSchema = z.object({
  ern: z
    .string()
    .trim()
    .regex(
      /^[0-9A-Za-z]{0,20}$/,
      "Use letters and digits only, at most 20. Keep any leading zeros.",
    ),
  telephone: phone,
  mobile: phone,
  declarant: z.string().trim().max(120, "Use at most 120 characters."),
  email: z
    .string()
    .trim()
    .max(254, "Use at most 254 characters.")
    .regex(
      /^$|^[^@\s,;]+@[^@\s,;]+$/,
      "Enter an email address such as name@example.com, without spaces or commas.",
    ),
});

export interface MraFailure {
  title: string;
  message: string;
}

/** Why a read or a save failed, in words. Nothing about the values. */
export function classifyMraError(error: unknown): MraFailure {
  const message = (error as { message?: unknown } | null)?.message;
  const text = typeof message === "string" ? message : "";
  if (isMissingTable(error) || (error as { code?: unknown } | null)?.code === "PGRST202") {
    return {
      title: "MRA details aren't set up in the database yet",
      message: `The owner needs to run supabase/migrations/${MRA_MIGRATION} once in the Supabase SQL editor. Nothing is wrong with your account.`,
    };
  }
  if (text.includes("PH_STALE")) {
    return {
      title: "Someone else saved these details since you opened them",
      message: "Nothing was saved. Close this window and open it again to see what is saved now.",
    };
  }
  if (text.includes("PH_NOT_ADMIN")) {
    return {
      title: "Only an admin of this company can change these",
      message: "Nothing was saved.",
    };
  }
  if (text.includes("PH_INVALID_INPUT")) {
    return {
      title: "The database refused a value",
      message: `${text.replace(/^.*PH_INVALID_INPUT:?\s*/, "").slice(0, 200)}. Nothing was saved.`,
    };
  }
  const problem = classifyDataError(error);
  return { title: problem.title, message: problem.message };
}
