import { useState } from "react";
import { ArrowLeftRight, ArrowRight, LoaderCircle, RotateCw, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/misc";
import { EmptyState } from "@/components/ui/states";
import { Tooltip } from "@/components/ui/tooltip";
import { retryTransfer } from "@/features/workspace/deliver";
import { formatCount } from "@/lib/format";
import { useStore } from "@/lib/store";
import { clearTransferLog, transferLog, type TransferLogEntry } from "./transferLog";

const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
const SELECT =
  "h-9 rounded-lg border border-line bg-surface px-2.5 text-sm text-fg shadow-inner-glow hover:border-line-strong";
const TH = "border-b border-line px-4 py-3 text-left text-xs font-medium text-muted";
const TD = "border-b border-line px-4 py-3";

export function StatusBadge({ entry }: { entry: TransferLogEntry }) {
  if (entry.status === "delivered") return <Badge tone="accent">Delivered</Badge>;
  if (entry.status === "failed") return <Badge tone="danger">Failed</Badge>;
  return (
    <Badge tone="warn">
      <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
      Sending
    </Badge>
  );
}

function retry(entry: TransferLogEntry) {
  if (!retryTransfer(entry.id)) {
    toast.error("That data is no longer in memory", {
      description: "Start the transfer again from its source.",
    });
  }
}

function LogIllustration() {
  return (
    <svg viewBox="0 0 120 80" fill="none" aria-hidden="true" className="h-20 w-30">
      <rect x="10" y="26" width="30" height="28" rx="6" stroke="var(--line-strong)" />
      <rect x="80" y="26" width="30" height="28" rx="6" stroke="var(--line-strong)" />
      <path d="M44 40h32" stroke="var(--accent)" strokeDasharray="4 4" />
      <path
        d="m70 34 6 6-6 6"
        stroke="var(--accent)"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function TransferLogPage() {
  const entries = useStore(transferLog);
  const [status, setStatus] = useState<"all" | TransferLogEntry["status"]>("all");
  const [appId, setAppId] = useState("all");

  const apps = [...new Map(entries.map((entry) => [entry.toAppId, entry.toName]))];
  const shown = entries.filter(
    (entry) =>
      (status === "all" || entry.status === status) && (appId === "all" || entry.toAppId === appId),
  );

  return (
    <>
      <PageHeader
        title="Transfer log"
        description="What was sent where during this session. It lists no payroll values, lives in memory only, and is emptied when you sign out."
        actions={
          entries.length > 0 && (
            <Button onClick={clearTransferLog}>
              <Trash2 aria-hidden="true" />
              Clear log
            </Button>
          )
        }
      />

      <div className="mt-8">
        {entries.length === 0 ? (
          <div className="glass rounded-2xl">
            <EmptyState
              illustration={<LogIllustration />}
              title="No transfers yet in this session"
              className="py-16"
              action={
                <Button asChild variant="primary">
                  <Link to="/transfer">
                    <ArrowLeftRight aria-hidden="true" />
                    Start a transfer
                  </Link>
                </Button>
              }
            >
              Every send to an app is listed here, with whether the app confirmed it.
            </EmptyState>
          </div>
        ) : (
          <section className="glass overflow-hidden rounded-2xl">
            <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
              <select
                aria-label="Filter by status"
                className={SELECT}
                value={status}
                onChange={(event) => setStatus(event.target.value as typeof status)}
              >
                <option value="all">Any status</option>
                <option value="delivered">Delivered</option>
                <option value="failed">Failed</option>
                <option value="sending">Sending</option>
              </select>
              <select
                aria-label="Filter by destination"
                className={SELECT}
                value={appId}
                onChange={(event) => setAppId(event.target.value)}
              >
                <option value="all">Any destination</option>
                {apps.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
              <p className="ml-auto text-sm text-muted" aria-live="polite">
                <span className="tabular">{formatCount(shown.length)}</span> of{" "}
                <span className="tabular">{formatCount(entries.length)}</span>
              </p>
            </div>

            <div className="max-h-[65vh] overflow-auto">
              <table className="w-full border-separate border-spacing-0 text-sm">
                <caption className="sr-only">Transfers in this session, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col" className={TH}>
                      Time
                    </th>
                    <th scope="col" className={TH}>
                      From and to
                    </th>
                    <th scope="col" className={`${TH} text-right`}>
                      Rows
                    </th>
                    <th scope="col" className={TH}>
                      Result
                    </th>
                    <th scope="col" className={`${TH} text-right`}>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((entry) => (
                    <tr key={entry.id} className="transition-colors hover:bg-surface-hover">
                      <td className={`${TD} tabular whitespace-nowrap text-muted`}>
                        <time dateTime={new Date(entry.at).toISOString()}>
                          {clock.format(entry.at)}
                        </time>
                      </td>
                      <td className={`${TD} whitespace-nowrap`}>
                        <span className="inline-flex items-center gap-2 font-medium">
                          {entry.from}
                          <ArrowRight className="size-3.5 text-subtle" aria-label="to" />
                          {entry.toName}
                        </span>
                      </td>
                      <td className={`${TD} tabular text-right`}>{formatCount(entry.rowCount)}</td>
                      <td className={TD}>
                        <span className="flex flex-wrap items-center gap-2">
                          <StatusBadge entry={entry} />
                          {entry.reason && <span className="text-muted">{entry.reason}</span>}
                          {entry.attempts > 1 && (
                            <span className="text-xs text-subtle">{entry.attempts} attempts</span>
                          )}
                        </span>
                      </td>
                      <td className={`${TD} text-right whitespace-nowrap`}>
                        {entry.status === "failed" &&
                          (entry.canRetry ? (
                            <Button size="sm" onClick={() => retry(entry)}>
                              <RotateCw aria-hidden="true" />
                              Retry
                            </Button>
                          ) : (
                            <Tooltip label="The data is no longer in memory. Start the transfer again from its source.">
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-disabled="true"
                                className="cursor-not-allowed opacity-60"
                              >
                                <RotateCw aria-hidden="true" />
                                Retry
                              </Button>
                            </Tooltip>
                          ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {shown.length === 0 && (
                <EmptyState title="Nothing matches these filters" className="py-10" />
              )}
            </div>
          </section>
        )}
      </div>
    </>
  );
}
