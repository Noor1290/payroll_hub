import { useId, useMemo, useRef, useState, type CSSProperties } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Info, LoaderCircle, Lock, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/misc";
import { ErrorState } from "@/components/ui/states";
import { Tooltip } from "@/components/ui/tooltip";
import { getApp } from "@/config/apps.config";
import { formatCount } from "@/lib/format";
import { LIST_LABELS, SHORT_APP_NAMES } from "./pickerText";
import type { AppList, ListChange } from "@/lib/supabase/companyLists";
import type { DataFailure } from "@/lib/supabase/errors";
import { cn } from "@/lib/utils";
import {
  changesBetween,
  countsOf,
  hueOf,
  initialsOf,
  isOn,
  isSelected,
  setAll,
  shownCompanies,
  toggleCompany,
  toggleList,
  type Choice,
  type PickerCompany,
  type PickerFilter,
} from "./pickerModel";

export function CompanyAvatar({
  name,
  hueKey,
  className,
}: {
  name: string;
  hueKey: string;
  className?: string;
}) {
  const hue = hueOf(hueKey);
  const style = {
    color: `oklch(var(--avatar-fg-l) 0.13 ${hue})`,
    background: `oklch(0.7 0.13 ${hue} / var(--avatar-bg-a))`,
    boxShadow: `inset 0 0 0 1px oklch(0.7 0.13 ${hue} / 0.35)`,
  } satisfies CSSProperties;
  return (
    <span
      aria-hidden="true"
      style={style}
      className={cn(
        "grid size-11 shrink-0 place-items-center rounded-full text-[15px] font-semibold tracking-wide",
        className,
      )}
    >
      {initialsOf(name)}
    </span>
  );
}

const FILTERS: { id: PickerFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "selected", label: "Selected" },
  { id: "not-selected", label: "Not selected" },
];

export type PickerLoad =
  | { status: "loading" }
  | { status: "failed"; failure: DataFailure; retry: () => void }
  | { status: "ready"; companies: PickerCompany[]; loaded: Choice };

export interface CompanyPickerProps {
  appId: string;
  lists: readonly AppList[];
  load: PickerLoad;
  saving: boolean;
  /** Leaves without saving. */
  onClose: () => void;
  /** Saves the changes (never empty), then the host closes the picker. */
  onSave: (changes: ListChange[], chosen: Choice) => void;
}

