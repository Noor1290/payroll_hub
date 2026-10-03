import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Skeleton } from "@/components/ui/misc";
import { useAuth } from "./auth-context";

/** Shell-shaped skeleton shown while the stored session is being checked. */
function ShellSkeleton() {
  return (
    <div className="flex h-full" aria-busy="true" aria-label="Loading Payroll Hub">
      <div className="hidden w-62 shrink-0 space-y-3 border-r border-line p-4 lg:block">
        <Skeleton className="mb-6 h-9 w-36" />
        {Array.from({ length: 7 }, (_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
      <div className="flex-1 space-y-6 p-6">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      </div>
    </div>
  );
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === "loading") return <ShellSkeleton />;
  if (status === "signed-out") {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}
