import { useId, useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, LoaderCircle, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/misc";
import { ErrorState } from "@/components/ui/states";
import { useAuth } from "@/features/auth/auth-context";
import { UnlockForm } from "@/features/unlock/PasswordGate";
import { useUnlock } from "@/features/unlock/useUnlock";
import { formatCount, formatPeriod } from "@/lib/format";
import { classifyDataError } from "@/lib/supabase/errors";
import type { Membership } from "@/lib/supabase/schemas";
import { useCompany } from "./company-context";
import {
  classifyDeleteCompanyError,
  deleteCompany,
  fetchDeletePreview,
  forgetCompany,
  nameMatches,
  type DeleteCompanyFailure,
  type DeletePreview,
} from "./deleteCompany";

const MAX_PERIODS_SHOWN = 12;
const plural = (n: number, one: string, many = `${one}s`) =>
  `${formatCount(n)} ${n === 1 ? one : many}`;

function WhatGoes({ preview }: { preview: DeletePreview }) {
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm text-fg">
      <li>{plural(preview.employees, "employee")}</li>
      <li>{plural(preview.runs, "payroll run")}</li>
      <li>{plural(preview.entries, "payroll entry", "payroll entries")}</li>
      {preview.details > 0 && <li>{plural(preview.details, "company detail")}</li>}
      {preview.links > 0 && <li>{plural(preview.links, "link")}</li>}
      <li>
        {preview.otherMembers === 0
          ? "your own access (nobody else has access)"
          : `access for you and ${plural(preview.otherMembers, "other person", "other people")}`}
      </li>
    </ul>
  );
}

function Blocked({ preview }: { preview: DeletePreview }) {
  const { approved } = preview;
  const deleted = approved.filter((run) => run.deleted).length;
  return (
    <div role="alert" className="rounded-xl border border-danger/30 bg-danger/10 p-4 text-sm">
      <p className="flex items-center gap-2 font-medium text-fg">
        <CircleAlert className="size-4 shrink-0 text-danger" aria-hidden="true" />
        This company can't be deleted while it has {plural(approved.length, "approved run")}
      </p>
      <ul className="mt-2 list-disc space-y-0.5 pl-9 text-muted">
        {approved.slice(0, MAX_PERIODS_SHOWN).map((run) => (
          <li key={run.period}>
            {formatPeriod(run.period)}
            {run.deleted && " (a deleted run)"}
          </li>
        ))}
        {approved.length > MAX_PERIODS_SHOWN && (
          <li>and {formatCount(approved.length - MAX_PERIODS_SHOWN)} more</li>
        )}
      </ul>
      <p className="mt-2 text-muted">
        Set each one back to draft in the Data explorer, then come back here.
        {deleted > 0 &&
          " A deleted run doesn't appear there: import that month again, which brings it back as a draft, or change it in the Supabase SQL editor."}
      </p>
    </div>
  );
}

function ConfirmDelete({
  membership,
  preview,
  onClose,
}: {
  membership: Membership;
  preview: DeletePreview;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const { memberships, select } = useCompany();
  const queryClient = useQueryClient();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<DeleteCompanyFailure | null>(null);
  const inputId = useId();
  const noteId = useId();
  const { company } = membership;
  const matches = nameMatches(typed, company.name);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !matches || !user) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await deleteCompany({ id: user.id, isDemo: user.isDemo }, company, typed);
      const next = memberships.find((m) => m.company.id !== company.id);
      // Nothing about the deleted company stays in memory or in this browser.
      forgetCompany(company.id);
      if (next) select(next.company.id);
      toast.success(`${company.name} deleted`, {
        description: `Removed ${plural(result.employees, "employee")}, ${plural(result.runs, "run")} and ${plural(result.entries, "entry", "entries")}.`,
      });
      onClose();
      await queryClient.invalidateQueries({ queryKey: ["memberships"] });
    } catch (error) {
      setFailure(classifyDeleteCompanyError(error));
      setBusy(false);
      // What blocks it may have changed (for example a run was approved meanwhile).
      void queryClient.invalidateQueries({ queryKey: ["delete-preview", company.id] });
    }
  };

  return (
    <form onSubmit={onSubmit} className="mt-5 space-y-4">
      <div className="rounded-xl border border-line bg-surface p-4">
        <p className="mb-2 text-sm text-muted">This permanently removes, including deleted rows:</p>
        <WhatGoes preview={preview} />
      </div>

      <p className="flex items-start gap-2.5 text-sm font-medium text-danger">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        This cannot be undone from the dashboard. The only way back is a database backup.
      </p>

      <div className="space-y-2">
        <Label htmlFor={inputId}>
          Type <span className="font-semibold text-fg">{company.name}</span> to confirm
        </Label>
        <Input
          id={inputId}
          value={typed}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          disabled={busy}
          aria-invalid={failure?.nameField === true}
          aria-describedby={noteId}
          onChange={(event) => {
            setTyped(event.target.value);
            setFailure(null);
          }}
        />
        <p id={noteId} className="text-sm text-muted">
          The name must match exactly, including capital letters.
        </p>
      </div>

      {failure && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-danger/30 bg-danger/10 p-3.5 text-sm"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
          <div>
            <p className="font-medium text-fg">{failure.title}</p>
            <p className="mt-1 text-muted">{failure.message}</p>
          </div>
        </div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Dialog.Close asChild>
          <Button disabled={busy}>Cancel</Button>
        </Dialog.Close>
        <Button type="submit" variant="danger" disabled={busy || !matches}>
          {busy ? (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          ) : (
            <Trash2 aria-hidden="true" />
          )}
          {busy ? "Deleting" : "Delete this company"}
        </Button>
      </div>
    </form>
  );
}

