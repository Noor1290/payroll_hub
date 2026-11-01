import { useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Trash2, UserPlus, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FailureNote, FormDialog, FormField } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { ErrorState } from "@/components/ui/states";
import { useAuth } from "@/features/auth/auth-context";
import { UnlockForm } from "@/features/unlock/PasswordGate";
import { useUnlock } from "@/features/unlock/useUnlock";
import { formatDateTime } from "@/lib/format";
import {
  addMember,
  fetchMemberChanges,
  fetchMembers,
  MEMBER_ROLES,
  removeMember,
  setMemberRole,
  type Member,
  type MemberRole,
} from "@/lib/supabase/members";
import type { Membership } from "@/lib/supabase/schemas";
import { changeText, classifyMemberError, memberEmailSchema, type MemberFailure } from "./membersModel";

/**
 * The members of the selected company, for its admins: who they are, adding an existing user by
 * email, changing a role, removing someone, and every change made. The database applies all the
 * rules (migration 0021). Changing who belongs needs the password gate open, because it decides
 * who sees national IDs and pay. A member who is not an admin does not see this card at all.
 */

const ROLE_LABELS: Record<MemberRole, string> = { admin: "Admin", viewer: "Viewer" };

function RoleSelect({
  id,
  label,
  value,
  disabled,
  onChange,
}: {
  id?: string;
  label: string;
  value: MemberRole;
  disabled: boolean;
  onChange: (role: MemberRole) => void;
}) {
  return (
    <select
      id={id}
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as MemberRole)}
      className="h-9 rounded-lg border border-line bg-surface px-2 text-sm disabled:opacity-60"
    >
      {MEMBER_ROLES.map((role) => (
        <option key={role} value={role}>
          {ROLE_LABELS[role]}
        </option>
      ))}
    </select>
  );
}

