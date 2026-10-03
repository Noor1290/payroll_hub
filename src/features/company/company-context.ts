import { createContext, useContext } from "react";
import type { DataFailure } from "@/lib/supabase/errors";
import type { Membership } from "@/lib/supabase/schemas";

export interface CompanyContextValue {
  status: "loading" | "error" | "ready";
  failure: DataFailure | null;
  retry: () => void;
  /** Every company the user belongs to. Empty while loading or when they belong to none. */
  memberships: Membership[];
  /** The selected company and the user's role in it; null until loaded or when there are none. */
  current: Membership | null;
  /** UI hint only: hides write actions. The database enforces the real rule. */
  isAdmin: boolean;
  select: (companyId: string) => void;
}

export const COMPANY_STORAGE_KEY = "company";

/**
 * Which company to show: the remembered one if the user still belongs to it, otherwise the first.
 * A remembered id the user has lost access to is simply ignored.
 */
export function pickCompany(
  memberships: readonly Membership[],
  preferredId: string | null,
): Membership | null {
  return memberships.find((m) => m.company.id === preferredId) ?? memberships[0] ?? null;
}

export const CompanyContext = createContext<CompanyContextValue | null>(null);

export function useCompany(): CompanyContextValue {
  const value = useContext(CompanyContext);
  if (!value) throw new Error("useCompany must be used inside <CompanyProvider>.");
  return value;
}
