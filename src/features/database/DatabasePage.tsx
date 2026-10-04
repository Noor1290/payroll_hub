import { useCallback, useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Braces,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ChevronsUpDown,
  Copy,
  Eye,
  EyeOff,
  LoaderCircle,
  RotateCw,
  Search,
  ShieldAlert,
  X,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Badge, Skeleton } from "@/components/ui/misc";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { useAuth } from "@/features/auth/auth-context";
import { CompanyGate } from "@/features/company/CompanyGate";
import { PasswordGate, UnlockStatus } from "@/features/unlock/PasswordGate";
import { formatCount } from "@/lib/format";
import { refreshSeconds } from "@/lib/preferences";
import { useStore } from "@/lib/store";
import {
  DB_TABLE_NAMES,
  DB_TABLES,
  fetchTableCounts,
  fetchTablePage,
  OPTIONAL_TABLES,
  PAGE_SIZES,
  type DbColumn,
  type DbRow,
  type DbTable,
  type DbTableName,
  type TableQuery,
} from "@/lib/supabase/database";
import { classifyDataError, type DataFailure } from "@/lib/supabase/errors";
import type { Company } from "@/lib/supabase/schemas";
import { isUnlocked } from "@/lib/unlock";
import { cn } from "@/lib/utils";
import { cellKey, cellText, hasSensitiveColumns, MASK, rowJson } from "./view";

const SEARCH_DELAY_MS = 350;
const clock = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const SELECT =
  "h-9 rounded-lg border border-line bg-surface px-2.5 text-sm text-fg shadow-inner-glow hover:border-line-strong";

/** Page, sort and search for one table. Kept per table, so switching tabs loses nothing. */
type View = Pick<TableQuery, "page" | "pageSize" | "sort" | "search">;

const initialView = (table: DbTable): View => ({
  page: 0,
  pageSize: 50,
  sort: table.defaultSort,
  search: "",
});

/** Reads are refused the moment the gate is locked, even if one was already on its way. */
function whileUnlocked<T>(read: () => Promise<T>): Promise<T> {
  if (!isUnlocked()) return Promise.reject(new Error("The database viewer is locked."));
  return read();
}

/** A missing table is explained by naming the migration that creates it. */
function tableFailure(name: DbTableName, error: unknown): DataFailure {
  const failure = classifyDataError(error);
  const migration = OPTIONAL_TABLES[name];
  return failure.kind === "not-set-up" && migration
    ? {
        ...failure,
        title: `${name} isn't in the database yet`,
        message: `The owner needs to run supabase/migrations/${migration} once in the Supabase SQL editor.`,
      }
    : failure;
}

// ---------------------------------------------------------------- JSON panel

