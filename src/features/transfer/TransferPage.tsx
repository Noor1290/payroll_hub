import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleAlert,
  Database,
  Download,
  Eye,
  EyeOff,
  Inbox,
  LoaderCircle,
  RotateCw,
  Save,
  Send,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Badge, Skeleton, StatusDot } from "@/components/ui/misc";
import { EmptyState, ErrorState } from "@/components/ui/states";
import {
  appsAccepting,
  getApp,
  PAYROLL_RESULT,
  type AppConfig,
  type ExpectedField,
} from "@/config/apps.config";
import { useAuth } from "@/features/auth/auth-context";
import { useCompany } from "@/features/company/company-context";
import { PasswordGate, UnlockStatus } from "@/features/unlock/PasswordGate";
import {
  deliver,
  downloadJson,
  downloadName,
  failureText,
  retryTransfer,
} from "@/features/workspace/deliver";
import { healthView } from "@/features/workspace/health";
import { useAppHealth } from "@/lib/bridge/bridge";
import type { SendOutcome } from "@/lib/bridge/hub";
import { formatCount, formatPeriod } from "@/lib/format";
import { preferenceStorage } from "@/lib/storage";
import { useStore } from "@/lib/store";
import { classifyDataError } from "@/lib/supabase/errors";
import { fetchRunEntries, fetchRuns } from "@/lib/supabase/payroll";
import type { Company } from "@/lib/supabase/schemas";
import { cn } from "@/lib/utils";
import { showValue } from "./display";
import { FlowVisual, type FlowEnd, type FlowState } from "./FlowVisual";
import {
  autoMap,
  buildOutput,
  effectiveMapping,
  missingRequired,
  sensitiveColumnsSent,
  tableFromReceived,
  tableFromRun,
  validateRows,
  type Mapping,
  type SourceTable,
} from "./mapping";
import { SelectTable } from "./SelectTable";
import { applyTemplate, deleteTemplate, mappingTemplates, saveTemplate } from "./templates";
import type { TransferSource } from "./transferLog";
import { heldBatch } from "./transferSource";

const STEPS = ["Source", "Rows and columns", "Destination", "Mapping", "Preview and send"] as const;
const OPEN_AFTER_KEY = "transfer-open-after";
const PREVIEW_ROWS = 10;
const MAX_ISSUES_SHOWN = 50;
const SELECT =
  "h-10 rounded-lg border border-line bg-surface px-3 text-sm text-fg shadow-inner-glow hover:border-line-strong";
const timeFormat = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

type SourceChoice = { kind: "run"; runId: string } | { kind: "received" };

interface SendState {
  status: FlowState;
  outcome: SendOutcome | null;
}

/** Everything the user has chosen so far. Lives in the page, so it survives the gate locking. */
interface WizardState {
  step: number;
  /** null = every row / column (the default until the user changes it). */
  rows: ReadonlySet<string> | null;
  columns: ReadonlySet<string> | null;
  destinationId: string | null;
  /** null = use the automatic suggestion. */
  mapping: Mapping | null;
  send: SendState;
}

const FRESH: WizardState = {
  step: 0,
  rows: null,
  columns: null,
  destinationId: null,
  mapping: null,
  send: { status: "idle", outcome: null },
};

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

