import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/misc";
import { EmptyState, ErrorState } from "@/components/ui/states";
import type { Membership } from "@/lib/supabase/schemas";
import { useCompany } from "./company-context";

/**
 * Renders its children once a company is selected, and the right loading, error or
 * "no company" state otherwise, so every company-scoped screen handles these the same way.
 */
export function CompanyGate({ children }: { children: (current: Membership) => ReactNode }) {
  const { status, failure, retry, current } = useCompany();

  if (status === "loading") {
    return (
      <div aria-busy="true" aria-label="Loading" className="space-y-4">
        <Skeleton className="h-12 rounded-xl" />
        <Skeleton className="h-80 rounded-2xl" />
      </div>
    );
  }
  if (status === "error" && failure) return <ErrorState failure={failure} onRetry={retry} />;
  if (!current) {
    return (
      <div className="glass rounded-2xl">
        <EmptyState title="You're not a member of any company yet" className="py-16">
          Your sign-in works, but no company has been shared with this account. Ask the owner to add
          you as a member, then reload.
        </EmptyState>
      </div>
    );
  }
  return <>{children(current)}</>;
}
