import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Database, Inbox, ListChecks, LoaderCircle, Send, ShieldAlert } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusDot } from "@/components/ui/misc";
import { appsAccepting, getApp, PAYROLL_RESULT } from "@/config/apps.config";
import { toExportRow } from "@/config/payrollFields";
import { useAuth } from "@/features/auth/auth-context";
import { useCompany } from "@/features/company/company-context";
import { importInbox } from "@/features/import/importInbox";
import { heldBatch } from "@/features/transfer/transferSource";
import { parsePayrollRows } from "@/features/import/parsePayroll";
import { dataRequests, incomingBatches, useAppHealth } from "@/lib/bridge/bridge";
import type { DataRequest, IncomingBatch } from "@/lib/bridge/bridge";
import type { ResponseDataPayload } from "@/lib/bridge/protocol";
import { formatCount, formatPeriod } from "@/lib/format";
import { classifyDataError } from "@/lib/supabase/errors";
import { fetchRunEntries, fetchRuns } from "@/lib/supabase/payroll";
import { useStore } from "@/lib/store";
import { isUnlocked } from "@/lib/unlock";
import { UnlockForm } from "@/features/unlock/PasswordGate";
import { useUnlock } from "@/features/unlock/useUnlock";
import { exchangeContext } from "./appData";
import { deliver } from "./deliver";
import { healthView } from "./health";

const OVERLAY = "fixed inset-0 z-40 bg-black/60 backdrop-blur-sm";
const CONTENT =
  "fixed top-1/2 left-1/2 z-50 w-[min(92vw,30rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line-strong bg-elevated p-6 shadow-pop outline-none";

const timeFormat = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

