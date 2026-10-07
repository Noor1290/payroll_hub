import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleAlert,
  CircleCheck,
  FileJson,
  Info,
  LoaderCircle,
  Save,
  Table2,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import { Link } from "react-router-dom";
import { PageHeader } from "@/components/PageHeader";
import { PayrollTable } from "@/components/PayrollTable";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Badge, Skeleton } from "@/components/ui/misc";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { useAuth } from "@/features/auth/auth-context";
import { useCompany } from "@/features/company/company-context";
import { RoleBadge } from "@/features/company/CompanySwitcher";
import { formatCount, formatPeriod } from "@/lib/format";
import { classifyDataError, type DataFailure } from "@/lib/supabase/errors";
import { classifyImportError, fetchImportContext, importPayrollRun } from "@/lib/supabase/payroll";
import type { ImportResult, Membership } from "@/lib/supabase/schemas";
import { cn } from "@/lib/utils";
import { importInbox, type InboxItem } from "./importInbox";
import { companyDifferences, diffEmployees, matchCompanyByBrn, runConflict } from "./importPlan";
import {
  parsePayrollFile,
  periodFromFileName,
  periodFromMonthInput,
  type ParsedFile,
} from "./parsePayroll";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_ERRORS_SHOWN = 100;

interface SavedSummary {
  result: ImportResult;
  companyName: string;
  period: string;
}

/** One dropped file. Its contents live in memory only, and are dropped once saved or removed. */
interface ImportItem {
  key: string;
  fileName: string;
  parsed: ParsedFile;
  saved: SavedSummary | null;
  /** "YYYY-MM" when known without a file name (data received from an app). */
  month?: string;
}

const fromInbox = (entry: InboxItem, key: string): ImportItem => ({
  key,
  fileName: entry.label,
  parsed: entry.parsed,
  saved: null,
  month: entry.month,
});

function Notice({
  tone,
  title,
  children,
}: {
  tone: "warn" | "danger";
  title: string;
  children?: ReactNode;
}) {
  const Icon = tone === "danger" ? CircleAlert : TriangleAlert;
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-3 rounded-xl border p-3.5 text-sm",
        tone === "danger" ? "border-danger/30 bg-danger/10" : "border-warn/30 bg-warn/10",
      )}
    >
      <Icon
        className={cn("mt-0.5 size-4 shrink-0", tone === "danger" ? "text-danger" : "text-warn")}
        aria-hidden="true"
      />
      <div className="min-w-0">
        <p className="font-medium text-fg">{title}</p>
        {children && <div className="mt-1 space-y-1 text-muted">{children}</div>}
      </div>
    </div>
  );
}

function Count({ value, label, tone }: { value: number; label: string; tone?: "accent" | "warn" }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3">
      <p
        className={cn(
          "tabular text-xl font-semibold",
          value > 0 && tone === "accent" && "text-accent",
          value > 0 && tone === "warn" && "text-warn",
        )}
      >
        {formatCount(value)}
      </p>
      <p className="text-xs text-muted">{label}</p>
    </div>
  );
}

