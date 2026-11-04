import { useEffect, useId, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import {
  CircleAlert,
  Download,
  FileSpreadsheet,
  LoaderCircle,
  RotateCcw,
  TriangleAlert,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/misc";
import { useAuth } from "@/features/auth/auth-context";
import { classifyDataError } from "@/lib/supabase/errors";
import { useStore } from "@/lib/store";
import { downloadBytes, XLSX_TYPE } from "@/lib/xlsx/writeXlsx";
import { useCompany } from "./company-context";
import {
  buildReport,
  buildTemplate,
  importCompaniesOpen,
  loadImportChoices,
  previewRows,
  readCompaniesFile,
  reportFileName,
  runImport,
  TEMPLATE_FILE_NAME,
  type ImportChoices,
  type PreviewRow,
  type ReportLine,
} from "./companyImport";

const SELECT_CLASS =
  "h-10 w-full rounded-lg border border-line bg-surface px-2.5 text-sm text-fg shadow-inner-glow hover:border-line-strong disabled:opacity-50";
const CHECKBOX_CLASS =
  "size-4 cursor-pointer rounded accent-(--accent) disabled:cursor-not-allowed";
const NO_SETUP = "";

type Step =
  | { kind: "choose"; why: string | null; reading: boolean }
  | { kind: "preview"; fileName: string; rows: PreviewRow[] }
  | { kind: "running"; done: number; total: number }
  | { kind: "report"; lines: ReportLine[] };

type Choices =
  | { status: "loading" }
  | { status: "error"; title: string; message: string }
  | { status: "ready"; value: ImportChoices };

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

function Problem({ title, message }: { title: string; message?: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-lg border border-danger/30 bg-danger/10 p-3.5 text-sm"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
      <div>
        <p className="font-medium text-fg">{title}</p>
        {message && <p className="mt-1 text-muted">{message}</p>}
      </div>
    </div>
  );
}

const STATUS_BADGE: Record<
  PreviewRow["status"],
  { tone: "accent" | "neutral" | "warn" | "danger"; text: string }
> = {
  new: { tone: "accent", text: "New" },
  existing: { tone: "neutral", text: "Already in the dashboard" },
  twice: { tone: "warn", text: "Twice in the file" },
  problem: { tone: "danger", text: "Problem" },
};

/** What the preview says under a row. */
function rowNote(item: PreviewRow): { text: string; tone: "muted" | "warn" | "danger" } | null {
  switch (item.status) {
    case "problem":
      return { text: `Not created: ${item.row.problems.join(" ")}`, tone: "danger" };
    case "existing":
      return { text: `Skipped: ${item.existingName} already has this BRN.`, tone: "muted" };
    case "twice":
      return {
        text: `Skipped: same BRN as row ${item.sameAs?.[0]}, which is created instead.`,
        tone: "warn",
      };
    case "new": {
      const notes: string[] = [];
      if (item.row.warning) notes.push(item.row.warning);
      if (item.sameAs) {
        notes.push(
          `Also on ${item.sameAs.length === 1 ? "row" : "rows"} ${item.sameAs.join(", ")}: this row is created, the other skipped.`,
        );
      }
      return notes.length > 0
        ? { text: notes.join(" "), tone: item.row.warning ? "warn" : "muted" }
        : null;
    }
  }
}

/** The details a new row will be created with, in a few words. */
function rowDetails(item: PreviewRow): string {
  const { row } = item;
  const parts: string[] = [];
  if (row.address) parts.push(row.address);
  if (row.vat) parts.push(`VAT ${row.vat}`);
  for (const detail of row.details) parts.push(`${detail.label} ${detail.value}`);
  if (row.mra.ern) parts.push(`ERN ${row.mra.ern}`);
  if (row.mra.telephone) parts.push(`Tel. ${row.mra.telephone}`);
  if (row.mra.mobile) parts.push(`Mobile ${row.mra.mobile}`);
  if (row.mra.declarant) parts.push(`Declarant ${row.mra.declarant}`);
  return parts.join(" · ");
}

function ChooseStep({
  step,
  onFile,
}: {
  step: Extract<Step, { kind: "choose" }>;
  onFile: (file: File) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();
  return (
    <div className="mt-5 space-y-4">
      <ol className="list-decimal space-y-3 pl-5 text-sm text-muted">
        <li>
          <p>
            Download the template and fill in its Companies sheet, one row per company. Company name
            and BRN are required; the Read me sheet explains every column.
          </p>
          <Button
            className="mt-2"
            onClick={() => downloadBytes(buildTemplate(), TEMPLATE_FILE_NAME, XLSX_TYPE)}
          >
            <Download aria-hidden="true" />
            Download the companies template
          </Button>
        </li>
        <li>
          <p>
            Upload the filled-in file. You see what will happen to each row before anything is
            saved.
          </p>
          <input
            ref={input}
            id={inputId}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) onFile(file);
            }}
          />
          <Button
            variant="primary"
            className="mt-2"
            disabled={step.reading}
            onClick={() => input.current?.click()}
          >
            {step.reading ? (
              <LoaderCircle className="animate-spin" aria-hidden="true" />
            ) : (
              <Upload aria-hidden="true" />
            )}
            {step.reading ? "Reading the file" : "Choose the filled-in file"}
          </Button>
        </li>
      </ol>
      {step.why && <Problem title="This file can't be imported" message={step.why} />}
    </div>
  );
}