/** Shown when an app (the payroll app) sends results to the dashboard. */
function IncomingDialog({ batch }: { batch: IncomingBatch }) {
  const navigate = useNavigate();
  const health = useAppHealth();
  const { memberships } = useCompany();
  const sender = getApp(batch.appId);
  const { dataType, rows, meta } = batch.payload;
  const isPayroll = dataType === PAYROLL_RESULT;
  const canImport = isPayroll && memberships.some((m) => m.role === "admin");
  const targets = appsAccepting(dataType, batch.appId);
  const count = formatCount(rows.length);

  const dismiss = () => incomingBatches.set((all) => all.filter((b) => b.id !== batch.id));

  /** Hands the data to the transfer wizard, to pick rows and columns and map them first. */
  const choose = () => {
    heldBatch.set(batch);
    dismiss();
    navigate("/transfer");
  };

  const save = () => {
    importInbox.set((items) => [
      ...items,
      {
        label: `From ${sender?.name ?? batch.appId}, ${timeFormat.format(batch.receivedAt)}`,
        parsed: parsePayrollRows(rows),
        month: meta?.period,
      },
    ]);
    dismiss();
    navigate("/import");
  };

  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY} />
        <Dialog.Content
          className={CONTENT}
          // Received payroll data should not vanish because of a stray click or Esc.
          onEscapeKeyDown={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <div className="flex items-start gap-4">
            <span className="grid size-11 shrink-0 place-items-center rounded-full border border-accent/30 bg-accent/10">
              <Inbox className="size-5 text-accent" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <Dialog.Title className="text-lg font-semibold">
                {isPayroll
                  ? `Payroll results received (${count} ${rows.length === 1 ? "employee" : "employees"})`
                  : `Data received (${count} rows)`}
              </Dialog.Title>
              <Dialog.Description className="mt-1.5 text-sm text-muted">
                From {sender?.name ?? batch.appId}
                {meta?.period && ` for ${formatPeriod(`${meta.period}-01`)}`}. It is held in memory
                only until you choose what to do with it.
              </Dialog.Description>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={dismiss}>
              Dismiss
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button disabled={targets.length === 0}>
                  <Send aria-hidden="true" />
                  Send to…
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72">
                <DropdownMenuLabel>Apps that accept this data</DropdownMenuLabel>
                {targets.map((app) => {
                  const view = healthView(health[app.id]);
                  const ready = health[app.id] === "ready";
                  return (
                    <DropdownMenuItem
                      key={app.id}
                      disabled={!ready}
                      onSelect={() =>
                        void deliver(
                          app.id,
                          { dataType, rows, meta },
                          { source: { label: sender?.name ?? batch.appId, gated: false } },
                        )
                      }
                    >
                      <StatusDot tone={view.tone} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-fg">{app.name}</span>
                        {!ready && (
                          <span className="block truncate text-xs text-subtle">{view.label}</span>
                        )}
                      </span>
                    </DropdownMenuItem>
                  );
                })}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={choose}>
                  <ListChecks aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-fg">Choose rows and columns…</span>
                    <span className="block text-xs text-subtle">Open the transfer wizard</span>
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {canImport && (
              <Button variant="primary" onClick={save}>
                <Database aria-hidden="true" />
                Save to database
              </Button>
            )}
          </div>
          {isPayroll && !canImport && (
            <p className="mt-3 text-right text-xs text-subtle">
              Saving to the database needs an admin role.
            </p>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Shown when an app asks the dashboard for saved data. Nothing is sent without the user's say-so. */
function RequestDialog({ request }: { request: DataRequest }) {
  const { user } = useAuth();
  const { current } = useCompany();
  const [busy, setBusy] = useState(false);
  const app = getApp(request.appId);
  const { dataType, period } = request.payload;
  const supported = dataType === PAYROLL_RESULT;
  const what = period ? `the ${formatPeriod(`${period}-01`)} run` : "the latest run";

  const { unlocked } = useUnlock();

  const deny = () =>
    request.respond({
      ok: false,
      code: "denied",
      error: "The dashboard user declined the request.",
    });

  const approve = async () => {
    if (!user || !current) return;
    // The gate may have locked while this dialog was open. Saved runs never leave while locked.
    if (!isUnlocked()) return;
    setBusy(true);
    const viewer = { id: user.id, isDemo: user.isDemo };
    let response: ResponseDataPayload;
    try {
      // Read with the user's own permissions: the database only returns what they may see.
      const runs = await fetchRuns(viewer, current.company.id);
      const run = period ? runs.find((r) => r.period === `${period}-01`) : runs[0];
      if (!run) {
        response = { ok: false, error: `There is no saved run for ${period ?? "this company"}.` };
      } else {
        const entries = await fetchRunEntries(viewer, run.id);
        response =
          entries.length === 0
            ? { ok: false, error: "That run has no employees." }
            : {
                ok: true,
                dataType,
                rows: entries.map((row) => toExportRow(row, current.company)),
                meta: { period: run.period.slice(0, 7), label: current.company.name },
              };
      }
    } catch (error) {
      response = { ok: false, error: classifyDataError(error).title };
    }
    request.respond(response);
  };

  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY} />
        <Dialog.Content
          role="alertdialog"
          className={CONTENT}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <div className="flex items-start gap-4">
            <span className="grid size-11 shrink-0 place-items-center rounded-full border border-warn/30 bg-warn/10">
              <ShieldAlert className="size-5 text-warn" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <Dialog.Title className="text-lg font-semibold">
                {app?.name ?? request.appId} is asking for payroll data
              </Dialog.Title>
              <Dialog.Description asChild>
                <div className="mt-1.5 space-y-2 text-sm text-muted">
                  {!supported ? (
                    <p>It asked for a kind of data this dashboard can't provide.</p>
                  ) : !current ? (
                    <p>No company is selected, so there is nothing to send.</p>
                  ) : !unlocked ? (
                    <>
                      <p>
                        It wants {what} of <span className="text-fg">{current.company.name}</span>.
                      </p>
                      <p>
                        Saved payroll data is locked. Confirm your password to answer this request;
                        if you don't, the app is told the dashboard is locked.
                      </p>
                    </>
                  ) : (
                    <>
                      <p>
                        It wants {what} of <span className="text-fg">{current.company.name}</span>.
                      </p>
                      <p>
                        This sends every employee's national ID and salary figures to the app. Only
                        allow it if you started this from the app yourself.
                      </p>
                    </>
                  )}
                </div>
              </Dialog.Description>
            </div>
          </div>
          {supported && current && !unlocked && (
            <div className="mt-5">
              <UnlockForm />
            </div>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <Button autoFocus={unlocked} disabled={busy} onClick={deny}>
              Deny
            </Button>
            {supported && current && unlocked && (
              <Button variant="primary" disabled={busy} onClick={() => void approve()}>
                {busy ? (
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                ) : (
                  <Send aria-hidden="true" />
                )}
                Send {what}
              </Button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** One dialog at a time: requests first (an app is waiting on them), then received data. */
export function BridgeDialogs() {
  const { user } = useAuth();
  const { current } = useCompany();
  const userId = user?.id;
  const isDemo = user?.isDemo ?? false;

  // Handlers that answer apps without a dialog (appData.ts) run outside React: tell them who
  // is signed in and which company is selected.
  useEffect(() => {
    exchangeContext.set(
      userId && current ? { viewer: { id: userId, isDemo }, membership: current } : null,
    );
    return () => exchangeContext.set(null);
  }, [userId, isDemo, current]);

  const requests = useStore(dataRequests);
  const batches = useStore(incomingBatches);
  const request = requests[0];
  const batch = batches[0];

  if (request) return <RequestDialog key={request.id} request={request} />;
  if (batch) return <IncomingDialog key={batch.id} batch={batch} />;
  return null;
}