function JsonPanel({
  table,
  row,
  startRevealed,
  onClose,
}: {
  table: DbTable;
  row: DbRow;
  startRevealed: boolean;
  onClose: () => void;
}) {
  const [revealed, setRevealed] = useState(startRevealed);
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  const json = rowJson(table, row, () => revealed);
  const sensitive = hasSensitiveColumns(table);

  const copy = async () => {
    try {
      // Copies exactly what is on screen: masked values stay masked.
      await navigator.clipboard.writeText(json);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 right-0 z-50 flex w-[min(100vw,36rem)] flex-col border-l border-line-strong bg-elevated shadow-pop outline-none"
        >
          <div className="flex items-center gap-3 border-b border-line px-5 py-4">
            <Braces className="size-4 shrink-0 text-accent" aria-hidden="true" />
            <Dialog.Title className="min-w-0 flex-1 truncate font-semibold">
              <span className="tabular">{table.name}</span> row
              {row.__deleted && (
                <Badge tone="danger" className="ml-2">
                  deleted
                </Badge>
              )}
            </Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              className="grid size-9 place-items-center rounded-lg text-muted hover:bg-surface-hover hover:text-fg"
            >
              <X className="size-4" aria-hidden="true" />
            </Dialog.Close>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
            <Badge>Read only</Badge>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {sensitive && (
                <Button
                  size="sm"
                  aria-pressed={revealed}
                  onClick={() => {
                    setRevealed((value) => !value);
                    setCopied(null);
                  }}
                >
                  {revealed ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                  {revealed ? "Hide sensitive" : "Reveal sensitive"}
                </Button>
              )}
              <Button size="sm" onClick={() => void copy()}>
                {copied === "yes" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                {copied === "yes" ? "Copied" : "Copy"}
              </Button>
            </div>
            <p role="status" className="basis-full text-xs text-muted empty:hidden">
              {copied === "yes" &&
                (sensitive && !revealed
                  ? "Copied as shown: sensitive values are still masked."
                  : "Copied to the clipboard.")}
              {copied === "failed" && "This browser didn't allow copying. Select the text instead."}
            </p>
          </div>

          <pre
            tabIndex={0}
            aria-label={`${table.name} row as JSON`}
            className="tabular min-h-0 flex-1 overflow-auto p-5 text-[13px] leading-relaxed whitespace-pre-wrap break-words text-fg"
          >
            {json}
          </pre>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------- one table

function Cell({
  column,
  row,
  revealed,
  onToggle,
}: {
  column: DbColumn;
  row: DbRow;
  revealed: boolean;
  onToggle: () => void;
}) {
  const value = row[column.key];
  const empty = value === null || value === undefined;

  if (column.sensitive) {
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-label={revealed ? `Hide ${column.key}` : `${column.key} is hidden. Reveal it`}
        className={cn(
          "rounded hover:text-fg",
          revealed ? (empty ? "text-subtle" : "text-fg") : "tracking-widest text-subtle",
        )}
      >
        {revealed ? cellText(column, value) : MASK}
      </button>
    );
  }
  if (empty) return <span className="text-subtle">null</span>;
  if (column.kind === "id") return <span title={String(value)}>{cellText(column, value)}</span>;
  return <>{cellText(column, value)}</>;
}

interface TablePanelProps {
  table: DbTable;
  company: Company;
  view: View;
  onView: (patch: Partial<View>) => void;
  showDeleted: boolean;
  onShowDeleted: (value: boolean) => void;
  revealAll: boolean;
  onRevealAll: (value: boolean) => void;
}

function TablePanel({
  table,
  company,
  view,
  onView,
  showDeleted,
  onShowDeleted,
  revealAll,
  onRevealAll,
}: TablePanelProps) {
  const { user } = useAuth();
  const seconds = useStore(refreshSeconds);
  const [searchText, setSearchText] = useState(view.search);
  // Cells revealed one by one. Local to this panel, so it is gone when the page locks.
  const [revealedCells, setRevealedCells] = useState<ReadonlySet<string>>(new Set());
  const [jsonRow, setJsonRow] = useState<DbRow | null>(null);

  // Wait for a pause in typing before asking the server.
  useEffect(() => {
    if (searchText === view.search) return;
    const timer = setTimeout(() => onView({ search: searchText, page: 0 }), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [searchText, view.search, onView]);

  const query = useQuery({
    // Everything under "db" is wiped from memory when the password gate locks.
    queryKey: ["db", "rows", table.name, company.id, user?.id, view, showDeleted],
    queryFn: () =>
      whileUnlocked(() =>
        fetchTablePage({ id: user!.id, isDemo: user!.isDemo }, table.name, company.id, {
          ...view,
          showDeleted,
        }),
      ),
    enabled: user !== null,
    // Keep showing the current rows while the next read is on its way: no flicker, no jump.
    placeholderData: keepPreviousData,
    staleTime: 0,
    refetchInterval: seconds * 1000,
    // No polling while the browser tab is hidden.
    refetchIntervalInBackground: false,
  });

  const isRevealed = (row: DbRow, column: string) =>
    revealAll !== revealedCells.has(cellKey(row.__key, column));
  const toggleCell = (row: DbRow, column: string) =>
    setRevealedCells((current) => {
      const next = new Set(current);
      const key = cellKey(row.__key, column);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const sensitive = hasSensitiveColumns(table);
  const total = query.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / view.pageSize));
  const first = total === 0 ? 0 : view.page * view.pageSize + 1;
  const last = Math.min(total, (view.page + 1) * view.pageSize);
  const refreshing = query.isFetching && !query.isPending;
  const searchHint =
    table.name === "payroll_entries"
      ? "Search by employee name or ID"
      : table.name === "payroll_runs"
        ? "Search status, or a month like 2026-09"
        : "Search";

  const sortBy = (column: DbColumn) =>
    onView({
      page: 0,
      sort: {
        column: column.key,
        ascending: view.sort.column === column.key ? !view.sort.ascending : true,
      },
    });

  return (
    <div
      role="tabpanel"
      id={`db-panel-${table.name}`}
      aria-labelledby={`db-tab-${table.name}`}
      className="flex min-h-0 flex-col"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
        <label className="relative min-w-52 flex-1 sm:max-w-xs">
          <span className="sr-only">{searchHint}</span>
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle"
            aria-hidden="true"
          />
          <input
            type="search"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder={searchHint}
            className="h-9 w-full rounded-lg border border-line bg-surface pr-3 pl-9 text-sm shadow-inner-glow placeholder:text-subtle hover:border-line-strong"
          />
        </label>

        {table.canBeDeleted && (
          <label className="flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-3 text-sm shadow-inner-glow">
            <input
              type="checkbox"
              className="size-4 rounded accent-(--accent)"
              checked={showDeleted}
              onChange={(event) => {
                onShowDeleted(event.target.checked);
                onView({ page: 0 });
              }}
            />
            Show deleted
          </label>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <p className="flex items-center gap-1.5 text-xs text-muted" aria-live="off">
            {refreshing && (
              <LoaderCircle className="size-3.5 animate-spin text-accent" aria-label="Refreshing" />
            )}
            {query.dataUpdatedAt > 0 && (
              <>
                Updated{" "}
                <time className="tabular" dateTime={new Date(query.dataUpdatedAt).toISOString()}>
                  {clock.format(query.dataUpdatedAt)}
                </time>
              </>
            )}
          </p>
          <Button size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>
            <RotateCw className={cn(refreshing && "animate-spin")} aria-hidden="true" />
            Refresh
          </Button>
          {sensitive && (
            <Button
              size="sm"
              aria-pressed={revealAll}
              onClick={() => {
                onRevealAll(!revealAll);
                setRevealedCells(new Set());
              }}
            >
              {revealAll ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
              {revealAll ? "Hide all" : "Reveal all"}
            </Button>
          )}
        </div>
      </div>

      {query.isPending ? (
        <div aria-busy="true" aria-label={`Loading ${table.name}`} className="space-y-2 p-3">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-9" />
          ))}
        </div>
      ) : query.isError ? (
        <ErrorState
          failure={tableFailure(table.name, query.error)}
          onRetry={() => void query.refetch()}
          className="m-3"
        />
      ) : (
        <>
          {/* The table scrolls inside this box, never the page. */}
          <div className="max-h-[min(60vh,40rem)] min-h-0 overflow-auto">
            <table className="w-full border-separate border-spacing-0 text-sm">
              <caption className="sr-only">
                {table.name} rows for {company.name}, read only
              </caption>
              <thead>
                <tr>
                  {table.columns.map((column) => {
                    const sorted = view.sort.column === column.key;
                    const sortable = column.kind !== "json";
                    const Icon = !sorted
                      ? ChevronsUpDown
                      : view.sort.ascending
                        ? ArrowUp
                        : ArrowDown;
                    return (
                      <th
                        key={column.key}
                        scope="col"
                        aria-sort={
                          sorted ? (view.sort.ascending ? "ascending" : "descending") : "none"
                        }
                        className={cn(
                          "tabular sticky top-0 z-10 border-b border-line bg-elevated px-3 py-2.5 text-left text-xs font-medium whitespace-nowrap text-muted",
                          column.kind === "money" && "text-right",
                        )}
                      >
                        {sortable ? (
                          <button
                            type="button"
                            onClick={() => sortBy(column)}
                            className="inline-flex items-center gap-1 rounded hover:text-fg"
                          >
                            {column.key}
                            <Icon
                              className={cn("size-3.5", sorted ? "text-accent" : "text-subtle")}
                              aria-hidden="true"
                            />
                          </button>
                        ) : (
                          column.key
                        )}
                      </th>
                    );
                  })}
                  <th
                    scope="col"
                    className="sticky top-0 right-0 z-20 border-b border-line bg-elevated px-3 py-2.5"
                  >
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {query.data.rows.map((row) => (
                  <tr
                    key={row.__key}
                    className={cn("hover:bg-surface-hover", row.__deleted && "opacity-70")}
                  >
                    {table.columns.map((column, index) => (
                      <td
                        key={column.key}
                        className={cn(
                          "border-b border-line px-3 py-2 whitespace-nowrap",
                          column.kind !== "text" && "tabular",
                          column.kind === "money" && "text-right",
                        )}
                      >
                        {index === 0 && row.__deleted && (
                          <Badge tone="danger" className="mr-2">
                            {table.name === "payroll_entries" ? "run deleted" : "deleted"}
                          </Badge>
                        )}
                        <Cell
                          column={column}
                          row={row}
                          revealed={!!column.sensitive && isRevealed(row, column.key)}
                          onToggle={() => toggleCell(row, column.key)}
                        />
                      </td>
                    ))}
                    <td className="sticky right-0 border-b border-line bg-elevated px-2 py-1.5 text-right">
                      <Button size="sm" variant="ghost" onClick={() => setJsonRow(row)}>
                        <Braces aria-hidden="true" />
                        View JSON
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {query.data.rows.length === 0 &&
              (view.page > 0 ? (
                <EmptyState
                  title="This page no longer exists"
                  action={<Button onClick={() => onView({ page: 0 })}>Go to the first page</Button>}
                >
                  Rows were removed since it was opened.
                </EmptyState>
              ) : (
                <EmptyState title={view.search ? "No rows match" : `No rows in ${table.name}`}>
                  {view.search
                    ? "Clear the search to see every row."
                    : `${company.name} has nothing in this table${
                        table.canBeDeleted && !showDeleted
                          ? ' (apart from, possibly, deleted rows: tick "Show deleted")'
                          : ""
                      }.`}
                </EmptyState>
              ))}
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-3 py-2.5 text-sm text-muted">
            <p aria-live="polite">
              Rows{" "}
              <span className="tabular text-fg">
                {formatCount(first)}–{formatCount(last)}
              </span>{" "}
              of <span className="tabular text-fg">{formatCount(total)}</span>
            </p>
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              <select
                aria-label="Rows per page"
                className={cn(SELECT, "h-8")}
                value={view.pageSize}
                onChange={(event) => onView({ pageSize: Number(event.target.value), page: 0 })}
              >
                {PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size} per page
                  </option>
                ))}
              </select>
              <span className="tabular px-2">
                Page {formatCount(view.page + 1)} of {formatCount(pageCount)}
              </span>
              {(
                [
                  ["First page", ChevronsLeft, 0, view.page === 0],
                  ["Previous page", ChevronLeft, view.page - 1, view.page === 0],
                  ["Next page", ChevronRight, view.page + 1, view.page >= pageCount - 1],
                  ["Last page", ChevronsRight, pageCount - 1, view.page >= pageCount - 1],
                ] as const
              ).map(([label, Icon, target, disabled]) => (
                <Button
                  key={label}
                  size="icon"
                  variant="ghost"
                  aria-label={label}
                  disabled={disabled}
                  onClick={() => onView({ page: target })}
                >
                  <Icon aria-hidden="true" />
                </Button>
              ))}
            </div>
          </div>
        </>
      )}

      {jsonRow && (
        <JsonPanel
          table={table}
          row={jsonRow}
          startRevealed={revealAll}
          onClose={() => setJsonRow(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the viewer

/**
 * The tabs and tables. Only ever rendered inside the password gate, and keyed by company, so
 * everything in here (rows, what was revealed, search, page) is discarded when the gate locks
 * or the company changes.
 */
function DatabaseViewer({ company }: { company: Company }) {
  const { user } = useAuth();
  const seconds = useStore(refreshSeconds);
  const [active, setActive] = useState<DbTableName>("companies");
  const [views, setViews] = useState<Record<DbTableName, View>>(
    () =>
      Object.fromEntries(
        DB_TABLE_NAMES.map((name) => [name, initialView(DB_TABLES[name])]),
      ) as Record<DbTableName, View>,
  );
  const [showDeleted, setShowDeleted] = useState(false);
  const [revealAll, setRevealAll] = useState(false);

  const counts = useQuery({
    queryKey: ["db", "counts", company.id, user?.id, showDeleted],
    queryFn: () =>
      whileUnlocked(() =>
        fetchTableCounts({ id: user!.id, isDemo: user!.isDemo }, company.id, showDeleted),
      ),
    enabled: user !== null,
    placeholderData: keepPreviousData,
    staleTime: 0,
    refetchInterval: seconds * 1000,
    refetchIntervalInBackground: false,
  });

  const onView = useCallback(
    (patch: Partial<View>) =>
      setViews((current) => ({ ...current, [active]: { ...current[active], ...patch } })),
    [active],
  );
  const select = setActive;

  return (
    <section className="glass flex min-h-0 flex-col overflow-hidden rounded-2xl">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <div
          role="tablist"
          aria-label="Tables"
          className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
        >
          {DB_TABLE_NAMES.map((name) => {
            const selected = name === active;
            const count = counts.data?.[name];
            return (
              <button
                key={name}
                type="button"
                role="tab"
                id={`db-tab-${name}`}
                aria-selected={selected}
                aria-controls={`db-panel-${name}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => select(name)}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
                  const index = DB_TABLE_NAMES.indexOf(active);
                  const step = event.key === "ArrowRight" ? 1 : DB_TABLE_NAMES.length - 1;
                  const next = DB_TABLE_NAMES[(index + step) % DB_TABLE_NAMES.length]!;
                  select(next);
                  document.getElementById(`db-tab-${next}`)?.focus();
                }}
                className={cn(
                  "tabular flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-sm transition-colors",
                  selected
                    ? "bg-accent/10 text-fg shadow-inner-glow"
                    : "text-muted hover:bg-surface-hover hover:text-fg",
                )}
              >
                {name}
                <span
                  className="rounded-full border border-line bg-surface px-1.5 text-[11px] text-muted"
                  aria-label={
                    count === undefined
                      ? "counting rows"
                      : count === null
                        ? "not set up yet"
                        : `${count} rows`
                  }
                >
                  {count === undefined ? "…" : count === null ? "–" : formatCount(count)}
                </span>
              </button>
            );
          })}
        </div>
        <Badge>Read only</Badge>
      </div>

      {counts.isError && (
        <p role="alert" className="border-b border-line px-4 py-2 text-sm text-danger">
          Row counts unavailable: {classifyDataError(counts.error).title}
        </p>
      )}

      <TablePanel
        // A fresh panel per table: its revealed cells and open JSON panel don't carry over.
        key={active}
        table={DB_TABLES[active]}
        company={company}
        view={views[active]}
        onView={onView}
        showDeleted={showDeleted}
        onShowDeleted={setShowDeleted}
        revealAll={revealAll}
        onRevealAll={setRevealAll}
      />
    </section>
  );
}

function AdminsOnly({ companyName }: { companyName: string }) {
  return (
    <div className="glass rounded-2xl">
      <EmptyState
        illustration={
          <span className="grid size-12 place-items-center rounded-full border border-warn/30 bg-warn/10">
            <ShieldAlert className="size-5 text-warn" aria-hidden="true" />
          </span>
        }
        title="The Database page is for admins only"
        className="py-16"
      >
        You are a viewer of {companyName}. Ask the owner if you need an admin role. The Data
        explorer and History are still available to you.
      </EmptyState>
    </div>
  );
}

export function DatabasePage() {
  return (
    <>
      <PageHeader
        title="Database"
        description="A read-only look at the raw tables for the selected company. Nothing here can be edited."
        actions={<UnlockStatus />}
      />
      <div className="mt-8">
        <CompanyGate>
          {(current) =>
            // A courtesy check: what this account can actually read is decided by the database.
            current.role !== "admin" ? (
              <AdminsOnly companyName={current.company.name} />
            ) : (
              <PasswordGate what="The database viewer">
                {/* Keyed by company: switching company starts again, with everything masked. */}
                <DatabaseViewer key={current.company.id} company={current.company} />
              </PasswordGate>
            )
          }
        </CompanyGate>
      </div>
    </>
  );
}