function Options({
  choices,
  setupId,
  onSetup,
  useTemplates,
  onTemplates,
  onRetry,
  disabled,
}: {
  choices: Choices;
  setupId: string;
  onSetup: (id: string) => void;
  useTemplates: boolean;
  onTemplates: (value: boolean) => void;
  onRetry: () => void;
  disabled: boolean;
}) {
  const setupLabel = useId();
  if (choices.status === "loading") {
    return (
      <p className="flex items-center gap-2 text-sm text-muted">
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        Reading your column setups and MRA templates
      </p>
    );
  }
  if (choices.status === "error") {
    return (
      <div className="space-y-2">
        <Problem title={choices.title} message={choices.message} />
        <Button size="sm" onClick={onRetry}>
          <RotateCcw aria-hidden="true" />
          Try again
        </Button>
      </div>
    );
  }
  const { setups, templates } = choices.value;
  const names = templates.map((template) => template.name).join(" and ");
  return (
    <div className="grid gap-4 rounded-lg border border-line bg-surface p-4 sm:grid-cols-2">
      <div className="space-y-1.5">
        <label htmlFor={setupLabel} className="text-sm font-medium text-fg">
          Column setup of the new companies
        </label>
        <select
          id={setupLabel}
          className={SELECT_CLASS}
          value={setupId}
          disabled={disabled}
          onChange={(event) => onSetup(event.target.value)}
        >
          {setups.map((setup) => (
            <option key={setup.id} value={setup.id} disabled={!setup.canUse}>
              {setup.name} (used by{" "}
              {plural(setup.companies, "of your companies", "of your companies")})
              {setup.canUse ? "" : ": you're not an admin of every company using it"}
            </option>
          ))}
          <option value={NO_SETUP}>None yet</option>
        </select>
        <p className="text-xs text-muted">
          {setupId === NO_SETUP
            ? "The payroll app asks for a column setup the first time each company is opened."
            : "Shared: the new companies use its identity fields and Global columns, with no columns of their own yet."}
        </p>
      </div>
      <div className="space-y-1.5">
        <label className="flex items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            className={`${CHECKBOX_CLASS} mt-0.5`}
            checked={useTemplates && templates.length > 0}
            disabled={disabled || templates.length === 0}
            onChange={(event) => onTemplates(event.target.checked)}
          />
          <span>
            <span className="font-medium text-fg">Use the ready-made MRA templates</span>
            <span className="mt-1 block text-xs text-muted">
              {templates.length > 0
                ? `${names}, shared with the new companies as "Use them for all my companies" does in MRA Returns.`
                : "None of your companies uses them yet. Add them once in MRA Returns (Add the ready-made MRA templates), then import."}
            </span>
          </span>
        </label>
      </div>
    </div>
  );
}

