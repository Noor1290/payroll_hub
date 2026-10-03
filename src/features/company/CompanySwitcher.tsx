import { Building2, Check, ChevronsUpDown, CircleAlert } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge, Skeleton } from "@/components/ui/misc";
import { Tooltip } from "@/components/ui/tooltip";
import type { Role } from "@/lib/supabase/schemas";
import { useCompany } from "./company-context";

const TRIGGER_CLASS =
  "flex h-10 max-w-64 min-w-0 items-center gap-2.5 rounded-lg border border-line bg-surface px-3 text-sm shadow-inner-glow transition-colors";

export function RoleBadge({ role }: { role: Role }) {
  return <Badge tone={role === "admin" ? "accent" : "neutral"}>{role}</Badge>;
}

export function CompanySwitcher() {
  const { status, failure, retry, memberships, current, select } = useCompany();

  if (status === "loading") {
    return <Skeleton className="h-10 w-48" aria-hidden="true" />;
  }

  if (status === "error") {
    return (
      <Tooltip label={failure?.retryable ? `${failure.title}. Click to retry.` : failure?.title}>
        <button
          type="button"
          onClick={retry}
          className={`${TRIGGER_CLASS} border-danger/40 text-danger hover:bg-danger/10`}
        >
          <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
          <span className="truncate">Companies unavailable</span>
        </button>
      </Tooltip>
    );
  }

  if (!current) {
    return (
      <Tooltip label="Your account isn't a member of any company yet. Ask the owner to add you.">
        <button type="button" aria-disabled="true" className={`${TRIGGER_CLASS} text-muted`}>
          <Building2 className="size-4 shrink-0" aria-hidden="true" />
          <span className="truncate">No company</span>
        </button>
      </Tooltip>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Company: ${current.company.name} (${current.role}). Switch company`}
          className={`${TRIGGER_CLASS} text-fg hover:border-line-strong`}
        >
          <Building2 className="size-4 shrink-0 text-muted" aria-hidden="true" />
          <span className="truncate font-medium">{current.company.name}</span>
          <span className="hidden sm:inline-flex">
            <RoleBadge role={current.role} />
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-subtle" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[min(70vh,24rem)] w-72 overflow-y-auto">
        <DropdownMenuLabel>Your companies</DropdownMenuLabel>
        {memberships.map(({ company, role }) => {
          const selected = company.id === current.company.id;
          return (
            <DropdownMenuItem key={company.id} onSelect={() => select(company.id)}>
              <span className="grid size-4 shrink-0 place-items-center">
                {selected && <Check className="text-accent" aria-hidden="true" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-fg">{company.name}</span>
                {company.brn && (
                  <span className="tabular block truncate text-xs text-subtle">
                    BRN {company.brn}
                  </span>
                )}
              </span>
              <RoleBadge role={role} />
              {selected && <span className="sr-only">(selected)</span>}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
