import { useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { CalendarDays, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FailureNote, FormField } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { isEmploymentDate, type PayrollRow } from "@/config/payrollFields";
import { useAuth } from "@/features/auth/auth-context";
import type { DataFailure } from "@/lib/supabase/errors";
import { classifyEmployeeDateError, setEmployeeDate } from "@/lib/supabase/payroll";

function DateForm({ row, onDone }: { row: PayrollRow; onDone: () => void }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [value, setValue] = useState(row.date_of_employment ?? "");
  const [error, setError] = useState<string>();
  const [failure, setFailure] = useState<DataFailure | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (next: string | null) => {
    if (!user || !row.employee_id || busy) return;
    if (next !== null && !isEmploymentDate(next)) {
      setError("Enter a real date between 1900 and 2100.");
      return;
    }
    setError(undefined);
    setFailure(null);
    setBusy(true);
    try {
      await setEmployeeDate({ id: user.id, isDemo: user.isDemo }, row.employee_id, next);
      // The date belongs to the employee, so every run that shows them is out of date.
      await queryClient.invalidateQueries({ queryKey: ["run-entries"] });
      toast.success(
        next ? `Date of employment saved for ${row.surname}` : `Date of employment cleared`,
      );
      onDone();
    } catch (problem) {
      setFailure(classifyEmployeeDateError(problem));
      setBusy(false);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void save(value === "" ? null : value);
  };

  return (
    <form onSubmit={onSubmit} noValidate className="mt-5 space-y-4">
      <FormField
        label="Date of employment"
        error={error}
        hint="Sent to apps with this employee's saved runs. An import never changes it."
      >
        {(control) => (
          <Input
            {...control}
            type="date"
            min="1900-01-01"
            max="2100-12-31"
            value={value}
            disabled={busy}
            onChange={(event) => setValue(event.target.value)}
          />
        )}
      </FormField>

      {failure && <FailureNote failure={failure} />}

      <div className="flex flex-wrap justify-end gap-2 pt-1">
        {row.date_of_employment && (
          <Button type="button" className="mr-auto" disabled={busy} onClick={() => void save(null)}>
            Clear the date
          </Button>
        )}
        <Dialog.Close asChild>
          <Button disabled={busy}>Cancel</Button>
        </Dialog.Close>
        <Button type="submit" variant="primary" disabled={busy || value === ""}>
          {busy && <LoaderCircle className="animate-spin" aria-hidden="true" />}
          {busy ? "Saving" : "Save"}
        </Button>
      </div>
    </form>
  );
}

/**
 * Sets, changes or clears one employee's date of employment. Offered to admins only; the
 * database's update policy on `employees` is what actually decides.
 */
export function EmployeeDateDialog({
  row,
  onClose,
}: {
  row: PayrollRow | null;
  onClose: () => void;
}) {
  return (
    <Dialog.Root open={row !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[min(92vw,28rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line-strong bg-elevated p-6 shadow-pop outline-none">
          <div className="flex items-start gap-4">
            <span className="grid size-11 shrink-0 place-items-center rounded-full border border-accent/30 bg-accent/10">
              <CalendarDays className="size-5 text-accent" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <Dialog.Title className="text-lg font-semibold">Date of employment</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-muted">
                {row ? `${row.surname}${row.other_names ? `, ${row.other_names}` : ""}` : ""}
              </Dialog.Description>
            </div>
          </div>
          {/* Mounted only while open, so the form starts from the saved value every time. */}
          {row && <DateForm key={row.id} row={row} onDone={onClose} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
