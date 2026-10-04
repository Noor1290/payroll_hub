import { useRef, useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { Building2, Info, LoaderCircle, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FailureNote, FormDialog, FormField } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/features/auth/auth-context";
import { focusFirstInvalid } from "@/lib/forms";
import { fieldErrors } from "@/features/links/linkModel";
import {
  classifyCompanyDataError,
  updateCompanyCore,
  type CompanyDataFailure,
} from "@/lib/supabase/companyData";
import type { Company, Membership } from "@/lib/supabase/schemas";
import { CORE_LIMITS, coreFormSchema, type CoreField } from "./profileModel";

function CoreForm({ company, onDone }: { company: Company; onDone: () => void }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [values, setValues] = useState({
    name: company.name,
    address: company.address ?? "",
    vat: company.vat ?? "",
  });
  const [errors, setErrors] = useState<Partial<Record<CoreField, string>>>({});
  const [failure, setFailure] = useState<CompanyDataFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  const set = (field: CoreField) => (value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !user) return;
    setFailure(null);

    const parsed = coreFormSchema.safeParse(values);
    if (!parsed.success) {
      setErrors(fieldErrors<CoreField>(parsed.error));
      focusFirstInvalid(form.current);
      return;
    }

    setBusy(true);
    try {
      const saved = await updateCompanyCore(
        { id: user.id, isDemo: user.isDemo },
        company.id,
        parsed.data,
      );
      // The company list is where the name is read from everywhere else: update it at once.
      queryClient.setQueriesData<Membership[]>({ queryKey: ["memberships"] }, (list) =>
        list?.map((m) => (m.company.id === saved.id ? { ...m, company: saved } : m)),
      );
      await queryClient.invalidateQueries({ queryKey: ["memberships"] });
      toast.success(`${saved.name} updated`);
      onDone();
    } catch (error) {
      setFailure(classifyCompanyDataError(error, "company"));
      setBusy(false);
    }
  };

  return (
    <form ref={form} onSubmit={onSubmit} noValidate className="mt-5 space-y-4">
      <FormField label="Company name" error={errors.name}>
        {(control) => (
          <Input
            {...control}
            value={values.name}
            maxLength={CORE_LIMITS.name + 50}
            autoComplete="off"
            required
            disabled={busy}
            onChange={(event) => set("name")(event.target.value)}
          />
        )}
      </FormField>
      <FormField label="BRN">
        {(control) => (
          <Input {...control} value={company.brn ?? ""} placeholder="Not set" readOnly disabled />
        )}
      </FormField>
      <div className="flex items-start gap-2.5 rounded-lg border border-line bg-surface p-3 text-sm text-muted">
        <Info className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
        <p>
          The BRN must match the BRN in the payroll JSON exports. It can only be changed in the
          Supabase SQL editor, because changing it affects how imports are matched to this company.
        </p>
      </div>
      <FormField label="Address" optional error={errors.address}>
        {(control) => (
          <Input
            {...control}
            value={values.address}
            maxLength={CORE_LIMITS.address + 50}
            autoComplete="off"
            disabled={busy}
            onChange={(event) => set("address")(event.target.value)}
          />
        )}
      </FormField>
      <FormField label="VAT" optional error={errors.vat}>
        {(control) => (
          <Input
            {...control}
            value={values.vat}
            maxLength={CORE_LIMITS.vat + 50}
            placeholder="15%"
            autoComplete="off"
            disabled={busy}
            onChange={(event) => set("vat")(event.target.value)}
          />
        )}
      </FormField>

      {failure && <FailureNote failure={failure} />}

      <div className="flex justify-end gap-2 pt-1">
        <Dialog.Close asChild>
          <Button disabled={busy}>Cancel</Button>
        </Dialog.Close>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          ) : (
            <Save aria-hidden="true" />
          )}
          {busy ? "Saving" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

/** Edits a company's name, address and VAT. The BRN is shown but cannot be changed here. */
export function CoreDialog({
  open,
  onOpenChange,
  company,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  company: Company;
}) {
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      icon={Building2}
      title="Edit company"
      description="These appear wherever the company is named in the dashboard."
    >
      <CoreForm company={company} onDone={() => onOpenChange(false)} />
    </FormDialog>
  );
}
