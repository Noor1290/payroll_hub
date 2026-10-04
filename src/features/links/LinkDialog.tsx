import { useId, useRef, useState, type CSSProperties, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { Link2, LoaderCircle, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FailureNote, FormDialog, FormField } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/features/auth/auth-context";
import { focusFirstInvalid } from "@/lib/forms";
import {
  classifyCompanyDataError,
  createLinks,
  updateLink,
  type CompanyDataFailure,
  type CompanyLink,
} from "@/lib/supabase/companyData";
import { DEFAULT_ICON, LINK_ICONS } from "./icons";
import {
  ACCENTS,
  DEFAULT_ACCENT,
  fieldErrors,
  LINK_LIMITS,
  linkFormSchema,
  type LinkField,
} from "./linkModel";

interface LinkFormProps {
  companyId: string;
  /** The link being edited, or null to add one. */
  link: CompanyLink | null;
  /** The company's current links: for the category suggestions and the new link's position. */
  links: readonly CompanyLink[];
  onDone: () => void;
}

function LinkForm({ companyId, link, links, onDone }: LinkFormProps) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [values, setValues] = useState({
    title: link?.title ?? "",
    url: link?.url ?? "",
    description: link?.description ?? "",
    category: link?.category ?? "",
    icon: link?.icon && link.icon in LINK_ICONS ? link.icon : DEFAULT_ICON,
    accent: ACCENTS.some((accent) => accent.key === link?.accent)
      ? (link!.accent as string)
      : DEFAULT_ACCENT,
    is_pinned: link?.is_pinned ?? false,
  });
  const [errors, setErrors] = useState<Partial<Record<LinkField, string>>>({});
  const [failure, setFailure] = useState<CompanyDataFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const categoriesId = useId();
  const categories = [...new Set(links.map((l) => l.category).filter((c): c is string => !!c))];

  const set = <K extends keyof typeof values>(field: K, value: (typeof values)[K]) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !user) return;
    setFailure(null);

    const parsed = linkFormSchema.safeParse(values);
    if (!parsed.success) {
      setErrors(fieldErrors<LinkField>(parsed.error));
      focusFirstInvalid(form.current);
      return;
    }

    setBusy(true);
    const viewer = { id: user.id, isDemo: user.isDemo };
    try {
      if (link) await updateLink(viewer, link.id, parsed.data);
      else {
        const last = links.reduce((max, l) => Math.max(max, l.sort_order), -1);
        await createLinks(viewer, companyId, [parsed.data], last + 1);
      }
      await queryClient.invalidateQueries({ queryKey: ["company-links", companyId] });
      toast.success(link ? `${parsed.data.title} updated` : `${parsed.data.title} added`);
      onDone();
    } catch (error) {
      const problem = classifyCompanyDataError(error, "links");
      setFailure(problem);
      if (problem.field === "url") {
        setErrors((current) => ({ ...current, url: problem.title }));
        focusFirstInvalid(form.current);
      }
      setBusy(false);
    }
  };

  return (
    <form ref={form} onSubmit={onSubmit} noValidate className="mt-5 space-y-4">
      <FormField label="Title" error={errors.title}>
        {(control) => (
          <Input
            {...control}
            value={values.title}
            maxLength={LINK_LIMITS.title + 50}
            placeholder="Tax portal"
            autoComplete="off"
            required
            disabled={busy}
            onChange={(event) => set("title", event.target.value)}
          />
        )}
      </FormField>
      <FormField label="Web address" error={errors.url} hint="Must start with https:// or http://.">
        {(control) => (
          <Input
            {...control}
            type="url"
            inputMode="url"
            value={values.url}
            placeholder="https://example.org/tax"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            required
            disabled={busy}
            onChange={(event) => set("url", event.target.value)}
          />
        )}
      </FormField>
      <FormField label="Description" optional error={errors.description}>
        {(control) => (
          <Input
            {...control}
            value={values.description}
            maxLength={LINK_LIMITS.description + 50}
            autoComplete="off"
            disabled={busy}
            onChange={(event) => set("description", event.target.value)}
          />
        )}
      </FormField>
      <FormField
        label="Category"
        optional
        error={errors.category}
        hint="Links with the same category are shown together."
      >
        {(control) => (
          <>
            <Input
              {...control}
              list={categoriesId}
              value={values.category}
              maxLength={LINK_LIMITS.category + 20}
              placeholder="Government"
              autoComplete="off"
              disabled={busy}
              onChange={(event) => set("category", event.target.value)}
            />
            <datalist id={categoriesId}>
              {categories.map((category) => (
                <option key={category} value={category} />
              ))}
            </datalist>
          </>
        )}
      </FormField>

      <fieldset disabled={busy}>
        <legend className="text-sm font-medium">Icon</legend>
        <div className="mt-2 grid max-h-36 grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))] gap-1.5 overflow-y-auto rounded-lg border border-line bg-canvas/60 p-2">
          {Object.entries(LINK_ICONS).map(([key, { icon: Icon, label }]) => (
            <label key={key} title={label} className="cursor-pointer">
              <input
                type="radio"
                name="icon"
                value={key}
                checked={values.icon === key}
                onChange={() => set("icon", key)}
                className="peer sr-only"
              />
              <span className="grid size-9 place-items-center rounded-lg text-muted peer-checked:bg-accent/15 peer-checked:text-accent peer-checked:shadow-[0_0_0_1px_var(--accent)] peer-focus-visible:outline-2 peer-focus-visible:outline-accent hover:bg-surface-hover hover:text-fg">
                <Icon className="size-4" aria-hidden="true" />
                <span className="sr-only">{label}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset disabled={busy}>
        <legend className="text-sm font-medium">Colour</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {ACCENTS.map((accent) => (
            <label key={accent.key} title={accent.label} className="cursor-pointer">
              <input
                type="radio"
                name="accent"
                value={accent.key}
                checked={values.accent === accent.key}
                onChange={() => set("accent", accent.key)}
                className="peer sr-only"
              />
              <span
                style={{ "--swatch": accent.color } as CSSProperties}
                className="block size-8 rounded-full border-2 border-elevated bg-(--swatch) peer-checked:shadow-[0_0_0_2px_var(--swatch)] peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent"
              >
                <span className="sr-only">{accent.label}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="flex cursor-pointer items-center gap-2.5 text-sm">
        <input
          type="checkbox"
          className="size-4 rounded accent-(--accent)"
          checked={values.is_pinned}
          disabled={busy}
          onChange={(event) => set("is_pinned", event.target.checked)}
        />
        Pin to the top of the page
      </label>

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
          {busy ? "Saving" : link ? "Save changes" : "Add link"}
        </Button>
      </div>
    </form>
  );
}

/** Add or edit one link. Offered to admins only; the database checks the role itself. */
export function LinkDialog({
  open,
  onOpenChange,
  ...form
}: Omit<LinkFormProps, "onDone"> & { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      icon={Link2}
      title={form.link ? "Edit link" : "Add a link"}
      description="Shown as a card to everyone who can see this company."
      wide
    >
      <LinkForm key={form.link?.id ?? "new"} {...form} onDone={() => onOpenChange(false)} />
    </FormDialog>
  );
}
