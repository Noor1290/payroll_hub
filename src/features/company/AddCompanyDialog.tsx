import { useId, useRef, useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { Building2, CircleAlert, Info, LoaderCircle, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/features/auth/auth-context";
import { useStore } from "@/lib/store";
import { useCompany } from "./company-context";
import {
  addCompanyOpen,
  classifyCreateCompanyError,
  COMPANY_LIMITS,
  createCompany,
  fieldErrors,
  newCompanySchema,
  type CreateCompanyFailure,
  type NewCompanyField,
} from "./createCompany";

const EMPTY = { name: "", address: "", brn: "", vat: "" };

interface FieldProps {
  field: NewCompanyField;
  label: string;
  optional?: boolean;
  placeholder?: string;
  value: string;
  error?: string;
  hint?: string;
  disabled: boolean;
  onChange: (value: string) => void;
}

function Field({
  field,
  label,
  optional,
  placeholder,
  value,
  error,
  hint,
  disabled,
  onChange,
}: FieldProps) {
  const id = useId();
  const noteId = useId();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>
        {label}
        {optional && <span className="ml-1.5 font-normal text-subtle">(optional)</span>}
      </Label>
      <Input
        id={id}
        name={field}
        value={value}
        placeholder={placeholder}
        // A little above the limit, so the "too long" message can explain instead of typing just stopping.
        maxLength={COMPANY_LIMITS[field] + 50}
        autoComplete="off"
        required={!optional}
        disabled={disabled}
        aria-invalid={error !== undefined}
        aria-describedby={error || hint ? noteId : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {(error || hint) && (
        <p id={noteId} className={error ? "text-sm text-danger" : "text-sm text-muted"}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

function AddCompanyForm({ onDone }: { onDone: () => void }) {
  const { user } = useAuth();
  const { select } = useCompany();
  const queryClient = useQueryClient();
  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<NewCompanyField, string>>>({});
  const [failure, setFailure] = useState<CreateCompanyFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  const set = (field: NewCompanyField) => (value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const focusFirstInvalid = () =>
    // After React has marked the fields, move to the first one that needs attention.
    setTimeout(() => form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !user) return;
    setFailure(null);

    const parsed = newCompanySchema.safeParse(values);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      focusFirstInvalid();
      return;
    }

    setBusy(true);
    try {
      const company = await createCompany({ id: user.id, isDemo: user.isDemo }, parsed.data);
      // Choose it now; it becomes the selected company as soon as the refreshed list has it.
      select(company.id);
      await queryClient.invalidateQueries({ queryKey: ["memberships"] });
      toast.success(`${company.name} added`, {
        description: "You are its admin. It is now the selected company.",
      });
      onDone();
    } catch (error) {
      const problem = classifyCreateCompanyError(error);
      setFailure(problem);
      if (problem.field) {
        setErrors((current) => ({ ...current, [problem.field!]: problem.title }));
        focusFirstInvalid();
      }
      setBusy(false);
    }
  };

  return (
    <form ref={form} onSubmit={onSubmit} noValidate className="mt-5 space-y-4">
      <Field
        field="name"
        label="Company name"
        placeholder="ABC Co Ltd"
        value={values.name}
        error={errors.name}
        disabled={busy}
        onChange={set("name")}
      />
      <Field
        field="brn"
        label="BRN"
        placeholder="C1234567"
        value={values.brn}
        error={errors.brn}
        disabled={busy}
        onChange={set("brn")}
      />
      <div className="flex items-start gap-2.5 rounded-lg border border-line bg-surface p-3 text-sm text-muted">
        <Info className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
        <p>
          The BRN must be exactly the BRN in this company's payroll JSON exports. Imports are
          matched to a company by BRN, so a different value here means its files won't be
          recognised.
        </p>
      </div>
      <Field
        field="address"
        label="Address"
        optional
        value={values.address}
        error={errors.address}
        disabled={busy}
        onChange={set("address")}
      />
      <Field
        field="vat"
        label="VAT"
        optional
        placeholder="15%"
        value={values.vat}
        error={errors.vat}
        disabled={busy}
        onChange={set("vat")}
      />

      {failure && (
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
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Dialog.Close asChild>
          <Button disabled={busy}>Cancel</Button>
        </Dialog.Close>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          ) : (
            <Plus aria-hidden="true" />
          )}
          {busy ? "Adding" : "Add company"}
        </Button>
      </div>
    </form>
  );
}

/**
 * The "Add company" dialog. Rendered once in the app shell and opened through `addCompanyOpen`.
 * Offered only to users who are already an admin somewhere; the database function enforces
 * that rule itself, so this is a courtesy, not the check.
 */
export function AddCompanyDialog() {
  const open = useStore(addCompanyOpen);
  const { canAddCompany } = useCompany();
  if (!canAddCompany) return null;

  return (
    <Dialog.Root open={open} onOpenChange={addCompanyOpen.set}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[92vh] w-[min(92vw,30rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-line-strong bg-elevated p-6 shadow-pop outline-none">
          <div className="flex items-start gap-4">
            <span className="grid size-11 shrink-0 place-items-center rounded-full border border-accent/30 bg-accent/10">
              <Building2 className="size-5 text-accent" aria-hidden="true" />
            </span>
            <div>
              <Dialog.Title className="text-lg font-semibold">Add a company</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-muted">
                You will be its admin. Other people are given access by the owner.
              </Dialog.Description>
            </div>
          </div>
          {/* Mounted only while open, so the form starts empty every time. */}
          <AddCompanyForm onDone={() => addCompanyOpen.set(false)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
