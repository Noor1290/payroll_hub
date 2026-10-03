import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Eye, EyeOff, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";
import { formatCount } from "@/lib/format";
import { cn } from "@/lib/utils";
import { showValue } from "./display";
import type { SourceRow, SourceTable } from "./mapping";

const PAGE_SIZE = 25;
const MASK = "••••••";
const CHECKBOX = "size-4 cursor-pointer rounded accent-(--accent)";

interface SelectTableProps {
  table: SourceTable;
  selectedRows: ReadonlySet<string>;
  onRowsChange: (next: Set<string>) => void;
  selectedColumns: ReadonlySet<string>;
  onColumnsChange: (next: Set<string>) => void;
}

/**
 * The transfer wizard's grid: tick the rows and the columns to send. Sensitive columns are
 * masked until revealed; revealing is for looking only and does not change what is sent.
 */
export function SelectTable({
  table,
  selectedRows,
  onRowsChange,
  selectedColumns,
  onColumnsChange,
}: SelectTableProps) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [revealed, setRevealed] = useState(false);

  // Search looks at the non-sensitive text columns only (names, not IDs or figures).
  const searchable = useMemo(
    () => table.columns.filter((c) => !c.sensitive && c.type === "string").map((c) => c.key),
    [table.columns],
  );
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return table.rows;
    return table.rows.filter((row) =>
      searchable.some((key) =>
        String(row.values[key] ?? "")
          .toLowerCase()
          .includes(needle),
      ),
    );
  }, [table.rows, search, searchable]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);
  const visible = filtered.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);

  const allFilteredSelected = filtered.length > 0 && filtered.every((r) => selectedRows.has(r.id));
  const someFilteredSelected = filtered.some((r) => selectedRows.has(r.id));

  const toggleRow = (row: SourceRow) => {
    const next = new Set(selectedRows);
    if (next.has(row.id)) next.delete(row.id);
    else next.add(row.id);
    onRowsChange(next);
  };
  const toggleAllRows = () => {
    const next = new Set(selectedRows);
    for (const row of filtered) {
      if (allFilteredSelected) next.delete(row.id);
      else next.add(row.id);
    }
    onRowsChange(next);
  };
  const toggleColumn = (key: string) => {
    const next = new Set(selectedColumns);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onColumnsChange(next);
  };
  const allColumns = table.columns.every((c) => selectedColumns.has(c.key));

  return (
    <div className="overflow-hidden rounded-xl border border-line">
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
        <label className="relative min-w-48 flex-1 sm:max-w-xs">
          <span className="sr-only">Search rows by name</span>
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle"
            aria-hidden="true"
          />
          <input
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
            placeholder="Search by name"
            className="h-9 w-full rounded-lg border border-line bg-surface pr-3 pl-9 text-sm shadow-inner-glow placeholder:text-subtle hover:border-line-strong"
          />
        </label>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() =>
              onColumnsChange(allColumns ? new Set() : new Set(table.columns.map((c) => c.key)))
            }
          >
            {allColumns ? "Untick all columns" : "Tick all columns"}
          </Button>
          <Button size="sm" aria-pressed={revealed} onClick={() => setRevealed((v) => !v)}>
            {revealed ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
            {revealed ? "Hide sensitive" : "Reveal sensitive"}
          </Button>
        </div>
      </div>

      <div className="max-h-[min(52vh,32rem)] overflow-auto">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <caption className="sr-only">
            Rows and columns to send. Tick a row to include it; tick a column heading to include
            that column.
          </caption>
          <thead>
            <tr>
              <th
                scope="col"
                className="sticky top-0 left-0 z-20 border-b border-line bg-elevated px-3 py-2.5 text-left"
              >
                <input
                  type="checkbox"
                  className={CHECKBOX}
                  aria-label={search ? "Select all matching rows" : "Select all rows"}
                  checked={allFilteredSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someFilteredSelected && !allFilteredSelected;
                  }}
                  onChange={toggleAllRows}
                />
              </th>
              {table.columns.map((column) => {
                const included = selectedColumns.has(column.key);
                return (
                  <th
                    key={column.key}
                    scope="col"
                    className={cn(
                      "sticky top-0 z-10 border-b border-line bg-elevated px-3 py-2.5 text-left text-xs font-medium whitespace-nowrap",
                      included ? "text-fg" : "text-subtle",
                    )}
                  >
                    <label className="inline-flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        className={CHECKBOX}
                        checked={included}
                        onChange={() => toggleColumn(column.key)}
                        aria-label={`Include the ${column.label} column`}
                      />
                      {column.label}
                    </label>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const picked = selectedRows.has(row.id);
              return (
                <tr key={row.id} className={cn("hover:bg-surface-hover", picked && "bg-accent/5")}>
                  <td className="sticky left-0 border-b border-line bg-elevated px-3 py-2">
                    <input
                      type="checkbox"
                      className={CHECKBOX}
                      checked={picked}
                      onChange={() => toggleRow(row)}
                      aria-label={`Include row ${row.number}`}
                    />
                  </td>
                  {table.columns.map((column) => (
                    <td
                      key={column.key}
                      className={cn(
                        "border-b border-line px-3 py-2 whitespace-nowrap",
                        (column.type === "number" || column.sensitive) && "tabular",
                        column.type === "number" && "text-right",
                        // A row or column that isn't going is shown faded.
                        (!picked || !selectedColumns.has(column.key)) && "opacity-40",
                      )}
                    >
                      {column.sensitive && !revealed ? (
                        <span className="tracking-widest text-subtle">{MASK}</span>
                      ) : (
                        showValue(row.values[column.key], column.money)
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 && <EmptyState title="No rows match">Clear the search.</EmptyState>}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-3 py-2.5 text-sm text-muted">
        <p aria-live="polite">
          <span className="tabular text-fg">{formatCount(selectedRows.size)}</span> of{" "}
          <span className="tabular">{formatCount(table.rows.length)}</span> rows and{" "}
          <span className="tabular text-fg">{formatCount(selectedColumns.size)}</span> of{" "}
          <span className="tabular">{formatCount(table.columns.length)}</span> columns selected
        </p>
        <div className="ml-auto flex items-center gap-2">
          <span className="tabular">
            Page {current + 1} of {pageCount}
          </span>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Previous page"
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Next page"
            disabled={current >= pageCount - 1}
            onClick={() => setPage(current + 1)}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  );
}