function Stepper({
  step,
  reached,
  onGo,
}: {
  step: number;
  reached: number;
  onGo: (n: number) => void;
}) {
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-3">
      {STEPS.map((label, index) => {
        const done = index < step;
        const active = index === step;
        const canGo = index <= reached && index !== step;
        return (
          <li key={label} className="flex items-center gap-2">
            <button
              type="button"
              disabled={!canGo}
              onClick={() => onGo(index)}
              aria-current={active ? "step" : undefined}
              className={cn(
                "relative flex items-center gap-2.5 rounded-full py-1.5 pr-3.5 pl-1.5 text-sm font-medium transition-colors",
                active ? "text-fg" : done ? "text-muted hover:text-fg" : "text-subtle",
                !canGo && !active && "cursor-default",
              )}
            >
              {active && (
                <motion.span
                  layoutId="transfer-step"
                  className="absolute inset-0 rounded-full border border-accent/40 bg-accent/10"
                  transition={{ type: "spring", stiffness: 380, damping: 32 }}
                />
              )}
              <span
                className={cn(
                  "tabular relative grid size-7 place-items-center rounded-full border text-xs",
                  done
                    ? "border-accent bg-accent text-accent-fg"
                    : active
                      ? "border-accent text-accent"
                      : "border-line-strong",
                )}
              >
                {done ? <Check className="size-3.5" aria-hidden="true" /> : index + 1}
              </span>
              <span className="relative">
                <span className="sr-only">Step {index + 1}: </span>
                {label}
              </span>
            </button>
            {index < STEPS.length - 1 && (
              <span
                aria-hidden="true"
                className={cn("hidden h-px w-6 sm:block", done ? "bg-accent" : "bg-line-strong")}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function StepNav({
  onBack,
  onNext,
  nextLabel = "Next",
  blocked,
}: {
  onBack?: () => void;
  onNext?: () => void;
  nextLabel?: string;
  /** Why Next is unavailable, shown next to it. */
  blocked?: string | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-line pt-5">
      {onBack && (
        <Button onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          Back
        </Button>
      )}
      <div className="ml-auto flex flex-wrap items-center gap-3">
        <p className="text-sm text-muted" aria-live="polite">
          {blocked}
        </p>
        {onNext && (
          <Button variant="primary" disabled={!!blocked} onClick={onNext}>
            {nextLabel}
            <ArrowRight aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- step 3: destination

function DestinationStep({
  apps,
  selectedId,
  onSelect,
}: {
  apps: AppConfig[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const health = useAppHealth();
  if (apps.length === 0) {
    return <EmptyState title="No app accepts this kind of data yet" className="py-10" />;
  }
  return (
    <div role="radiogroup" aria-label="Destination app" className="grid gap-3 sm:grid-cols-2">
      {apps.map((app) => {
        const view = healthView(health[app.id]);
        const usable = health[app.id] === "ready";
        const selected = app.id === selectedId;
        return (
          <button
            key={app.id}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-disabled={!usable}
            onClick={() => usable && onSelect(app.id)}
            className={cn(
              "rounded-xl border p-4 text-left transition-colors",
              selected ? "border-accent bg-accent/10" : "border-line bg-surface",
              usable ? "hover:border-line-strong" : "cursor-not-allowed opacity-60",
            )}
          >
            <span className="flex items-center gap-2.5 font-medium">
              <app.icon className="size-4" style={{ color: app.accentColor }} aria-hidden="true" />
              {app.name}
              {selected && <Check className="ml-auto size-4 text-accent" aria-hidden="true" />}
            </span>
            <span className="mt-1.5 block text-sm text-muted">{app.description}</span>
            <span className="mt-3 flex items-center gap-2 text-xs text-muted">
              <StatusDot tone={view.tone} />
              {view.label}
            </span>
            {!usable && (
              <span className="mt-1.5 block text-xs text-subtle">
                Can't be chosen: {view.detail}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- step 4: mapping

function MappingStep({
  table,
  selectedColumns,
  destination,
  dataType,
  baseMapping,
  onChange,
  missing,
  issues,
  sensitive,
}: {
  table: SourceTable;
  selectedColumns: ReadonlySet<string>;
  destination: AppConfig;
  dataType: string;
  baseMapping: Mapping;
  onChange: (mapping: Mapping | null) => void;
  missing: ExpectedField[];
  issues: ReturnType<typeof validateRows>;
  sensitive: ReturnType<typeof sensitiveColumnsSent>;
}) {
  const templates = useStore(mappingTemplates).filter(
    (t) => t.destinationId === destination.id && t.dataType === dataType,
  );
  const [templateId, setTemplateId] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [savedNote, setSavedNote] = useState<string | null>(null);

  const available = table.columns.filter((column) => selectedColumns.has(column.key));
  const fields = destination.expectedFields;
  const effective = effectiveMapping(baseMapping, selectedColumns, fields);
  const mappedSources = new Set(Object.values(effective));
  const unmappedColumns = available.filter((column) => !mappedSources.has(column.key));
  const missingKeys = new Set(missing.map((field) => field.key));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3 rounded-xl border border-line bg-surface p-4">
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-sm">
            <span className="mb-1.5 block text-xs text-muted">Saved mappings</span>
            <select
              className={SELECT}
              value={templateId}
              onChange={(event) => setTemplateId(event.target.value)}
            >
              <option value="">{templates.length ? "Choose one" : "None saved yet"}</option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
          </label>
          <Button
            disabled={!templateId}
            onClick={() => {
              const template = templates.find((t) => t.id === templateId);
              if (template) onChange(applyTemplate(template, available, fields));
            }}
          >
            Apply
          </Button>
          <Button
            variant="ghost"
            size="icon"
            disabled={!templateId}
            aria-label="Delete the chosen saved mapping"
            onClick={() => {
              deleteTemplate(templateId);
              setTemplateId("");
            }}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const saved = saveTemplate({
              name: templateName,
              destinationId: destination.id,
              dataType,
              mapping: effective,
            });
            if (saved) {
              setSavedNote(`Saved "${saved.name}". Only column names are stored, never values.`);
              setTemplateName("");
              setTemplateId(saved.id);
            }
          }}
        >
          <label className="text-sm">
            <span className="mb-1.5 block text-xs text-muted">Save this mapping as</span>
            <input
              value={templateName}
              onChange={(event) => setTemplateName(event.target.value)}
              maxLength={60}
              placeholder={`Payroll to ${destination.name}`}
              className={cn(SELECT, "w-56 placeholder:text-subtle")}
            />
          </label>
          <Button type="submit" disabled={templateName.trim() === ""}>
            <Save aria-hidden="true" />
            Save
          </Button>
        </form>
        <Button variant="ghost" className="ml-auto" onClick={() => onChange(null)}>
          <RotateCw aria-hidden="true" />
          Match automatically
        </Button>
        {savedNote && (
          <p role="status" className="basis-full text-xs text-muted">
            {savedNote}
          </p>
        )}
      </div>

      <div className="max-h-[min(50vh,30rem)] overflow-auto rounded-xl border border-line">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <caption className="sr-only">
            Which source column fills each field {destination.name} expects
          </caption>
          <thead>
            <tr>
              {[`${destination.name} expects`, "Filled from", "Notes"].map((heading, i) => (
                <th
                  key={heading}
                  scope="col"
                  className="sticky top-0 z-10 border-b border-line bg-elevated px-4 py-2.5 text-left text-xs font-medium text-muted"
                >
                  {i === 2 ? <span className="sr-only">{heading}</span> : heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {fields.map((field) => {
              const source = effective[field.key] ?? "";
              const isMissing = missingKeys.has(field.key);
              return (
                <tr key={field.key}>
                  <th scope="row" className="border-b border-line px-4 py-2 text-left font-normal">
                    <span className="font-medium">{field.label}</span>
                    <span className="ml-2 text-xs text-subtle">{field.type}</span>
                  </th>
                  <td className="border-b border-line px-4 py-2">
                    <select
                      aria-label={`Source column for ${field.label}`}
                      aria-invalid={isMissing}
                      className={cn(SELECT, "h-9 w-full max-w-xs aria-invalid:border-danger")}
                      value={source}
                      onChange={(event) =>
                        onChange({ ...effective, [field.key]: event.target.value })
                      }
                    >
                      <option value="">Not mapped</option>
                      {available.map((column) => (
                        <option key={column.key} value={column.key}>
                          {column.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="border-b border-line px-4 py-2 whitespace-nowrap">
                    <span className="flex flex-wrap gap-1.5">
                      {field.required && (
                        <Badge tone={isMissing ? "danger" : "neutral"}>Required</Badge>
                      )}
                      {field.sensitive && source && <Badge tone="warn">Sensitive</Badge>}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {missing.length > 0 && (
        <Notice
          tone="danger"
          title={`${formatCount(missing.length)} required ${missing.length === 1 ? "field has" : "fields have"} no source column`}
        >
          <p>
            {missing.map((field) => field.label).join(", ")}. Map{" "}
            {missing.length === 1 ? "it" : "them"} above, or go back and tick the column you need.{" "}
            {destination.name} can't use the data without {missing.length === 1 ? "it" : "them"}.
          </p>
        </Notice>
      )}

      {issues.length > 0 && (
        <Notice
          tone="danger"
          title={`${formatCount(issues.length)} ${issues.length === 1 ? "value doesn't" : "values don't"} fit what ${destination.name} expects`}
        >
          <ul
            className="max-h-40 list-disc space-y-0.5 overflow-auto pl-4"
            tabIndex={0}
            aria-label="Values that don't fit"
          >
            {issues.slice(0, MAX_ISSUES_SHOWN).map((issue, i) => (
              <li key={i}>
                Row {issue.row}, {issue.field}: {issue.message}
              </li>
            ))}
          </ul>
          {issues.length > MAX_ISSUES_SHOWN && <p>Showing the first {MAX_ISSUES_SHOWN}.</p>}
          <p>
            Change the mapping, or go back and untick those rows. Values are never altered here.
          </p>
        </Notice>
      )}

      {sensitive.length > 0 && (
        <Notice
          tone="warn"
          title={`${formatCount(sensitive.length)} sensitive ${sensitive.length === 1 ? "column goes" : "columns go"} to ${destination.name}`}
        >
          <p>{sensitive.map((column) => column.label).join(", ")}.</p>
        </Notice>
      )}

      {unmappedColumns.length > 0 && (
        <p className="text-sm text-muted">
          Not sent, because nothing in {destination.name} is mapped to{" "}
          {unmappedColumns.length === 1 ? "it" : "them"}:{" "}
          {unmappedColumns.map((column) => column.label).join(", ")}.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- step 5: preview and send

function PreviewStep({
  output,
  fields,
  mapping,
  destination,
  from,
  send,
  onSend,
  onRetry,
  onDownload,
  openAfter,
  onOpenAfterChange,
}: {
  output: Record<string, unknown>[];
  fields: readonly ExpectedField[];
  mapping: Mapping;
  destination: AppConfig;
  from: FlowEnd;
  send: SendState;
  onSend: () => void;
  onRetry: () => void;
  onDownload: () => void;
  openAfter: boolean;
  onOpenAfterChange: (value: boolean) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const sent = fields.filter((field) => mapping[field.key]);
  const failed = send.status === "failed" && send.outcome && !send.outcome.ok ? send.outcome : null;
  const rowsText = `${formatCount(output.length)} ${output.length === 1 ? "row" : "rows"}`;

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-line bg-surface px-4 py-8">
        <FlowVisual
          state={send.status}
          from={from}
          to={{ label: destination.name, icon: destination.icon, color: destination.accentColor }}
        />
        <div className="mt-6 text-center" aria-live="polite">
          {send.status === "idle" && (
            <p className="text-sm text-muted">
              Ready to send {rowsText} with {formatCount(sent.length)} fields each.
            </p>
          )}
          {send.status === "sending" && (
            <p className="text-sm text-warn">Sending {rowsText} and waiting for confirmation…</p>
          )}
          {send.status === "delivered" && (
            <p className="font-medium text-accent">
              Delivered. {destination.name} confirmed it received {rowsText}.
            </p>
          )}
          {failed && (
            <div role="alert">
              <p className="font-medium text-danger">Not delivered</p>
              <p className="mt-1 text-sm text-muted">{failureText(failed)}</p>
            </div>
          )}
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          {(send.status === "idle" || send.status === "sending") && (
            <Button
              variant="primary"
              size="lg"
              disabled={send.status === "sending"}
              onClick={onSend}
            >
              {send.status === "sending" ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : (
                <Send aria-hidden="true" />
              )}
              {send.status === "sending" ? "Sending" : `Send to ${destination.name}`}
            </Button>
          )}
          {failed && (
            <>
              <Button variant="primary" onClick={onRetry}>
                <RotateCw aria-hidden="true" />
                Retry
              </Button>
              <Button onClick={onDownload}>
                <Download aria-hidden="true" />
                Download JSON instead
              </Button>
            </>
          )}
          {send.status === "delivered" && (
            <Button onClick={onSend}>
              <Send aria-hidden="true" />
              Send again
            </Button>
          )}
        </div>
        <label className="mt-4 flex items-center justify-center gap-2 text-sm text-muted">
          <input
            type="checkbox"
            className="size-4 rounded accent-(--accent)"
            checked={openAfter}
            onChange={(event) => onOpenAfterChange(event.target.checked)}
          />
          Open {destination.name} when it is delivered
        </label>
      </div>

      <div className="overflow-hidden rounded-xl border border-line">
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5">
          <p className="text-sm font-medium">
            Exactly what {destination.name} will receive
            <span className="ml-2 font-normal text-muted">
              (first {formatCount(Math.min(PREVIEW_ROWS, output.length))} of {rowsText})
            </span>
          </p>
          <Button
            size="sm"
            className="ml-auto"
            aria-pressed={revealed}
            onClick={() => setRevealed((value) => !value)}
          >
            {revealed ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
            {revealed ? "Hide sensitive" : "Reveal sensitive"}
          </Button>
        </div>
        <div
          className="max-h-80 overflow-auto"
          tabIndex={0}
          role="region"
          aria-label="Preview of the rows that will be sent"
        >
          <table className="w-full border-separate border-spacing-0 text-sm">
            <caption className="sr-only">Preview of the rows that will be sent</caption>
            <thead>
              <tr>
                {sent.map((field) => (
                  <th
                    key={field.key}
                    scope="col"
                    className="sticky top-0 border-b border-line bg-elevated px-3 py-2.5 text-left text-xs font-medium whitespace-nowrap text-muted"
                  >
                    {field.key}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {output.slice(0, PREVIEW_ROWS).map((row, i) => (
                <tr key={i}>
                  {sent.map((field) => (
                    <td
                      key={field.key}
                      className={cn(
                        "border-b border-line px-3 py-2 whitespace-nowrap",
                        (field.type === "number" || field.sensitive) && "tabular",
                        field.type === "number" && "text-right",
                      )}
                    >
                      {field.sensitive && !revealed ? (
                        <span className="tracking-widest text-subtle">••••••</span>
                      ) : (
                        showValue(row[field.key], field.type === "number")
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- steps 2 to 5, once there is a table

interface StepsProps {
  table: SourceTable;
  source: TransferSource;
  dataType: string;
  meta: { period?: string; label?: string } | undefined;
  /** The app the data came from, which can't also be its destination. */
  sourceApp?: AppConfig;
  state: WizardState;
  update: (patch: Partial<WizardState>) => void;
}

function Steps({ table, source, dataType, meta, sourceApp, state, update }: StepsProps) {
  const navigate = useNavigate();
  const [openAfter, setOpenAfter] = useState(
    () => preferenceStorage.getItem(OPEN_AFTER_KEY) === "1",
  );

  const allRows = useMemo(() => new Set(table.rows.map((row) => row.id)), [table.rows]);
  const allColumns = useMemo(() => new Set(table.columns.map((c) => c.key)), [table.columns]);
  const selectedRows = state.rows ?? allRows;
  const selectedColumns = state.columns ?? allColumns;

  const destinations = appsAccepting(dataType, sourceApp?.id);
  const destination = getApp(state.destinationId) ?? null;

  const derived = useMemo(() => {
    const fields = destination?.expectedFields ?? [];
    const available = table.columns.filter((column) => selectedColumns.has(column.key));
    const base = state.mapping ?? autoMap(available, fields);
    const mapping = effectiveMapping(base, selectedColumns, fields);
    const rows = table.rows.filter((row) => selectedRows.has(row.id));
    return {
      fields,
      base,
      mapping,
      missing: missingRequired(base, selectedColumns, fields),
      issues: validateRows(rows, mapping, fields),
      sensitive: sensitiveColumnsSent(mapping, table.columns),
      output: buildOutput(rows, mapping, fields),
    };
  }, [table, selectedRows, selectedColumns, destination, state.mapping]);

  const go = (step: number) => update({ step, send: FRESH.send });

  const finish = (outcome: SendOutcome | null) => {
    if (!outcome) {
      update({
        send: {
          status: "failed",
          outcome: {
            ok: false,
            id: "",
            reason: "unavailable",
            error: "This data is no longer in memory. Go back and send it again.",
          },
        },
      });
      return;
    }
    update({ send: { status: outcome.ok ? "delivered" : "failed", outcome } });
    if (outcome.ok && openAfter && destination) {
      // Let the "delivered" state be seen before leaving the page.
      setTimeout(() => navigate(`/workspace?app=${destination.id}`), 1200);
    }
  };

  const payload = { dataType, rows: derived.output, meta };

  const send = async () => {
    if (!destination || derived.output.length === 0) return;
    update({ send: { status: "sending", outcome: null } });
    finish(await deliver(destination.id, payload, { source, notify: false }));
  };

  const retry = async () => {
    const id = state.send.outcome?.id;
    update({ send: { status: "sending", outcome: null } });
    finish(id ? await (retryTransfer(id, false) ?? Promise.resolve(null)) : null);
  };

  const { step } = state;
  return (
    <>
      {step === 1 && (
        <>
          <SelectTable
            table={table}
            selectedRows={selectedRows}
            onRowsChange={(rows) => update({ rows })}
            selectedColumns={selectedColumns}
            onColumnsChange={(columns) => update({ columns })}
          />
          <StepNav
            onBack={() => go(0)}
            onNext={() => go(2)}
            blocked={
              selectedRows.size === 0
                ? "Tick at least one row."
                : selectedColumns.size === 0
                  ? "Tick at least one column."
                  : null
            }
          />
        </>
      )}

      {step === 2 && (
        <>
          <DestinationStep
            apps={destinations}
            selectedId={state.destinationId}
            // A different destination expects different fields, so the mapping starts over.
            onSelect={(destinationId) => update({ destinationId, mapping: null })}
          />
          <StepNav
            onBack={() => go(1)}
            onNext={() => go(3)}
            blocked={destination ? null : "Choose where to send the data."}
          />
        </>
      )}

      {step === 3 && destination && (
        <>
          <MappingStep
            table={table}
            selectedColumns={selectedColumns}
            destination={destination}
            dataType={dataType}
            baseMapping={derived.base}
            onChange={(mapping) => update({ mapping })}
            missing={derived.missing}
            issues={derived.issues}
            sensitive={derived.sensitive}
          />
          <StepNav
            onBack={() => go(2)}
            onNext={() => go(4)}
            blocked={
              derived.missing.length > 0
                ? "Map every required field first."
                : derived.issues.length > 0
                  ? "Fix the values listed above first."
                  : Object.keys(derived.mapping).length === 0
                    ? "Map at least one field."
                    : null
            }
          />
        </>
      )}

      {step === 4 && destination && (
        <>
          <PreviewStep
            output={derived.output}
            fields={derived.fields}
            mapping={derived.mapping}
            destination={destination}
            from={{ label: source.label, icon: sourceApp?.icon, color: sourceApp?.accentColor }}
            send={state.send}
            onSend={() => void send()}
            onRetry={() => void retry()}
            onDownload={() => downloadJson(derived.output, downloadName(payload))}
            openAfter={openAfter}
            onOpenAfterChange={(value) => {
              setOpenAfter(value);
              preferenceStorage.setItem(OPEN_AFTER_KEY, value ? "1" : "0");
            }}
          />
          <StepNav onBack={state.send.status === "sending" ? undefined : () => go(3)} />
        </>
      )}
    </>
  );
}

/** Loads a saved run's rows (only ever rendered inside the password gate). */
function RunSource({
  runId,
  company,
  children,
}: {
  runId: string;
  company: Company;
  children: (table: SourceTable) => ReactNode;
}) {
  const { user } = useAuth();
  const query = useQuery({
    // Same key as the data explorer: it is wiped when the password gate locks.
    queryKey: ["run-entries", runId, user?.id],
    queryFn: () => fetchRunEntries({ id: user!.id, isDemo: user!.isDemo }, runId),
    enabled: user !== null,
  });
  const table = useMemo(
    () => (query.data ? tableFromRun(query.data, company) : null),
    [query.data, company],
  );

  if (query.isPending) {
    return (
      <div aria-busy="true" aria-label="Loading the run" className="space-y-2">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-9" />
        ))}
      </div>
    );
  }
  if (query.isError) {
    return <ErrorState failure={classifyDataError(query.error)} onRetry={() => query.refetch()} />;
  }
  if (!table || table.rows.length === 0) {
    return <EmptyState title="This run has no employees" className="py-10" />;
  }
  return <>{children(table)}</>;
}

// ---------------------------------------------------------------- the page

export function TransferPage() {
  const { user } = useAuth();
  const { current } = useCompany();
  const [params] = useSearchParams();
  const batch = useStore(heldBatch);

  const [choice, setChoice] = useState<SourceChoice | null>(() => {
    const runId = params.get("run");
    if (runId) return { kind: "run", runId };
    return heldBatch.get() ? { kind: "received" } : null;
  });
  // Arriving with a source already chosen (from History, or from received data) skips step 1.
  const [state, setState] = useState<WizardState>(() => ({ ...FRESH, step: choice ? 1 : 0 }));
  const [reached, setReached] = useState(state.step);
  const update = (patch: Partial<WizardState>) => {
    setState((previous) => ({ ...previous, ...patch }));
    if (patch.step !== undefined) setReached((r) => Math.max(r, patch.step!));
  };

  const runs = useQuery({
    queryKey: ["runs", current?.company.id, user?.id],
    queryFn: () => fetchRuns({ id: user!.id, isDemo: user!.isDemo }, current!.company.id),
    enabled: user !== null && current !== null,
  });

  const choose = (next: SourceChoice | null) => {
    setChoice(next);
    // A different source means different rows and columns: start the later steps afresh.
    setState({ ...FRESH });
    setReached(0);
  };

  const run = choice?.kind === "run" ? runs.data?.find((r) => r.id === choice.runId) : undefined;
  const receivedTable = useMemo(
    () => (batch ? tableFromReceived(batch.payload.rows) : null),
    [batch],
  );
  const sender = batch ? getApp(batch.appId) : undefined;

  const sourceReady =
    choice?.kind === "run"
      ? run !== undefined && current !== null
      : choice?.kind === "received" && batch !== null;

  return (
    <>
      <PageHeader
        title="Transfer"
        description="Pick rows and columns, map them to what an app expects, check the result, and send."
        actions={<UnlockStatus />}
      />

      <section className="glass mt-8 space-y-6 rounded-2xl p-5 sm:p-6">
        <Stepper
          step={state.step}
          reached={reached}
          onGo={(step) => update({ step, send: FRESH.send })}
        />

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={state.step}
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -12 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="space-y-6"
          >
            {state.step === 0 && (
              <>
                <div
                  role="radiogroup"
                  aria-label="Where the data comes from"
                  className="grid gap-3 lg:grid-cols-2"
                >
                  <div
                    className={cn(
                      "rounded-xl border p-4",
                      choice?.kind === "run"
                        ? "border-accent bg-accent/10"
                        : "border-line bg-surface",
                    )}
                  >
                    <label className="flex cursor-pointer items-start gap-3">
                      <input
                        type="radio"
                        name="transfer-source"
                        className="mt-1 size-4 accent-(--accent)"
                        checked={choice?.kind === "run"}
                        disabled={!runs.data?.length}
                        onChange={() => choose({ kind: "run", runId: runs.data![0]!.id })}
                      />
                      <span>
                        <span className="flex items-center gap-2 font-medium">
                          <Database className="size-4 text-accent" aria-hidden="true" />A saved run
                        </span>
                        <span className="mt-1 block text-sm text-muted">
                          A payroll run stored in the database
                          {current && ` for ${current.company.name}`}. You'll be asked for your
                          password.
                        </span>
                      </span>
                    </label>
                    <div className="mt-3 pl-7">
                      {!current ? (
                        <p className="text-sm text-subtle">No company is selected.</p>
                      ) : runs.isPending ? (
                        <Skeleton className="h-10 w-56" />
                      ) : runs.isError ? (
                        <p className="text-sm text-danger">{classifyDataError(runs.error).title}</p>
                      ) : runs.data.length === 0 ? (
                        <p className="text-sm text-subtle">This company has no saved runs yet.</p>
                      ) : (
                        <select
                          aria-label="Run to send"
                          className={SELECT}
                          value={choice?.kind === "run" && run ? run.id : ""}
                          onChange={(event) =>
                            choose(
                              event.target.value
                                ? { kind: "run", runId: event.target.value }
                                : null,
                            )
                          }
                        >
                          <option value="">Choose a run</option>
                          {runs.data.map((r) => (
                            <option key={r.id} value={r.id}>
                              {formatPeriod(r.period)} ({r.status}, {formatCount(r.entryCount)}{" "}
                              employees)
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  </div>

                  <div
                    className={cn(
                      "rounded-xl border p-4",
                      choice?.kind === "received"
                        ? "border-accent bg-accent/10"
                        : "border-line bg-surface",
                      !batch && "opacity-70",
                    )}
                  >
                    <label className={cn("flex items-start gap-3", batch && "cursor-pointer")}>
                      <input
                        type="radio"
                        name="transfer-source"
                        className="mt-1 size-4 accent-(--accent)"
                        checked={choice?.kind === "received"}
                        disabled={!batch}
                        onChange={() => choose({ kind: "received" })}
                      />
                      <span>
                        <span className="flex items-center gap-2 font-medium">
                          <Inbox className="size-4 text-accent" aria-hidden="true" />
                          Data just received from an app
                        </span>
                        <span className="mt-1 block text-sm text-muted">
                          {batch
                            ? `${formatCount(batch.payload.rows.length)} rows from ${sender?.name ?? batch.appId}, received at ${timeFormat.format(batch.receivedAt)}. Held in memory only.`
                            : 'Nothing is being held. When the payroll app sends results, choose "Send to…" then "Choose rows and columns" to bring them here.'}
                        </span>
                      </span>
                    </label>
                    {batch && (
                      <div className="mt-3 pl-7">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            heldBatch.set(null);
                            if (choice?.kind === "received") choose(null);
                          }}
                        >
                          <Trash2 aria-hidden="true" />
                          Discard this data
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
                <StepNav
                  onNext={() => update({ step: 1 })}
                  blocked={sourceReady ? null : "Choose where the data comes from."}
                />
              </>
            )}

            {state.step > 0 && choice?.kind === "received" && batch && receivedTable && (
              <Steps
                table={receivedTable}
                source={{ label: sender?.name ?? batch.appId, gated: false }}
                dataType={batch.payload.dataType}
                meta={batch.payload.meta}
                sourceApp={sender}
                state={state}
                update={update}
              />
            )}

            {state.step > 0 && choice?.kind === "run" && current && run && (
              // Rows of a saved run only load, and only stay in memory, while the gate is open.
              <PasswordGate what="A saved run">
                <RunSource runId={run.id} company={current.company}>
                  {(table) => (
                    <Steps
                      table={table}
                      source={{ label: `Database, ${formatPeriod(run.period)}`, gated: true }}
                      dataType={PAYROLL_RESULT}
                      meta={{ period: run.period.slice(0, 7), label: current.company.name }}
                      state={state}
                      update={update}
                    />
                  )}
                </RunSource>
              </PasswordGate>
            )}

            {state.step > 0 && !sourceReady && (
              <>
                {choice?.kind === "run" && runs.isPending ? (
                  <Skeleton className="h-40" />
                ) : (
                  <EmptyState title="That source is no longer available" className="py-10">
                    The run may belong to another company, or the received data was discarded.
                    Choose a source again.
                  </EmptyState>
                )}
                <StepNav onBack={() => update({ step: 0 })} />
              </>
            )}
          </motion.div>
        </AnimatePresence>
      </section>
    </>
  );
}
