import { useRef, useState, type ComponentProps, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileSpreadsheet, Info, LoaderCircle, Pencil, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FailureNote, FormDialog, FormField } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { ErrorState } from "@/components/ui/states";
import { useAuth } from "@/features/auth/auth-context";
import { fieldErrors } from "@/features/links/linkModel";
import { focusFirstInvalid } from "@/lib/forms";
import {
  fetchMraCompanyDetails,
  fetchMraSettings,
  saveMraCompanyDetails,
  saveMraSettings,
  type MraCompanyDetails,
  type MraSettings,
} from "@/lib/supabase/mraReturns";
import type { Company, Membership } from "@/lib/supabase/schemas";
import { cn } from "@/lib/utils";
import { classifyMraError, mraFormSchema, type MraFailure } from "./mraModel";

/**
 * A company's details for the MRA return files (migration 0020): the Employer Registration
 * Number, the telephone and mobile numbers and the name of the declarant, and the signed-in
 * user's own email for the returns, the same for every company. Admins only: the database lets
 * nobody else read or change them, so a member does not see this card at all.
 */

type Field = "ern" | "telephone" | "mobile" | "declarant" | "email";
/** What FormField hands its input: id, label and error wiring. */
type ControlProps = Parameters<ComponentProps<typeof FormField>["children"]>[0];