function ErrorReport({ parsed }: { parsed: ParsedFile }) {
  const shown = parsed.errors.slice(0, MAX_ERRORS_SHOWN);
  const badRows = new Set(parsed.errors.map((e) => e.row)).size;
  return (
    <div className="rounded-xl border border-danger/30">
      <div className="flex items-start gap-3 border-b border-danger/30 bg-danger/10 p-3.5 text-sm">
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
        <div>
          <p className="font-medium" role="alert">
            {formatCount(parsed.errors.length)}{" "}
            {parsed.errors.length === 1 ? "problem" : "problems"} in {formatCount(badRows)} of{" "}
            {formatCount(parsed.rowCount)} rows. Nothing can be saved until they are fixed.
          </p>
          <p className="mt-1 text-muted">
            Correct them in the payroll app and export again. This dashboard never edits payroll
            figures.
          </p>
        </div>
      </div>
      <div
        className="max-h-64 overflow-auto"
        tabIndex={0}
        role="region"
        aria-label="Problems found in the file"
      >
        <table className="w-full border-separate border-spacing-0 text-sm">
          <caption className="sr-only">Problems found in the file</caption>
          <thead>
            <tr>
              {["Row", "Field", "Problem"].map((heading) => (
                <th
                  key={heading}
                  scope="col"
                  className="sticky top-0 border-b border-line bg-elevated px-3.5 py-2 text-left text-xs font-medium text-muted"
                >
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((error, i) => (
              <tr key={i}>
                <td className="tabular border-b border-line px-3.5 py-1.5">{error.row}</td>
                <td className="border-b border-line px-3.5 py-1.5 font-medium">{error.field}</td>
                <td className="border-b border-line px-3.5 py-1.5 text-muted">{error.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {parsed.errors.length > shown.length && (
        <p className="border-t border-line px-3.5 py-2 text-xs text-muted">
          Showing the first {MAX_ERRORS_SHOWN} of {formatCount(parsed.errors.length)} problems.
        </p>
      )}
    </div>
  );
}

function SavedPanel({ saved }: { saved: SavedSummary }) {
  const { result, companyName, period } = saved;
  const verb =
    result.outcome === "created"
      ? "created"
      : result.outcome === "replaced"
        ? "replaced"
        : "restored and overwritten";
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-4 rounded-xl border border-accent/30 bg-accent/10 p-4"
    >
      <CircleCheck className="size-5 shrink-0 text-accent" aria-hidden="true" />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium">
          {formatPeriod(period)} run {verb} for {companyName}
        </p>
        <p className="mt-1 text-muted">
          {formatCount(result.entries)} entries saved as a draft
          {result.employeesNew > 0 && `, ${formatCount(result.employeesNew)} new employees added`}
          {result.entriesRemoved > 0 &&
            `, ${formatCount(result.entriesRemoved)} entries removed that were not in this file`}
          .
        </p>
      </div>
      <Button asChild size="sm">
        <Link to={`/explorer?run=${result.runId}`}>
          <Table2 aria-hidden="true" />
          Open in explorer
        </Link>
      </Button>
    </div>
  );
}

/** Everything about a matched, valid file that needs the database: what exists, what would change, and Save. */
function SavePlan({
  item,
  membership,
  period,
  onSaved,
}: {
  item: ImportItem;
  membership: Membership;
  period: string;
  onSaved: (saved: SavedSummary) => void;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<DataFailure | null>(null);
  const viewer = { id: user!.id, isDemo: user!.isDemo };
  const { company } = membership;
  const label = formatPeriod(period);

  const context = useQuery({
    queryKey: ["import-context", company.id, period, user?.id],
    queryFn: () => fetchImportContext(viewer, company.id, period),
    // Always look again: someone else may have imported or approved in the meantime.
    staleTime: 0,
    gcTime: 0,
  });

  const save = useMutation({
    mutationFn: (replace: boolean) =>
      importPayrollRun(viewer, { companyId: company.id, period, rows: item.parsed.rows, replace }),
    onSuccess: async (result) => {
      setConfirming(false);
      await Promise.all(
        ["runs", "overview"].map((key) =>
          queryClient.invalidateQueries({ queryKey: [key, company.id] }),
        ),
      );
      await queryClient.invalidateQueries({ queryKey: ["run-entries", result.runId] });
      onSaved({ result, companyName: company.name, period });
    },
    onError: (error) => {
      setConfirming(false);
      setFailure(classifyImportError(error));
      // The picture may have changed (e.g. a run now exists), so refresh what we show.
      void context.refetch();
    },
  });

  if (context.isPending) {
    return (
      <div aria-busy="true" aria-label="Checking the database" className="space-y-3">
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-10 w-40 rounded-lg" />
      </div>
    );
  }
  if (context.isError) {
    return (
      <ErrorState failure={classifyDataError(context.error)} onRetry={() => context.refetch()} />
    );
  }

  const conflict = runConflict(context.data.run);
  const diff = diffEmployees(item.parsed.rows, context.data.employees);
  const differences = item.parsed.company ? companyDifferences(item.parsed.company, company) : [];
  const blocked = conflict.kind === "blocked-approved";
  const replacing = conflict.kind === "replace-draft" || conflict.kind === "revive-deleted";

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Count value={diff.new} label="New employees" tone="accent" />
        <Count value={diff.changed} label="Details changed" tone="warn" />
        <Count value={diff.unchanged} label="Unchanged" />
        <Count value={diff.restored} label="Restored (were deleted)" tone="warn" />
      </div>

      {differences.length > 0 && (
        <Notice tone="warn" title="Company details differ from the database">
          <ul className="list-disc space-y-0.5 pl-4">
            {differences.map((difference) => (
              <li key={difference}>{difference}</li>
            ))}
          </ul>
          <p>The database is left as it is. Importing does not change company details.</p>
        </Notice>
      )}

      {conflict.kind === "replace-draft" && (
        <Notice tone="warn" title={`A draft run for ${label} already exists`}>
          <p>
            Saving will replace it: entries are updated from this file, and entries for employees
            who are not in this file are removed.
          </p>
        </Notice>
      )}
      {conflict.kind === "revive-deleted" && (
        <Notice tone="warn" title={`A deleted run for ${label} exists`}>
          <p>Saving will bring that run back as a draft and overwrite it with this file's data.</p>
        </Notice>
      )}
      {blocked && (
        <Notice tone="danger" title={`The ${label} run is approved`}>
          <p>
            An approved run can't be replaced. Set it back to draft in the{" "}
            <Link to={`/explorer?run=${context.data.run?.id}`} className="text-fg underline">
              Data explorer
            </Link>{" "}
            first, then check again.
          </p>
        </Notice>
      )}

      {failure && <ErrorState failure={failure} className="py-8" />}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          disabled={blocked || save.isPending}
          onClick={() => {
            setFailure(null);
            if (replacing) setConfirming(true);
            else save.mutate(false);
          }}
        >
          {save.isPending ? (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          ) : (
            <Save aria-hidden="true" />
          )}
          {save.isPending
            ? "Saving"
            : replacing
              ? `Replace ${label} run`
              : `Save ${formatCount(item.parsed.rows.length)} employees to ${label}`}
        </Button>
        {blocked && (
          <Button onClick={() => context.refetch()} disabled={context.isFetching}>
            Check again
          </Button>
        )}
        <p className="text-xs text-subtle">
          Saved as one step: it either all succeeds or nothing changes.
        </p>
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Replace the ${label} run?`}
        confirmLabel="Replace"
        tone="danger"
        busy={save.isPending}
        onConfirm={() => save.mutate(true)}
      >
        <p>
          The existing {label} run for {company.name} will be overwritten with the{" "}
          {formatCount(item.parsed.rows.length)} employees in this file. Entries for anyone not in
          the file are removed.
        </p>
        <p>This can't be undone from the dashboard.</p>
      </ConfirmDialog>
    </div>
  );
}

function ImportCard({
  item,
  memberships,
  onRemove,
  onSaved,
}: {
  item: ImportItem;
  memberships: Membership[];
  onRemove: () => void;
  onSaved: (saved: SavedSummary) => void;
}) {
  const monthId = useId();
  const [month, setMonth] = useState(
    () => item.month ?? periodFromFileName(item.fileName)?.slice(0, 7) ?? "",
  );
  const { parsed } = item;
  const period = periodFromMonthInput(month);
  const match = matchCompanyByBrn(memberships, parsed.company?.brn);
  const membership = match.kind === "matched" ? match.membership : null;
  const isAdmin = membership?.role === "admin";
  const hasErrors = parsed.errors.length > 0;

  return (
    <li className="glass rounded-2xl">
      <div className="flex items-center gap-3 border-b border-line px-5 py-4">
        <FileJson className="size-5 shrink-0 text-accent" aria-hidden="true" />
        <h2 className="min-w-0 flex-1 truncate font-semibold">{item.fileName}</h2>
        <Button
          size="icon"
          variant="ghost"
          aria-label={`Remove ${item.fileName}`}
          onClick={onRemove}
        >
          <X aria-hidden="true" />
        </Button>
      </div>

      <div className="space-y-4 p-5">
        {item.saved ? (
          <SavedPanel saved={item.saved} />
        ) : parsed.fatal ? (
          <Notice tone="danger" title="This file can't be imported">
            <p>{parsed.fatal}</p>
          </Notice>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
              <div className="min-w-0">
                <p className="text-xs text-muted">Company (matched by BRN)</p>
                {membership ? (
                  <p className="mt-1 flex items-center gap-2 font-medium">
                    <span className="truncate">{membership.company.name}</span>
                    <RoleBadge role={membership.role} />
                  </p>
                ) : (
                  <p className="mt-1 font-medium text-danger">Not matched</p>
                )}
              </div>
              <div>
                <label htmlFor={monthId} className="block text-xs text-muted">
                  Period {periodFromFileName(item.fileName) ? "(from the file name)" : ""}
                </label>
                <input
                  id={monthId}
                  type="month"
                  value={month}
                  onChange={(e) => setMonth(e.target.value)}
                  aria-invalid={!period}
                  className="mt-1 h-10 rounded-lg border border-line bg-surface px-3 text-sm shadow-inner-glow hover:border-line-strong aria-invalid:border-danger"
                />
              </div>
              <div>
                <p className="text-xs text-muted">Employees in file</p>
                <p className="tabular mt-1 font-medium">{formatCount(parsed.rowCount)}</p>
              </div>
            </div>

            {match.kind === "no-brn" && (
              <Notice tone="danger" title="The file has no BRN">
                <p>
                  Companies are matched by BRN, so this file can't be linked to one. Export it again
                  from the payroll app with the company's BRN filled in.
                </p>
              </Notice>
            )}
            {match.kind === "unknown" && (
              <Notice tone="danger" title={`No company with BRN ${match.brn}`}>
                <p>
                  None of your companies has this BRN. Check the BRN in the file. If the company is
                  new, add it first with "Add company" in the company switcher, using exactly this
                  BRN; if it already exists, ask the owner to make you a member.
                </p>
              </Notice>
            )}
            {membership && !isAdmin && (
              <Notice tone="danger" title={`You're a viewer of ${membership.company.name}`}>
                <p>Only admins can import. You can preview the file, but not save it.</p>
              </Notice>
            )}
            {!period && (
              <Notice tone="danger" title="Choose the period">
                <p>
                  The file name doesn't end in a month like 2026-09, so pick the month this payroll
                  is for.
                </p>
              </Notice>
            )}

            {parsed.dateOfEmploymentIgnored && (
              <p role="status" className="flex items-start gap-2 text-sm text-muted">
                <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                <span>
                  This file has a "Date of Employment" field. It is ignored: the date is set in the
                  Data explorer.
                </span>
              </p>
            )}

            {hasErrors && <ErrorReport parsed={parsed} />}

            {membership && isAdmin && period && !hasErrors && (
              <SavePlan
                key={`${membership.company.id}:${period}`}
                item={item}
                membership={membership}
                period={period}
                onSaved={onSaved}
              />
            )}

            {parsed.rows.length > 0 && (
              <div className="overflow-hidden rounded-xl border border-line">
                <p className="border-b border-line px-3.5 py-2.5 text-sm font-medium">
                  Preview
                  {hasErrors && (
                    <span className="ml-2 font-normal text-muted">
                      (only the {formatCount(parsed.rows.length)} rows without problems)
                    </span>
                  )}
                </p>
                <PayrollTable
                  rows={parsed.rows}
                  initialPageSize={10}
                  caption={`Preview of ${item.fileName}`}
                />
              </div>
            )}
          </>
        )}
      </div>
    </li>
  );
}

function DropIllustration() {
  return (
    <svg viewBox="0 0 120 80" fill="none" aria-hidden="true" className="h-20 w-30">
      <rect x="30" y="8" width="60" height="64" rx="8" stroke="var(--line-strong)" />
      <path d="M42 26h20M42 36h36M42 46h28" stroke="var(--line-strong)" strokeLinecap="round" />
      <circle cx="88" cy="58" r="14" fill="var(--elevated)" stroke="var(--accent)" />
      <path
        d="M88 64V52m-5 5 5-5 5 5"
        stroke="var(--accent)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ImportPage() {
  const { status, failure, retry, memberships } = useCompany();
  // Data handed over from an app (via the bridge) starts in the inbox; pick it up here.
  const [items, setItems] = useState<ImportItem[]>(() =>
    importInbox.get().map((entry, i) => fromInbox(entry, `inbox-${i}`)),
  );
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const nextKey = useRef(0);

  useEffect(() => {
    const take = () => {
      const waiting = importInbox.get();
      if (waiting.length === 0) return;
      importInbox.set([]);
      setItems((current) => {
        const known = new Set(current.map((item) => item.parsed));
        const added = waiting
          .filter((entry) => !known.has(entry.parsed))
          .map((entry) => fromInbox(entry, `inbox-late-${nextKey.current++}`));
        return [...added, ...current];
      });
    };
    const unsubscribe = importInbox.subscribe(take);
    // What was waiting at mount is already in state (see above); just empty the inbox.
    importInbox.set([]);
    return unsubscribe;
  }, []);

  const adminOf = memberships.filter((m) => m.role === "admin");

  const addFiles = async (files: FileList | File[]) => {
    setReading(true);
    const added: ImportItem[] = [];
    for (const file of Array.from(files)) {
      let parsed: ParsedFile;
      if (file.size > MAX_FILE_BYTES) {
        parsed = {
          rows: [],
          errors: [],
          company: null,
          rowCount: 0,
          fatal:
            "This file is larger than 20 MB, which is far more than a payroll export should be.",
        };
      } else {
        try {
          parsed = parsePayrollFile(await file.text());
        } catch {
          parsed = {
            rows: [],
            errors: [],
            company: null,
            rowCount: 0,
            fatal: "The file couldn't be read. Try choosing it again.",
          };
        }
      }
      added.push({ key: `file-${nextKey.current++}`, fileName: file.name, parsed, saved: null });
    }
    setItems((current) => [...added, ...current]);
    setReading(false);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length > 0) void addFiles(event.dataTransfer.files);
  };

  return (
    <>
      <PageHeader
        title="Import"
        description="Drop payroll JSON exports to check them and save each one as a run. Files are read in your browser and kept in memory only."
      />

      <div className="mt-8 space-y-6">
        {status === "loading" && <Skeleton className="h-56 rounded-2xl" aria-hidden="true" />}
        {status === "error" && failure && <ErrorState failure={failure} onRetry={retry} />}

        {status === "ready" && adminOf.length === 0 && (
          <div className="glass rounded-2xl">
            <EmptyState title="Importing needs an admin role" className="py-16">
              {memberships.length === 0
                ? "Your account isn't a member of any company yet. Ask the owner to add you."
                : "You're a viewer in every company you belong to. Ask the owner to make you an admin if you need to import."}
            </EmptyState>
          </div>
        )}

        {status === "ready" && adminOf.length > 0 && (
          <>
            <div
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={cn(
                "flex flex-col items-center rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors",
                dragging ? "border-accent bg-accent/10" : "border-line-strong bg-surface",
              )}
            >
              <DropIllustration />
              <p className="mt-4 font-semibold">Drop payroll JSON files here</p>
              <p className="mt-1.5 max-w-md text-sm text-muted">
                One file per company and month, named like{" "}
                <span className="tabular text-fg">ABC Co Ltd-pdf-fill-2026-09.json</span>. The
                company is found by its BRN.
              </p>
              <input
                ref={input}
                type="file"
                accept=".json,application/json"
                multiple
                className="sr-only"
                aria-label="Choose payroll JSON files"
                onChange={(event) => {
                  if (event.target.files?.length) void addFiles(event.target.files);
                  event.target.value = "";
                }}
              />
              <Button
                variant="primary"
                className="mt-5"
                disabled={reading}
                onClick={() => input.current?.click()}
              >
                {reading ? (
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                ) : (
                  <Upload aria-hidden="true" />
                )}
                Choose files
              </Button>
              <p className="mt-3 flex flex-wrap items-center justify-center gap-1.5 text-xs text-subtle">
                You can import for:
                {adminOf.map((m) => (
                  <Badge key={m.company.id}>{m.company.name}</Badge>
                ))}
              </p>
            </div>

            {items.length > 0 && (
              <ul className="space-y-6">
                {items.map((item) => (
                  <ImportCard
                    key={item.key}
                    item={item}
                    memberships={memberships}
                    onRemove={() =>
                      setItems((current) => current.filter((i) => i.key !== item.key))
                    }
                    onSaved={(saved) =>
                      setItems((current) =>
                        current.map((i) =>
                          // Once saved, let go of the payroll rows: only the summary is kept.
                          i.key === item.key
                            ? { ...i, saved, parsed: { ...i.parsed, rows: [], errors: [] } }
                            : i,
                        ),
                      )
                    }
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </>
  );
}