export function MembersCard({ current }: { current: Membership }) {
  const { user } = useAuth();
  const { unlocked } = useUnlock();
  const queryClient = useQueryClient();
  const { company } = current;
  const admin = current.role === "admin";
  const viewer = user ? { id: user.id, isDemo: user.isDemo } : null;

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MemberRole>("viewer");
  const [emailError, setEmailError] = useState<string | undefined>();
  const [failure, setFailure] = useState<MemberFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);

  const members = useQuery({
    queryKey: ["company-members", company.id, user?.id],
    queryFn: () => fetchMembers(viewer!, company.id),
    enabled: admin && viewer !== null,
  });
  const changes = useQuery({
    queryKey: ["company-member-changes", company.id, user?.id],
    queryFn: () => fetchMemberChanges(viewer!, company.id),
    enabled: admin && viewer !== null,
  });

  if (!admin) return null;

  /** Runs one change. Whatever happens, the lists are read again: the database has the truth. */
  const change = async (work: () => Promise<void>, done: string): Promise<boolean> => {
    setBusy(true);
    setFailure(null);
    let worked = true;
    try {
      await work();
      toast.success(done);
    } catch (error) {
      setFailure(classifyMemberError(error));
      worked = false;
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["company-members", company.id] }),
      queryClient.invalidateQueries({ queryKey: ["company-member-changes", company.id] }),
    ]);
    setBusy(false);
    return worked;
  };

  const onAdd = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !viewer) return;
    const parsed = memberEmailSchema.safeParse(email);
    if (!parsed.success) {
      setEmailError(parsed.error.issues[0]?.message);
      return;
    }
    setEmailError(undefined);
    const added = await change(
      () => addMember(viewer, company.id, parsed.data, role),
      `${parsed.data} added to ${company.name}`,
    );
    if (added) setEmail("");
  };

  const heading = (
    <div className="flex items-center gap-3 border-b border-line px-5 py-4">
      <h2 id="profile-members" className="flex-1 font-semibold">
        Members
      </h2>
    </div>
  );

  if (members.isPending || changes.isPending) {
    return (
      <section aria-labelledby="profile-members" className="glass rounded-2xl">
        {heading}
        <div aria-busy="true" aria-label="Loading the members" className="space-y-2 p-4">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      </section>
    );
  }
  if (members.isError || changes.isError) {
    return (
      <section aria-labelledby="profile-members" className="glass rounded-2xl">
        {heading}
        <ErrorState
          failure={{
            kind: "unknown",
            retryable: true,
            ...classifyMemberError(members.error ?? changes.error),
          }}
          onRetry={() => void Promise.all([members.refetch(), changes.refetch()])}
          className="m-4"
        />
      </section>
    );
  }

  return (
    <section aria-labelledby="profile-members" className="glass rounded-2xl" data-testid="members-card">
      {heading}
      <p className="flex items-center gap-2.5 border-b border-line px-5 py-2.5 text-sm text-muted">
        <Users className="size-4 shrink-0 text-accent" aria-hidden="true" />
        Who can open {company.name}. Admins see and change everything here; viewers can't see this
        card.
      </p>

      <ul className="divide-y divide-line" aria-label="Members of this company">
        {members.data.map((member) => {
          const you = member.user_id === user?.id;
          return (
            <li key={member.user_id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="break-words">
                  {member.email}
                  {you && <span className="text-muted"> (you)</span>}
                </p>
                <p className="text-sm text-muted">Added {formatDateTime(member.added_at)}</p>
              </div>
              <RoleSelect
                label={`Role of ${member.email}`}
                value={member.role}
                disabled={busy || !unlocked || you}
                onChange={(next) =>
                  void change(
                    () => setMemberRole(viewer!, company.id, member.user_id, next),
                    `${member.email} is now ${ROLE_LABELS[next].toLowerCase()}`,
                  )
                }
              />
              {!you && (
                <Button
                  size="sm"
                  disabled={busy || !unlocked}
                  onClick={() => setRemoving(member)}
                  aria-label={`Remove ${member.email}`}
                >
                  <Trash2 aria-hidden="true" />
                  Remove
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      <div className="space-y-3 border-t border-line p-5">
        {failure && <FailureNote failure={{ kind: "unknown", retryable: false, ...failure }} />}
        {unlocked ? (
          <form onSubmit={onAdd} noValidate className="flex flex-wrap items-end gap-3">
            <div className="min-w-56 flex-1">
              <FormField label="Add an existing user by email" error={emailError}>
                {(control) => (
                  <Input
                    {...control}
                    value={email}
                    maxLength={300}
                    inputMode="email"
                    autoComplete="off"
                    disabled={busy}
                    onChange={(event) => {
                      setEmail(event.target.value);
                      setEmailError(undefined);
                    }}
                  />
                )}
              </FormField>
            </div>
            <RoleSelect label="Role of the new member" value={role} disabled={busy} onChange={setRole} />
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : (
                <UserPlus aria-hidden="true" />
              )}
              Add
            </Button>
          </form>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted">
              Confirm your password to add, change or remove members. They decide who sees national
              IDs and pay.
            </p>
            <UnlockForm />
          </div>
        )}
      </div>

      <div className="border-t border-line px-5 py-4">
        <h3 className="text-sm font-semibold">Changes</h3>
        {changes.data.length === 0 ? (
          <p className="mt-1 text-sm text-muted">No changes have been made here yet.</p>
        ) : (
          <ul className="mt-2 space-y-2 text-sm" aria-label="Changes to the members">
            {changes.data.map((one) => (
              <li key={one.id}>
                <span className="tabular text-muted">{formatDateTime(one.changed_at)}</span>{" "}
                {changeText(one)}
              </li>
            ))}
          </ul>
        )}
      </div>

      <FormDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        icon={Trash2}
        title={`Remove ${removing?.email ?? ""}?`}
        description={`They will no longer be able to open ${company.name}. You can add them again later.`}
      >
        <div className="mt-5 flex justify-end gap-2">
          <Dialog.Close asChild>
            <Button disabled={busy}>Cancel</Button>
          </Dialog.Close>
          <Button
            variant="primary"
            disabled={busy}
            onClick={async () => {
              const member = removing!;
              await change(
                () => removeMember(viewer!, company.id, member.user_id),
                `${member.email} removed from ${company.name}`,
              );
              setRemoving(null);
            }}
          >
            Remove
          </Button>
        </div>
      </FormDialog>
    </section>
  );
}