function PreviewTable({
  rows,
  onTick,
  disabled,
}: {
  rows: PreviewRow[];
  onTick: (line: number, ticked: boolean) => void;
  disabled: boolean;
}) {
  return (
    <div className="max-h-[46vh] overflow-auto rounded-lg border border-line">
      <table className="w-full text-left text-sm">
        <thead className="sticky top-0 z-10 bg-elevated text-xs text-muted">
          <tr className="border-b border-line">
            <th scope="col" className="w-10 px-3 py-2">
              <span className="sr-only">Create</span>
            </th>
            <th scope="col" className="w-12 px-2 py-2">
              Row
            </th>
            <th scope="col" className="px-2 py-2">
              Company
            </th>
            <th scope="col" className="px-2 py-2">
              BRN
            </th>
            <th scope="col" className="px-2 py-2">
              What happens
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => {
            const note = rowNote(item);
            const badge = STATUS_BADGE[item.status];
            const details = item.status === "new" ? rowDetails(item) : "";
            return (
              <tr key={item.row.line} className="border-b border-line align-top last:border-b-0">
                <td className="px-3 py-2.5">
                  <input
                    type="checkbox"
                    className={CHECKBOX_CLASS}
                    aria-label={`Create row ${item.row.line}${item.row.name ? `, ${item.row.name}` : ""}`}
                    checked={item.ticked}
                    disabled={disabled || item.status !== "new"}
                    onChange={(event) => onTick(item.row.line, event.target.checked)}
                  />
                </td>
                <td className="tabular px-2 py-2.5 text-muted">{item.row.line}</td>
                <td className="px-2 py-2.5">
                  <span className="font-medium text-fg">{item.row.name || "(no name)"}</span>
                  {details && <span className="mt-0.5 block text-xs text-muted">{details}</span>}
                </td>
                <td className="tabular px-2 py-2.5 whitespace-nowrap">
                  {item.row.brn || "(no BRN)"}
                </td>
                <td className="px-2 py-2.5">
                  <Badge tone={badge.tone}>{badge.text}</Badge>
                  {note && (
                    <p
                      className={`mt-1 text-xs ${note.tone === "danger" ? "text-danger" : note.tone === "warn" ? "text-warn" : "text-muted"}`}
                    >
                      {note.text}
                    </p>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ReportStep({ lines, onClose }: { lines: ReportLine[]; onClose: () => void }) {
  const count = (result: ReportLine["result"]) =>
    lines.filter((line) => line.result === result).length;
  const created = count("Created");
  return (
    <div className="mt-5 space-y-4">
      <p className="text-sm text-fg" role="status">
        {plural(created, "company", "companies")} created, {count("Skipped")} skipped,{" "}
        {plural(count("Problem"), "problem")}.
        {created > 0 && " You are the admin of every company created."}
      </p>
      <div className="max-h-[50vh] overflow-auto rounded-lg border border-line">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-elevated text-xs text-muted">
            <tr className="border-b border-line">
              <th scope="col" className="w-12 px-3 py-2">
                Row
              </th>
              <th scope="col" className="px-2 py-2">
                Company
              </th>
              <th scope="col" className="px-2 py-2">
                BRN
              </th>
              <th scope="col" className="px-2 py-2">
                Result
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.line} className="border-b border-line align-top last:border-b-0">
                <td className="tabular px-3 py-2.5 text-muted">{line.line}</td>
                <td className="px-2 py-2.5 font-medium text-fg">{line.name || "(no name)"}</td>
                <td className="tabular px-2 py-2.5 whitespace-nowrap">{line.brn || "(no BRN)"}</td>
                <td className="px-2 py-2.5">
                  <Badge
                    tone={
                      line.result === "Created"
                        ? "accent"
                        : line.result === "Problem"
                          ? "danger"
                          : "neutral"
                    }
                  >
                    {line.result}
                  </Badge>
                  {line.why && <p className="mt-1 text-xs text-muted">{line.why}</p>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={() => downloadBytes(buildReport(lines), reportFileName(), XLSX_TYPE)}>
          <Download aria-hidden="true" />
          Download the report
        </Button>
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

function ImportFlow({ onDone, onBusy }: { onDone: () => void; onBusy: (busy: boolean) => void }) {
  const { user } = useAuth();
  const { memberships } = useCompany();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>({ kind: "choose", why: null, reading: false });
  const [choices, setChoices] = useState<Choices>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [setupId, setSetupId] = useState<string | null>(null);
  const [useTemplates, setUseTemplates] = useState(true);
  const viewer = user ? { id: user.id, isDemo: user.isDemo } : null;
  const running = step.kind === "running";

  useEffect(() => {
    onBusy(running);
    return () => onBusy(false);
  }, [running, onBusy]);

  // What the new companies can be given, read once the dialog opens (and on "Try again").
  useEffect(() => {
    if (!viewer) return;
    let live = true;
    loadImportChoices(viewer, memberships).then(
      (value) => {
        if (!live) return;
        setChoices({ status: "ready", value });
        setSetupId((current) => current ?? value.defaultSetupId ?? NO_SETUP);
      },
      (error: unknown) => {
        if (!live) return;
        const problem = classifyDataError(error);
        setChoices({
          status: "error",
          title: "Your column setups and MRA templates couldn't be read",
          message: problem.message,
        });
      },
    );
    return () => {
      live = false;
    };
    // Read again only on "Try again"; the memberships are those of when the dialog opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, user?.id]);

  const readFile = async (file: File) => {
    setStep({ kind: "choose", why: null, reading: true });
    try {
      const result = await readCompaniesFile(file);
      if (!result.ok) return setStep({ kind: "choose", why: result.why, reading: false });
      setStep({
        kind: "preview",
        fileName: file.name,
        rows: previewRows(result.rows, memberships),
      });
    } catch {
      setStep({
        kind: "choose",
        why: "The file couldn't be read. Save it again in Excel as .xlsx and try again.",
        reading: false,
      });
    }
  };

  const create = async (rows: PreviewRow[]) => {
    if (!viewer || choices.status !== "ready") return;
    const chosen = {
      sharedSetupId: setupId === NO_SETUP ? null : setupId,
      mraTemplateIds: useTemplates ? choices.value.templates.map((template) => template.id) : [],
    };
    setStep({ kind: "running", done: 0, total: 0 });
    const lines = await runImport(viewer, rows, chosen, (done, total) =>
      setStep({ kind: "running", done, total }),
    );
    const created = lines.filter((line) => line.result === "Created").length;
    if (created > 0) await queryClient.invalidateQueries({ queryKey: ["memberships"] });
    toast.success(`${plural(created, "company", "companies")} created`, {
      description: "The report says what happened to every row.",
    });
    setStep({ kind: "report", lines });
  };

  if (step.kind === "choose")
    return <ChooseStep step={step} onFile={(file) => void readFile(file)} />;
  if (step.kind === "report") return <ReportStep lines={step.lines} onClose={onDone} />;

  if (step.kind === "running") {
    return (
      <p className="mt-6 flex items-center gap-2 text-sm text-fg" role="status">
        <LoaderCircle className="size-4 animate-spin text-accent" aria-hidden="true" />
        {step.total === 0
          ? "Starting"
          : `Creating ${Math.min(step.done + 1, step.total)} of ${step.total}`}
        . Keep this window open.
      </p>
    );
  }

  const ticked = step.rows.filter((item) => item.ticked).length;
  const counts = (status: PreviewRow["status"]) =>
    step.rows.filter((item) => item.status === status).length;
  const setupChosen = choices.status === "ready" && setupId !== null;
  return (
    <div className="mt-5 space-y-4">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
        <FileSpreadsheet className="size-4 text-accent" aria-hidden="true" />
        <span className="font-medium text-fg">{step.fileName}</span>
        <span>
          {plural(step.rows.length, "row")}: {counts("new")} new, {counts("existing")} already in
          the dashboard, {counts("twice")} twice in the file, {plural(counts("problem"), "problem")}
          .
        </span>
      </p>
      <Options
        choices={choices}
        setupId={setupId ?? NO_SETUP}
        onSetup={setSetupId}
        useTemplates={useTemplates}
        onTemplates={setUseTemplates}
        onRetry={() => {
          setChoices({ status: "loading" });
          setAttempt((n) => n + 1);
        }}
        disabled={false}
      />
      <PreviewTable
        rows={step.rows}
        disabled={false}
        onTick={(line, value) =>
          setStep({
            ...step,
            rows: step.rows.map((item) =>
              item.row.line === line ? { ...item, ticked: value } : item,
            ),
          })
        }
      />
      {step.rows.some((item) => item.row.warning) && (
        <p className="flex items-start gap-2 text-xs text-warn">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />A BRN that
          doesn't look like one is not ticked. Tick it if it is right.
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <Button
          variant="ghost"
          onClick={() => setStep({ kind: "choose", why: null, reading: false })}
        >
          Choose another file
        </Button>
        <div className="flex gap-2">
          <Dialog.Close asChild>
            <Button>Cancel</Button>
          </Dialog.Close>
          <Button
            variant="primary"
            disabled={ticked === 0 || !setupChosen}
            onClick={() => void create(step.rows)}
          >
            {ticked === 1 ? "Create 1 company" : `Create ${ticked} companies`}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * The "Import companies from Excel" dialog. Rendered once in the app shell and opened through
 * `importCompaniesOpen`. Offered only to users who are already an admin somewhere; the database
 * function enforces that rule itself, so this is a courtesy, not the check.
 */
export function ImportCompaniesDialog() {
  const open = useStore(importCompaniesOpen);
  const [busy, setBusy] = useState(false);
  const { canAddCompany } = useCompany();
  if (!canAddCompany) return null;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!busy) importCompaniesOpen.set(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          className="fixed top-1/2 left-1/2 z-50 max-h-[94vh] w-[min(94vw,60rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-line-strong bg-elevated p-6 shadow-pop outline-none"
          // A click outside never closes it: the preview would be lost.
          onPointerDownOutside={(event) => event.preventDefault()}
          // Nor does Escape while companies are being created.
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <div className="flex items-start gap-4">
            <span className="grid size-11 shrink-0 place-items-center rounded-full border border-accent/30 bg-accent/10">
              <FileSpreadsheet className="size-5 text-accent" aria-hidden="true" />
            </span>
            <div>
              <Dialog.Title className="text-lg font-semibold">
                Import companies from Excel
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-muted">
                Creates many companies with their details at once. You become the admin of every
                company created.
              </Dialog.Description>
            </div>
          </div>
          {/* Mounted only while open, so it starts afresh every time. */}
          <ImportFlow onDone={() => importCompaniesOpen.set(false)} onBusy={setBusy} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
