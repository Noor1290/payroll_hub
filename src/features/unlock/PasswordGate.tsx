import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { CircleAlert, LoaderCircle, Lock, LockKeyhole, LockKeyholeOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/features/auth/auth-context";
import type { AuthFailure } from "@/features/auth/authErrors";
import { unlockMinutes } from "@/lib/preferences";
import { useStore } from "@/lib/store";
import type { LockReason } from "@/lib/unlock";
import { useUnlock } from "./useUnlock";

const minutesText = (minutes: number) => (minutes === 1 ? "1 minute" : `${minutes} minutes`);

const LOCKED_BECAUSE: Partial<Record<LockReason, string>> = {
  timeout: "It locked again because the time was up.",
  hidden: "It locked again because this tab was in the background for more than two minutes.",
  manual: "You locked it.",
};

/**
 * The password field and its messages. Used by <PasswordGate> and anywhere else that needs
 * the user to unlock in place (for example a dialog).
 */
export function UnlockForm({ autoFocus = true }: { autoFocus?: boolean }) {
  const { unlock } = useUnlock();
  const { user } = useAuth();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const errorId = useId();

  useEffect(() => {
    if (failure) input.current?.focus();
  }, [failure]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || password === "") return;
    // Take the password out of the field and out of React state before doing anything else.
    // From here it only exists in this one call, and is gone when the call returns.
    const entered = password;
    setPassword("");
    setBusy(true);
    setFailure(null);
    const result = await unlock(entered);
    setBusy(false);
    setFailure(result);
  };

  return (
    <form onSubmit={onSubmit} className="space-y-3 text-left">
      {/* Lets password managers match the right account without showing a second field. */}
      <input
        type="text"
        name="username"
        autoComplete="username"
        value={user?.email ?? ""}
        readOnly
        hidden
      />
      <div className="space-y-2">
        <Label htmlFor={inputId}>Password</Label>
        <Input
          ref={input}
          id={inputId}
          type="password"
          name="password"
          autoComplete="current-password"
          autoFocus={autoFocus}
          required
          disabled={busy}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-invalid={failure !== null}
          aria-describedby={failure ? errorId : undefined}
        />
      </div>
      {failure && (
        <div
          id={errorId}
          role="alert"
          className="flex items-start gap-2.5 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
          <div>
            <p className="font-medium text-fg">{failure.title}</p>
            <p className="mt-0.5 text-muted">{failure.message}</p>
          </div>
        </div>
      )}
      <Button type="submit" variant="primary" className="w-full" disabled={busy || password === ""}>
        {busy ? (
          <LoaderCircle className="animate-spin" aria-hidden="true" />
        ) : (
          <LockKeyholeOpen aria-hidden="true" />
        )}
        {busy ? "Checking" : "Unlock"}
      </Button>
    </form>
  );
}

interface PasswordGateProps {
  /** What is behind the gate, completing "… shows national IDs and salary figures", e.g. "The data explorer". */
  what: string;
  children: ReactNode;
}

/**
 * Shows its children only after the user has confirmed their password, and hides them again
 * when the gate locks. Wrap any screen that shows sensitive stored data in this.
 *
 * It is a convenience layer for a shared or unattended screen, not a security boundary: what
 * a signed-in user can read is decided by the database's security rules.
 */
export function PasswordGate({ what, children }: PasswordGateProps) {
  const { unlocked, lockedBy } = useUnlock();
  const minutes = useStore(unlockMinutes);

  if (unlocked) return <>{children}</>;

  return (
    <section
      aria-labelledby="password-gate-title"
      className="glass mx-auto max-w-md rounded-2xl p-7 text-center sm:p-9"
    >
      <span className="mx-auto grid size-12 place-items-center rounded-full border border-accent/30 bg-accent/10">
        <LockKeyhole className="size-5 text-accent" aria-hidden="true" />
      </span>
      <h2 id="password-gate-title" className="mt-5 text-lg font-semibold">
        Confirm your password to continue
      </h2>
      <p className="mt-2 text-sm text-muted">
        {what} shows national IDs and salary figures. It stays open for {minutesText(minutes)}, then
        locks again. You stay signed in either way.
      </p>
      {lockedBy && LOCKED_BECAUSE[lockedBy] && (
        <p role="status" className="mt-2 text-sm text-subtle">
          {LOCKED_BECAUSE[lockedBy]}
        </p>
      )}
      <div className="mt-6">
        <UnlockForm />
      </div>
    </section>
  );
}

const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

/** Small "unlocked until 14:32" note with a Lock now button. Renders nothing while locked. */
export function UnlockStatus() {
  const { unlocked, expiresAt, lock } = useUnlock();
  if (!unlocked || expiresAt === null) return null;
  return (
    <div className="flex items-center gap-2 text-sm text-muted">
      <LockKeyholeOpen className="size-4 text-accent" aria-hidden="true" />
      <span>
        Unlocked until <time className="tabular text-fg">{clock.format(expiresAt)}</time>
      </span>
      <Button size="sm" onClick={lock}>
        <Lock aria-hidden="true" />
        Lock now
      </Button>
    </div>
  );
}
