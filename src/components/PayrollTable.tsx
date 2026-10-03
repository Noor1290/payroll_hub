import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type RowSelectionState,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Columns3,
  Eye,
  EyeOff,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/states";
import { ROW_FIELDS, type PayrollRow } from "@/config/payrollFields";
import { formatCount, formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

const MASK = "••••••";
const PAGE_SIZES = [10, 25, 50, 100];

const SELECT_CLASS =
  "h-9 rounded-lg border border-line bg-surface px-2.5 text-sm text-fg shadow-inner-glow hover:border-line-strong";
const CHECKBOX_CLASS = "size-4 cursor-pointer rounded accent-(--accent)";

interface ColumnMeta {
  label: string;
  sensitive: boolean;
  numeric: boolean;
}

function showExtra(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function buildColumns(rows: readonly PayrollRow[]): ColumnDef<PayrollRow>[] {
  const known: ColumnDef<PayrollRow>[] = ROW_FIELDS.map((field) => ({
    id: field.column,
    accessorFn: (row) => row[field.column as keyof PayrollRow],
    header: field.label,
    meta: {
      label: field.label,
      sensitive: field.sensitive,
      numeric: field.type === "number",
    } satisfies ColumnMeta,
    cell: ({ getValue }) => {
      const value = getValue();
      if (field.type === "number") return formatMoney(value as number);
      if (field.type === "boolean") return value ? "Yes" : "No";
      return (value as string | null) ?? "";
    },
    filterFn: field.column === "age_60_plus" ? "equals" : "equalsString",
  }));

  // Fields the payroll app added that this dashboard has no column for yet.
  const extraKeys = [...new Set(rows.flatMap((row) => Object.keys(row.extra)))].sort();
  const extras: ColumnDef<PayrollRow>[] = extraKeys.map((key) => ({
    id: `extra:${key}`,
    accessorFn: (row) => showExtra(row.extra[key]),
    header: key,
    // Unknown fields are treated as sensitive until someone decides otherwise.
    meta: { label: `${key} (extra)`, sensitive: true, numeric: false } satisfies ColumnMeta,
    cell: ({ getValue }) => getValue() as string,
  }));

  return [...known, ...extras];
}

const metaOf = (column: { columnDef: { meta?: unknown } }) => column.columnDef.meta as ColumnMeta;

interface PayrollTableProps {
  rows: readonly PayrollRow[];
  /** Show row checkboxes and report the selected row ids. */
  selectable?: boolean;
  onSelectionChange?: (ids: string[]) => void;
  initialPageSize?: number;
  /** Extra controls placed at the end of the toolbar. */
  toolbar?: ReactNode;
  /** Accessible name for the table, e.g. "September 2026 payroll". */
  caption: string;
}

/**
 * The payroll grid, shared by the import preview and the data explorer.
 * Columns come from the field mapping. Sensitive columns are masked until revealed, and the
 * revealed state lives only in this component: it resets whenever the grid is remounted.
 */
export function PayrollTable({
  rows,
  selectable = false,
  onSelectionChange,
  initialPageSize = 25,
  toolbar,
  caption,
}: PayrollTableProps) {
  const data = useMemo(() => [...rows], [rows]);
  const dataColumns = useMemo(() => buildColumns(rows), [rows]);

  const [sorting, setSorting] = useState<SortingState>([{ id: "surname", desc: false }]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());

  const columns = useMemo<ColumnDef<PayrollRow>[]>(() => {
    if (!selectable) return dataColumns;
    const select: ColumnDef<PayrollRow> = {
      id: "select",
      enableSorting: false,
      enableHiding: false,
      header: ({ table }) => (
        <input
          type="checkbox"
          className={CHECKBOX_CLASS}
          aria-label="Select all rows"
          checked={table.getIsAllRowsSelected()}
          ref={(el) => {
            if (el) el.indeterminate = table.getIsSomeRowsSelected();
          }}
          onChange={table.getToggleAllRowsSelectedHandler()}
        />
      ),
      cell: ({ row }) => (
        <input
          type="checkbox"
          className={CHECKBOX_CLASS}
          aria-label={`Select ${row.original.surname}`}
          checked={row.getIsSelected()}
          onChange={row.getToggleSelectedHandler()}
        />
      ),
    };
    return [select, ...dataColumns];
  }, [dataColumns, selectable]);

  // TanStack Table returns functions that cannot be memoised safely; this component does not pass them on.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data,
    columns,
    getRowId: (row) => row.id,
    state: { sorting, globalFilter, columnFilters, columnVisibility, rowSelection },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    enableRowSelection: selectable,
    // Search by name or ID only, never by salary figures.
    globalFilterFn: (row, _columnId, filter: string) => {
      const needle = filter.trim().toLowerCase();
      if (!needle) return true;
      const { surname, other_names, national_id } = row.original;
      return [surname, other_names ?? "", national_id].some((v) =>
        v.toLowerCase().includes(needle),
      );
    },
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: initialPageSize } },
  });

  useEffect(() => {
    onSelectionChange?.(Object.keys(rowSelection).filter((id) => rowSelection[id]));
  }, [rowSelection, onSelectionChange]);

  const sensitiveIds = useMemo(
    () => dataColumns.filter((c) => (c.meta as ColumnMeta).sensitive).map((c) => c.id!),
    [dataColumns],
  );
  const allRevealed = sensitiveIds.length > 0 && sensitiveIds.every((id) => revealed.has(id));
  const toggleReveal = (id: string) =>
    setRevealed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const employmentTypes = useMemo(
    () =>
      [
        ...new Set(rows.map((r) => r.employment_type).filter((v): v is string => v !== null)),
      ].sort(),
    [rows],
  );
  const employmentFilter = (table.getColumn("employment_type")?.getFilterValue() as string) ?? "";
  const ageFilter = table.getColumn("age_60_plus")?.getFilterValue() as boolean | undefined;

  const filteredCount = table.getFilteredRowModel().rows.length;
  const selectedCount = Object.values(rowSelection).filter(Boolean).length;
  const { pageIndex, pageSize } = table.getState().pagination;
  const firstShown = filteredCount === 0 ? 0 : pageIndex * pageSize + 1;
  const lastShown = Math.min(filteredCount, (pageIndex + 1) * pageSize);

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
        <label className="relative min-w-48 flex-1 sm:max-w-xs">
          <span className="sr-only">Search by name or ID</span>
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle"
            aria-hidden="true"
          />
          <input
            type="search"
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            placeholder="Search name or ID"
            className="h-9 w-full rounded-lg border border-line bg-surface pr-3 pl-9 text-sm shadow-inner-glow placeholder:text-subtle hover:border-line-strong"
          />
        </label>

        {employmentTypes.length > 1 && (
          <select
            aria-label="Filter by employment type"
            className={SELECT_CLASS}
            value={employmentFilter}
            onChange={(e) =>
              table.getColumn("employment_type")?.setFilterValue(e.target.value || undefined)
            }
          >
            <option value="">All employment types</option>
            {employmentTypes.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        )}

        <select
          aria-label="Filter by age 60+"
          className={SELECT_CLASS}
          value={ageFilter === undefined ? "" : ageFilter ? "yes" : "no"}
          onChange={(e) =>
            table
              .getColumn("age_60_plus")
              ?.setFilterValue(e.target.value === "" ? undefined : e.target.value === "yes")
          }
        >
          <option value="">Any age</option>
          <option value="yes">Age 60+</option>
          <option value="no">Under 60</option>
        </select>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            aria-pressed={allRevealed}
            onClick={() => setRevealed(allRevealed ? new Set() : new Set(sensitiveIds))}
          >
            {allRevealed ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
            {allRevealed ? "Hide sensitive" : "Reveal sensitive"}
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm">
                <Columns3 aria-hidden="true" />
                Columns
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
              <DropdownMenuLabel>Show columns</DropdownMenuLabel>
              {table
                .getAllLeafColumns()
                .filter((column) => column.getCanHide())
                .map((column) => (
                  <DropdownMenuCheckboxItem
                    key={column.id}
                    checked={column.getIsVisible()}
                    onCheckedChange={(checked) => column.toggleVisibility(checked === true)}
                    onSelect={(event) => event.preventDefault()}
                  >
                    {metaOf(column).label}
                  </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {toolbar}
        </div>
      </div>

      {/* The grid scrolls inside this box, never the page. */}
      <div className="max-h-[min(62vh,40rem)] min-h-0 overflow-auto">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const isSelect = header.column.id === "select";
                  const meta = isSelect ? null : metaOf(header.column);
                  const sorted = header.column.getIsSorted();
                  const SortIcon =
                    sorted === "asc" ? ArrowUp : sorted === "desc" ? ArrowDown : ChevronsUpDown;
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      aria-sort={
                        sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"
                      }
                      className={cn(
                        "sticky top-0 z-10 border-b border-line bg-elevated px-3 py-2.5 text-left text-xs font-medium whitespace-nowrap text-muted",
                        meta?.numeric && "text-right",
                        isSelect && "w-10",
                      )}
                    >
                      {isSelect ? (
                        flexRender(header.column.columnDef.header, header.getContext())
                      ) : (
                        <span
                          className={cn(
                            "inline-flex items-center gap-1",
                            meta?.numeric && "flex-row-reverse",
                          )}
                        >
                          <button
                            type="button"
                            onClick={header.column.getToggleSortingHandler()}
                            className="inline-flex items-center gap-1 rounded hover:text-fg"
                          >
                            {meta?.label}
                            <SortIcon
                              className={cn("size-3.5", sorted ? "text-accent" : "text-subtle")}
                              aria-hidden="true"
                            />
                          </button>
                          {meta?.sensitive && (
                            <button
                              type="button"
                              onClick={() => toggleReveal(header.column.id)}
                              aria-pressed={revealed.has(header.column.id)}
                              aria-label={`${revealed.has(header.column.id) ? "Hide" : "Reveal"} ${meta.label}`}
                              className="rounded p-0.5 text-subtle hover:text-fg"
                            >
                              {revealed.has(header.column.id) ? (
                                <EyeOff className="size-3.5" aria-hidden="true" />
                              ) : (
                                <Eye className="size-3.5" aria-hidden="true" />
                              )}
                            </button>
                          )}
                        </span>
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                className={cn(
                  "transition-colors hover:bg-surface-hover",
                  row.getIsSelected() && "bg-accent/5",
                )}
              >
                {row.getVisibleCells().map((cell) => {
                  const isSelect = cell.column.id === "select";
                  const meta = isSelect ? null : metaOf(cell.column);
                  const masked = meta?.sensitive && !revealed.has(cell.column.id);
                  return (
                    <td
                      key={cell.id}
                      className={cn(
                        "border-b border-line px-3 py-2 whitespace-nowrap",
                        meta?.numeric && "tabular text-right",
                        cell.column.id === "national_id" && "tabular",
                      )}
                    >
                      {masked ? (
                        <button
                          type="button"
                          onClick={() => toggleReveal(cell.column.id)}
                          aria-label={`${meta.label} hidden. Reveal this column`}
                          className="rounded tracking-widest text-subtle hover:text-fg"
                        >
                          {MASK}
                        </button>
                      ) : (
                        flexRender(cell.column.columnDef.cell, cell.getContext())
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {filteredCount === 0 && (
          <EmptyState title={rows.length === 0 ? "No employees in this run" : "No rows match"}>
            {rows.length === 0 ? undefined : "Clear the search or filters to see every employee."}
          </EmptyState>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-3 py-2.5 text-sm text-muted">
        <p aria-live="polite">
          <span className="tabular">
            {formatCount(firstShown)}–{formatCount(lastShown)}
          </span>{" "}
          of <span className="tabular">{formatCount(filteredCount)}</span>
          {filteredCount !== rows.length && (
            <>
              {" "}
              (filtered from <span className="tabular">{formatCount(rows.length)}</span>)
            </>
          )}
          {selectable && selectedCount > 0 && (
            <span className="ml-3 text-accent">
              <span className="tabular">{formatCount(selectedCount)}</span> selected
            </span>
          )}
        </p>
        <div className="ml-auto flex items-center gap-2">
          <select
            aria-label="Rows per page"
            className={cn(SELECT_CLASS, "h-8")}
            value={pageSize}
            onChange={(e) => table.setPageSize(Number(e.target.value))}
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size} per page
              </option>
            ))}
          </select>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Previous page"
            disabled={!table.getCanPreviousPage()}
            onClick={() => table.previousPage()}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Next page"
            disabled={!table.getCanNextPage()}
            onClick={() => table.nextPage()}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  );
}
