import { useState, type CSSProperties } from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQueryClient } from "@tanstack/react-query";
import { useReducedMotion } from "framer-motion";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Copy,
  Ellipsis,
  GripVertical,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/misc";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { useAuth } from "@/features/auth/auth-context";
import { useCompany } from "@/features/company/company-context";
import { CompanyGate } from "@/features/company/CompanyGate";
import { formatCount } from "@/lib/format";
import {
  classifyCompanyDataError,
  deleteLink,
  saveOrder,
  updateLink,
  type CompanyLink,
} from "@/lib/supabase/companyData";
import type { Membership } from "@/lib/supabase/schemas";
import { cn } from "@/lib/utils";
import { CopyLinksDialog } from "./CopyLinksDialog";
import { LinkIcon } from "./LinkIcon";
import { LinkDialog } from "./LinkDialog";
import {
  accentColor,
  bySortOrder,
  groupLinks,
  hostOf,
  moveBy,
  reorderWithin,
  safeHref,
  type LinkGroup,
} from "./linkModel";
import { linksKey, useCompanyLinks } from "./useLinks";

/** Drawn here, in the page: nothing is fetched for it. */
function EmptyIllustration() {
  return (
    <svg
      width="132"
      height="88"
      viewBox="0 0 132 88"
      fill="none"
      aria-hidden="true"
      className="text-line-strong"
    >
      <rect x="6" y="22" width="52" height="44" rx="10" stroke="currentColor" strokeWidth="1.5" />
      <rect x="74" y="22" width="52" height="44" rx="10" stroke="currentColor" strokeWidth="1.5" />
      <rect x="15" y="31" width="14" height="14" rx="4" fill="var(--accent)" opacity="0.8" />
      <rect x="83" y="31" width="14" height="14" rx="4" fill="var(--glow)" opacity="0.8" />
      <path d="M15 53h30M15 59h18M83 53h30M83 59h18" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M58 44h16"
        stroke="var(--accent)"
        strokeWidth="1.5"
        strokeDasharray="3 3"
        strokeLinecap="round"
      />
      <circle cx="66" cy="14" r="5" stroke="var(--accent)" strokeWidth="1.5" />
      <path d="M66 19v6" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

interface CardActions {
  onEdit: (link: CompanyLink) => void;
  onDelete: (link: CompanyLink) => void;
  onPin: (link: CompanyLink) => void;
  onMove: (link: CompanyLink, step: -1 | 1) => void;
}

function LinkCard({
  link,
  admin,
  draggable,
  position,
  count,
  actions,
}: {
  link: CompanyLink;
  admin: boolean;
  /** Dragging is off for viewers and while a search is narrowing the list. */
  draggable: boolean;
  position: number;
  count: number;
  actions: CardActions;
}) {
  const reduceMotion = useReducedMotion();
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: link.id,
    disabled: !draggable,
    transition: reduceMotion ? null : undefined,
  });
  // Only ever a plain http(s) address; anything else is shown but cannot be opened.
  const href = safeHref(link.url);

  const body = (
    <>
      <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-[color-mix(in_srgb,var(--card-accent)_35%,transparent)] bg-[color-mix(in_srgb,var(--card-accent)_14%,transparent)] text-(--card-accent)">
        <LinkIcon name={link.icon} className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 font-medium text-fg">
          <span className="truncate">{link.title}</span>
          {link.is_pinned && (
            <Pin className="size-3.5 shrink-0 text-(--card-accent)" aria-label="Pinned" />
          )}
        </span>
        <span className="mt-0.5 flex items-center gap-1 text-xs text-subtle">
          <span className="truncate">{hostOf(link.url)}</span>
          {href && <ArrowUpRight className="size-3 shrink-0" aria-hidden="true" />}
        </span>
        {link.description && (
          <span className="mt-2 line-clamp-2 text-sm text-muted">{link.description}</span>
        )}
      </span>
    </>
  );
  const bodyClass = cn("flex h-full items-start gap-3.5 rounded-2xl p-4", admin && "pr-20");

  return (
    <li
      ref={setNodeRef}
      style={
        {
          transform: CSS.Transform.toString(transform),
          transition,
          "--card-accent": accentColor(link.accent),
        } as CSSProperties
      }
      className={cn(
        "glass group relative rounded-2xl transition-[border-color,box-shadow,translate] duration-150 hover:border-[color-mix(in_srgb,var(--card-accent)_45%,transparent)] motion-safe:hover:-translate-y-0.5",
        isDragging && "z-10 opacity-80 shadow-pop",
      )}
    >
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className={bodyClass}>
          {body}
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      ) : (
        <div className={bodyClass}>{body}</div>
      )}

      {admin && (
        <div className="absolute top-2.5 right-2.5 flex items-center">
          {draggable && (
            <button
              type="button"
              ref={setActivatorNodeRef}
              {...attributes}
              {...listeners}
              aria-label={`Drag ${link.title} to reorder`}
              className="grid size-8 cursor-grab touch-none place-items-center rounded-lg text-subtle hover:bg-surface-hover hover:text-fg active:cursor-grabbing"
            >
              <GripVertical className="size-4" aria-hidden="true" />
            </button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`Actions for ${link.title}`}
              className="grid size-8 place-items-center rounded-lg text-subtle hover:bg-surface-hover hover:text-fg"
            >
              <Ellipsis className="size-4" aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuItem onSelect={() => actions.onEdit(link)}>
                <Pencil aria-hidden="true" />
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => actions.onPin(link)}>
                {link.is_pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
                {link.is_pinned ? "Unpin" : "Pin to top"}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!draggable || position === 0}
                onSelect={() => actions.onMove(link, -1)}
              >
                <ArrowUp aria-hidden="true" />
                Move up
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!draggable || position === count - 1}
                onSelect={() => actions.onMove(link, 1)}
              >
                <ArrowDown aria-hidden="true" />
                Move down
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-danger" onSelect={() => actions.onDelete(link)}>
                <Trash2 aria-hidden="true" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </li>
  );
}

