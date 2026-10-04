import { useId, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { CircleAlert, type LucideIcon } from "lucide-react";
import { Label } from "@/components/ui/label";
import type { DataFailure } from "@/lib/supabase/errors";

interface ControlProps {
  id: string;
  "aria-invalid": boolean;
  "aria-describedby": string | undefined;
}

/** A label, one control, and the hint or error that belongs to it, wired up for screen readers. */
export function FormField({
  label,
  optional,
  error,
  hint,
  children,
}: {
  label: string;
  optional?: boolean;
  error?: string;
  hint?: ReactNode;
  children: (control: ControlProps) => ReactNode;
}) {
  const id = useId();
  const noteId = useId();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>
        {label}
        {optional && <span className="ml-1.5 font-normal text-subtle">(optional)</span>}
      </Label>
      {children({
        id,
        "aria-invalid": error !== undefined,
        "aria-describedby": error || hint ? noteId : undefined,
      })}
      {(error || hint) && (
        <p id={noteId} className={error ? "text-sm text-danger" : "text-sm text-muted"}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

/** Why saving failed, shown inside the form that failed. */
export function FailureNote({ failure }: { failure: DataFailure }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-lg border border-danger/30 bg-danger/10 p-3.5 text-sm"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
      <div>
        <p className="font-medium text-fg">{failure.title}</p>
        <p className="mt-1 text-muted">{failure.message}</p>
      </div>
    </div>
  );
}

/** The frame every add/edit dialog shares. Its children are mounted only while it is open. */
export function FormDialog({
  open,
  onOpenChange,
  icon: Icon,
  title,
  description,
  wide = false,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  icon: LucideIcon;
  title: string;
  description: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          className={`fixed top-1/2 left-1/2 z-50 max-h-[92vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-line-strong bg-elevated p-6 shadow-pop outline-none ${
            wide ? "w-[min(92vw,36rem)]" : "w-[min(92vw,30rem)]"
          }`}
        >
          <div className="flex items-start gap-4">
            <span className="grid size-11 shrink-0 place-items-center rounded-full border border-accent/30 bg-accent/10">
              <Icon className="size-5 text-accent" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-muted">
                {description}
              </Dialog.Description>
            </div>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
