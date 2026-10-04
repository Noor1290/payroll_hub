import { useRef, useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { ListPlus, LoaderCircle, Save, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FailureNote, FormDialog, FormField } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { useAuth } from "@/features/auth/auth-context";
import { focusFirstInvalid } from "@/lib/forms";
import { fieldErrors } from "@/features/links/linkModel";
import {
  classifyCompanyDataError,
  createDetail,
  updateDetail,
  type CompanyDataFailure,
  type CompanyDetail,
} from "@/lib/supabase/companyData";
import {
  DETAIL_LIMITS,
  detailFormSchema,
  FIELD_TYPE_LABELS,
  FIELD_TYPES,
  type DetailField,
  type FieldType,
} from "./profileModel";

const PLACEHOLDERS: Record<FieldType, string> = {
  text: "",
  link: "https://example.org",
  email: "name@example.com",
  phone: "+230 5555 0100",
  date: "2026-06-30",
  number: "12.5",
};

interface DetailFormProps {
  companyId: string;
  /** The detail being edited, or null to add one. */
  detail: CompanyDetail | null;
  /** Its current value. For a sensitive detail this arrives separately, once the gate is open. */
  value: string | null;
  /** Where a new detail goes in the list. */
  nextSortOrder: number;
  onDone: () => void;
}

function DetailForm({ companyId, detail, value, nextSortOrder, onDone }: DetailFormProps) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [values, setValues] = useState({
    label: detail?.label ?? "",
    field_type: (detail?.field_type ?? "text") as FieldType,
    value: value ?? "",
    is_sensitive: detail?.is_sensitive ?? false,
  });
  const [errors, setErrors] = useState<Partial<Record<DetailField, string>>>({});
  const [failure, setFailure] = useState<CompanyDataFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  const set = <K extends keyof typeof values>(field: K, next: (typeof values)[K]) => {
    setValues((current) => ({ ...current, [field]: next }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !user) return;
    setFailure(null);

    const parsed = detailFormSchema.safeParse(values);
    if (!parsed.success) {
      setErrors(fieldErrors<DetailField>(parsed.error));
      focusFirstInvalid(form.current);
      return;
    }

    setBusy(true);
    const viewer = { id: user.id, isDemo: user.isDemo };
    try {
      if (detail) await updateDetail(viewer, detail.id, parsed.data);
      else await createDetail(viewer, companyId, parsed.data, nextSortOrder);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["company-details", companyId] }),
        queryClient.invalidateQueries({ queryKey: ["company-details-sensitive", companyId] }),
      ]);
      toast.success(detail ? `${parsed.data.label} updated` : `${parsed.data.label} added`);
      onDone();
    } catch (error) {
      const problem = classifyCompanyDataError(error, "details");
      setFailure(problem);
      if (problem.field === "label") {
        setErrors((current) => ({ ...current, label: problem.title }));
        focusFirstInvalid(form.current);
      }
      setBusy(false);
    }
  };

  return (
    <form ref={form} onSubmit={onSubmit} noValidate className="mt-5 space-y-4">
      <FormField label="Label" error={errors.label}>
        {(control) => (
          <Input
            {...control}
            value={values.label}
            maxLength={DETAIL_LIMITS.label + 50}
            placeholder="Payroll contact"
            autoComplete="off"
            required
            disabled={busy}
            onChange={(event) => set("label", event.target.value)}
          />
        )}
      </FormField>
      <FormField label="Kind of value">
        {(control) => (
          <select
            {...control}
            value={values.field_type}
            disabled={busy}
            onChange={(event) => set("field_type", event.target.value as FieldType)}
            className="h-11 w-full rounded-lg border border-line bg-canvas/60 px-3 text-[15px] text-fg shadow-inner-glow hover:border-line-strong"
          >
            {FIELD_TYPES.map((type) => (
              <option key={type} value={type}>
                {FIELD_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <FormField label="Value" optional error={errors.value}>
        {(control) => (
          <Input
            {...control}
            value={values.value}
            maxLength={DETAIL_LIMITS.value + 50}
            placeholder={PLACEHOLDERS[values.field_type]}
            autoComplete="off"
            spellCheck={values.field_type === "text"}
            disabled={busy}
            onChange={(event) => set("value", event.target.value)}
          />
        )}
      </FormField>

      <label className="flex cursor-pointer items-start gap-2.5 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 size-4 rounded accent-(--accent)"
          checked={values.is_sensitive}
          disabled={busy}
          onChange={(event) => set("is_sensitive", event.target.checked)}
        />
        <span>
          Sensitive
          <span className="mt-0.5 block text-muted">
            Only admins can see it, and only after confirming their password. Viewers are not shown
            it at all.
          </span>
        </span>
      </label>

      <p className="flex items-start gap-2.5 rounded-lg border border-warn/30 bg-warn/10 p-3 text-sm text-fg">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
        Don't store passwords here.
      </p>

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
          {busy ? "Saving" : detail ? "Save changes" : "Add detail"}
        </Button>
      </div>
    </form>
  );
}

/** Add or edit one custom detail. Offered to admins only; the database checks the role itself. */
export function DetailDialog({
  open,
  onOpenChange,
  value,
  loadFailure,
  ...form
}: Omit<DetailFormProps, "onDone" | "value"> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Undefined while a sensitive value is still being fetched. */
  value: string | null | undefined;
  /** Set when that fetch failed: the form is not shown, so the value can't be overwritten blind. */
  loadFailure?: CompanyDataFailure;
}) {
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      icon={ListPlus}
      title={form.detail ? "Edit detail" : "Add a detail"}
      description="A labelled value shown on this company's profile."
    >
      {loadFailure ? (
        <div className="mt-5">
          <FailureNote failure={loadFailure} />
        </div>
      ) : value === undefined ? (
        <div aria-busy="true" aria-label="Loading the value" className="mt-5 space-y-3">
          <Skeleton className="h-11" />
          <Skeleton className="h-11" />
          <Skeleton className="h-11" />
        </div>
      ) : (
        <DetailForm
          key={form.detail?.id ?? "new"}
          {...form}
          value={value}
          onDone={() => onOpenChange(false)}
        />
      )}
    </FormDialog>
  );
}