/** The full-page company picker: a grid of cards over the app, Done at the bottom. */
export function CompanyPicker({ appId, lists, load, saving, onClose, onSave }: CompanyPickerProps) {
  const app = getApp(appId);
  const appName = SHORT_APP_NAMES[appId] ?? app?.name ?? appId;
  const ready = load.status === "ready" ? load : null;
  const [chosen, setChosen] = useState<Choice | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<PickerFilter>("all");
  const [askLeave, setAskLeave] = useState(false);
  const searchId = useId();
  const searchRef = useRef<HTMLInputElement>(null);

  // Until the first change, the choice is what was loaded.
  const companies = useMemo(() => ready?.companies ?? [], [ready]);
  const choice = useMemo<Choice>(() => chosen ?? ready?.loaded ?? new Map(), [chosen, ready]);
  const shown = useMemo(
    () => shownCompanies(companies, choice, search, filter),
    [companies, choice, search, filter],
  );
  const changes = ready ? changesBetween(ready.loaded, choice, companies, lists) : [];
  const counts = countsOf(choice, companies, lists);
  const selectedCount = companies.filter((one) => isSelected(choice, one.id)).length;
  const canChangeAny = companies.some((one) => one.admin);
  const changeableShown = shown.filter((one) => one.admin);
  const multi = lists.length > 1;

  const leave = () => {
    if (saving) return;
    if (changes.length > 0) setAskLeave(true);
    else onClose();
  };
  const done = () => {
    if (saving) return;
    if (changes.length === 0) onClose();
    else onSave(changes, choice);
  };

  const counter = multi
    ? `${lists.map((list) => `${LIST_LABELS[list]} ${formatCount(counts[list])}`).join(" · ")} of ${formatCount(companies.length)}`
    : `${formatCount(selectedCount)} of ${formatCount(companies.length)} ${companies.length === 1 ? "company" : "companies"} selected`;

  return (
    <Dialog.Root open onOpenChange={(open) => !open && leave()}>
      <Dialog.Portal>
        <Dialog.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            searchRef.current?.focus();
          }}
          className="fixed inset-0 z-50 flex flex-col bg-canvas outline-none"
        >
          {/* A soft wash of the app's colour behind the header. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-72 opacity-70"
            style={{
              background: `radial-gradient(60rem 18rem at 20% -4rem, color-mix(in srgb, ${app?.accentColor ?? "var(--accent)"} 18%, transparent), transparent 70%), radial-gradient(40rem 14rem at 90% -6rem, var(--aurora-b), transparent 70%)`,
            }}
          />

          <header className="relative mx-auto w-full max-w-6xl px-4 pt-5 sm:px-8 sm:pt-8">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-[13px] font-medium text-muted">
                  {app && (
                    <app.icon
                      className="size-4"
                      style={{ color: app.accentColor }}
                      aria-hidden="true"
                    />
                  )}
                  {appName}
                </p>
                <div className="mt-1.5 flex items-center gap-2">
                  <Dialog.Title className="text-2xl font-semibold tracking-tight sm:text-[28px]">
                    Choose companies
                  </Dialog.Title>
                  <Tooltip label="Everyone on a company sees the same list." side="right">
                    <button
                      type="button"
                      aria-label="About this list"
                      className="grid size-7 place-items-center rounded-full text-subtle hover:bg-surface-hover hover:text-fg"
                    >
                      <Info className="size-4" aria-hidden="true" />
                    </button>
                  </Tooltip>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close"
                onClick={leave}
                disabled={saving}
              >
                <X aria-hidden="true" />
              </Button>
            </div>

            <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
              <label htmlFor={searchId} className="sr-only">
                Search by name or BRN
              </label>
              <div className="relative flex-1">
                <Search
                  className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-subtle"
                  aria-hidden="true"
                />
                <input
                  ref={searchRef}
                  id={searchId}
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search by name or BRN"
                  autoComplete="off"
                  className="h-11 w-full rounded-xl border border-line bg-elevated/70 pr-3.5 pl-10 text-[15px] text-fg shadow-inner-glow transition-colors placeholder:text-subtle hover:border-line-strong focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent/40"
                />
              </div>
              <div
                role="radiogroup"
                aria-label="Show"
                className="flex shrink-0 gap-1 rounded-xl border border-line bg-elevated/70 p-1"
              >
                {FILTERS.map((one) => (
                  <button
                    key={one.id}
                    type="button"
                    role="radio"
                    aria-checked={filter === one.id}
                    onClick={() => setFilter(one.id)}
                    className={cn(
                      "h-9 flex-1 rounded-lg px-3.5 text-sm font-medium whitespace-nowrap transition-colors sm:flex-none",
                      filter === one.id
                        ? "bg-accent/15 text-fg shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_45%,transparent)]"
                        : "text-muted hover:bg-surface-hover hover:text-fg",
                    )}
                  >
                    {one.label}
                  </button>
                ))}
              </div>
            </div>
          </header>

          <div className="relative min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-6xl px-4 pt-5 pb-8 sm:px-8">
              {load.status === "loading" && (
                <div aria-busy="true" aria-label="Loading" className={GRID}>
                  {Array.from({ length: 6 }, (_, index) => (
                    <Skeleton key={index} className="h-[5.5rem] rounded-2xl" />
                  ))}
                </div>
              )}
              {load.status === "failed" && (
                <ErrorState failure={load.failure} onRetry={load.retry} />
              )}
              {ready && shown.length === 0 && (
                <p className="py-16 text-center text-sm text-muted">
                  {search.trim() !== ""
                    ? `No company matches "${search.trim()}".`
                    : filter === "selected"
                      ? "None selected."
                      : "All selected."}
                </p>
              )}
              {ready && shown.length > 0 && (
                <ul className={GRID} aria-label="Companies">
                  {shown.map((company) => (
                    <li key={company.id}>
                      <CompanyCard
                        company={company}
                        lists={lists}
                        choice={choice}
                        onToggle={() =>
                          setChosen((now) => toggleCompany(now ?? choice, company.id, lists))
                        }
                        onToggleList={(list) =>
                          setChosen((now) => toggleList(now ?? choice, company.id, list))
                        }
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <footer className="relative border-t border-line bg-elevated/85 backdrop-blur-xl">
            <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-8">
              <p
                className="min-w-0 flex-1 text-sm font-medium text-fg tabular-nums"
                aria-live="polite"
              >
                {ready ? counter : ""}
              </p>
              {canChangeAny && (
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!ready || saving || changeableShown.length === 0}
                    onClick={() => setChosen((now) => setAll(now ?? choice, shown, lists, true))}
                  >
                    Select all
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!ready || saving || changeableShown.length === 0}
                    onClick={() => setChosen((now) => setAll(now ?? choice, shown, lists, false))}
                  >
                    Clear
                  </Button>
                </div>
              )}
              <div className="flex w-full gap-2 sm:w-auto">
                <Button className="flex-1 sm:flex-none" onClick={leave} disabled={saving}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  className="min-w-28 flex-1 sm:flex-none"
                  onClick={done}
                  disabled={saving || !ready}
                >
                  {saving && <LoaderCircle className="animate-spin" aria-hidden="true" />}
                  Done
                </Button>
              </div>
            </div>
          </footer>

          <ConfirmDialog
            open={askLeave}
            onOpenChange={setAskLeave}
            title="Leave without saving?"
            confirmLabel="Leave"
            cancelLabel="Keep choosing"
            tone="danger"
            onConfirm={() => {
              setAskLeave(false);
              onClose();
            }}
          >
            <p>Your changes won't be kept.</p>
          </ConfirmDialog>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const GRID = "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3";

const CARD =
  "group relative flex w-full items-center gap-3.5 rounded-2xl border p-4 text-left transition-[background-color,border-color,box-shadow] duration-200";

function CompanyCard({
  company,
  lists,
  choice,
  onToggle,
  onToggleList,
}: {
  company: PickerCompany;
  lists: readonly AppList[];
  choice: Choice;
  onToggle: () => void;
  onToggleList: (list: AppList) => void;
}) {
  const selected = isSelected(choice, company.id);
  const multi = lists.length > 1;
  const look = cn(
    CARD,
    selected
      ? "border-accent/60 bg-accent/[0.08] shadow-[0_0_0_1px_color-mix(in_srgb,var(--accent)_35%,transparent),0_12px_32px_-18px_var(--accent)]"
      : "border-line bg-elevated/60 hover:border-line-strong hover:bg-surface-hover",
    !company.admin && "opacity-60",
  );

  const body = (
    <>
      <CompanyAvatar name={company.name} hueKey={company.brn || company.id} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-fg">{company.name}</span>
        <span className="tabular mt-0.5 block truncate text-xs text-subtle">
          {company.brn || "No BRN"}
        </span>
      </span>
    </>
  );

  // The check badge pops in; with "reduce motion" it simply appears (MotionConfig).
  const badge = (
    <AnimatePresence initial={false}>
      {selected && (
        <motion.span
          key="check"
          aria-hidden="true"
          initial={{ scale: 0.3, opacity: 0 }}
          animate={{ scale: [0.3, 1.18, 1], opacity: 1 }}
          exit={{ scale: 0.5, opacity: 0 }}
          transition={{ duration: 0.32, ease: "easeOut" }}
          className="absolute -top-2 -right-2 grid size-6 place-items-center rounded-full bg-accent text-accent-fg shadow-[0_4px_12px_-4px_var(--accent)] ring-2 ring-canvas"
        >
          <Check className="size-3.5" strokeWidth={3} />
        </motion.span>
      )}
    </AnimatePresence>
  );

  if (!company.admin) {
    return (
      <Tooltip label="Only an admin can change this">
        <div className={look} aria-disabled="true" tabIndex={0}>
          {body}
          <Lock
            className="size-4 shrink-0 text-subtle"
            aria-label="Only an admin can change this"
          />
          {badge}
        </div>
      </Tooltip>
    );
  }

  if (multi) {
    return (
      <div className={cn(look, "items-start")}>
        <CompanyAvatar name={company.name} hueKey={company.brn || company.id} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-fg">{company.name}</span>
          <span className="tabular mt-0.5 block truncate text-xs text-subtle">
            {company.brn || "No BRN"}
          </span>
          <span className="mt-2.5 flex gap-1.5" role="group" aria-label={company.name}>
            {lists.map((list) => {
              const on = isOn(choice, company.id, list);
              return (
                <motion.button
                  key={list}
                  type="button"
                  aria-pressed={on}
                  aria-label={`${LIST_LABELS[list]}, ${company.name}`}
                  onClick={() => onToggleList(list)}
                  whileTap={{ scale: 0.92 }}
                  className={cn(
                    "h-7 rounded-full border px-3 text-xs font-semibold tracking-wide transition-colors",
                    on
                      ? "border-accent bg-accent text-accent-fg"
                      : "border-line-strong text-muted hover:border-accent/60 hover:text-fg",
                  )}
                >
                  {LIST_LABELS[list]}
                </motion.button>
              );
            })}
          </span>
        </span>
        {badge}
      </div>
    );
  }

  return (
    <motion.button
      type="button"
      aria-pressed={selected}
      onClick={onToggle}
      whileTap={{ scale: 0.97 }}
      animate={selected ? { scale: [1, 1.03, 1] } : { scale: 1 }}
      transition={{ duration: 0.28, ease: "easeOut" }}
      className={look}
    >
      {body}
      {badge}
    </motion.button>
  );
}
