import { z } from "zod";
import { isMissingFunction, isMissingTable } from "@/lib/supabase/errors";
import { MEMBERS_MIGRATION, type MemberChange, type MemberRole } from "@/lib/supabase/members";

// The Members card on the Company profile (MembersCard.tsx): its rules and its wording.

/** The same rule as the database's own check, so an address it would refuse is caught here first. */
export const memberEmailSchema = z
  .string()
  .trim()
  .max(254, "Use at most 254 characters.")
  .regex(/^[^@\s]+@[^@\s]+$/, "Enter an email address such as name@example.com.");

export interface MemberFailure {
  title: string;
  message: string;
}

const NOTHING = "Nothing was changed.";

const WORDS: [string, MemberFailure][] = [
  [
    "PH_NO_ACCOUNT",
    {
      title: "No account uses this email",
      message: `Create the account in Supabase first, then add it here. ${NOTHING}`,
    },
  ],
  [
    "PH_ALREADY_MEMBER",
    { title: "This person is already a member", message: `Change their role below. ${NOTHING}` },
  ],
  [
    "PH_LAST_ADMIN",
    {
      title: "A company must keep at least one admin",
      message: `Make someone else an admin first. ${NOTHING}`,
    },
  ],
  [
    "PH_NOT_YOURSELF",
    {
      title: "You can't remove yourself or make yourself a viewer",
      message: `Another admin of this company can do it. ${NOTHING}`,
    },
  ],
  [
    "PH_NOT_FOUND",
    {
      title: "This person is no longer a member",
      message: `Someone else may have changed it. ${NOTHING}`,
    },
  ],
  ["PH_SAME_ROLE", { title: "They already have that role", message: NOTHING }],
  [
    "PH_NOT_ADMIN",
    { title: "Only an admin of this company can manage its members", message: NOTHING },
  ],
];

/** Why a read or a change failed, in words. */
export function classifyMemberError(error: unknown): MemberFailure {
  if (isMissingTable(error) || isMissingFunction(error)) {
    return {
      title: "Members aren't set up in the database yet",
      message: `The owner needs to run supabase/migrations/${MEMBERS_MIGRATION} once in the Supabase SQL editor. Nothing has been lost.`,
    };
  }
  const message = (error as { message?: unknown } | null)?.message;
  const text = typeof message === "string" ? message : "";
  return (
    WORDS.find(([code]) => text.includes(code))?.[1] ?? {
      title: "The dashboard could not reach the members",
      message: `Check your connection and try again. ${NOTHING}`,
    }
  );
}

/** "a@example.com added b@example.com as a viewer." */
export function changeText(change: MemberChange): string {
  const role = (one: MemberRole | null) => (one === "admin" ? "an admin" : "a viewer");
  const { changed_by_email: by, member_email: who } = change;
  switch (change.action) {
    case "added":
      return `${by} added ${who} as ${role(change.new_role)}.`;
    case "role-changed":
      return `${by} changed ${who} from ${role(change.old_role)} to ${role(change.new_role)}.`;
    case "removed":
      return `${by} removed ${who}, who was ${role(change.old_role)}.`;
  }
}
