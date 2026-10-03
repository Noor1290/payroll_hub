import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, LoaderCircle, Trash2, Undo2, Upload } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { PageHeader } from "@/components/PageHeader";
import { PayrollTable } from "@/components/PayrollTable";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Badge, Skeleton } from "@/components/ui/misc";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { useAuth } from "@/features/auth/auth-context";
import { CompanyGate } from "@/features/company/CompanyGate";
import { PasswordGate, UnlockStatus } from "@/features/unlock/PasswordGate";
import { formatCount, formatDateTime, formatPeriod } from "@/lib/format";
import { classifyDataError } from "@/lib/supabase/errors";
import { fetchRunEntries, fetchRuns, setRunStatus, softDeleteRun } from "@/lib/supabase/payroll";
import type { Membership, RunStatus, RunSummary } from "@/lib/supabase/schemas";

function RunGrid({ run }: { run: RunSummary }) {
  const { user } = useAuth();
  const query = useQuery({
    queryKey: ["run-entries", run.id, user?.id],
    queryFn: () => fetchRunEntries({ id: user!.id, isDemo: user!.isDemo }, run.id),
    enabled: user !== null,
  });

  if (query.isPending) {
    return (
      <div aria-busy="true" aria-label="Loading employees" className="space-y-2 p-3">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-9" />
        ))}
      </div>
    );
  }
  if (query.isError) {
    return (
      <ErrorState
        failure={classifyDataError(query.error)}
        onRetry={() => query.refetch()}
        className="m-3"
      />
    );
  }
  return (
    <PayrollTable rows={query.data} selectable caption={`${formatPeriod(run.period)} payroll`} />
  );
}

function RunView({ current, runs }: { current: Membership; runs: RunSummary[] }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const isAdmin = current.role === "admin";
  const viewer = { id: user!.id, isDemo: user!.isDemo };

  const run = runs.find((r) => r.id === params.get("run")) ?? runs[0]!;
  const label = formatPeriod(run.period);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["runs", current.company.id] }),
      queryClient.invalidateQueries({ queryKey: ["overview", current.company.id] }),
    ]);

  const statusMutation = useMutation({
    mutationFn: (status: RunStatus) => setRunStatus(viewer, run.id, status),
    onSuccess: async (_data, status) => {
      await refresh();
      toast.success(
        status === "approved" ? `${label} run approved` : `${label} run set back to draft`,
      );
    },
    onError: (error) => {
      const failure = classifyDataError(error);
      toast.error(failure.title, { description: failure.message });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => softDeleteRun(viewer, run.id),
    onSuccess: async () => {
      setConfirmingDelete(false);
      setParams({}, { replace: true });
      await refresh();
      toast.success(`${label} run deleted`);
    },
    onError: (error) => {
      setConfirmingDelete(false);
      const failure = classifyDataError(error);
      toast.error(failure.title, { description: failure.message });
    },
  });

  const nextStatus: RunStatus = run.status === "approved" ? "draft" : "approved";
  const busy = statusMutation.isPending || deleteMutation.isPending;

  return (
    <section className="glass flex min-h-0 flex-col rounded-2xl">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-line p-4">
        <label className="flex items-center gap-2 text-sm text-muted">
          Run
          <select
            value={run.id}
            onChange={(e) => setParams({ run: e.target.value }, { replace: true })}
            className="h-10 rounded-lg border border-line bg-surface px-3 text-sm font-medium text-fg shadow-inner-glow hover:border-line-strong"
          >
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {formatPeriod(r.period)} ({r.status})
              </option>
            ))}
          </select>
        </label>
        <Badge tone={run.status === "approved" ? "accent" : "warn"}>{run.status}</Badge>
        <p className="text-sm text-muted">
          <span className="tabular">{formatCount(run.entryCount)}</span>{" "}
          {run.entryCount === 1 ? "employee" : "employees"}
          {" · "}
          {run.createdBy === null
            ? "Created"
            : run.createdBy === user?.id
              ? "Created by you"
              : "Created by another user"}{" "}
          on <time dateTime={run.createdAt}>{formatDateTime(run.createdAt)}</time>
        </p>

        {/* Hidden for viewers as a courtesy; the database refuses these for non-admins regardless. */}
        {isAdmin && (
          <div className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => statusMutation.mutate(nextStatus)}>
              {statusMutation.isPending ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : nextStatus === "approved" ? (
                <CircleCheck aria-hidden="true" />
              ) : (
                <Undo2 aria-hidden="true" />
              )}
              {nextStatus === "approved" ? "Approve" : "Set back to draft"}
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={busy}
              onClick={() => setConfirmingDelete(true)}
            >
              <Trash2 aria-hidden="true" />
              Delete run
            </Button>
          </div>
        )}
      </div>

      <RunGrid key={run.id} run={run} />

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={`Delete the ${label} run?`}
        confirmLabel="Delete run"
        tone="danger"
        busy={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate()}
      >
        <p>
          The run and its {formatCount(run.entryCount)} entries will disappear from the dashboard
          for everyone in {current.company.name}.
        </p>
        <p>
          It is kept in the database, and importing {label} again will bring the run back with the
          new file's data.
        </p>
      </ConfirmDialog>
    </section>
  );
}

function CompanyExplorer({ current }: { current: Membership }) {
  const { user } = useAuth();
  const query = useQuery({
    queryKey: ["runs", current.company.id, user?.id],
    queryFn: () => fetchRuns({ id: user!.id, isDemo: user!.isDemo }, current.company.id),
    enabled: user !== null,
  });

  if (query.isPending) {
    return (
      <div aria-busy="true" aria-label="Loading runs" className="space-y-4">
        <Skeleton className="h-16 rounded-2xl" />
        <Skeleton className="h-96 rounded-2xl" />
      </div>
    );
  }
  if (query.isError) {
    return <ErrorState failure={classifyDataError(query.error)} onRetry={() => query.refetch()} />;
  }
  if (query.data.length === 0) {
    return (
      <div className="glass rounded-2xl">
        <EmptyState
          title="No payroll runs to explore yet"
          className="py-16"
          action={
            current.role === "admin" ? (
              <Button asChild variant="primary">
                <Link to="/import">
                  <Upload aria-hidden="true" />
                  Import a payroll file
                </Link>
              </Button>
            ) : undefined
          }
        >
          {current.role === "admin"
            ? `Import a payroll JSON export to create the first run for ${current.company.name}.`
            : "An admin needs to import a payroll export before anything shows here."}
        </EmptyState>
      </div>
    );
  }
  return <RunView current={current} runs={query.data} />;
}

export function ExplorerPage() {
  return (
    <>
      <PageHeader
        title="Data explorer"
        description="Browse a run's employees and figures. Sensitive columns stay hidden until you reveal them."
        actions={<UnlockStatus />}
      />
      <div className="mt-8">
        {/* Password first; masking with click-to-reveal still applies once it is open. */}
        <PasswordGate what="The data explorer">
          <CompanyGate>
            {(current) => <CompanyExplorer key={current.company.id} current={current} />}
          </CompanyGate>
        </PasswordGate>
      </div>
    </>
  );
}