function DeleteCompanyBody({
  membership,
  onClose,
}: {
  membership: Membership;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const { unlocked } = useUnlock();
  const { company } = membership;

  const preview = useQuery({
    queryKey: ["delete-preview", company.id, user?.id],
    queryFn: () => fetchDeletePreview({ id: user!.id, isDemo: user!.isDemo }, company.id),
    // Only once the password is confirmed, and always fresh: this decides a permanent action.
    enabled: unlocked && user !== null,
    staleTime: 0,
    gcTime: 0,
  });

  if (!unlocked) {
    return (
      <div className="mt-5 space-y-4">
        <p className="text-sm text-muted">
          Confirm your password to continue. Deleting a company is behind the same lock as the other
          sensitive areas.
        </p>
        <UnlockForm />
        <div className="flex justify-end">
          <Dialog.Close asChild>
            <Button>Cancel</Button>
          </Dialog.Close>
        </div>
      </div>
    );
  }

  if (preview.isPending) {
    return (
      <div aria-busy="true" aria-label="Checking what would be deleted" className="mt-5 space-y-3">
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-11" />
      </div>
    );
  }
  if (preview.isError) {
    return (
      <div className="mt-5 space-y-4">
        <ErrorState
          failure={classifyDataError(preview.error)}
          onRetry={() => void preview.refetch()}
          className="py-8"
        />
        <div className="flex justify-end">
          <Dialog.Close asChild>
            <Button>Close</Button>
          </Dialog.Close>
        </div>
      </div>
    );
  }

  if (preview.data.approved.length > 0) {
    return (
      <div className="mt-5 space-y-4">
        <Blocked preview={preview.data} />
        <div className="flex justify-end">
          <Dialog.Close asChild>
            <Button>Close</Button>
          </Dialog.Close>
        </div>
      </div>
    );
  }

  return <ConfirmDelete membership={membership} preview={preview.data} onClose={onClose} />;
}

/**
 * The "Danger zone" in Settings: permanently delete the selected company.
 * Shown only to an admin of that company. That is a courtesy; the database function checks
 * the caller's role itself (migration 0004).
 */
export function DeleteCompanySection() {
  const { current, isAdmin } = useCompany();
  const [open, setOpen] = useState(false);
  const headingId = useId();

  if (!current || !isAdmin) return null;
  const { company } = current;

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-2xl border border-danger/40 bg-danger/5"
    >
      <div className="flex items-center gap-3 border-b border-danger/30 px-5 py-4">
        <TriangleAlert className="size-4 text-danger" aria-hidden="true" />
        <h2 id={headingId} className="font-semibold">
          Danger zone
        </h2>
      </div>
      <div className="space-y-4 p-5">
        <p className="text-sm text-muted">
          Deleting <span className="font-medium text-fg">{company.name}</span> permanently removes
          the company with all of its employees, payroll runs and entries, and everyone's access to
          it. It cannot be undone from the dashboard.
        </p>
        <Button variant="danger" onClick={() => setOpen(true)}>
          <Trash2 aria-hidden="true" />
          Delete {company.name}…
        </Button>
      </div>

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />
          <Dialog.Content
            role="alertdialog"
            className="fixed top-1/2 left-1/2 z-50 max-h-[92vh] w-[min(92vw,30rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-danger/40 bg-elevated p-6 shadow-pop outline-none"
          >
            <div className="flex items-start gap-4">
              <span className="grid size-11 shrink-0 place-items-center rounded-full border border-danger/30 bg-danger/10">
                <Trash2 className="size-5 text-danger" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <Dialog.Title className="text-lg font-semibold">
                  Delete {company.name}?
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-sm text-muted">
                  The company and everything stored for it will be removed for good.
                </Dialog.Description>
              </div>
            </div>
            {/* Mounted only while open, so the typed name never lingers. */}
            <DeleteCompanyBody
              key={company.id}
              membership={current}
              onClose={() => setOpen(false)}
            />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
