import type { ReactNode } from "react";
import { CircleAlert, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DataFailure } from "@/lib/supabase/errors";
import { cn } from "@/lib/utils";

/** What to show when a region failed to load. Says what happened and offers a retry when one could help. */
export function ErrorState({
  failure,
  onRetry,
  className,
}: {
  failure: DataFailure;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center rounded-2xl border border-danger/30 bg-danger/5 px-6 py-12 text-center",
        className,
      )}
    >
      <span className="grid size-11 place-items-center rounded-full border border-danger/30 bg-danger/10">
        <CircleAlert className="size-5 text-danger" aria-hidden="true" />
      </span>
      <h2 className="mt-4 font-semibold">{failure.title}</h2>
      <p className="mt-1.5 max-w-md text-sm text-muted">{failure.message}</p>
      {onRetry && failure.retryable && (
        <Button className="mt-5" onClick={onRetry}>
          <RotateCw aria-hidden="true" />
          Try again
        </Button>
      )}
    </div>
  );
}

/** What to show when a region loaded fine but has nothing in it. */
export function EmptyState({
  illustration,
  title,
  children,
  action,
  className,
}: {
  illustration?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center px-6 py-12 text-center", className)}>
      {illustration}
      <h2 className={cn("font-semibold", illustration ? "mt-5" : undefined)}>{title}</h2>
      {children && <p className="mt-1.5 max-w-md text-sm text-muted">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
