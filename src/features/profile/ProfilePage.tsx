import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
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
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useReducedMotion } from "framer-motion";
import {
  ArrowDown,
  ArrowUp,
  Eye,
  EyeOff,
  GripVertical,
  LockKeyhole,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { FormDialog } from "@/components/ui/form";
import { Badge, Skeleton } from "@/components/ui/misc";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { useAuth } from "@/features/auth/auth-context";
import { CompanyGate } from "@/features/company/CompanyGate";
import { bySortOrder, moveBy, reorderWithin } from "@/features/links/linkModel";
import { UnlockForm, UnlockStatus } from "@/features/unlock/PasswordGate";
import { useUnlock } from "@/features/unlock/useUnlock";
import {
  classifyCompanyDataError,
  deleteDetail,
  fetchDetails,
  fetchSensitiveValues,
  saveOrder,
  type CompanyDetail,
} from "@/lib/supabase/companyData";
import type { Membership } from "@/lib/supabase/schemas";
import { isUnlocked, registerLockCleanup, unlockState } from "@/lib/unlock";
import { cn } from "@/lib/utils";
import { CoreDialog } from "./CoreDialog";
import { DetailDialog } from "./DetailDialog";
import { detailHref } from "./profileModel";

const MASK = "••••••";
const NONE: ReadonlySet<string> = new Set();

/** What to show for one detail's value. */
type Shown =
  | { state: "open"; value: string | null }
  | { state: "masked" }
  | { state: "loading" }
  | { state: "failed" };

function ValueText({ type, value }: { type: string; value: string | null }) {
  if (value === null || value === "") return <span className="text-subtle">Not set</span>;
  // Only http(s), mailto and tel links are ever produced.
  const href = detailHref(type, value);
  if (!href) return <>{value}</>;
  return (
    <a
      href={href}
      className="text-accent underline-offset-4 hover:underline"
      {...(type === "link" ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      {value}
    </a>
  );
}

interface RowActions {
  onReveal: (detail: CompanyDetail) => void;
  onHide: (detail: CompanyDetail) => void;
  onEdit: (detail: CompanyDetail) => void;
  onDelete: (detail: CompanyDetail) => void;
  onMove: (detail: CompanyDetail, step: -1 | 1) => void;
}

function DetailRow({
  detail,
  shown,
  admin,
  position,
  count,
  actions,
}: {
  detail: CompanyDetail;
  shown: Shown;
  admin: boolean;
  position: number;
  count: number;
  actions: RowActions;
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
    id: detail.id,
    disabled: !admin,
    transition: reduceMotion ? null : undefined,
  });

  let value: ReactNode;
  if (shown.state === "open") {
    value = (
      <>
        <span className="min-w-0 break-words">
          <ValueText type={detail.field_type} value={shown.value} />
        </span>
        {detail.is_sensitive && (
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Hide ${detail.label}`}
            onClick={() => actions.onHide(detail)}
          >
            <EyeOff aria-hidden="true" />
            Hide
          </Button>
        )}
      </>
    );
  } else if (shown.state === "masked") {
    value = (
      <>
        <span className="tracking-widest text-subtle" aria-hidden="true">
          {MASK}
        </span>
        <span className="sr-only">Hidden</span>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Reveal ${detail.label}`}
          onClick={() => actions.onReveal(detail)}
        >
          <Eye aria-hidden="true" />
          Reveal
        </Button>
      </>
    );
  } else if (shown.state === "loading") {
    value = <Skeleton className="h-5 w-40" />;
  } else {
    value = <span className="text-danger">Couldn't load this value. Try again in a moment.</span>;
  }

  return (
    <li
      ref={setNodeRef}
      style={
        {
          transform: CSS.Transform.toString(transform),
          transition,
        } as CSSProperties
      }
      className={cn(
        "flex items-center gap-2 border-b border-line px-3 py-2.5 last:border-b-0 sm:px-4",
        isDragging && "relative z-10 rounded-lg bg-elevated shadow-pop",
      )}
    >
      {admin && (
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={`Drag ${detail.label} to reorder`}
          className="grid size-8 shrink-0 cursor-grab touch-none place-items-center rounded-lg text-subtle hover:bg-surface-hover hover:text-fg active:cursor-grabbing"
        >
          <GripVertical className="size-4" aria-hidden="true" />
        </button>
      )}
      <div className="min-w-0 flex-1 sm:grid sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] sm:items-center sm:gap-4">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
          <span className="break-words">{detail.label}</span>
          {detail.is_sensitive && <Badge tone="warn">Sensitive</Badge>}
        </div>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-2 sm:mt-0">{value}</div>
      </div>
      {admin && (
        <div className="flex shrink-0 items-center">
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Move ${detail.label} up`}
            disabled={position === 0}
            onClick={() => actions.onMove(detail, -1)}
          >
            <ArrowUp aria-hidden="true" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Move ${detail.label} down`}
            disabled={position === count - 1}
            onClick={() => actions.onMove(detail, 1)}
          >
            <ArrowDown aria-hidden="true" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Edit ${detail.label}`}
            onClick={() => actions.onEdit(detail)}
          >
            <Pencil aria-hidden="true" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Delete ${detail.label}`}
            onClick={() => actions.onDelete(detail)}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      )}
    </li>
  );
}

function CoreCard({ current }: { current: Membership }) {
  const [editing, setEditing] = useState(false);
  const { company } = current;
  const admin = current.role === "admin";
  const fields: [string, string | null][] = [
    ["Name", company.name],
    ["BRN", company.brn],
    ["Address", company.address],
    ["VAT", company.vat],
  ];

  return (
    <section aria-labelledby="profile-core" className="glass rounded-2xl">
      <div className="flex items-center gap-3 border-b border-line px-5 py-4">
        <h2 id="profile-core" className="flex-1 font-semibold">
          Company
        </h2>
        <Badge tone={admin ? "accent" : "neutral"}>{current.role}</Badge>
        {admin && (
          <Button size="sm" onClick={() => setEditing(true)}>
            <Pencil aria-hidden="true" />
            Edit
          </Button>
        )}
      </div>
      <dl className="divide-y divide-line">
        {fields.map(([label, value]) => (
          <div key={label} className="px-5 py-3">
            <dt className="text-sm text-muted">{label}</dt>
            <dd className={cn("mt-0.5 break-words", label === "BRN" && "tabular")}>
              {value ? value : <span className="text-subtle">Not set</span>}
            </dd>
          </div>
        ))}
      </dl>
      {admin && <CoreDialog open={editing} onOpenChange={setEditing} company={company} />}
    </section>
  );
}

type Pending = { action: "reveal" | "edit"; detail: CompanyDetail };

function Details({ current }: { current: Membership }) {
  const { user } = useAuth();
  const { unlocked } = useUnlock();
  const queryClient = useQueryClient();
  const { company } = current;
  // A courtesy: the database decides what this account may read or change.
  const admin = current.role === "admin";

  const [revealed, setRevealed] = useState<ReadonlySet<string>>(NONE);
  const [pending, setPending] = useState<Pending | null>(null);
  const [dialog, setDialog] = useState<{ detail: CompanyDetail | null } | null>(null);
  const [deleting, setDeleting] = useState<CompanyDetail | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const detailsKey = ["company-details", company.id, user?.id] as const;
  const details = useQuery({
    queryKey: detailsKey,
    queryFn: () => fetchDetails({ id: user!.id, isDemo: user!.isDemo }, company.id),
    enabled: user !== null,
  });

  // Nothing counts as revealed while the gate is locked, whatever was revealed before.
  const visible = unlocked ? revealed : NONE;
  const editingSensitive = dialog?.detail?.is_sensitive === true;
  const sensitive = useQuery({
    // Wiped from memory when the password gate locks (see GATED_QUERY_KEYS).
    queryKey: ["company-details-sensitive", company.id, user?.id],
    queryFn: () => fetchSensitiveValues({ id: user!.id, isDemo: user!.isDemo }, company.id),
    // Sensitive values are fetched only for an admin, with the gate open, who asked to see one.
    enabled: admin && unlocked && user !== null && (visible.size > 0 || editingSensitive),
    staleTime: 0,
  });

  // When the gate locks, everything masks again and a form holding a sensitive value closes.
  useEffect(
    () =>
      registerLockCleanup(() => {
        setRevealed(NONE);
        setDialog((open) => (open?.detail?.is_sensitive ? null : open));
      }),
    [],
  );

  // Asked to reveal or edit while locked: carry on as soon as the password is confirmed.
  useEffect(() => {
    if (!pending) return;
    return unlockState.subscribe(() => {
      if (!unlockState.get().unlocked) return;
      if (pending.action === "reveal") {
        setRevealed((current) => new Set(current).add(pending.detail.id));
      } else {
        setDialog({ detail: pending.detail });
      }
      setPending(null);
    });
  }, [pending]);

  const heading = (
    <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4">
      <h2 id="profile-details" className="flex-1 font-semibold">
        Other details
      </h2>
      {admin && details.isSuccess && (
        <Button size="sm" variant="primary" onClick={() => setDialog({ detail: null })}>
          <Plus aria-hidden="true" />
          Add detail
        </Button>
      )}
    </div>
  );

  if (details.isPending) {
    return (
      <section aria-labelledby="profile-details" className="glass rounded-2xl">
        {heading}
        <div aria-busy="true" aria-label="Loading details" className="space-y-2 p-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      </section>
    );
  }
  if (details.isError) {
    return (
      <section aria-labelledby="profile-details" className="glass rounded-2xl">
        {heading}
        <ErrorState
          failure={classifyCompanyDataError(details.error, "details")}
          onRetry={() => void details.refetch()}
          className="m-4"
        />
      </section>
    );
  }

  const list = details.data;
  const ids = list.map((detail) => detail.id);
  const viewer = { id: user!.id, isDemo: user!.isDemo };
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["company-details", company.id] }),
      queryClient.invalidateQueries({ queryKey: ["company-details-sensitive", company.id] }),
    ]);
  const report = (error: unknown) => {
    const problem = classifyCompanyDataError(error, "details");
    toast.error(problem.title, { description: problem.message });
  };

  const whenUnlocked = (action: Pending["action"], detail: CompanyDetail) => {
    if (!isUnlocked()) setPending({ action, detail });
    else if (action === "reveal") setRevealed((current) => new Set(current).add(detail.id));
    else setDialog({ detail });
  };

  const reorder = async (next: string[]) => {
    const changes = reorderWithin(list, next);
    if (changes.length === 0) return;
    const moved = new Map(changes.map((change) => [change.id, change.sort_order]));
    queryClient.setQueryData<CompanyDetail[]>(detailsKey, (rows) =>
      rows
        ?.map((row) => (moved.has(row.id) ? { ...row, sort_order: moved.get(row.id)! } : row))
        .sort(bySortOrder),
    );
    try {
      await saveOrder(viewer, "company_details", changes);
    } catch (error) {
      report(error);
    }
    await queryClient.invalidateQueries({ queryKey: ["company-details", company.id] });
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from >= 0 && to >= 0) void reorder(arrayMove(ids, from, to));
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await deleteDetail(viewer, deleting.id);
      toast.success(`${deleting.label} deleted`);
    } catch (error) {
      report(error);
    }
    await refresh();
    setDeleteBusy(false);
    setDeleting(null);
  };

  const shownFor = (detail: CompanyDetail): Shown => {
    if (!detail.is_sensitive) return { state: "open", value: detail.value };
    if (!visible.has(detail.id)) return { state: "masked" };
    if (sensitive.data) return { state: "open", value: sensitive.data[detail.id] ?? null };
    return sensitive.isError ? { state: "failed" } : { state: "loading" };
  };

  const actions: RowActions = {
    onReveal: (detail) => whenUnlocked("reveal", detail),
    onHide: (detail) =>
      setRevealed((current) => new Set([...current].filter((id) => id !== detail.id))),
    onEdit: (detail) =>
      detail.is_sensitive ? whenUnlocked("edit", detail) : setDialog({ detail }),
    onDelete: setDeleting,
    onMove: (detail, step) => void reorder(moveBy(ids, detail.id, step)),
  };

  const editing = dialog?.detail ?? null;
  const editingValue = !editing
    ? null
    : !editing.is_sensitive
      ? editing.value
      : sensitive.data
        ? (sensitive.data[editing.id] ?? null)
        : undefined;

  return (
    <section aria-labelledby="profile-details" className="glass rounded-2xl">
      {heading}
      {admin && (
        <p className="flex items-center gap-2.5 border-b border-line bg-warn/5 px-5 py-2.5 text-sm text-fg">
          <TriangleAlert className="size-4 shrink-0 text-warn" aria-hidden="true" />
          Don't store passwords here.
        </p>
      )}

      {list.length === 0 ? (
        <EmptyState
          title="No other details yet"
          action={
            admin ? (
              <Button variant="primary" onClick={() => setDialog({ detail: null })}>
                <Plus aria-hidden="true" />
                Add the first detail
              </Button>
            ) : undefined
          }
        >
          {admin
            ? "Add anything worth keeping with the company: a contact, a reference number, a year end."
            : `Nothing else has been added for ${company.name}.`}
        </EmptyState>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={ids} strategy={verticalListSortingStrategy} disabled={!admin}>
            <ul>
              {list.map((detail, index) => (
                <DetailRow
                  key={detail.id}
                  detail={detail}
                  shown={shownFor(detail)}
                  admin={admin}
                  position={index}
                  count={list.length}
                  actions={actions}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      {admin && (
        <>
          <DetailDialog
            open={dialog !== null}
            onOpenChange={(open) => !open && setDialog(null)}
            companyId={company.id}
            detail={editing}
            value={editingValue}
            loadFailure={
              editingSensitive && sensitive.isError
                ? classifyCompanyDataError(sensitive.error, "details")
                : undefined
            }
            nextSortOrder={list.reduce((max, detail) => Math.max(max, detail.sort_order), -1) + 1}
          />
          <FormDialog
            open={pending !== null}
            onOpenChange={(open) => !open && setPending(null)}
            icon={LockKeyhole}
            title="Confirm your password"
            description={`${pending?.detail.label ?? "This detail"} is marked sensitive. It stays hidden until you confirm your password, and hides again when the lock closes.`}
          >
            <div className="mt-5">
              <UnlockForm />
            </div>
          </FormDialog>
          <ConfirmDialog
            open={deleting !== null}
            onOpenChange={(open) => !open && setDeleting(null)}
            title={`Delete ${deleting?.label ?? "this detail"}?`}
            confirmLabel="Delete detail"
            tone="danger"
            busy={deleteBusy}
            onConfirm={() => void confirmDelete()}
          >
            <p>The label and its value are removed from {company.name} for good.</p>
          </ConfirmDialog>
        </>
      )}
    </section>
  );
}

export function ProfilePage() {
  return (
    <>
      <PageHeader
        title="Company profile"
        description="The selected company's registered details, and anything else worth keeping with it."
        actions={<UnlockStatus />}
      />
      <div className="mt-8">
        <CompanyGate>
          {(current) => (
            // Keyed by company: switching company starts again, with everything masked.
            <div
              key={current.company.id}
              className="grid items-start gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]"
            >
              <CoreCard current={current} />
              <Details current={current} />
            </div>
          )}
        </CompanyGate>
      </div>
    </>
  );
}
