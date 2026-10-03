import type { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  /** "danger" for actions that remove or overwrite something. */
  tone?: "primary" | "danger";
  busy?: boolean;
  onConfirm: () => void;
}

/** Asks before doing something that overwrites or removes data. Cancel is the default focus. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  confirmLabel,
  tone = "primary",
  busy = false,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          role="alertdialog"
          className="fixed top-1/2 left-1/2 z-50 w-[min(92vw,28rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line-strong bg-elevated p-6 shadow-pop outline-none"
        >
          <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
          <Dialog.Description asChild>
            <div className="mt-2 space-y-2 text-sm text-muted">{children}</div>
          </Dialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button autoFocus disabled={busy}>
                Cancel
              </Button>
            </Dialog.Close>
            <Button variant={tone} disabled={busy} onClick={onConfirm}>
              {busy && <LoaderCircle className="animate-spin" aria-hidden="true" />}
              {confirmLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