function MraForm({
  company,
  details,
  settings,
  onDone,
}: {
  company: Company;
  details: MraCompanyDetails | null;
  settings: MraSettings | null;
  onDone: () => void;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [values, setValues] = useState({
    ern: details?.ern ?? "",
    telephone: details?.telephone ?? "",
    mobile: details?.mobile ?? "",
    declarant: details?.declarant ?? "",
    email: settings?.email ?? "",
  });
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [failure, setFailure] = useState<MraFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  const set = (field: Field) => (value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !user) return;
    setFailure(null);
    const parsed = mraFormSchema.safeParse(values);
    if (!parsed.success) {
      setErrors(fieldErrors<Field>(parsed.error));
      focusFirstInvalid(form.current);
      return;
    }
    const viewer = { id: user.id, isDemo: user.isDemo };
    const { email, ...own } = parsed.data;
    const ownChanged =
      !details ||
      own.ern !== details.ern ||
      own.telephone !== details.telephone ||
      own.mobile !== details.mobile ||
      own.declarant !== details.declarant;
    const emailChanged = email !== (settings?.email ?? "");

    setBusy(true);
    try {
      if (ownChanged) {
        await saveMraCompanyDetails(viewer, company.id, {
          ...own,
          expectedRevision: details?.revision ?? 0,
        });
      }
      if (emailChanged) await saveMraSettings(viewer, email, settings?.revision ?? 0);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["mra-company-details", company.id] }),
        queryClient.invalidateQueries({ queryKey: ["mra-settings"] }),
      ]);
      toast.success(`MRA details of ${company.name} saved`);
      onDone();
    } catch (error) {
      setFailure(classifyMraError(error));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["mra-company-details", company.id] }),
        queryClient.invalidateQueries({ queryKey: ["mra-settings"] }),
      ]);
      setBusy(false);
    }
  };

  const input =
    (field: Field, more: Record<string, unknown> = {}) =>
    (control: ControlProps) => (
      <Input
        {...control}
        {...more}
        value={values[field]}
        autoComplete="off"
        disabled={busy}
        onChange={(event) => set(field)(event.target.value)}
      />
    );

  return (
    <form ref={form} onSubmit={onSubmit} noValidate className="mt-5 space-y-4">
      <FormField label="Employer Registration Number (ERN)" optional error={errors.ern}>
        {input("ern", { maxLength: 40, inputMode: "text", className: "tabular" })}
      </FormField>
      <FormField label="Telephone number" optional error={errors.telephone}>
        {input("telephone", { maxLength: 40, inputMode: "tel" })}
      </FormField>
      <FormField label="Mobile number" optional error={errors.mobile}>
        {input("mobile", { maxLength: 40, inputMode: "tel" })}
      </FormField>
      <FormField label="Name of declarant" optional error={errors.declarant}>
        {input("declarant", { maxLength: 170 })}
      </FormField>
      <FormField label="Your email for the MRA returns" optional error={errors.email}>
        {input("email", { maxLength: 300, inputMode: "email" })}
      </FormField>
      <div className="flex items-start gap-2.5 rounded-lg border border-line bg-surface p-3 text-sm text-muted">
        <Info className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
        <p>
          The email is yours: the same for every company, and other admins do not see it. A template
          in MRA Returns can use a fixed email instead.
        </p>
      </div>

      {failure && <FailureNote failure={{ kind: "unknown", retryable: false, ...failure }} />}

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

/** The MRA details of the selected company, for its admins. Nothing at all for anyone else. */
export function MraCard({ current }: { current: Membership }) {
  const { user } = useAuth();
  const [editing, setEditing] = useState(false);
  const { company } = current;
  const admin = current.role === "admin";
  const viewer = user ? { id: user.id, isDemo: user.isDemo } : null;

  const details = useQuery({
    queryKey: ["mra-company-details", company.id, user?.id],
    queryFn: () => fetchMraCompanyDetails(viewer!, company.id),
    enabled: admin && viewer !== null,
  });
  const settings = useQuery({
    queryKey: ["mra-settings", user?.id],
    queryFn: () => fetchMraSettings(viewer!),
    enabled: admin && viewer !== null,
  });

  if (!admin) return null;

  const heading = (
    <div className="flex items-center gap-3 border-b border-line px-5 py-4">
      <h2 id="profile-mra" className="flex-1 font-semibold">
        MRA returns
      </h2>
      {details.isSuccess && settings.isSuccess && (
        <Button size="sm" onClick={() => setEditing(true)} aria-label="Edit the MRA details">
          <Pencil aria-hidden="true" />
          Edit
        </Button>
      )}
    </div>
  );

  if (details.isPending || settings.isPending) {
    return (
      <section aria-labelledby="profile-mra" className="glass rounded-2xl">
        {heading}
        <div aria-busy="true" aria-label="Loading the MRA details" className="space-y-2 p-4">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      </section>
    );
  }
  if (details.isError || settings.isError) {
    const failure = classifyMraError(details.error ?? settings.error);
    return (
      <section aria-labelledby="profile-mra" className="glass rounded-2xl">
        {heading}
        <ErrorState
          failure={{ kind: "unknown", retryable: true, ...failure }}
          onRetry={() => void Promise.all([details.refetch(), settings.refetch()])}
          className="m-4"
        />
      </section>
    );
  }

  const fields: [string, string, boolean][] = [
    ["Employer Registration Number (ERN)", details.data?.ern ?? "", true],
    ["Telephone number", details.data?.telephone ?? "", true],
    ["Mobile number", details.data?.mobile ?? "", true],
    ["Name of declarant", details.data?.declarant ?? "", false],
    ["Your email (the same for every company)", settings.data?.email ?? "", false],
  ];

  return (
    <section aria-labelledby="profile-mra" className="glass rounded-2xl" data-testid="mra-card">
      {heading}
      <p className="flex items-center gap-2.5 border-b border-line px-5 py-2.5 text-sm text-muted">
        <FileSpreadsheet className="size-4 shrink-0 text-accent" aria-hidden="true" />
        Used on the employer line of the CSG and PRGF files. Only admins see these.
      </p>
      <dl className="divide-y divide-line">
        {fields.map(([label, value, number]) => (
          <div key={label} className="px-5 py-3">
            <dt className="text-sm text-muted">{label}</dt>
            <dd className={cn("mt-0.5 break-words", number && "tabular")}>
              {value ? value : <span className="text-subtle">Not set</span>}
            </dd>
          </div>
        ))}
      </dl>
      <FormDialog
        open={editing}
        onOpenChange={setEditing}
        icon={FileSpreadsheet}
        title="Edit the MRA details"
        description={`For the return files of ${company.name}.`}
      >
        <MraForm
          company={company}
          details={details.data ?? null}
          settings={settings.data ?? null}
          onDone={() => setEditing(false)}
        />
      </FormDialog>
    </section>
  );
}