function Group({
  group,
  admin,
  draggable,
  actions,
  onReorder,
}: {
  group: LinkGroup<CompanyLink>;
  admin: boolean;
  draggable: boolean;
  actions: CardActions;
  onReorder: (ids: string[]) => void;
}) {
  const sensors = useSensors(
    // A small distance first, so a click on the handle is not taken for a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = group.links.map((link) => link.id);
  const headingId = `links-group-${group.key}`;

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from >= 0 && to >= 0) onReorder(arrayMove(ids, from, to));
  };

  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="flex items-center gap-2 text-sm font-medium text-muted">
        {group.key === "pinned" && <Pin className="size-3.5 text-accent" aria-hidden="true" />}
        {group.title}
        <span className="tabular rounded-full border border-line bg-surface px-1.5 text-[11px]">
          {formatCount(group.links.length)}
        </span>
      </h2>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={ids} strategy={rectSortingStrategy} disabled={!draggable}>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {group.links.map((link, index) => (
              <LinkCard
                key={link.id}
                link={link}
                admin={admin}
                draggable={draggable}
                position={index}
                count={group.links.length}
                actions={{
                  ...actions,
                  onMove: (moved, step) => onReorder(moveBy(ids, moved.id, step)),
                }}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </section>
  );
}

type Editing = { link: CompanyLink | null } | null;

function CompanyLinks({ current }: { current: Membership }) {
  const { user } = useAuth();
  const { memberships } = useCompany();
  const queryClient = useQueryClient();
  const { company } = current;
  // A courtesy: the database decides who may change links, whatever this page shows.
  const admin = current.role === "admin";
  const query = useCompanyLinks(company.id);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<CompanyLink | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [copying, setCopying] = useState(false);

  if (query.isPending) {
    return (
      <div
        aria-busy="true"
        aria-label="Loading links"
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
      >
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-24 rounded-2xl" />
        ))}
      </div>
    );
  }
  if (query.isError) {
    return (
      <ErrorState
        failure={classifyCompanyDataError(query.error, "links")}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const links = query.data;
  const viewer = { id: user!.id, isDemo: user!.isDemo };
  const key = linksKey(company.id, user?.id);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["company-links", company.id] });
  const report = (error: unknown) => {
    const problem = classifyCompanyDataError(error, "links");
    toast.error(problem.title, { description: problem.message });
  };

  const reorder = async (ids: string[]) => {
    const changes = reorderWithin(links, ids);
    if (changes.length === 0) return;
    const moved = new Map(changes.map((change) => [change.id, change.sort_order]));
    // Show the new order straight away; the database is asked right after.
    queryClient.setQueryData<CompanyLink[]>(key, (list) =>
      list
        ?.map((link) => (moved.has(link.id) ? { ...link, sort_order: moved.get(link.id)! } : link))
        .sort(bySortOrder),
    );
    try {
      await saveOrder(viewer, "company_links", changes);
    } catch (error) {
      report(error);
    }
    await refresh();
  };

  const togglePin = async (link: CompanyLink) => {
    try {
      await updateLink(viewer, link.id, { is_pinned: !link.is_pinned });
    } catch (error) {
      report(error);
    }
    await refresh();
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await deleteLink(viewer, deleting.id);
      toast.success(`${deleting.title} deleted`);
    } catch (error) {
      report(error);
    }
    await refresh();
    setDeleteBusy(false);
    setDeleting(null);
  };

  const searching = search.trim() !== "";
  const groups = groupLinks(links, search);
  const actions: CardActions = {
    onEdit: (link) => setEditing({ link }),
    onDelete: setDeleting,
    onPin: (link) => void togglePin(link),
    onMove: () => {},
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-52 flex-1 sm:max-w-xs">
          <span className="sr-only">Search links</span>
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle"
            aria-hidden="true"
          />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search links"
            className="h-10 w-full rounded-lg border border-line bg-surface pr-3 pl-9 text-sm shadow-inner-glow placeholder:text-subtle hover:border-line-strong"
          />
        </label>
        {admin && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {memberships.length > 1 && (
              <Button onClick={() => setCopying(true)}>
                <Copy aria-hidden="true" />
                Copy from another company
              </Button>
            )}
            <Button variant="primary" onClick={() => setEditing({ link: null })}>
              <Plus aria-hidden="true" />
              Add link
            </Button>
          </div>
        )}
      </div>

      {admin && searching && links.length > 1 && (
        <p className="text-sm text-muted">Clear the search to reorder links.</p>
      )}

      {links.length === 0 ? (
        <div className="glass rounded-2xl">
          <EmptyState
            illustration={<EmptyIllustration />}
            title="No links yet"
            className="py-16"
            action={
              admin ? (
                <Button variant="primary" onClick={() => setEditing({ link: null })}>
                  <Plus aria-hidden="true" />
                  Add the first link
                </Button>
              ) : undefined
            }
          >
            {admin
              ? `Keep the websites ${company.name} uses for payroll in one place: the tax portal, the bank, shared folders.`
              : `An admin of ${company.name} hasn't added any links yet.`}
          </EmptyState>
        </div>
      ) : groups.length === 0 ? (
        <div className="glass rounded-2xl">
          <EmptyState
            title="No links match"
            action={<Button onClick={() => setSearch("")}>Clear the search</Button>}
          >
            Nothing in the titles, addresses, descriptions or categories matches “{search.trim()}”.
          </EmptyState>
        </div>
      ) : (
        groups.map((group) => (
          <Group
            key={group.key}
            group={group}
            admin={admin}
            draggable={admin && !searching}
            actions={actions}
            onReorder={(ids) => void reorder(ids)}
          />
        ))
      )}

      {admin && (
        <>
          <LinkDialog
            open={editing !== null}
            onOpenChange={(open) => !open && setEditing(null)}
            companyId={company.id}
            link={editing?.link ?? null}
            links={links}
          />
          <CopyLinksDialog
            open={copying}
            onOpenChange={setCopying}
            target={company}
            existing={links}
          />
          <ConfirmDialog
            open={deleting !== null}
            onOpenChange={(open) => !open && setDeleting(null)}
            title={`Delete ${deleting?.title ?? "this link"}?`}
            confirmLabel="Delete link"
            tone="danger"
            busy={deleteBusy}
            onConfirm={() => void confirmDelete()}
          >
            <p>The card is removed for everyone who can see {company.name}.</p>
          </ConfirmDialog>
        </>
      )}
    </div>
  );
}

export function LinksPage() {
  return (
    <>
      <PageHeader
        title="Links"
        description="The websites the selected company uses, one click away. They open in a new tab."
      />
      <div className="mt-8">
        <CompanyGate>
          {(current) => <CompanyLinks key={current.company.id} current={current} />}
        </CompanyGate>
      </div>
    </>
  );
}
