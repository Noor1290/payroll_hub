import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/features/auth/auth-context";
import { preferenceStorage } from "@/lib/storage";
import { classifyDataError } from "@/lib/supabase/errors";
import { fetchMemberships } from "@/lib/supabase/queries";
import type { Membership } from "@/lib/supabase/schemas";
import {
  canAddCompany,
  COMPANY_STORAGE_KEY,
  CompanyContext,
  pickCompany,
  type CompanyContextValue,
} from "./company-context";
import { askBeforeLeaving } from "./leaveGuard";
import { LeaveQuestionDialog } from "./LeaveQuestionDialog";

const NO_MEMBERSHIPS: Membership[] = [];

export function CompanyProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  // Only the company id is remembered (not sensitive, and useless without access).
  const [preferredId, setPreferredId] = useState(() =>
    preferenceStorage.getItem(COMPANY_STORAGE_KEY),
  );

  const query = useQuery({
    queryKey: ["memberships", user?.id],
    queryFn: () => fetchMemberships({ id: user!.id, isDemo: user!.isDemo }),
    enabled: user !== null,
    staleTime: 5 * 60_000,
  });

  const { refetch } = query;
  const memberships = query.data ?? NO_MEMBERSHIPS;
  const current = pickCompany(memberships, preferredId);
  const currentId = current?.company.id ?? null;
  const currentName = current?.company.name ?? null;

  const select = useCallback(
    (companyId: string, options: { force?: boolean; afterwards?: () => void } = {}) => {
      const go = () => {
        setPreferredId(companyId);
        preferenceStorage.setItem(COMPANY_STORAGE_KEY, companyId);
        options.afterwards?.();
      };
      // The same company changes nothing and reloads nothing.
      if (options.force || companyId === currentId) go();
      else askBeforeLeaving(currentName, go);
    },
    [currentId, currentName],
  );

  const failure = useMemo(
    () => (query.error ? classifyDataError(query.error) : null),
    [query.error],
  );

  const value = useMemo<CompanyContextValue>(() => {
    return {
      status: query.isPending ? "loading" : failure ? "error" : "ready",
      failure,
      retry: () => void refetch(),
      memberships,
      current,
      isAdmin: current?.role === "admin",
      canAddCompany: canAddCompany(memberships),
      select,
    };
  }, [memberships, current, query.isPending, failure, refetch, select]);

  return (
    <CompanyContext.Provider value={value}>
      {children}
      <LeaveQuestionDialog />
    </CompanyContext.Provider>
  );
}
