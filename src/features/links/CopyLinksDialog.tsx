import { useId, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FailureNote, FormDialog } from "@/components/ui/form";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/misc";
import { useAuth } from "@/features/auth/auth-context";
import { useCompany } from "@/features/company/company-context";
import { formatCount } from "@/lib/format";
import {
  classifyCompanyDataError,
  createLinks,
  type CompanyDataFailure,
  type CompanyLink,
} from "@/lib/supabase/companyData";
import type { Company } from "@/lib/supabase/schemas";
import { planCopy, safeHref } from "./linkModel";
import { useCompanyLinks } from "./useLinks";

const MAX_TITLES_SHOWN = 8;
const links = (n: number) => `${formatCount(n)} ${n === 1 ? "link" : "links"}`;

interface CopyProps {
  target: Company;
  existing: readonly CompanyLink[];
  onDone: () => void;
}

function CopyLinksBody({ target, existing, onDone }: CopyProps) {
  const { user } = useAuth();
  const { memberships } = useCompany();
  const queryClient = useQueryClient();
  const others = memberships.filter((m) => m.company.id !== target.id);
  const [sourceId, setSourceId] = useState(others[0]?.company.id);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<CompanyDataFailure | null>(null);
  const selectId = useId();
  const source = useCompanyLinks(sourceId);
  const plan = source.data ? planCopy(source.data, existing) : null;

  const copy = async () => {
    if (busy || !user || !plan || plan.toCopy.length === 0) return;
    setBusy(true);
    setFailure(null);
    try {
      const last = existing.reduce((max, link) => Math.max(max, link.sort_order), -1);
      const copied = await createLinks(
        { id: user.id, isDemo: user.isDemo },
        target.id,
        plan.toCopy.map((link) => ({
          title: link.title,
          // Tidied the same way as a typed address, so the same site is never added twice.
          url: safeHref(link.url)!,
          description: link.description,
          category: link.category,
          icon: link.icon,
          accent: link.accent,
          is_pinned: link.is_pinned,
        })),
        last + 1,
      );
      await queryClient.invalidateQueries({ queryKey: ["company-links", target.id] });
      toast.success(`Copied ${links(copied)} to ${target.name}`, {
        description:
          plan.skipped.length === 0
            ? "Nothing was skipped."
            : `Skipped ${links(plan.skipped.length)} that ${target.name} already has.`,
      });
      onDone();
    } catch (error) {
      setFailure(classifyCompanyDataError(error, "links"));
      setBusy(false);
      // Someone may have added one of them meanwhile: read the list again and recount.
      void queryClient.invalidateQueries({ queryKey: ["company-links", target.id] });
    }
  };

  return (
    <div className="mt-5 space-y-4">
      <div className="space-y-2">
        <Label htmlFor={selectId}>Copy from</Label>
        <select
          id={selectId}
          value={sourceId}
          disabled={busy}
          onChange={(event) => {
            setSourceId(event.target.value);
            setFailure(null);
          }}
          className="h-11 w-full rounded-lg border border-line bg-canvas/60 px-3 text-[15px] text-fg shadow-inner-glow hover:border-line-strong"
        >
          {others.map(({ company }) => (
            <option key={company.id} value={company.id}>
              {company.name}
            </option>
          ))}
        </select>
      </div>

      {source.isPending ? (
        <div aria-busy="true" aria-label="Loading that company's links">
          <Skeleton className="h-24 rounded-xl" />
        </div>
      ) : source.isError ? (
        <FailureNote failure={classifyCompanyDataError(source.error, "links")} />
      ) : (
        plan && (
          <div className="rounded-xl border border-line bg-surface p-4 text-sm" role="status">
            {plan.toCopy.length === 0 ? (
              <p className="text-fg">
                {source.data.length === 0
                  ? "That company has no links."
                  : `Nothing to copy: ${target.name} already has all ${links(source.data.length)}.`}
              </p>
            ) : (
              <>
                <p className="font-medium text-fg">{links(plan.toCopy.length)} will be copied</p>
                <ul className="mt-2 list-disc space-y-0.5 pl-5 text-muted">
                  {plan.toCopy.slice(0, MAX_TITLES_SHOWN).map((link) => (
                    <li key={link.id}>{link.title}</li>
                  ))}
                  {plan.toCopy.length > MAX_TITLES_SHOWN && (
                    <li>and {formatCount(plan.toCopy.length - MAX_TITLES_SHOWN)} more</li>
                  )}
                </ul>
                {plan.skipped.length > 0 && (
                  <p className="mt-2 text-muted">
                    {links(plan.skipped.length)} will be skipped because {target.name} already has{" "}
                    {plan.skipped.length === 1 ? "that address" : "those addresses"}.
                  </p>
                )}
              </>
            )}
          </div>
        )
      )}

      {failure && <FailureNote failure={failure} />}

      <div className="flex justify-end gap-2 pt-1">
        <Dialog.Close asChild>
          <Button disabled={busy}>Cancel</Button>
        </Dialog.Close>
        <Button
          variant="primary"
          disabled={busy || !plan || plan.toCopy.length === 0}
          onClick={() => void copy()}
        >
          {busy ? (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          ) : (
            <Copy aria-hidden="true" />
          )}
          {busy
            ? "Copying"
            : plan && plan.toCopy.length > 0
              ? `Copy ${links(plan.toCopy.length)}`
              : "Copy"}
        </Button>
      </div>
    </div>
  );
}

/** Copies another company's links into this one, leaving out addresses it already has. */
export function CopyLinksDialog({
  open,
  onOpenChange,
  target,
  existing,
}: Omit<CopyProps, "onDone"> & { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      icon={Copy}
      title="Copy links from another company"
      description={`Adds them to ${target.name}. The other company is not changed.`}
    >
      <CopyLinksBody target={target} existing={existing} onDone={() => onOpenChange(false)} />
    </FormDialog>
  );
}
