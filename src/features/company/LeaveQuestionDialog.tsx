import { ConfirmDialog } from "@/components/ui/dialog";
import { useStore } from "@/lib/store";
import { leaveQuestion, unsavedTitle } from "./leaveGuard";

/** The question asked by askBeforeLeaving. Rendered once, by the company provider. */
export function LeaveQuestionDialog() {
  const asked = useStore(leaveQuestion);
  return (
    <ConfirmDialog
      open={asked !== null}
      onOpenChange={(open) => {
        if (!open) leaveQuestion.set(null);
      }}
      title={asked ? unsavedTitle(asked.apps) : ""}
      cancelLabel={asked ? `Stay on ${asked.stayOn}` : undefined}
      confirmLabel="Switch anyway"
      tone="danger"
      onConfirm={() => {
        const go = asked?.go;
        leaveQuestion.set(null);
        go?.();
      }}
    >
      <p>Switch anyway?</p>
    </ConfirmDialog>
  );
}
