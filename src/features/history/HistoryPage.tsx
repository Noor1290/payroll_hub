import { useQuery } from "@tanstack/react-query";
import { Send, Table2, Upload } from "lucide-react";
import { Link } from "react-router-dom";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Badge, Skeleton } from "@/components/ui/misc";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { useAuth } from "@/features/auth/auth-context";
import { CompanyGate } from "@/features/company/CompanyGate";
import { formatCount, formatDateTime, formatPeriod } from "@/lib/format";
import { classifyDataError } from "@/lib/supabase/errors";
import { fetchRuns } from "@/lib/supabase/payroll";
import type { Membership } from "@/lib/supabase/schemas";

const TH = "border-b border-line px-4 py-3 text-left text-xs font-medium text-muted";
const TD = "border-b border-line px-4 py-3";

function CompanyHistory({ current }: { current: Membership }) {
  const { user } = useAuth();
  const query = useQuery({
    queryKey: ["runs", current.company.id, user?.id],
    queryFn: () => fetchRuns({ id: user!.id, isDemo: user!.isDemo }, current.company.id),
    enabled: user !== null,
  });

  if (query.isPending) {
    return (
      <div aria-busy="true" aria-label="Loading runs" className="glass space-y-2 rounded-2xl p-4">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-11" />
        ))}
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
          title="No payroll runs yet"
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
          Each imported month appears here as one run.
        </EmptyState>
      </div>
    );
  }

  return (
    <section className="glass overflow-hidden rounded-2xl">
      <div className="max-h-[70vh] overflow-auto">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <caption className="sr-only">Payroll runs for {current.company.name}</caption>
          <thead>
            <tr>
              <th scope="col" className={TH}>
                Period
              </th>
              <th scope="col" className={TH}>
                Status
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Employees
              </th>
              <th scope="col" className={TH}>
                Created by
              </th>
              <th scope="col" className={TH}>
                Created
              </th>
              <th scope="col" className={`${TH} text-right`}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {query.data.map((run) => (
              <tr key={run.id} className="transition-colors hover:bg-surface-hover">
                <th scope="row" className={`${TD} text-left font-medium whitespace-nowrap`}>
                  {formatPeriod(run.period)}
                </th>
                <td className={TD}>
                  <Badge tone={run.status === "approved" ? "accent" : "warn"}>{run.status}</Badge>
                </td>
                <td className={`${TD} tabular text-right`}>{formatCount(run.entryCount)}</td>
                <td className={`${TD} whitespace-nowrap text-muted`}>
                  {run.createdBy === null
                    ? "Unknown"
                    : run.createdBy === user?.id
                      ? "You"
                      : "Another user"}
                </td>
                <td className={`${TD} whitespace-nowrap text-muted`}>
                  <time dateTime={run.createdAt}>{formatDateTime(run.createdAt)}</time>
                </td>
                <td className={`${TD} text-right whitespace-nowrap`}>
                  <span className="inline-flex gap-2">
                    <Button asChild size="sm">
                      <Link
                        to={`/explorer?run=${run.id}`}
                        aria-label={`Open the ${formatPeriod(run.period)} run in the explorer`}
                      >
                        <Table2 aria-hidden="true" />
                        Open
                      </Link>
                    </Button>
                    <Button asChild size="sm" variant="ghost">
                      <Link
                        to={`/transfer?run=${run.id}`}
                        aria-label={`Send the ${formatPeriod(run.period)} run to an app`}
                      >
                        <Send aria-hidden="true" />
                        Send
                      </Link>
                    </Button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function HistoryPage() {
  return (
    <>
      <PageHeader title="History" description="Every payroll run for the selected company." />
      <div className="mt-8">
        <CompanyGate>
          {(current) => <CompanyHistory key={current.company.id} current={current} />}
        </CompanyGate>
      </div>
    </>
  );
}
